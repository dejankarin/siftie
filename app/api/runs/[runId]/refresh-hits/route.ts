/**
 * POST /api/runs/[runId]/refresh-hits
 *
 * Re-fire the Peec brand-mention baseline for an entire run and write
 * the freshly-fetched `hits` / `totalChannels` back onto **every**
 * prompt in the run. Honest semantics: Peec doesn't index our prompt
 * ids — its baseline lookup is portfolio-wide — so the only correct
 * thing to do is update all prompts with the same number, not just
 * one. (Pre-Session 9 a per-prompt `/api/prompts/[promptId]/test`
 * endpoint pretended to "test" a single prompt while doing this same
 * portfolio-wide lookup; the rename + scope move makes the wire path
 * match what actually happens.)
 *
 * The route:
 *   1. Loads the run, verifies ownership via the
 *      research → project → clerk_user_id chain.
 *   2. Resolves the user's Peec key; 4xx if missing.
 *   3. Calls `fetchPeecBaseline` once for a fresh 30-day brand-mention
 *      lookup against the user's Peec project.
 *   4. Maps the new `hits` (and `totalChannels` if Peec reports a
 *      different active set) onto every prompt in `runs.prompts`.
 *      Realtime propagates the UPDATE to every open tab.
 *   5. Captures `hits_refreshed` for product analytics.
 *
 * Returns the updated `prompts` array so the optimistic client can
 * swap the whole list in place.
 */
import { withUser } from '@/lib/auth';
import { getUserApiKey } from '@/lib/keys';
import {
  PeecNoBrandError,
  PeecNoProjectError,
  fetchPeecBaseline,
} from '@/lib/peec-baseline';
import { PeecKeyMissingError } from '@/lib/peec';
import { getPostHogServer } from '@/lib/posthog';
import { classifyProviderError } from '@/lib/provider-errors';
import { getRunForOwner, updateRunPrompts } from '@/lib/runs';
import type { FinalPrompt } from '@/lib/research/schema';
import { getProjectIdForResearch } from '@/lib/workspace';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ runId: string }> };

export const POST = withUser<Ctx>(async ({ userId }, _req, ctx) => {
  const { runId } = await ctx.params;
  if (!runId) {
    return Response.json({ error: 'invalid_run_id' }, { status: 400 });
  }

  const ph = getPostHogServer();
  const start = Date.now();

  const run = await getRunForOwner(userId, runId);
  if (!run) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  if (run.status !== 'complete') {
    return Response.json(
      { error: 'invalid_state', message: 'Run is not complete yet.' },
      { status: 409 },
    );
  }
  if (run.prompts.length === 0) {
    return Response.json(
      { error: 'no_prompts', message: 'This run has no prompts to refresh.' },
      { status: 409 },
    );
  }

  const peecKey = await getUserApiKey(userId, 'peec');
  if (!peecKey) {
    return Response.json(
      {
        error: 'missing_peec_key',
        message: 'Add a Peec key in Settings to refresh hit counts.',
      },
      { status: 400 },
    );
  }

  const projectId = await getProjectIdForResearch(run.researchId);
  const traceId = `hits_refresh_${runId}`;

  let baseline: Awaited<ReturnType<typeof fetchPeecBaseline>>;
  try {
    baseline = await fetchPeecBaseline(peecKey, {
      posthogDistinctId: userId,
      posthogTraceId: traceId,
      posthogProperties: {
        feature: 'hits_refresh',
        research_id: run.researchId,
        run_id: runId,
        prompt_count: run.prompts.length,
      },
      posthogGroups: projectId ? { project: projectId } : undefined,
    });
  } catch (err) {
    let code = 'peec_failed';
    let message = 'Peec lookup failed.';
    let status = 502;
    if (err instanceof PeecKeyMissingError) {
      code = 'missing_peec_key';
      message = 'Add a Peec key in Settings to refresh hit counts.';
      status = 400;
    } else if (err instanceof PeecNoProjectError) {
      code = 'peec_no_project';
      message = err.message;
      status = 400;
    } else if (err instanceof PeecNoBrandError) {
      code = 'peec_no_brand';
      message = err.message;
      status = 400;
    } else {
      const classified = classifyProviderError(err, 'peec');
      message = classified.message;
    }
    ph.capture({
      distinctId: userId,
      event: 'hits_refresh_failed',
      groups: projectId ? { project: projectId } : undefined,
      properties: {
        research_id: run.researchId,
        run_id: runId,
        prompt_count: run.prompts.length,
        error_code: code,
        latency_ms: Date.now() - start,
      },
    });
    return Response.json({ error: code, message }, { status });
  }

  // Portfolio-wide baseline → every prompt gets the same new hits /
  // totalChannels. We preserve `totalChannels` per-row when Peec
  // doesn't report a fresh count (rare; keeps backward compat with
  // pre-channels-persistence runs).
  const updatedPrompts: FinalPrompt[] = run.prompts.map((p) => ({
    ...p,
    hits: baseline.hits,
    totalChannels: baseline.totalChannels || p.totalChannels,
  }));

  await updateRunPrompts(userId, runId, updatedPrompts);

  ph.capture({
    distinctId: userId,
    event: 'hits_refreshed',
    groups: projectId ? { project: projectId } : undefined,
    properties: {
      research_id: run.researchId,
      run_id: runId,
      prompt_count: updatedPrompts.length,
      hits_after: baseline.hits,
      total_channels: baseline.totalChannels,
      latency_ms: Date.now() - start,
      $ai_trace_id: traceId,
    },
  });

  return Response.json({ prompts: updatedPrompts });
});
