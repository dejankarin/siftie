/**
 * Server-side helpers for the workspace tables (`projects` + `researches`).
 *
 * As of Session 3 the bootstrap payload also includes every research's
 * sources, so the client can paint the full workspace in one round-trip
 * (no N+1 fetches when switching researches). Messages and prompts remain
 * client-side until Sessions 4 and 5.
 *
 * We use the service-role client + manual `clerk_user_id` filters rather
 * than the Clerk-scoped client so behaviour is consistent with `lib/keys.ts`
 * and unaffected by transient JWT propagation issues. Every helper takes
 * `clerkUserId` as a parameter that the caller MUST have verified via
 * `requireUser()` first.
 */
import 'server-only';
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
    .select('id, project_id, name, created_at')
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

  // Hydrate sources for every research in one query (avoids N+1).
  const researchIds = finalResearches.map((r) => r.id);
  const sources = await listSourcesForResearches(researchIds);

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
      createdAt: new Date(r.created_at).getTime(),
    })),
    sources,
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
        createdAt: new Date(research.created_at).getTime(),
      },
    ],
    // Fresh user has no sources yet — saves one round-trip.
    sources: [],
  };
}

async function insertResearch(projectId: string, name: string) {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('researches')
    .insert({ project_id: projectId, name })
    .select('id, project_id, name, created_at')
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
    createdAt: new Date(research.created_at).getTime(),
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

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
