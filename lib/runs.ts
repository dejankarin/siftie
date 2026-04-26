/**
 * Server-side helpers for the `runs` table.
 *
 * Each "do research" command produces one row here. The orchestrator
 * (`lib/research.ts`) calls `createRun` at start, persists `prompts`
 * via `completeRun` at the end, or `failRun` on error.
 *
 * The current portfolio shown in the Prompts column is whatever the
 * **latest** run for that research stored in `prompts`. We expose
 * `getLatestRunByResearch` for the orchestrator's idempotency check
 * (don't start a new run if one is already in flight) and a bulk
 * `listLatestRunsForResearches` for the workspace bootstrap so the
 * client paints the persisted portfolio in a single round-trip.
 *
 * Like the rest of the data layer, we use the service-role client and
 * gate every write on an explicit ownership check (RLS would normally
 * enforce this, but service-role bypasses it).
 */
import 'server-only';
import type { CouncilDepth, FinalPrompt } from './research/schema';
import { createServiceRoleSupabaseClient } from './supabase/server';
import { ForbiddenError } from './workspace';

export type RunStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface RunRow {
  id: string;
  researchId: string;
  status: RunStatus;
  councilDepth: CouncilDepth;
  prompts: FinalPrompt[];
  totalChannels: number;
  peecSkipped: boolean;
  /** epoch milliseconds */
  startedAt: number;
  /** epoch milliseconds, or null while still running. */
  finishedAt: number | null;
}

interface DbRunRow {
  id: string;
  research_id: string;
  status: RunStatus;
  council_depth: CouncilDepth;
  prompts: unknown;
  total_channels: number;
  peec_skipped: boolean;
  started_at: string;
  finished_at: string | null;
}

/**
 * Insert a new run row in `running` state. Caller is the orchestrator,
 * which will mutate this row with `completeRun` or `failRun` later.
 *
 * Verifies ownership before writing because service-role bypasses RLS.
 */
export async function createRun(
  clerkUserId: string,
  researchId: string,
  councilDepth: CouncilDepth,
): Promise<RunRow> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('runs')
    .insert({
      research_id: researchId,
      status: 'running',
      council_depth: councilDepth,
      prompts: [],
      total_channels: 0,
      peec_skipped: false,
    })
    .select(
      'id, research_id, status, council_depth, prompts, total_channels, peec_skipped, started_at, finished_at',
    )
    .single();
  if (error || !data) throw error ?? new Error('Failed to create run');
  return rowToRun(data as DbRunRow);
}

export interface CompleteRunInput {
  prompts: FinalPrompt[];
  totalChannels: number;
  peecSkipped: boolean;
}

/**
 * Mark the run as complete and write the final prompts portfolio.
 *
 * No ownership check — `runId` was returned by `createRun` which
 * already verified ownership. (We rely on the orchestrator owning its
 * own runId; nothing else has it.)
 */
