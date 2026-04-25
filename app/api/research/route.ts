/**
 * POST /api/research { researchId }
 *
 * Kicks off a research orchestration run. The actual work (Ideate +
 * Peec + Council + Surface) takes 60-180s — way more than the API
 * route's `maxDuration` budget — so we:
 *
 *   1. Validate inputs synchronously (`startResearchRun` checks for
 *      sources, user messages, and required keys; throws a friendly
 *      `Error` with `cause` = a short code).
 *   2. Insert a `runs` row in `running` state.
 *   3. Hand the orchestration off to `waitUntil(...)` so the lambda
 *      keeps the worker alive after the 202 response goes out.
 *   4. Return `{ runId }` with status 202 immediately.
 *
 * The client doesn't poll — it watches the existing Supabase Realtime
 * channels for `messages` (council bubbles + final summary) and `runs`
 * (status flips to `complete` / `failed`) and refreshes its
 * `WorkspaceState` from those events.
 */
import { withUser } from '@/lib/auth';
import { runResearchPipeline, startResearchRun } from '@/lib/research';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';

export const runtime = 'nodejs';
// 30 s is plenty for the validation + insert. The actual orchestration
// runs inside `waitUntil` and isn't constrained by this number.
export const maxDuration = 30;

const Body = z.object({
  researchId: z.string().uuid(),
});

export const POST = withUser(async ({ userId }, req) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { researchId } = parsed.data;

  let started: Awaited<ReturnType<typeof startResearchRun>>;
  try {
    started = await startResearchRun(userId, researchId);
  } catch (err) {
    const code = (err as Error & { cause?: unknown })?.cause;
    const message = err instanceof Error ? err.message : 'Failed to start research run';
    if (typeof code === 'string') {
      // Validation errors → 400 so the client surfaces a friendly toast.
      return Response.json({ error: code, message }, { status: 400 });
    }
    // Unknown failures → 500.
    return Response.json({ error: 'unknown', message }, { status: 500 });
  }

  // Idempotency: if a run is already in flight we just hand back the
  // existing run id and don't fire the pipeline again.
  if (started.reused) {
    return Response.json({ runId: started.runId, reused: true }, { status: 200 });
  }

  // Fire-and-forget the long-running orchestration. waitUntil keeps
  // the function instance alive until the promise settles even though
  // we've already returned to the client.
  waitUntil(
    runResearchPipeline(userId, researchId, started.runId).catch((err) => {
      // Defensive log only — `runResearchPipeline` always handles its
      // own failures internally (failRun + chat bubble + capture event).
      console.error('[api/research] background pipeline crashed', err);
    }),
  );

  return Response.json({ runId: started.runId, reused: false }, { status: 202 });
});
