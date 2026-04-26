/**
 * Server-side helpers for the `messages` table.
 *
 * Mirrors the same pattern as `lib/sources.ts`: we use the service-role
 * Supabase client for performance, but every helper takes a `clerkUserId`
 * (verified upstream by `requireUser()`) and runs an explicit ownership
 * check against `researches.projects.clerk_user_id` before reading or
 * writing — RLS is bypassed by service-role, so this is the safety net.
 *
 * The schema reserves columns we don't write yet (`council_role`,
 * `council_seat`, `run_id`) — those land in Sessions 6+. For Session 4
 * we only persist the basic fields a chat needs: id, research_id, role,
 * body, created_at.
 */
import 'server-only';
import { createServiceRoleSupabaseClient } from './supabase/server';
import { ForbiddenError } from './workspace';

export type MessageRole = 'user' | 'agent';

export interface MessageRow {
  id: string;
  researchId: string;
  role: MessageRole;
  body: string;
  /** epoch milliseconds — converted from Postgres timestamptz on read */
  createdAt: number;
  /** Reserved for Session 6 council bubbles. `null` for ordinary chat. */
  councilRole: 'reviewer' | 'chair' | null;
  /** Reserved for Session 6 council bubbles (1..4). `null` otherwise. */
  councilSeat: number | null;
  /** Reserved for Session 6 — links to `runs.id` once research runs land. */
  runId: string | null;
}

interface DbMessageRow {
  id: string;
  research_id: string;
  role: MessageRole;
  body: string;
  council_role: 'reviewer' | 'chair' | null;
  council_seat: number | null;
  run_id: string | null;
  created_at: string;
}

/**
 * List every message for a single research, oldest-first (chat order).
 * Verifies ownership before reading.
 */
export async function listMessagesForResearch(
  clerkUserId: string,
  researchId: string,
): Promise<MessageRow[]> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('messages')
    .select('id, research_id, role, body, council_role, council_seat, run_id, created_at')
    .eq('research_id', researchId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as DbMessageRow[] | null)?.map(rowToMessage) ?? [];
}

/**
 * Messages tied to a specific research run (Council bubbles + narration).
 * Oldest-first. Ownership is enforced via the research id.
 */
export async function listMessagesForRun(
  clerkUserId: string,
  researchId: string,
  runId: string,
): Promise<MessageRow[]> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('messages')
    .select('id, research_id, role, body, council_role, council_seat, run_id, created_at')
    .eq('research_id', researchId)
    .eq('run_id', runId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as DbMessageRow[] | null)?.map(rowToMessage) ?? [];
}

/**
 * Bulk variant for the workspace bootstrap — pulls messages for every
 * research in one query so the initial paint is a single round-trip.
 *
 * Skips ownership checks because the caller already filters
 * `researchIds` to research rows the user owns (via `lib/workspace.ts`).
 */
export async function listMessagesForResearches(
  researchIds: string[],
): Promise<MessageRow[]> {
  if (researchIds.length === 0) return [];
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('messages')
    .select('id, research_id, role, body, council_role, council_seat, run_id, created_at')
    .in('research_id', researchIds)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as DbMessageRow[] | null)?.map(rowToMessage) ?? [];
}

export interface CreateMessageInput {
  researchId: string;
  role: MessageRole;
  body: string;
  councilRole?: 'reviewer' | 'chair' | null;
  councilSeat?: number | null;
  runId?: string | null;
}

/**
 * Insert a single message. Verifies ownership before writing.
 */
export async function createMessage(
  clerkUserId: string,
  input: CreateMessageInput,
): Promise<MessageRow> {
  await assertResearchOwner(clerkUserId, input.researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('messages')
    .insert({
      research_id: input.researchId,
      role: input.role,
      body: input.body,
      council_role: input.councilRole ?? null,
      council_seat: input.councilSeat ?? null,
      run_id: input.runId ?? null,
    })
    .select('id, research_id, role, body, council_role, council_seat, run_id, created_at')
    .single();
  if (error || !data) throw error ?? new Error('Failed to insert message');
  return rowToMessage(data as DbMessageRow);
}

/**
 * Insert several messages for the same research, in order. Used by the
 * interview generator (Session 4) to drop in the 6 opening questions
 * one at a time so the Realtime stream feels like the agent is
 * "thinking out loud" rather than dumping a wall of 6 messages.
 *
 * Each insert is awaited individually with a small `delayMs` between
 * them so Realtime fires per row. The default of 250ms keeps the total
 * extra latency under 1.5s for 6 rows — invisible compared to the
 * Gemini call that produced them.
 *
 * If any insert fails, we stop and return the rows that did succeed so
 * the chat shows partial progress rather than an empty void.
 */
export async function createMessagesSequenced(
  clerkUserId: string,
  researchId: string,
  messages: Omit<CreateMessageInput, 'researchId'>[],
  delayMs = 250,
): Promise<MessageRow[]> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const inserted: MessageRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (i > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const { data, error } = await supabase
      .from('messages')
      .insert({
        research_id: researchId,
        role: m.role,
        body: m.body,
        council_role: m.councilRole ?? null,
        council_seat: m.councilSeat ?? null,
        run_id: m.runId ?? null,
      })
      .select('id, research_id, role, body, council_role, council_seat, run_id, created_at')
      .single();
    if (error || !data) {
      // Surface what we have instead of throwing — the user gets partial
      // questions rather than an empty chat with a 500 error.
      console.error('[createMessagesSequenced] partial failure at index', i, error);
      break;
    }
    inserted.push(rowToMessage(data as DbMessageRow));
  }
  return inserted;
}

/**
 * Lightweight read used by route handlers that need to decide whether
 * the very first agent reply (the 6 interview questions) should fire.
 * Just `select count` so we don't pull bodies we don't need.
 */
export async function countMessagesForResearch(
  clerkUserId: string,
  researchId: string,
): Promise<number> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('research_id', researchId);
  if (error) throw error;
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMessage(row: DbMessageRow): MessageRow {
  return {
    id: row.id,
    researchId: row.research_id,
    role: row.role,
    body: row.body,
    createdAt: new Date(row.created_at).getTime(),
    councilRole: row.council_role,
    councilSeat: row.council_seat,
    runId: row.run_id,
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
