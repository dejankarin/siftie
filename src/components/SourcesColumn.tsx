import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { SOURCE_TYPES } from '../data/mock';
import type { CouncilDepth, Source } from '../types';
import { CouncilRunButton } from './CouncilRunButton';
import type { AddTab } from './AddSourceModal';

type ViewMode = 'compact' | 'detailed';
type SortMode = 'recent' | 'type' | 'title';

const VIEW_STORAGE_KEY = 'siftie.sourcesView';

interface IconProps {
  size?: number;
}

function PlusIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function SearchIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function EditIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function TrashIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
function RenamePencilIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function CompactIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function DetailedIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
    </svg>
  );
}

function TypeChip({ type, dense = false }: { type: Source['type']; dense?: boolean }) {
  const t = SOURCE_TYPES[type];
  return (
    <span
      className={`chip ${dense ? '!px-2 !py-[2px] !text-[10.5px]' : ''}`}
      style={{
        background: `color-mix(in oklch, ${t.dot} 14%, transparent)`,
        color: t.dot,
      }}
    >
      {t.label}
    </span>
  );
}

function AddMenu({ onPick }: { onPick: (tab: AddTab) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const items: { id: AddTab; label: string; hint: string }[] = [
    { id: 'pdf', label: 'Upload PDF', hint: 'Research decks, reports, briefs' },
    { id: 'url', label: 'Paste URL', hint: 'Site, article, brand' },
    { id: 'doc', label: 'Upload Word doc', hint: 'DOC or DOCX files' },
    { id: 'md', label: 'Upload .md', hint: 'Markdown notes or docs' },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-primary inline-flex items-center gap-1.5 px-3 h-8 text-[12.5px] font-medium"
      >
        <PlusIcon />
        Add source
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-[240px] rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow-pop)] p-1.5"
        >
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(it.id);
              }}
              className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--surface-2)] flex flex-col"
            >
              <span className="text-[12.5px] font-medium text-[var(--ink)] leading-tight">{it.label}</span>
              <span className="text-[11px] text-[var(--ink-3)] mt-0.5 leading-snug">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div role="tablist" aria-label="Source view" className="flex items-center bg-[var(--surface-2)] rounded-lg p-0.5">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'compact'}
        onClick={() => onChange('compact')}
        title="Compact view"
        className={`flex items-center justify-center w-7 h-6 rounded-md transition ${
          value === 'compact' ? 'bg-[var(--surface)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-3)] hover:text-[var(--ink-2)]'
        }`}
      >
        <CompactIcon />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'detailed'}
        onClick={() => onChange('detailed')}
        title="Detailed view"
        className={`flex items-center justify-center w-7 h-6 rounded-md transition ${
          value === 'detailed' ? 'bg-[var(--surface)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-3)] hover:text-[var(--ink-2)]'
        }`}
      >
        <DetailedIcon />
      </button>
    </div>
  );
}

