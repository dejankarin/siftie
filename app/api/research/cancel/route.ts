/**
 * POST /api/research/cancel { runId }
 *
 * User-initiated cancel for an in-flight research run. Companion to
 * POST /api/research (which kicks the orchestrator off in `waitUntil`).
 *
 * The trick: we can't actually kill the orchestrator's lambda from
 * another HTTP request. What we can do is mark the `runs` row as
 * `failed` immediately — the existing Realtime subscription on the
 * client picks that up and flips the UI out of "Working…" right away.
 * The orchestrator polls the same row at every stage boundary
 * (`isRunCancelled`, see lib/research.ts) and bails out via
 * `RunCancelledError` at the next checkpoint, so no further LLM stages
 * run. Any LLM call that was already in flight at the moment Stop was
 * pressed will still complete in the background — that's a hard
 * trade-off of fire-and-forget compute on Vercel.
 *
 * Cancellation is idempotent: if the run is already `complete` or
 * `failed`, we just return `{ cancelled: false }` and don't emit a
 * second "Run cancelled." bubble.
 */
import { withUser } from '@/lib/auth';
import { createMessage } from '@/lib/messages';
import { cancelRun } from '@/lib/runs';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 10;

const Body = z.object({
  runId: z.string().uuid(),
});

export const POST = withUser(async ({ userId }, req) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { runId } = parsed.data;

  let result: Awaited<ReturnType<typeof cancelRun>>;
  try {
    result = await cancelRun(userId, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cancel failed';
    return Response.json({ error: 'unknown', message }, { status: 500 });
  }

  // Drop a chat bubble explaining what happened. Only when we actually
  // cancelled — if the run had already completed/failed we skip the
  // bubble so a too-late Stop click doesn't add stale narration.
  if (result.cancelled) {
    await createMessage(userId, {
      researchId: result.researchId,
      role: 'agent',
      body: 'Run cancelled. The Council has been stopped — hit Run research when you want another pass.',
      runId,
    }).catch((err) => {
      // Best-effort: the run is already `failed`, so a missed bubble
      // is annoying but not blocking. Logged for ops triage.
      console.error('[api/research/cancel] failed to insert cancel bubble', err);
    });
  }

  return Response.json({ cancelled: result.cancelled }, { status: 200 });
});
