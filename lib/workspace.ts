/**
 * Server-side helpers for the workspace tables (`projects` + `researches`).
 *
 * As of Session 4 the bootstrap payload includes every research's sources
 * AND messages, so the client can paint the full workspace in a single
 * round-trip (no N+1 fetches when switching researches). Prompts remain
 * client-side until Session 7.
 *
 * We use the service-role client + manual `clerk_user_id` filters rather
 * than the Clerk-scoped client so behaviour is consistent with `lib/keys.ts`
 * and unaffected by transient JWT propagation issues. Every helper takes
 * `clerkUserId` as a parameter that the caller MUST have verified via
 * `requireUser()` first.
 */
import 'server-only';
import { listMessagesForResearches, type MessageRow } from './messages';
import type { CouncilDepth } from './research/schema';
import { listLatestRunsForResearches, type RunRow } from './runs';
import { listSourcesForResearches, type SourceRow } from './sources';
import { createServiceRoleSupabaseClient } from './supabase/server';

export interface WorkspaceProject {
  id: string;
  name: string;
  createdAt: number;
}

export interface WorkspaceResearch {
  id: string;
  projectId: string;
  name: string;
  /**
   * Composer dropdown choice for this research. Stored on the research
   * row so refreshing the page doesn't reset it.
   */
  councilDepth: CouncilDepth;
  createdAt: number;
}

export interface WorkspacePayload {
  projects: WorkspaceProject[];
  researches: WorkspaceResearch[];
  /**
   * Every source for every research the user owns, returned newest-first
   * within each research. Empty for fresh users / fresh researches.
   */
  sources: SourceRow[];
  /**
   * Every persisted chat message for every research the user owns,
   * oldest-first within each research (chat order). Empty for brand-new
   * researches where the user hasn't sent anything yet — the UI shows
   * a synthetic intro bubble in that case.
   */
  messages: MessageRow[];
  /**
   * The most recent run per research (Session 6+). Hydrates the Prompts
   * column on first paint so the user sees their last vetted portfolio
   * without firing a separate request.
   */
  latestRuns: RunRow[];
}

const DEFAULT_PROJECT_NAME = 'My first project';
const DEFAULT_RESEARCH_NAME = 'Untitled research';

/**
 * Fetch all projects + researches owned by the user. If the user has none,
 * lazily seed one project + one blank research and return them — so the UI
 * never has to deal with an "empty workspace" edge case.
 *
 * Returns ISO timestamps converted to epoch milliseconds so they line up
 * with the existing `WorkspaceState` shape on the client (which uses
 * `createdAt: number` from `Date.now()`).
 */
export async function fetchOrSeedWorkspace(clerkUserId: string): Promise<WorkspacePayload> {
  const supabase = createServiceRoleSupabaseClient();

  const { data: projects, error: projectsErr } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .eq('clerk_user_id', clerkUserId)
    .order('created_at', { ascending: true });
  if (projectsErr) throw projectsErr;

  if (!projects || projects.length === 0) {
    return seedInitialWorkspace(clerkUserId);
  }

  const projectIds = projects.map((p) => p.id);
  const { data: researches, error: researchesErr } = await supabase
    .from('researches')
    .select('id, project_id, name, council_depth, created_at')
    .in('project_id', projectIds)
    .order('created_at', { ascending: true });
  if (researchesErr) throw researchesErr;

  // Defensive: if a project somehow lost its researches (e.g. an aborted
  // earlier seed crashed mid-write), backfill a blank one so the UI never
  // crashes on `researchesForActiveProject[0]!`.
  const researchesByProject = new Map<string, typeof researches>();
  for (const r of researches ?? []) {
    const list = researchesByProject.get(r.project_id) ?? [];
    list.push(r);
    researchesByProject.set(r.project_id, list);
  }
  const finalResearches: typeof researches = [...(researches ?? [])];
  for (const project of projects) {
    if (!researchesByProject.get(project.id)?.length) {
      const seeded = await insertResearch(project.id, DEFAULT_RESEARCH_NAME);
      finalResearches.push(seeded);
    }
  }

  // Hydrate sources + messages + latest run per research in parallel
  // (avoids N+1 fetches and three queries that don't depend on each
  // other; no reason to serialise them).
  const researchIds = finalResearches.map((r) => r.id);
  const [sources, messages, latestRuns] = await Promise.all([
    listSourcesForResearches(researchIds),
    listMessagesForResearches(researchIds),
    listLatestRunsForResearches(researchIds),
  ]);

  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).getTime(),
    })),
    researches: finalResearches.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      councilDepth: (r.council_depth ?? 'standard') as CouncilDepth,
      createdAt: new Date(r.created_at).getTime(),
    })),
    sources,
    messages,
    latestRuns,
  };
}

