import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronRight,
  FlaskConical,
  Folder,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { Project, Research } from '../types';

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

interface ResearchNavProps {
  projects: Project[];
  allResearches: Research[];
  activeProject: Project;
  activeResearch: Research;
  onSelectProject: (id: string) => void;
  onSelectResearch: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onCreateResearch: () => void;
  onRenameResearch: (id: string, name: string) => void;
  onDeleteResearch: (id: string) => void;
}

const RAIL_NEW_KEY = 'cmd+n';

export function ResearchNav(props: ResearchNavProps) {
  const {
    projects,
    allResearches,
    activeProject,
    activeResearch,
    onSelectProject,
    onSelectResearch,
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onCreateResearch,
    onRenameResearch,
    onDeleteResearch,
  } = props;

  const [projectsOpen, setProjectsOpen] = useState(false);
  const totalResearches = allResearches.length;

  return (
    <nav aria-label="Research workspace">
      <ul className="space-y-0.5" role="list">
        <li>
          <button
            type="button"
            onClick={onCreateResearch}
            className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition text-left"
          >
            <span className="flex items-center justify-center w-5 h-5 text-[var(--ink-2)] group-hover:text-[var(--ink)]">
              <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="flex-1 text-[13.5px] font-medium text-[var(--ink)] leading-tight">New research</span>
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 h-5 rounded border border-[var(--line)] bg-[var(--surface-2)] text-[10.5px] text-[var(--ink-3)] font-mono">
              ⌘N
            </kbd>
            <span className="sr-only">{RAIL_NEW_KEY}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => setProjectsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={projectsOpen}
            title={`Browse ${projects.length} ${projects.length === 1 ? 'project' : 'projects'} · ${totalResearches} ${
              totalResearches === 1 ? 'research' : 'researches'
            }`}
            className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--surface-2)] transition text-left"
          >
            <span className="flex items-center justify-center w-5 h-5 text-[var(--ink-2)] group-hover:text-[var(--ink)]">
              <Folder size={14} strokeWidth={1.6} aria-hidden="true" />
            </span>
            <span className="flex-1 text-[13.5px] text-[var(--ink)] leading-tight">Projects</span>
            <span className="text-[10.5px] text-[var(--ink-3)] tabular-nums pr-0.5">{totalResearches}</span>
          </button>
        </li>
      </ul>

      <ProjectsPanel
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
        projects={projects}
        allResearches={allResearches}
        activeProject={activeProject}
        activeResearch={activeResearch}
        onSelectProject={(id) => {
          onSelectProject(id);
          setProjectsOpen(false);
        }}
        onSelectResearch={(id) => {
          onSelectResearch(id);
          setProjectsOpen(false);
        }}
        onCreateProject={onCreateProject}
        onRenameProject={onRenameProject}
        onDeleteProject={onDeleteProject}
        onCreateResearch={onCreateResearch}
        onRenameResearch={onRenameResearch}
        onDeleteResearch={onDeleteResearch}
      />
    </nav>
  );
}

interface ProjectsPanelProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  allResearches: Research[];
  activeProject: Project;
  activeResearch: Research;
  onSelectProject: (id: string) => void;
  onSelectResearch: (id: string) => void;
  onCreateProject: () => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onCreateResearch: () => void;
  onRenameResearch: (id: string, name: string) => void;
  onDeleteResearch: (id: string) => void;
}

type RenameTarget = { kind: 'project' | 'research'; id: string };

