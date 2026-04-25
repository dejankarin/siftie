import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blankIntroMessage, createBlankResearch } from '../data/workspace';
import type { Project, Research, WorkspaceState } from '../types';

/**
 * Workspace hook — Supabase edition (Session 2B).
 *
 * Behaviour vs. Session 1's localStorage version:
 *   - On mount: GETs /api/workspace which returns the user's projects +
 *     researches from Supabase (and lazily seeds one of each if the user is
 *     fresh). Returns `null` while in flight so callers can show a loading
 *     state without the hooks-rules dance of conditionally calling other
 *     hooks.
 *   - Project + research CRUD goes through API routes that hit Supabase.
 *     Mutations are optimistic — local state updates first, the network
 *     call fires in the background. On failure we log + leave the optimistic
 *     update in place; the next reload re-syncs from Supabase as the source
 *     of truth, so any temporary divergence self-heals.
 *   - Sources, messages, and prompts inside a research are NOT yet persisted
 *     this session — they live in component-local state and are lost on
 *     reload. Sessions 3 (ingest) and 4 (chat) will swap those for per-row
 *     Supabase tables + Realtime subscriptions, so we don't bother building
 *     throwaway persistence here.
 *   - Active project/research IDs are persisted to localStorage (just the
 *     two strings, ~80 bytes) so reload returns to the same view without a
 *     second server round-trip.
 */

const ACTIVE_KEY = 'siftie.workspace.v1.active';

interface ActiveIds {
  projectId: string;
  researchId: string;
}

interface ApiWorkspaceResponse {
  projects: { id: string; name: string; createdAt: number }[];
  researches: { id: string; projectId: string; name: string; createdAt: number }[];
}

export interface UseWorkspaceResult {
  state: WorkspaceState;
  projects: Project[];
  researchesForActiveProject: Research[];
  activeProject: Project;
  activeResearch: Research;
  setActiveProject: (id: string) => void;
  setActiveResearch: (id: string) => void;
  createProject: (name?: string) => Project;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  createResearch: (name?: string, projectId?: string) => Research;
  renameResearch: (id: string, name: string) => void;
  deleteResearch: (id: string) => void;
  updateActiveResearch: (updater: (r: Research) => Research) => void;
}

function readActiveIds(): ActiveIds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.projectId === 'string' && typeof parsed?.researchId === 'string') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeActiveIds(ids: ActiveIds) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(ids));
  } catch {
    // ignore (private mode, quota)
  }
}

/**
 * Convert the API's flat shape into the in-memory WorkspaceState the
 * existing UI expects, hydrating each research with empty
 * sources/messages/prompts plus a fresh intro message so ChatColumn isn't
 * empty on first paint.
 */
function hydrate(api: ApiWorkspaceResponse): WorkspaceState {
  const projects: Project[] = api.projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
  }));
  const researches: Research[] = api.researches.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    createdAt: r.createdAt,
    sources: [],
    messages: [blankIntroMessage()],
    prompts: [],
  }));

  const stored = readActiveIds();
  let activeProjectId = projects[0]?.id ?? '';
  let activeResearchId = researches[0]?.id ?? '';
  if (stored) {
    const proj = projects.find((p) => p.id === stored.projectId);
    if (proj) {
      activeProjectId = proj.id;
      const matchingResearch = researches.find(
        (r) => r.id === stored.researchId && r.projectId === proj.id,
      );
      if (matchingResearch) {
        activeResearchId = matchingResearch.id;
      } else {
        activeResearchId = researches.find((r) => r.projectId === proj.id)?.id ?? activeResearchId;
      }
    }
  }
  return { projects, researches, activeProjectId, activeResearchId };
}