async function seedInitialWorkspace(clerkUserId: string): Promise<WorkspacePayload> {
  const supabase = createServiceRoleSupabaseClient();
  const { data: project, error: pErr } = await supabase
    .from('projects')
    .insert({ clerk_user_id: clerkUserId, name: DEFAULT_PROJECT_NAME })
    .select('id, name, created_at')
    .single();
  if (pErr || !project) throw pErr ?? new Error('Failed to seed project');

  const research = await insertResearch(project.id, DEFAULT_RESEARCH_NAME);
  return {
    projects: [
      {
        id: project.id,
        name: project.name,
        createdAt: new Date(project.created_at).getTime(),
      },
    ],
    researches: [
      {
        id: research.id,
        projectId: research.project_id,
        name: research.name,
        councilDepth: (research.council_depth ?? 'standard') as CouncilDepth,
        createdAt: new Date(research.created_at).getTime(),
      },
    ],
    // Fresh user has no sources, messages, or runs yet — saves three round-trips.
    sources: [],
    messages: [],
    latestRuns: [],
  };
}

async function insertResearch(projectId: string, name: string) {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .insert({ project_id: projectId, name })
    .select('id, project_id, name, council_depth, created_at')
    .single();
  if (error || !data) throw error ?? new Error('Failed to seed research');
  return data;
}

// ---------------------------------------------------------------------------
// Project mutators
// ---------------------------------------------------------------------------
export async function createProject(
  clerkUserId: string,
  name: string,
): Promise<{ project: WorkspaceProject; research: WorkspaceResearch }> {
  const supabase = createServiceRoleSupabaseClient();
  const { data: project, error: pErr } = await supabase
    .from('projects')
    .insert({ clerk_user_id: clerkUserId, name: name.trim() || DEFAULT_PROJECT_NAME })
    .select('id, name, created_at')
    .single();
  if (pErr || !project) throw pErr ?? new Error('Failed to create project');

  const research = await insertResearch(project.id, DEFAULT_RESEARCH_NAME);
  return {
    project: {
      id: project.id,
      name: project.name,
      createdAt: new Date(project.created_at).getTime(),
    },
    research: {
      id: research.id,
      projectId: research.project_id,
      name: research.name,
      councilDepth: (research.council_depth ?? 'standard') as CouncilDepth,
      createdAt: new Date(research.created_at).getTime(),
    },
  };
}

export async function renameProject(
  clerkUserId: string,
  projectId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('projects')
    .update({ name: trimmed })
    .eq('id', projectId)
    .eq('clerk_user_id', clerkUserId);
  if (error) throw error;
}

