import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBlankResearch, seedWorkspace, uid } from '../data/workspace';
import type { Project, Research, WorkspaceState } from '../types';

const STORAGE_KEY = 'aeoagent.workspace.v1';

function isValidWorkspace(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<WorkspaceState>;
  return (
    Array.isArray(v.projects) &&
    Array.isArray(v.researches) &&
    typeof v.activeProjectId === 'string' &&
    typeof v.activeResearchId === 'string'
  );
}

function loadWorkspace(): WorkspaceState {
  if (typeof window === 'undefined') return seedWorkspace();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedWorkspace();
    const parsed: unknown = JSON.parse(raw);
    if (!isValidWorkspace(parsed)) return seedWorkspace();
    return heal(parsed);
  } catch {
    return seedWorkspace();
  }
}

function heal(state: WorkspaceState): WorkspaceState {
  if (state.projects.length === 0) return seedWorkspace();
  const projectIds = new Set(state.projects.map((p) => p.id));
  const researches = state.researches.filter((r) => projectIds.has(r.projectId));
  let activeProjectId = projectIds.has(state.activeProjectId) ? state.activeProjectId : state.projects[0]!.id;
  let researchesInActive = researches.filter((r) => r.projectId === activeProjectId);
  let next = researches;
  if (researchesInActive.length === 0) {
    const blank = createBlankResearch(activeProjectId, 'Untitled research');
    next = [...researches, blank];
    researchesInActive = [blank];
  }
  const activeResearchId = researchesInActive.find((r) => r.id === state.activeResearchId)?.id ?? researchesInActive[0]!.id;
  return { projects: state.projects, researches: next, activeProjectId, activeResearchId };
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

export function useWorkspace(): UseWorkspaceResult {
  const [state, setState] = useState<WorkspaceState>(loadWorkspace);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore storage errors (private mode, quota)
    }
  }, [state]);

  const projects = state.projects;
  const researchesForActiveProject = useMemo(
    () => state.researches.filter((r) => r.projectId === state.activeProjectId),
    [state.researches, state.activeProjectId]
  );

  const activeProject = useMemo(
    () => state.projects.find((p) => p.id === state.activeProjectId) ?? state.projects[0]!,
    [state.projects, state.activeProjectId]
  );

  const activeResearch = useMemo(
    () =>
      state.researches.find((r) => r.id === state.activeResearchId) ??
      researchesForActiveProject[0]!,
    [state.researches, state.activeResearchId, researchesForActiveProject]
  );

  const setActiveProject = useCallback((id: string) => {
    setState((s) => {
      if (!s.projects.find((p) => p.id === id)) return s;
      const firstResearch = s.researches.find((r) => r.projectId === id);
      if (!firstResearch) {
        const blank = createBlankResearch(id, 'Untitled research');
        return {
          ...s,
          researches: [...s.researches, blank],
          activeProjectId: id,
          activeResearchId: blank.id,
        };
      }
      return { ...s, activeProjectId: id, activeResearchId: firstResearch.id };
    });
  }, []);

  const setActiveResearch = useCallback((id: string) => {
    setState((s) => {
      const r = s.researches.find((x) => x.id === id);
      if (!r) return s;
      return { ...s, activeProjectId: r.projectId, activeResearchId: r.id };
    });
  }, []);

  const createProject = useCallback((name?: string) => {
    const project: Project = { id: uid('p'), name: (name?.trim() || 'New project'), createdAt: Date.now() };
    const research = createBlankResearch(project.id, 'Untitled research');
    setState((s) => ({
      ...s,
      projects: [...s.projects, project],
      researches: [...s.researches, research],
      activeProjectId: project.id,
      activeResearchId: research.id,
    }));
    return project;
  }, []);

  const renameProject = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) => ({
      ...s,
      projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
    }));
  }, []);

  const deleteProject = useCallback((id: string) => {
    setState((s) => {
      if (s.projects.length <= 1) return s;
      const remainingProjects = s.projects.filter((p) => p.id !== id);
      const remainingResearches = s.researches.filter((r) => r.projectId !== id);
      const fallbackProject = remainingProjects[0]!;
      const fallbackResearch =
        remainingResearches.find((r) => r.projectId === fallbackProject.id) ??
        createBlankResearch(fallbackProject.id, 'Untitled research');
      const researches = remainingResearches.includes(fallbackResearch)
        ? remainingResearches
        : [...remainingResearches, fallbackResearch];
      return {
        projects: remainingProjects,
        researches,
        activeProjectId: fallbackProject.id,
        activeResearchId: fallbackResearch.id,
      };
    });
  }, []);

  const createResearch = useCallback((name?: string, projectId?: string) => {
    let research!: Research;
    setState((s) => {
      const targetProjectId = projectId ?? s.activeProjectId;
      research = createBlankResearch(targetProjectId, name?.trim() || 'Untitled research');
      return {
        ...s,
        researches: [...s.researches, research],
        activeProjectId: targetProjectId,
        activeResearchId: research.id,
      };
    });
    return research;
  }, []);

  const renameResearch = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) => ({
      ...s,
      researches: s.researches.map((r) => (r.id === id ? { ...r, name: trimmed } : r)),
    }));
  }, []);

  const deleteResearch = useCallback((id: string) => {
    setState((s) => {
      const target = s.researches.find((r) => r.id === id);
      if (!target) return s;
      const projectId = target.projectId;
      const remaining = s.researches.filter((r) => r.id !== id);
      const inSameProject = remaining.filter((r) => r.projectId === projectId);
      let nextResearches = remaining;
      let nextActiveResearchId = s.activeResearchId;
      if (inSameProject.length === 0) {
        const blank = createBlankResearch(projectId, 'Untitled research');
        nextResearches = [...remaining, blank];
        nextActiveResearchId = blank.id;
      } else if (s.activeResearchId === id) {
        nextActiveResearchId = inSameProject[0]!.id;
      }
      return { ...s, researches: nextResearches, activeResearchId: nextActiveResearchId };
    });
  }, []);

  const updateActiveResearch = useCallback((updater: (r: Research) => Research) => {
    setState((s) => ({
      ...s,
      researches: s.researches.map((r) => (r.id === s.activeResearchId ? updater(r) : r)),
    }));
  }, []);

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