function ProjectsPanel(props: ProjectsPanelProps) {
  const {
    open,
    onClose,
    projects,
    allResearches,
    activeProject,
    activeResearch,
    onSelectProject,
    onSelectResearch,
    onCreateProject,
    onRenameProject,
    onDeleteProject,
    onCreateResearch,
    onRenameResearch,
    onDeleteResearch,
  } = props;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [draftName, setDraftName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setRename(null);
      setDraftName('');
      return;
    }
    // Expand every project by default so all collections are visible at once.
    setExpanded(() => Object.fromEntries(projects.map((p) => [p.id, true])));
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, projects, onClose]);

  useEffect(() => {
    if (rename) renameInputRef.current?.select();
  }, [rename]);

  const startRename = (kind: RenameTarget['kind'], id: string, current: string) => {
    setRename({ kind, id });
    setDraftName(current);
  };
  const commitRename = () => {
    if (!rename) return;
    const name = draftName.trim();
    if (name) {
      if (rename.kind === 'project') onRenameProject(rename.id, name);
      else onRenameResearch(rename.id, name);
    }
    setRename(null);
    setDraftName('');
  };
  const cancelRename = () => {
    setRename(null);
    setDraftName('');
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };
  const requestDeleteProject = (project: Project) => {
    if (projects.length <= 1) return;
    if (window.confirm(`Delete project “${project.name}” and all its research sessions?`)) {
      onDeleteProject(project.id);
    }
  };
  const requestDeleteResearch = (research: Research) => {
    if (window.confirm(`Delete research “${research.name}”?`)) {
      onDeleteResearch(research.id);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-[var(--overlay)] backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[560px] max-h-[78vh] flex flex-col bg-[var(--surface)] rounded-2xl border border-[var(--line)] shadow-[var(--shadow-pop)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-panel-title"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line-2)]">
          <div>
            <h3 id="projects-panel-title" className="text-[15px] font-semibold text-[var(--ink)]">
              Projects
            </h3>
            <p className="text-[12px] text-[var(--ink-3)] mt-0.5">
              Each project is a collection of your research sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="btn-ghost flex items-center justify-center w-8 h-8 text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 min-h-0 scroll-y px-3 py-3">
          {projects.map((project) => {
            const isActiveProject = project.id === activeProject.id;
            const projectResearches = allResearches
              .filter((r) => r.projectId === project.id)
              .sort((a, b) => b.createdAt - a.createdAt);
            const isOpen = expanded[project.id] ?? false;
            const isRenamingProject = rename?.kind === 'project' && rename.id === project.id;

            return (
              <div key={project.id} className="mb-1">
                <div
                  className={`group/project flex items-center gap-1.5 rounded-lg pl-1 pr-2 py-1.5 transition ${
                    isActiveProject ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setExpanded((c) => ({ ...c, [project.id]: !isOpen }))}
                    aria-label={isOpen ? 'Collapse project' : 'Expand project'}
                    className="flex items-center justify-center w-5 h-5 text-[var(--ink-3)] hover:text-[var(--ink-2)] shrink-0"
                  >
                    <span className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                      <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                  </button>
                  <span className="flex items-center justify-center w-5 h-5 text-[var(--accent-ink)] shrink-0">
                    <Folder size={13} strokeWidth={1.6} aria-hidden="true" />
                  </span>
                  {isRenamingProject ? (
                    <input
                      ref={renameInputRef}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={onRenameKey}
                      className="flex-1 min-w-0 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[13px] text-[var(--ink)] focus-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelectProject(project.id)}
                      className="flex-1 min-w-0 flex items-center gap-2 text-left"
                    >
                      <span className="text-[13px] font-medium text-[var(--ink)] truncate">{project.name}</span>
                      <span className="text-[11px] text-[var(--ink-3)] tabular-nums shrink-0">
                        {projectResearches.length}
                      </span>
                      {isActiveProject && (
                        <span className="text-[var(--success-ink)] shrink-0" aria-label="Active project">
                          <Check size={12} strokeWidth={2} aria-hidden="true" />
                        </span>
                      )}
                    </button>
                  )}
                  {!isRenamingProject && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover/project:opacity-100 focus-within:opacity-100 transition">
                      <button
                        type="button"
                        onClick={() => startRename('project', project.id, project.name)}
                        aria-label="Rename project"
                        title="Rename"
                        className="btn-ghost flex items-center justify-center w-6 h-6 text-[var(--ink-3)] hover:text-[var(--ink)]"
                      >
                        <Pencil size={12} strokeWidth={1.6} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => requestDeleteProject(project)}
                        disabled={projects.length <= 1}
                        aria-label="Delete project"
                        title={projects.length <= 1 ? 'Need at least one project' : 'Delete'}
                        className="btn-ghost flex items-center justify-center w-6 h-6 text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={12} strokeWidth={1.6} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>

                {isOpen && (
                  <ul className="mt-0.5 ml-7 mb-1.5 space-y-0.5 border-l border-[var(--line-2)] pl-2" role="list">
                    {projectResearches.map((r) => {
                      const isActiveResearch = r.id === activeResearch.id;
                      const isRenamingResearch = rename?.kind === 'research' && rename.id === r.id;
                      const sourcesCount = r.sources.length;
                      return (
                        <li
                          key={r.id}
                          className={`group/research flex items-center gap-2 rounded-md pl-1 pr-1.5 py-1.5 transition ${
                            isActiveResearch ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                          }`}
                        >
                          {isRenamingResearch ? (
                            <input
                              ref={renameInputRef}
                              value={draftName}
                              onChange={(e) => setDraftName(e.target.value)}
                              onBlur={commitRename}
                              onKeyDown={onRenameKey}
                              className="flex-1 min-w-0 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[12.5px] text-[var(--ink)] focus-ring"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => onSelectResearch(r.id)}
                              className="flex-1 min-w-0 flex items-center gap-2 text-left"
                            >
                              <span className="flex items-center justify-center w-4 h-4 text-[var(--accent-ink)] shrink-0">
                                <FlaskConical size={11} strokeWidth={1.6} aria-hidden="true" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[12.5px] text-[var(--ink)] truncate leading-tight">
                                  {r.name}
                                </span>
                                <span className="block text-[10.5px] text-[var(--ink-3)] leading-tight">
                                  {dateLabel(r.createdAt)} · {sourcesCount} {sourcesCount === 1 ? 'source' : 'sources'}
                                </span>
                              </span>
                              {isActiveResearch && (
                                <span className="text-[var(--success-ink)] shrink-0" aria-label="Active research">
                                  <Check size={12} strokeWidth={2} aria-hidden="true" />
                                </span>
                              )}
                            </button>
                          )}
                          {!isRenamingResearch && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover/research:opacity-100 focus-within:opacity-100 transition">
                              <button
                                type="button"
                                onClick={() => startRename('research', r.id, r.name)}
                                aria-label="Rename research"
                                title="Rename"
                                className="btn-ghost flex items-center justify-center w-6 h-6 text-[var(--ink-3)] hover:text-[var(--ink)]"
                              >
                                <Pencil size={12} strokeWidth={1.6} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => requestDeleteResearch(r)}
                                aria-label="Delete research"
                                title="Delete"
                                className="btn-ghost flex items-center justify-center w-6 h-6 text-[var(--ink-3)] hover:text-[var(--ink)]"
                              >
                                <Trash2 size={12} strokeWidth={1.6} aria-hidden="true" />
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                    {projectResearches.length === 0 && (
                      <li className="px-2 py-1.5 text-[11.5px] text-[var(--ink-3)]">No research sessions yet.</li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-[var(--line-2)] flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onCreateProject}
            className="btn-ghost inline-flex items-center gap-1.5 px-2.5 h-8 text-[12.5px] text-[var(--ink-2)] hover:text-[var(--ink)]"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            New project
          </button>
          <button
            type="button"
            onClick={onCreateResearch}
            className="btn-primary inline-flex items-center gap-1.5 px-3 h-8 text-[12.5px] font-medium"
          >
            <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
            New research in {activeProject.name}
          </button>
        </div>
      </div>
    </div>
  );
}