export async function completeRun(runId: string, input: CompleteRunInput): Promise<void> {
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('runs')
    .update({
      status: 'complete',
      prompts: input.prompts,
      total_channels: input.totalChannels,
      peec_skipped: input.peecSkipped,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw error;
}

/**
 * Mark a run as failed. We deliberately don't write the partial prompts
 * here — failed runs leave the prompts column showing the previous
 * successful run's data, which is more useful to the user than an
 * empty/half-baked portfolio.
 */
export async function failRun(runId: string): Promise<void> {
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw error;
}

/**
 * User-initiated cancellation.
 *
 * The orchestrator runs inside `waitUntil` on a serverless lambda so we
 * can't kill the process from outside; instead we mark the run as
 * `failed` immediately (which flips the UI out of "Working…" via the
 * existing Realtime subscription) and rely on the orchestrator's
 * cancellation checkpoints (`isRunCancelled`) to bail out at the next
 * stage boundary. In-flight LLM calls still complete in the background
 * — that's just how `waitUntil` works — but no new stages run.
 *
 * Idempotent: cancelling a run that's already `complete`/`failed` is a
 * no-op. Returns whether we actually flipped the row (so the API route
 * can decide whether to emit the "Run cancelled." chat bubble).
 *
 * Verifies ownership via the research → project chain because
 * service-role bypasses RLS.
 */
export async function cancelRun(
  clerkUserId: string,
  runId: string,
): Promise<{ cancelled: boolean; researchId: string }> {
  const supabase = createServiceRoleSupabaseClient();
  // Read the run row (status + research_id). We then verify ownership
  // by walking research → project, reusing the same helper as the rest
  // of this file.
  const { data: existing, error: readErr } = await supabase
    .from('runs')
    .select('id, research_id, status')
    .eq('id', runId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) throw new ForbiddenError('Run not found or not owned by this user');

  await assertResearchOwner(clerkUserId, existing.research_id);

  if (existing.status !== 'running' && existing.status !== 'pending') {
    return { cancelled: false, researchId: existing.research_id };
  }

  const { error } = await supabase
    .from('runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId)
    // Guard against the orchestrator finishing between the read and the
    // write — only flip if it's still running/pending.
    .in('status', ['running', 'pending']);
  if (error) throw error;
  return { cancelled: true, researchId: existing.research_id };
}

/**
 * Cheap polling helper used by the orchestrator at stage boundaries.
 *
 * Returns true if the run row has been flipped to a terminal state by
 * `cancelRun` (or any other path). The orchestrator throws an
 * `AbortError` when this returns true so the remaining stages are
 * skipped.
 *
 * Implemented as a single-row select so it's cheap to call between
 * every reviewer in the Council without hammering Postgres.
 */
export async function isRunCancelled(runId: string): Promise<boolean> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('runs')
    .select('status')
    .eq('id', runId)
    .maybeSingle();
  if (error) {
    // Fail open: if we can't read the row, don't block the run. The
    // orchestrator's existing error handling will surface real DB
    // failures elsewhere.
    return false;
  }
  if (!data) return false;
  return data.status === 'failed' || data.status === 'complete';
}

/**
 * Return the most recent run for a research, or null if none exists.
 *
 * Used by the orchestrator's idempotency guard (refuse to start a new
 * run if one is already `running`) and by the workspace bootstrap
 * (single-research case).
 */
export async function getLatestRunByResearch(
  clerkUserId: string,
  researchId: string,
): Promise<RunRow | null> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('runs')
    .select(
      'id, research_id, status, council_depth, prompts, total_channels, peec_skipped, started_at, finished_at',
    )
    .eq('research_id', researchId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRun(data as DbRunRow) : null;
}

/**
 * Bulk variant for the workspace bootstrap: returns the latest run
 * (by `started_at`) for each given research id, in one query.
 *
 * Skips ownership checks because the caller (`lib/workspace.ts`) has
 * already filtered `researchIds` to research rows the user owns.
 *
 * Implementation: pull all runs for the given researches, then keep
 * the first (= newest) one per research_id in JS. The set of researches
 * per user is small (10s, not 1000s), so a `select * order by started_at
 * desc` followed by an in-memory dedupe is fine and avoids a DISTINCT
 * ON query that would need RLS-aware handling.
 */
export async function listLatestRunsForResearches(
  researchIds: string[],
): Promise<RunRow[]> {
  if (researchIds.length === 0) return [];
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('runs')
    .select(
      'id, research_id, status, council_depth, prompts, total_channels, peec_skipped, started_at, finished_at',
    )
    .in('research_id', researchIds)
    .order('started_at', { ascending: false });
  if (error) throw error;
  const seen = new Set<string>();
  const latest: RunRow[] = [];
  for (const row of (data as DbRunRow[] | null) ?? []) {
    if (seen.has(row.research_id)) continue;
    seen.add(row.research_id);
    latest.push(rowToRun(row));
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRun(row: DbRunRow): RunRow {
  return {
    id: row.id,
    researchId: row.research_id,
    status: row.status,
    councilDepth: row.council_depth,
    // `prompts` is JSONB in Postgres → arrives as `unknown` (could be
    // any JSON shape if a future migration writes garbage). We trust
    // the orchestrator's writes but cast safely: the client is the
    // ultimate consumer and tolerates an empty array better than a
    // crash on a bad row.
    prompts: Array.isArray(row.prompts) ? (row.prompts as FinalPrompt[]) : [],
    totalChannels: row.total_channels,
    peecSkipped: row.peec_skipped,
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
  };
}

async function assertResearchOwner(clerkUserId: string, researchId: string): Promise<void> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .select('id, projects!inner(clerk_user_id)')
    .eq('id', researchId)
    .eq('projects.clerk_user_id', clerkUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForbiddenError('Research not found or not owned by this user');
}