export async function deleteProject(clerkUserId: string, projectId: string): Promise<void> {
  // Researches/sources/messages/runs cascade-delete via the FK chain.
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('clerk_user_id', clerkUserId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Research mutators
// ---------------------------------------------------------------------------
export async function createResearch(
  clerkUserId: string,
  projectId: string,
  name: string,
): Promise<WorkspaceResearch> {
  // Verify the project belongs to the user before inserting (service-role
  // bypasses RLS, so we'd otherwise allow cross-user writes).
  await assertProjectOwner(clerkUserId, projectId);
  const research = await insertResearch(projectId, name.trim() || DEFAULT_RESEARCH_NAME);
  return {
    id: research.id,
    projectId: research.project_id,
    name: research.name,
    councilDepth: (research.council_depth ?? 'standard') as CouncilDepth,
    createdAt: new Date(research.created_at).getTime(),
  };
}

/**
 * Update the council depth on a research. Idempotent — setting to the
 * same value is a no-op (Postgres returns 0 affected rows but no
 * error). Verifies ownership before writing.
 */
export async function setResearchCouncilDepth(
  clerkUserId: string,
  researchId: string,
  depth: CouncilDepth,
): Promise<void> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('researches')
    .update({ council_depth: depth })
    .eq('id', researchId);
  if (error) throw error;
}

/**
 * Read a research row + its parent project name, used by the research
 * orchestrator to know what to title things. Verifies ownership.
 */
export async function getResearchWithContext(
  clerkUserId: string,
  researchId: string,
): Promise<{ research: WorkspaceResearch; projectName: string }> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .select(
      'id, project_id, name, council_depth, created_at, projects!inner(name)',
    )
    .eq('id', researchId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForbiddenError('Research not found');
  const project = (data as unknown as { projects: { name: string } }).projects;
  return {
    research: {
      id: data.id as string,
      projectId: data.project_id as string,
      name: data.name as string,
      councilDepth: ((data.council_depth ?? 'standard') as CouncilDepth),
      createdAt: new Date(data.created_at as string).getTime(),
    },
    projectName: project?.name ?? '',
  };
}

export async function renameResearch(
  clerkUserId: string,
  researchId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase.from('researches').update({ name: trimmed }).eq('id', researchId);
  if (error) throw error;
}

export async function deleteResearch(clerkUserId: string, researchId: string): Promise<void> {
  await assertResearchOwner(clerkUserId, researchId);
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase.from('researches').delete().eq('id', researchId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Ownership guards (used by every research mutator because service-role
// bypasses the RLS that would normally enforce this).
// ---------------------------------------------------------------------------
async function assertProjectOwner(clerkUserId: string, projectId: string): Promise<void> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForbiddenError('Project not found or not owned by this user');
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

/**
 * Boolean ownership check used by the `/app/[projectId]/[researchId]`
 * server route. Returns `true` only when the research belongs to the
 * given project AND the project belongs to the user. Differs from
 * `assertResearchOwner` in three ways:
 *   1. Verifies the project ⇄ research relationship (so a stale URL
 *      that points at a research the user *does* own but under a
 *      different project still falls back to /app rather than silently
 *      switching their visible project).
 *   2. Returns a boolean so the route can call `redirect('/app')`
 *      without try/catching a thrown ForbiddenError.
 *   3. Validates id shape first; the page exposes the ids in the URL,
 *      so we want to short-circuit before issuing a DB query for
 *      obvious garbage like a manually typed "abc/def".
 */
export async function userOwnsProjectAndResearch(
  clerkUserId: string,
  projectId: string,
  researchId: string,
): Promise<boolean> {
  if (!UUID_RE.test(projectId) || !UUID_RE.test(researchId)) return false;
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .select('id, projects!inner(id, clerk_user_id)')
    .eq('id', researchId)
    .eq('project_id', projectId)
    .eq('projects.clerk_user_id', clerkUserId)
    .maybeSingle();
  if (error) {
    console.warn('[userOwnsProjectAndResearch] query error:', error.message);
    return false;
  }
  return Boolean(data);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Look up the parent project id for a research. Used by analytics call sites
 * that need to attach `groups: { project: projectId }` to PostHog events
 * (group analytics — see app/PostHogIdentify.tsx for the browser side).
 *
 * Returns null on miss instead of throwing: analytics failures must never
 * crash a request handler.
 */
export async function getProjectIdForResearch(researchId: string): Promise<string | null> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .select('project_id')
    .eq('id', researchId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.project_id as string) ?? null;
}
