/**
 * POST /api/prompts/[promptId]/test
 *
 * Rebaseline one prompt's Peec hit count without re-running the whole
 * Council. The route:
 *   1. Loads the run row that owns the prompt (verifies ownership via
 *      the research → project chain inside `getRunForOwner`).
 *   2. Resolves the user's Peec key; 4xx if missing.
 *   3. Calls `fetchPeecBaseline` for a fresh 30-day brand-mention
 *      lookup. The shape of this lookup is *portfolio-wide* — Peec
 *      doesn't track our generated prompt ids — so today every prompt
 *      in a given run shares the same baseline. Test still has value
 *      because the underlying numbers drift as Peec ingests new data.
 *   4. Writes the new `hits` (and `totalChannels` / `channels` if Peec
 *      reports a different active set than the run captured) back to
 *      the run row's `prompts` JSONB. Realtime propagates the UPDATE
 *      to every open tab.
 *   5. Captures `prompt_tested` for product analytics.
 *
 * Returns the updated FinalPrompt so the optimistic client can swap
 * the row in place.
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
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PostBody = z.object({
  runId: z.string().min(1),
});

type Ctx = { params: Promise<{ promptId: string }> };

export const POST = withUser<Ctx>(async ({ userId }, req, ctx) => {
  const { promptId } = await ctx.params;
  const raw = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { runId } = parsed.data;

  const ph = getPostHogServer();
  const start = Date.now();

  // Run + ownership check (the helper walks research → project →
  // clerk_user_id). 404 hides whether the run exists at all when the
  // user doesn't own it.
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
  const promptIndex = run.prompts.findIndex((p) => p.id === promptId);
  if (promptIndex < 0) {
    return Response.json({ error: 'prompt_not_found' }, { status: 404 });
  }
  const existing = run.prompts[promptIndex]!;

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
  const traceId = `prompt_test_${runId}_${promptId}`;

  let baseline: Awaited<ReturnType<typeof fetchPeecBaseline>>;
  try {
    baseline = await fetchPeecBaseline(peecKey, {
      posthogDistinctId: userId,
      posthogTraceId: traceId,
      posthogProperties: {
        feature: 'prompt_test',
        research_id: run.researchId,
        run_id: runId,
        prompt_id: promptId,
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
      event: 'prompt_test_failed',
      groups: projectId ? { project: projectId } : undefined,
      properties: {
        research_id: run.researchId,
        run_id: runId,
        prompt_id: promptId,
        error_code: code,
        latency_ms: Date.now() - start,
      },
    });
    return Response.json({ error: code, message }, { status });
  }

  const updated: FinalPrompt = {
    ...existing,
    hits: baseline.hits,
    totalChannels: baseline.totalChannels || existing.totalChannels,
  };
  const nextPrompts = run.prompts.slice();
  nextPrompts[promptIndex] = updated;

  await updateRunPrompts(userId, runId, nextPrompts);

  ph.capture({
    distinctId: userId,
    event: 'prompt_tested',
    groups: projectId ? { project: projectId } : undefined,
    properties: {
      research_id: run.researchId,
      run_id: runId,
      prompt_id: promptId,
      cluster: existing.cluster,
      intent: existing.intent,
      hits_before: existing.hits,
      hits_after: baseline.hits,
      total_channels: baseline.totalChannels,
      latency_ms: Date.now() - start,
      $ai_trace_id: traceId,
    },
  });

  return Response.json({ prompt: updated });
});
