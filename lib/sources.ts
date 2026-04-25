/**
 * Server-side helpers for the `sources` table.
 *
 * Mirrors the pattern used in `lib/workspace.ts`: service-role client
 * for fast inserts, with manual ownership checks because RLS is bypassed.
 *
 * Every helper takes `clerkUserId` that the route handler MUST have
 * verified via `requireUser()` first.
 */
import 'server-only';
import type { ContextDoc } from './ingest/schema';
import type { IngestKind, SourceMeta } from './ingest';
import { createServiceRoleSupabaseClient } from './supabase/server';
import { ForbiddenError } from './workspace';

export interface SourceRow {
  id: string;
  researchId: string;
  kind: IngestKind;
  title: string;
  meta: SourceMeta;
  snippet: string;
  contextDoc: ContextDoc;
  createdAt: number;
  updatedAt: number;
}

interface DbSourceRow {
  id: string;
  research_id: string;
  kind: IngestKind;
  title: string;
  meta: SourceMeta;
  snippet: string | null;
  context_doc: ContextDoc;
  created_at: string;
  updated_at: string;
}

/**
 * List every source for a research, newest first. Verifies the user owns
 * the research before reading.
 */
export async function listSourcesForResearch(
  clerkUserId: string,
  researchId: string,
): Promise<SourceRow[]> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('sources')
    .select('id, research_id, kind, title, meta, snippet, context_doc, created_at, updated_at')
    .eq('research_id', researchId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as DbSourceRow[] | null)?.map(rowToSource) ?? [];
}

/**
 * Bulk version used by the workspace bootstrap so we can hydrate every
 * research's sources in one query rather than N+1.
 */
export async function listSourcesForResearches(
  researchIds: string[],
): Promise<SourceRow[]> {
  if (researchIds.length === 0) return [];
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('sources')
    .select('id, research_id, kind, title, meta, snippet, context_doc, created_at, updated_at')
    .in('research_id', researchIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as DbSourceRow[] | null)?.map(rowToSource) ?? [];
}

export interface CreateSourceInput {
  researchId: string;
  kind: IngestKind;
  title: string;
  meta: SourceMeta;
  snippet: string;
  contextDoc: ContextDoc;
}

export async function createSource(
  clerkUserId: string,
  input: CreateSourceInput,
): Promise<SourceRow> {
  await assertResearchOwner(clerkUserId, input.researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('sources')
    .insert({
      research_id: input.researchId,
      kind: input.kind,
      title: input.title,
      meta: input.meta,
      snippet: input.snippet,
      context_doc: input.contextDoc,
    })
    .select('id, research_id, kind, title, meta, snippet, context_doc, created_at, updated_at')
    .single();
  if (error || !data) throw error ?? new Error('Failed to insert source');
  return rowToSource(data as DbSourceRow);
}

export async function getSource(clerkUserId: string, sourceId: string): Promise<SourceRow> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('sources')
    .select(
      'id, research_id, kind, title, meta, snippet, context_doc, created_at, updated_at, researches!inner(project_id, projects!inner(clerk_user_id))',
    )
    .eq('id', sourceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForbiddenError('Source not found');

  // The nested join enforces ownership — bail if it doesn't match.
  const researches = (data as unknown as { researches: { projects: { clerk_user_id: string } } })
    .researches;
  if (researches?.projects?.clerk_user_id !== clerkUserId) {
    throw new ForbiddenError('Source not owned by this user');
  }

  return rowToSource(data as DbSourceRow);
}

export async function updateSource(
  clerkUserId: string,
  sourceId: string,
  patch: Partial<Pick<CreateSourceInput, 'title' | 'meta' | 'snippet' | 'contextDoc'>>,
): Promise<SourceRow> {
  // Ownership via getSource (which throws on mismatch).
  await getSource(clerkUserId, sourceId);
  const supabase = createServiceRoleSupabaseClient();
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.meta !== undefined) update.meta = patch.meta;
  if (patch.snippet !== undefined) update.snippet = patch.snippet;
  if (patch.contextDoc !== undefined) update.context_doc = patch.contextDoc;
  const { data, error } = await supabase
    .from('sources')
    .update(update)
    .eq('id', sourceId)
    .select('id, research_id, kind, title, meta, snippet, context_doc, created_at, updated_at')
    .single();
  if (error || !data) throw error ?? new Error('Failed to update source');
  return rowToSource(data as DbSourceRow);
}

export async function deleteSource(clerkUserId: string, sourceId: string): Promise<void> {
  // Verify ownership before deleting — service-role bypasses RLS.
  await getSource(clerkUserId, sourceId);
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase.from('sources').delete().eq('id', sourceId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSource(row: DbSourceRow): SourceRow {
  return {
    id: row.id,
    researchId: row.research_id,
    kind: row.kind,
    title: row.title,
    meta: row.meta,
    snippet: row.snippet ?? '',
    contextDoc: row.context_doc,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
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