function CompactRow({
  source,
  analyzing,
  onEdit,
  onRemove,
}: {
  source: Source;
  analyzing: boolean;
  onEdit: (s: Source) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="group flex items-center gap-2.5 px-3 py-2 rounded-lg border border-transparent hover:border-[var(--line)] hover:bg-[var(--surface-2)] transition">
      <TypeChip type={source.type} dense />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="text-[13px] font-medium leading-tight text-[var(--ink)] truncate">{source.title}</h4>
          {analyzing && (
            <span className="text-[10.5px] text-[var(--ink-3)] flex items-center gap-1 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse"></span>
              Analyzing
            </span>
          )}
        </div>
        <p className="text-[11px] text-[var(--ink-3)] mt-0.5 truncate">{source.meta}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <button
          type="button"
          onClick={() => onEdit(source)}
          aria-label={`Edit ${source.title}`}
          title="Edit"
          className="btn-ghost flex items-center justify-center w-7 h-7 text-[var(--ink-3)] hover:text-[var(--ink)]"
        >
          <EditIcon />
        </button>
        <button
          type="button"
          onClick={() => onRemove(source.id)}
          aria-label={`Remove ${source.title}`}
          title="Remove"
          className="btn-ghost flex items-center justify-center w-7 h-7 text-[var(--ink-3)] hover:text-[var(--ink)]"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function DetailedCard({
  source,
  analyzing,
  onEdit,
  onRemove,
}: {
  source: Source;
  analyzing: boolean;
  onEdit: (s: Source) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="src-card p-3.5 group relative">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <TypeChip type={source.type} />
            {analyzing && (
              <span className="text-[10.5px] text-[var(--ink-3)] flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse"></span>
                Analyzing
              </span>
            )}
          </div>
          <h4 className="mt-1.5 text-[13.5px] font-medium leading-snug text-[var(--ink)] truncate">{source.title}</h4>
          <p className="text-[11.5px] text-[var(--ink-3)] mt-0.5">{source.meta}</p>
          <p className="text-[12.5px] text-[var(--ink-2)] mt-2 leading-relaxed line-clamp-3">{source.snippet}</p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
          <button
            type="button"
            onClick={() => onEdit(source)}
            aria-label={`Edit ${source.title}`}
            title="Edit"
            className="btn-ghost flex items-center justify-center w-7 h-7 text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            <EditIcon />
          </button>
          <button
            type="button"
            onClick={() => onRemove(source.id)}
            aria-label={`Remove ${source.title}`}
            title="Remove"
            className="btn-ghost flex items-center justify-center w-7 h-7 text-[var(--ink-3)] hover:text-[var(--ink)]"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SourcesColumnProps {
  sources: Source[];
  onRemoveSource: (id: string) => Promise<void>;
  onReindexSource: (id: string) => Promise<void>;
  onAdd: (initialTab?: AddTab) => void;
  onEdit: (source: Source) => void;
  analyzingId: string | null;
  navSlot?: ReactNode;
  researchName: string;
  onRenameResearch: (name: string) => void;
  renameOnMount?: boolean;
  onRenameConsumed?: () => void;
  /** Council run controls (also row-persisted depth). */
  councilDepth: CouncilDepth;
  onCouncilDepthChange: (depth: CouncilDepth) => void;
  onRunResearch: () => void;
  onCancelResearch: () => void;
  runStatus: 'pending' | 'running' | 'complete' | 'failed' | null | undefined;
  canRunCouncil: boolean;
}

const TYPE_ORDER: Record<Source['type'], number> = { pdf: 0, url: 1, doc: 2, md: 3 };

function getInitialView(): ViewMode {
  if (typeof window === 'undefined') return 'detailed';
  const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return stored === 'compact' || stored === 'detailed' ? stored : 'detailed';
}

export function SourcesColumn({
  sources,
  onRemoveSource,
  onReindexSource,
  onAdd,
  onEdit,
  analyzingId,
  navSlot,
  researchName,
  onRenameResearch,
  renameOnMount = false,
  onRenameConsumed,
  councilDepth,
  onCouncilDepthChange,
  onRunResearch,
  onCancelResearch,
  runStatus,
  canRunCouncil,
}: SourcesColumnProps) {
  const [view, setView] = useState<ViewMode>(getInitialView);
  const [sort, setSort] = useState<SortMode>('recent');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState(renameOnMount);
  const [draftName, setDraftName] = useState(researchName);
  const [reindexing, setReindexing] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  }, [view]);

  useEffect(() => {
    if (renaming) {
      setDraftName(researchName);
      const t = window.setTimeout(() => renameInputRef.current?.select(), 0);
      return () => window.clearTimeout(t);
    }
    return;
  }, [renaming, researchName]);

  useEffect(() => {
    if (renameOnMount) onRenameConsumed?.();
  }, [renameOnMount, onRenameConsumed]);

  const startRename = () => {
    setDraftName(researchName);
    setRenaming(true);
  };
  const commitRename = () => {
    const next = draftName.trim();
    if (next && next !== researchName) onRenameResearch(next);
    setRenaming(false);
  };
  const cancelRename = () => {
    setRenaming(false);
    setDraftName(researchName);
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

  const removeSource = async (id: string) => {
    const target = sources.find((s) => s.id === id);
    if (!target) return;
    if (window.confirm(`Remove "${target.title}"? The agent will stop using this source.`)) {
      await onRemoveSource(id);
    }
  };

  const reindexAll = async () => {
    const candidates = sources.filter((s) => (s.type === 'url' || s.type === 'md') && !s.pending);
    if (candidates.length === 0) {
      window.alert('Re-index is currently available for URL and Markdown sources. Re-upload PDFs or Word docs to refresh them.');
      return;
    }
    setReindexing(true);
    try {
      for (const source of candidates) {
        await onReindexSource(source.id);
      }
    } finally {
      setReindexing(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = q
      ? sources.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.snippet.toLowerCase().includes(q) ||
            s.meta.toLowerCase().includes(q)
        )
      : sources.slice();

    if (sort === 'type') {
      arr = arr.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.title.localeCompare(b.title));
    } else if (sort === 'title') {
      arr = arr.sort((a, b) => a.title.localeCompare(b.title));
    }
    return arr;
  }, [sources, query, sort]);

  const totalWords = useMemo(
    () => sources.reduce((sum, source) => sum + (source.contextDoc?.words ?? 0), 0),
    [sources],
  );

  return (
    <section className="flex flex-col h-full min-h-0">
      {navSlot && <div className="px-4 pt-4 pb-2">{navSlot}</div>}
      {navSlot && <div className="mx-4 my-1 h-px bg-[var(--line)]" aria-hidden="true" />}
      <header className={`px-5 ${navSlot ? 'pt-3' : 'pt-5'} pb-3`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1 group/research-name">
            {renaming ? (
              <input
                ref={renameInputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={onRenameKey}
                aria-label="Research name"
                placeholder="Name this research"
                className="flex-1 min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[15px] font-semibold tracking-tight text-[var(--ink)] focus-ring"
              />
            ) : (
              <>
                <h2
                  className="text-[15px] font-semibold tracking-tight text-[var(--ink)] truncate cursor-text"
                  onDoubleClick={startRename}
                  title="Double-click to rename"
                >
                  {researchName}
                </h2>
                <button
                  type="button"
                  onClick={startRename}
                  aria-label="Rename research"
                  title="Rename research"
                  className="btn-ghost flex items-center justify-center w-6 h-6 text-[var(--ink-3)] hover:text-[var(--ink)] opacity-0 group-hover/research-name:opacity-100 focus-within:opacity-100 transition shrink-0"
                >
                  <RenamePencilIcon />
                </button>
              </>
            )}
          </div>
          <AddMenu onPick={onAdd} />
        </div>
      </header>

      <div className="px-5 pb-2.5 space-y-2">
        <label className="relative block">
          <span className="sr-only">Search sources</span>
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-3)] pointer-events-none">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sources…"
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] pl-8 pr-3 h-8 text-[12.5px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]"
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
              aria-label="Sort sources"
              className="appearance-none pill bg-[var(--surface)] text-[11.5px] text-[var(--ink-2)] pl-2.5 pr-7 h-7 cursor-pointer"
            >
              <option value="recent">Recent</option>
              <option value="type">Type</option>
              <option value="title">Title</option>
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink-3)] text-[10px]">▾</span>
          </div>
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {sources.length > 0 && (
        <div className="mx-5 mb-3 px-3 py-2 rounded-xl bg-[var(--surface-2)] flex items-center justify-between text-[11.5px] text-[var(--ink-3)]">
          <span>
            <span className="text-[var(--ink-2)] font-medium">{sources.length}</span> sources ·{' '}
            <span className="text-[var(--ink-2)] font-medium">{totalWords.toLocaleString()}</span> words indexed
          </span>
          <button
            type="button"
            onClick={reindexAll}
            disabled={reindexing || sources.some((s) => s.pending)}
            className="text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reindexing ? 'Re-indexing…' : 'Re-index'}
          </button>
        </div>
      )}

      <div className={`flex-1 min-h-0 scroll-y px-3 pb-3 ${view === 'compact' ? 'space-y-1' : 'space-y-2.5 px-5'}`}>
        {sources.length === 0 ? (
          <div className="mx-2 border border-dashed border-[var(--line)] rounded-2xl p-8 text-center">
            <p className="text-[13px] font-medium text-[var(--ink)]">Upload contents for this research</p>
            <p className="text-[12px] text-[var(--ink-3)] mt-1">
              Brand briefs, competitor URLs, customer interviews — anything the agent should reason on.
            </p>
            <button
              type="button"
              onClick={() => onAdd('pdf')}
              className="btn-primary mt-3 inline-flex items-center gap-1.5 px-3 h-8 text-[12.5px] font-medium"
            >
              <PlusIcon />
              Add source
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="mx-2 border border-dashed border-[var(--line)] rounded-xl p-6 text-center">
            <p className="text-[12.5px] text-[var(--ink-2)]">No sources match “{query}”.</p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="btn-ghost mt-2 px-2.5 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              Clear search
            </button>
          </div>
        ) : view === 'compact' ? (
          filtered.map((s) => (
            <CompactRow key={s.id} source={s} analyzing={s.pending || s.id === analyzingId} onEdit={onEdit} onRemove={removeSource} />
          ))
        ) : (
          filtered.map((s) => (
            <DetailedCard key={s.id} source={s} analyzing={s.pending || s.id === analyzingId} onEdit={onEdit} onRemove={removeSource} />
          ))
        )}
      </div>

      {sources.length > 0 && (
        <div className="shrink-0 px-5 pb-5 pt-1 border-t border-[var(--line-2)] mt-auto">
          <p className="text-[12px] text-[var(--ink-2)] leading-snug mb-3">
            Import your indexed sources into the Council chat and start the run — no need to type a message first.
          </p>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
            <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--ink-3)] min-w-0 sm:flex-1">
              <span className="shrink-0">Council</span>
              <select
                value={councilDepth}
                onChange={(e) => onCouncilDepthChange(e.target.value as CouncilDepth)}
                disabled={runStatus === 'running' || runStatus === 'pending'}
                className="min-w-0 flex-1 appearance-none pill bg-[var(--surface)] text-[11.5px] text-[var(--ink-2)] pl-2 pr-2.5 py-0.5 cursor-pointer disabled:opacity-50"
                aria-label="Council depth"
              >
                <option value="quick">Quick · 3 reviewers</option>
                <option value="standard">Standard · 4 reviewers</option>
              </select>
            </label>
            <CouncilRunButton
              onClick={onRunResearch}
              onCancel={onCancelResearch}
              status={runStatus}
              disabled={!canRunCouncil}
              primaryLabel="Send sources to Council"
              className="w-full sm:w-auto min-h-8 sm:shrink-0 justify-center"
            />
          </div>
        </div>
      )}
    </section>
  );
}