export function useWorkspace(): UseWorkspaceResult | null {
  const [state, setState] = useState<WorkspaceState | null>(null);
  // Keep a ref of the latest state so async mutators can compute rollbacks
  // without stale closures pinning the React state at hook-creation time.
  const stateRef = useRef<WorkspaceState | null>(null);
  stateRef.current = state;

  // -------------------------------------------------------------------------
  // Initial fetch
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspace', { method: 'GET' });
        if (!res.ok) throw new Error(`GET /api/workspace failed (${res.status})`);
        const api = (await res.json()) as ApiWorkspaceResponse;
        if (cancelled) return;
        setState(hydrate(api));
      } catch (err) {
        console.error('[useWorkspace] initial load failed:', err);
        // Fall back to a minimal in-memory workspace so the UI doesn't get
        // stuck on the loading state. Reloading once the network recovers
        // will pull the real workspace from Supabase.
        if (cancelled) return;
        const projectId = 'p_offline';
        const research = createBlankResearch(projectId, 'Untitled research');
        setState({
          projects: [{ id: projectId, name: 'Offline workspace', createdAt: Date.now() }],
          researches: [research],
          activeProjectId: projectId,
          activeResearchId: research.id,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Persist active IDs whenever they change so reload returns to same view.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!state) return;
    writeActiveIds({ projectId: state.activeProjectId, researchId: state.activeResearchId });
  }, [state]);

  // -------------------------------------------------------------------------
  // Derived selectors (only valid once state is loaded)
  // -------------------------------------------------------------------------
  const projects = state?.projects ?? [];
  const researchesForActiveProject = useMemo(
    () => (state ? state.researches.filter((r) => r.projectId === state.activeProjectId) : []),
    [state],
  );
  const activeProject = useMemo(
    () => state?.projects.find((p) => p.id === state.activeProjectId) ?? state?.projects[0] ?? null,
    [state],
  );
  const activeResearch = useMemo(
    () =>
      state?.researches.find((r) => r.id === state.activeResearchId) ??
      researchesForActiveProject[0] ??
      null,
    [state, researchesForActiveProject],
  );

  // -------------------------------------------------------------------------
  // Mutators — local optimistic update + background API call.
  // -------------------------------------------------------------------------
  const setActiveProject = useCallback((id: string) => {
    setState((s) => {
      if (!s) return s;
      const project = s.projects.find((p) => p.id === id);
      if (!project) return s;
      const firstResearch = s.researches.find((r) => r.projectId === id);
      if (!firstResearch) return s;
      return { ...s, activeProjectId: id, activeResearchId: firstResearch.id };
    });
  }, []);

  const setActiveResearch = useCallback((id: string) => {
    setState((s) => {
      if (!s) return s;
      const research = s.researches.find((r) => r.id === id);
      if (!research) return s;
      return { ...s, activeProjectId: research.projectId, activeResearchId: research.id };
    });
  }, []);

  const createProject = useCallback((name?: string): Project => {
    // Synchronous return contract is part of the legacy API (callers use the
    // returned id immediately). We optimistically generate a temporary id
    // and reconcile with the server-assigned UUID once the POST resolves.
    const tempId = 'p_tmp_' + Math.random().toString(36).slice(2, 10);
    const tempResearchId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
    const finalName = name?.trim() || 'New project';
    const optimisticProject: Project = { id: tempId, name: finalName, createdAt: Date.now() };
    const optimisticResearch = createBlankResearch(tempId, 'Untitled research');
    optimisticResearch.id = tempResearchId;

    setState((s) =>
      s
        ? {
            projects: [...s.projects, optimisticProject],
            researches: [...s.researches, optimisticResearch],
            activeProjectId: tempId,
            activeResearchId: tempResearchId,
          }
        : s,
    );

    (async () => {
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: finalName }),
        });
        if (!res.ok) throw new Error(`POST /api/projects failed (${res.status})`);
        const { project, research } = (await res.json()) as {
          project: { id: string; name: string; createdAt: number };
          research: { id: string; projectId: string; name: string; createdAt: number };
        };
        setState((s) => {
          if (!s) return s;
          return {
            projects: s.projects.map((p) =>
              p.id === tempId ? { id: project.id, name: project.name, createdAt: project.createdAt } : p,
            ),
            researches: s.researches.map((r) =>
              r.id === tempResearchId
                ? {
                    ...r,
                    id: research.id,
                    projectId: research.projectId,
                    name: research.name,
                    createdAt: research.createdAt,
                  }
                : r.projectId === tempId
                  ? { ...r, projectId: research.projectId }
                  : r,
            ),
            activeProjectId: s.activeProjectId === tempId ? project.id : s.activeProjectId,
            activeResearchId: s.activeResearchId === tempResearchId ? research.id : s.activeResearchId,
          };
        });
      } catch (err) {
        console.error('[useWorkspace] createProject failed:', err);
      }
    })();

    return optimisticProject;
  }, []);

  const renameProject = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) =>
      s
        ? {
            ...s,
            projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
          }
        : s,
    );
    void fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch((err) => console.error('[useWorkspace] renameProject failed:', err));
  }, []);

  const deleteProject = useCallback((id: string) => {
    const previous = stateRef.current;
    if (!previous || previous.projects.length <= 1) return;
    const remainingProjects = previous.projects.filter((p) => p.id !== id);
    const remainingResearches = previous.researches.filter((r) => r.projectId !== id);
    const fallbackProject = remainingProjects[0]!;
    const fallbackResearch =
      remainingResearches.find((r) => r.projectId === fallbackProject.id) ??
      remainingResearches[0]!;
    setState({
      projects: remainingProjects,
      researches: remainingResearches,
      activeProjectId: fallbackProject.id,
      activeResearchId: fallbackResearch.id,
    });
    void fetch(`/api/projects/${id}`, { method: 'DELETE' }).catch((err) =>
      console.error('[useWorkspace] deleteProject failed:', err),
    );
  }, []);

  const createResearch = useCallback((name?: string, projectId?: string): Research => {
    const targetProjectId = projectId ?? stateRef.current?.activeProjectId;
    if (!targetProjectId) {
      // Should never happen — state is guaranteed non-null when consumers can
      // call this — but TS demands the guard.
      throw new Error('createResearch called without an active project');
    }
    const finalName = name?.trim() || 'Untitled research';
    const tempId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
    const optimistic = createBlankResearch(targetProjectId, finalName);
    optimistic.id = tempId;

    setState((s) =>
      s
        ? {
            ...s,
            researches: [...s.researches, optimistic],
            activeProjectId: targetProjectId,
            activeResearchId: tempId,
          }
        : s,
    );

    (async () => {
      try {
        const res = await fetch('/api/researches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: targetProjectId, name: finalName }),
        });
        if (!res.ok) throw new Error(`POST /api/researches failed (${res.status})`);
        const { research } = (await res.json()) as {
          research: { id: string; projectId: string; name: string; createdAt: number };
        };
        setState((s) => {
          if (!s) return s;
          return {
            ...s,
            researches: s.researches.map((r) =>
              r.id === tempId
                ? {
                    ...r,
                    id: research.id,
                    projectId: research.projectId,
                    name: research.name,
                    createdAt: research.createdAt,
                  }
                : r,
            ),
            activeResearchId: s.activeResearchId === tempId ? research.id : s.activeResearchId,
          };
        });
      } catch (err) {
        console.error('[useWorkspace] createResearch failed:', err);
      }
    })();

    return optimistic;
  }, []);

  const renameResearch = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => (r.id === id ? { ...r, name: trimmed } : r)),
          }
        : s,
    );
    void fetch(`/api/researches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch((err) => console.error('[useWorkspace] renameResearch failed:', err));
  }, []);

  const deleteResearch = useCallback((id: string) => {
    const previous = stateRef.current;
    if (!previous) return;
    const target = previous.researches.find((r) => r.id === id);
    if (!target) return;
    const projectId = target.projectId;
    const remaining = previous.researches.filter((r) => r.id !== id);
    const sameProject = remaining.filter((r) => r.projectId === projectId);

    if (sameProject.length === 0) {
      // Last research in this project — replace it with a fresh blank so the
      // UI never lands on an empty project. Optimistically swap with a temp
      // research, then reconcile against the server-created one.
      const tempId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
      const blank = createBlankResearch(projectId, 'Untitled research');
      blank.id = tempId;
      const nextResearches = [...remaining, blank];
      setState({
        ...previous,
        researches: nextResearches,
        activeResearchId: tempId,
      });

      (async () => {
        try {
          await fetch(`/api/researches/${id}`, { method: 'DELETE' });
          const res = await fetch('/api/researches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, name: 'Untitled research' }),
          });
          if (!res.ok) throw new Error(`POST /api/researches failed (${res.status})`);
          const { research } = (await res.json()) as {
            research: { id: string; projectId: string; name: string; createdAt: number };
          };
          setState((s) => {
            if (!s) return s;
            return {
              ...s,
              researches: s.researches.map((r) =>
                r.id === tempId
                  ? {
                      ...r,
                      id: research.id,
                      projectId: research.projectId,
                      name: research.name,
                      createdAt: research.createdAt,
                    }
                  : r,
              ),
              activeResearchId: s.activeResearchId === tempId ? research.id : s.activeResearchId,
            };
          });
        } catch (err) {
          console.error('[useWorkspace] deleteResearch (last) failed:', err);
        }
      })();
      return;
    }

    const nextActiveResearchId =
      previous.activeResearchId === id ? sameProject[0]!.id : previous.activeResearchId;
    setState({ ...previous, researches: remaining, activeResearchId: nextActiveResearchId });
    void fetch(`/api/researches/${id}`, { method: 'DELETE' }).catch((err) =>
      console.error('[useWorkspace] deleteResearch failed:', err),
    );
  }, []);

  const updateActiveResearch = useCallback((updater: (r: Research) => Research) => {
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => (r.id === s.activeResearchId ? updater(r) : r)),
          }
        : s,
    );
  }, []);

  if (!state || !activeProject || !activeResearch) {
    return null;
  }

  return {
    state,
    projects,
    researchesForActiveProject,
    activeProject,
    activeResearch,
    setActiveProject,
    setActiveResearch,
    createProject,
    renameProject,
    deleteProject,
    createResearch,
    renameResearch,
    deleteResearch,
    updateActiveResearch,
  };
}
