import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import posthog from 'posthog-js';
import { ChevronDown, FileDown, RefreshCw, Sparkles, X } from 'lucide-react';
import { PROMPT_FILTERS } from '../data/mock';
import type { PortfolioPrompt, PromptCluster, PromptFilter, RunChannel } from '../types';

// ---------------------------------------------------------------------------
// Tiny presentational helpers — kept colocated with the column so a single
// file owns the prompts UI surface.
// ---------------------------------------------------------------------------

function ClusterDot({ cluster }: { cluster: PortfolioPrompt['cluster'] | 'All' }) {
  if (cluster === 'All') return null;
  const map: Record<PromptCluster, string> = {
    Category: 'oklch(60% 0.10 240)',
    Persona: 'oklch(58% 0.12 30)',
    Comparison: 'oklch(55% 0.10 300)',
  };
  return (
    <span
      className="w-1.5 h-1.5 rounded-full inline-block"
      style={{ background: map[cluster] || 'gray' }}
    />
  );
}

/**
 * One filled / unfilled cell per Peec model channel — `channels.length`
 * cells, with the first `hits` filled. Each cell carries the channel's
 * human-readable description as its `title`, so hovering surfaces the
 * channel name (e.g. "OpenAI gpt-5", "Perplexity sonar-pro").
 *
 * When `peecSkipped` (or the run pre-dates Session 7 channel capture)
 * the column renders the no-Peec banner above this and the bar reads
 * "0 / 0" with a muted explanatory tooltip.
 */
function HitsBar({
  hits,
  channels,
  peecSkipped,
}: {
  hits: number;
  channels: RunChannel[];
  peecSkipped: boolean;
}) {
  // Empty state — older runs / Peec-skipped runs render 3 muted cells so
  // the row layout doesn't shift. The parent banner explains *why*.
  if (channels.length === 0) {
    return (
      <span
        className="flex items-end gap-px"
        title={
          peecSkipped
            ? 'Peec was skipped — add a key in Settings to see live channel hits.'
            : 'No channel data yet for this run.'
        }
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <span key={i} className="w-1 h-3.5 rounded-[2px] bg-[var(--surface-3)]" />
        ))}
      </span>
    );
  }

  // Cap the *displayed* hits to channels.length so a stale prompt with
  // hits > channels (e.g. a run completed against a smaller channel
  // set, then a Test refresh against a larger one) still renders
  // sensibly. The numeric tooltip always shows the real count.
  const filledCount = Math.min(Math.max(hits, 0), channels.length);
  return (
    <span
      className="flex items-end gap-px"
      title={`${hits} / ${channels.length} channels surfaced your brand`}
    >
      {channels.map((channel, i) => (
        <span
          key={channel.id}
          title={channel.description}
          className={`w-1 h-3.5 rounded-[2px] ${
            i < filledCount ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
          }`}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PromptCard
// ---------------------------------------------------------------------------

function PromptCard({
  prompt,
  onCopy,
  isNew,
  channels,
  peecSkipped,
  position,
}: {
  prompt: PortfolioPrompt;
  onCopy: (prompt: PortfolioPrompt, position: number) => void;
  isNew: boolean;
  channels: RunChannel[];
  peecSkipped: boolean;
  /** 1-based index inside the visible filtered/sorted list. */
  position: number;
}) {
  const [copied, setCopied] = useState(false);
  const [showNote, setShowNote] = useState(false);

  const doCopy = (e: MouseEvent) => {
    e.stopPropagation();
    onCopy(prompt, position);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={`src-card p-3.5 ${isNew ? 'anim-slide-up' : ''}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-3)] min-w-0">
          <ClusterDot cluster={prompt.cluster} />
          <span className="font-medium text-[var(--ink-2)]">{prompt.cluster}</span>
          <span className="text-[var(--ink-3)]">·</span>
          <span>{prompt.intent} intent</span>
        </div>
        <HitsBar hits={prompt.hits} channels={channels} peecSkipped={peecSkipped} />
      </div>
      <p className="text-[13.5px] leading-[1.5] text-[var(--ink)]">
        <span className="text-[var(--ink-3)] font-mono text-[11px] mr-1.5">"</span>
        {prompt.text}
        <span className="text-[var(--ink-3)] font-mono text-[11px] ml-0.5">"</span>
      </p>
      {prompt.councilNote && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowNote((v) => !v);
            }}
            className="text-[11px] text-[var(--ink-3)] hover:text-[var(--ink-2)] flex items-center gap-1"
          >
            <span>{showNote ? '−' : '+'}</span>
            <span>Council rationale</span>
          </button>
          {showNote && (
            <p className="mt-1.5 text-[12px] leading-[1.5] text-[var(--ink-2)] italic border-l-2 border-[var(--accent)] pl-2.5">
              {prompt.councilNote}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[var(--line-2)]">
        <button
          type="button"
          onClick={doCopy}
          className="text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)] btn-ghost px-1.5 py-1 -ml-1.5"
        >
          {copied ? <span className="text-[var(--success-ink)]">Copied</span> : <span>Copy</span>}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers shared between the main list, the drawer, and the surface-rate card
// ---------------------------------------------------------------------------

function sortPrompts(
  prompts: PortfolioPrompt[],
  sort: 'Cluster' | 'Intent' | 'Hits',
): PortfolioPrompt[] {
  if (sort === 'Intent') {
    const order: Record<PortfolioPrompt['intent'], number> = { High: 0, Med: 1, Low: 2 };
    return [...prompts].sort((a, b) => order[a.intent] - order[b.intent]);
  }
  if (sort === 'Hits') {
    return [...prompts].sort((a, b) => b.hits - a.hits);
  }
  const order: Record<PromptCluster, number> = { Category: 0, Persona: 1, Comparison: 2 };
  return [...prompts].sort((a, b) => order[a.cluster] - order[b.cluster]);
}

const MAX_VISIBLE = 12;
const PEEC_BANNER_DISMISS_KEY_PREFIX = 'siftie.peec.bannerDismissed.';

// ---------------------------------------------------------------------------
// Drawer + popover — small bespoke components rather than a UI dependency
// to keep the bundle lean and the styling consistent with the rest of the
// column.
// ---------------------------------------------------------------------------

/**
 * Bottom sheet showing the full council-reviewed list. Each prompt's
 * council rationale is collapsible via a native `<details>` element
 * (no extra a11y wiring required). Backdrop and Esc dismiss.
 */
function ShowAllDrawer({
  open,
  onClose,
  prompts,
  channels,
  peecSkipped,
  onExportCsv,
  exporting,
  canExport,
}: {
  open: boolean;
  onClose: () => void;
  prompts: PortfolioPrompt[];
  channels: RunChannel[];
  peecSkipped: boolean;
  onExportCsv: () => void;
  exporting: boolean;
  canExport: boolean;
}) {
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-30" role="dialog" aria-modal="true" aria-labelledby={labelId}>
      <div
        className="absolute inset-0 bg-black/30 anim-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-x-0 bottom-0 top-12 bg-[var(--surface)] border-t border-[var(--line)] rounded-t-2xl shadow-xl flex flex-col anim-slide-up">
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--line-2)]">
          <div className="min-w-0 flex-1">
            <h3 id={labelId} className="text-[14px] font-semibold tracking-tight text-[var(--ink)]">
              All {prompts.length} prompts
            </h3>
            <p className="text-[11.5px] text-[var(--ink-3)] mt-0.5">
              Council rationale on every row. Expand the details to see why each prompt made the cut.
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onExportCsv}
              disabled={!canExport || exporting}
              className="btn-ghost px-2 py-1 rounded-md text-[11.5px] text-[var(--ink-2)] hover:text-[var(--ink)] flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              title={canExport ? 'Export prompt portfolio as CSV' : 'Available once your run finishes.'}
            >
              {exporting ? (
                <>
                  <span className="w-2.5 h-2.5 rounded-full border border-[var(--accent)] border-t-transparent animate-spin" />
                  <span>Exporting…</span>
                </>
              ) : (
                <>
                  <FileDown size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>Export CSV</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn-ghost p-1.5 rounded-full text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              <X size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="flex-1 min-h-0 scroll-y px-5 py-3 space-y-2.5">
          {prompts.map((p) => (
            <details
              key={p.id}
              className="src-card p-3.5 group"
            >
              <summary className="cursor-pointer list-none flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-3)] mb-1.5">
                    <ClusterDot cluster={p.cluster} />
                    <span className="font-medium text-[var(--ink-2)]">{p.cluster}</span>
                    <span className="text-[var(--ink-3)]">·</span>
                    <span>{p.intent} intent</span>
                  </div>
                  <p className="text-[13px] leading-[1.5] text-[var(--ink)]">{p.text}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <HitsBar hits={p.hits} channels={channels} peecSkipped={peecSkipped} />
                  <ChevronDown
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    className="text-[var(--ink-3)] transition group-open:rotate-180"
                  />
                </div>
              </summary>
              {p.councilNote ? (
                <p className="mt-2.5 text-[12px] leading-[1.5] text-[var(--ink-2)] italic border-l-2 border-[var(--accent)] pl-2.5">
                  {p.councilNote}
                </p>
              ) : (
                <p className="mt-2.5 text-[11.5px] text-[var(--ink-3)] italic">
                  No Chair rationale recorded for this prompt.
                </p>
              )}
            </details>
          ))}
          {prompts.length === 0 && (
            <p className="text-[12px] text-[var(--ink-3)] py-8 text-center">No prompts yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Small dropdown popover with the three cluster choices. Posting any of
 * them sends a synthetic user message that the Session 8 reply router
 * will branch on (`refine_prompts` intent). Until that ships, the
 * message lands in chat as a normal user line — Council can rerun
 * picking up the new context.
 */
function GenerateClusterPopover({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (cluster: PromptCluster) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const choices: { cluster: PromptCluster; label: string; hint: string }[] = [
    {
      cluster: 'Category',
      label: 'Category',
      hint: 'Broad "best X for Y" prompts that capture top-of-funnel discovery.',
    },
    {
      cluster: 'Persona',
      label: 'Persona',
      hint: 'Role-led prompts ("As a marketing lead at a series-B SaaS…") that test ICP fit.',
    },
    {
      cluster: 'Comparison',
      label: 'Comparison',
      hint: 'Head-to-heads ("X vs Y") that test how engines rank you against named alternatives.',
    },
  ];

  return (
    <div
      ref={ref}
      className="absolute right-0 top-9 z-20 w-72 rounded-xl border border-[var(--line)] bg-[var(--surface)] shadow-lg p-1.5 anim-fade-in"
      role="menu"
    >
      <div className="px-2 pt-1 pb-2 border-b border-[var(--line-2)]">
        <p className="text-[11.5px] font-semibold text-[var(--ink-2)]">Generate a new cluster</p>
        <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
          Adds a chat instruction the Council will pick up on the next run.
        </p>
      </div>
      <div className="py-1">
        {choices.map((c) => (
          <button
            key={c.cluster}
            type="button"
            role="menuitem"
            onClick={() => {
              onPick(c.cluster);
              onClose();
            }}
            className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[var(--surface-2)] flex items-start gap-2"
          >
            <ClusterDot cluster={c.cluster} />
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-[var(--ink)] leading-tight">{c.label}</p>
              <p className="text-[11px] text-[var(--ink-3)] mt-0.5 leading-snug">{c.hint}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main column
// ---------------------------------------------------------------------------

export interface PromptsColumnProps {
  prompts: PortfolioPrompt[];
  /** Active research id; scopes the Peec banner dismissal localStorage key. */
  researchId: string;
  onToast: (msg: string) => void;
  /**
   * Total channels for the latest run. Kept as a fallback for the
   * surface-rate card's denominator when `channels` is empty (older
   * runs that pre-date channel persistence).
   */
  totalChannels: number;
  /**
   * Active Peec channels for the latest run, in Peec's order. Drives
   * the per-cell HitsBar tooltip.
   */
  channels: RunChannel[];
  /** Whether Peec was skipped on the latest completed run. */
  peecSkipped: boolean;
  /** Latest run status; drives the "Working…" / "Failed" banner. */
  runStatus: 'pending' | 'running' | 'complete' | 'failed' | null | undefined;
  /** Latest completed (or in-flight) run id — required for Markdown / CSV download. */
  latestRunId: string | null | undefined;
  /**
   * Send a chat message on behalf of the user. Used by the Generate
   * Cluster popover to post the synthetic refine instruction.
   */
  onSendChatMessage: (text: string) => Promise<void>;
  /**
   * Re-fire the Peec brand-baseline lookup for the entire run and
   * replace every prompt's `hits` with the freshly-fetched portfolio-
   * wide value. Resolves with the updated prompts; throws (with `code`)
   * on missing key / Peec failure.
   */
  onRefreshHits: () => Promise<PortfolioPrompt[]>;
}

export function PromptsColumn({
  prompts,
  researchId,
  onToast,
  totalChannels,
  channels,
  peecSkipped,
  runStatus,
  latestRunId,
  onSendChatMessage,
  onRefreshHits,
}: PromptsColumnProps) {
  const [filter, setFilter] = useState<PromptFilter>('All');
  const [sort, setSort] = useState<'Cluster' | 'Intent' | 'Hits'>('Cluster');
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [clusterPopoverOpen, setClusterPopoverOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Reset transient drawer / popover state when switching researches.
  useEffect(() => {
    setShowAll(false);
    setClusterPopoverOpen(false);
    setFilter('All');
    setSort('Cluster');
  }, [researchId]);

  // Hydrate the dismissed state from localStorage per research. Stored
  // per-research so dismissing on one project doesn't hide the banner
  // everywhere — each Peec configuration is per-Peec-key and the user
  // may want a reminder when a new research is created.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(
        PEEC_BANNER_DISMISS_KEY_PREFIX + researchId,
      );
      setBannerDismissed(stored === '1');
    } catch {
      setBannerDismissed(false);
    }
  }, [researchId]);

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PEEC_BANNER_DISMISS_KEY_PREFIX + researchId, '1');
      } catch {
        // localStorage can throw under quota / private mode — silent fail
        // is fine, the banner just reappears on next mount.
      }
    }
  }, [researchId]);

  // If the user later adds a Peec key and runs again, peecSkipped flips
  // to false; clear any dismissal so the banner can warn again on a
  // future skipped run without manual reset.
  useEffect(() => {
    if (!peecSkipped && typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(PEEC_BANNER_DISMISS_KEY_PREFIX + researchId);
      } catch {
        // ignore
      }
    }
  }, [peecSkipped, researchId]);

  const canDownloadReport =
    runStatus === 'complete' && prompts.length > 0 && !!latestRunId;
  const canExportCsv = runStatus === 'complete' && prompts.length > 0;

  const filtered = useMemo(() => {
    const arr = filter === 'All' ? prompts : prompts.filter((p) => p.cluster === filter);
    return sortPrompts(arr, sort);
  }, [prompts, filter, sort]);

  const visible = useMemo(() => filtered.slice(0, MAX_VISIBLE), [filtered]);
  const overflow = filtered.length - visible.length;

  const counts = useMemo(() => {
    const c: Record<PromptFilter, number> = {
      All: prompts.length,
      Category: 0,
      Persona: 0,
      Comparison: 0,
    };
    prompts.forEach((p) => c[p.cluster]++);
    return c;
  }, [prompts]);

  // Surface-rate card — when Peec was skipped we render an empty state
  // instead. Otherwise compute "X / Y engine surfaces" against the real
  // channel total so the headline scales with the user's Peec setup.
  const totalHits = useMemo(() => prompts.reduce((s, p) => s + p.hits, 0), [prompts]);
  const denom = channels.length > 0 ? channels.length : totalChannels;
  const possible = prompts.length * denom;

  const doCopy = useCallback(
    (prompt: PortfolioPrompt, position: number) => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(prompt.text).catch(() => {});
      }
      onToast('Copied to clipboard');
      try {
        posthog.capture('prompt_copied', {
          prompt_id: prompt.id,
          research_id: researchId,
          run_id: latestRunId ?? null,
          cluster: prompt.cluster,
          intent: prompt.intent,
          hits: prompt.hits,
          total_channels: channels.length || totalChannels,
          position_in_list: position,
          has_hits: prompt.hits > 0,
          // The Council Chair always attaches a councilNote for prompts
          // that survived the cut, so its presence is a faithful proxy
          // for "this prompt was a Chair pick".
          is_chair_pick: !!prompt.councilNote,
        });
      } catch {
        // posthog.capture only throws if init was misconfigured; the
        // off-prod no-op never throws. Defensive try/catch keeps copy
        // working even if a future SDK change throws synchronously.
      }
    },
    [onToast, researchId, latestRunId, channels.length, totalChannels],
  );

  const doRefreshHits = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshHits();
      onToast('Hits refreshed');
    } catch (err) {
      const maybe = err as Error & { code?: string };
      if (maybe.code === 'missing_peec_key') {
        onToast('Add a Peec key to refresh hits');
        window.location.href = '/settings/api-keys?onboarding=1';
      } else if (maybe.code === 'no_run') {
        onToast('Run research first to enable refresh');
      } else {
        onToast('Could not refresh — try again');
      }
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshHits, onToast, refreshing]);

  const doGenerateCluster = useCallback(
    async (cluster: PromptCluster) => {
      try {
        posthog.capture('prompt_cluster_generated', {
          research_id: researchId,
          cluster,
          run_id: latestRunId ?? null,
        });
      } catch {
        // ignore — see doCopy
      }
      // Canonical instruction string so the Session 8 reply router can
      // match it exactly. Keep human-readable for chat-history clarity.
      await onSendChatMessage(`Generate a new ${cluster} cluster of prompts.`);
      onToast('Sent to Council');
    },
    [onSendChatMessage, onToast, researchId, latestRunId],
  );

  const downloadReport = useCallback(async () => {
    if (!latestRunId || !canDownloadReport) return;
    setDownloading(true);
    try {
      const res = await fetch(`/api/research/${latestRunId}/report`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = typeof j.message === 'string' ? j.message : `Download failed (${res.status})`;
        onToast(msg);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition');
      const match = cd?.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `siftie-report-${latestRunId.slice(0, 8)}.md`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      onToast('Report downloaded');
    } catch {
      onToast('Download failed');
    } finally {
      setDownloading(false);
    }
  }, [latestRunId, canDownloadReport, onToast]);

  const exportCsv = useCallback(async () => {
    if (!canExportCsv || !latestRunId) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/research/${encodeURIComponent(latestRunId)}/export`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        onToast(typeof j.message === 'string' ? j.message : 'Export failed');
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition');
      const match = cd?.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `siftie-prompts-${latestRunId.slice(0, 8)}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      onToast('CSV exported');
      // Server captures the canonical `csv_exported` event with prompt
      // counts and Peec state; we mirror it client-side too so the
      // funnel can correlate to the same session distinct id without
      // an identify-events bridge.
      try {
        posthog.capture('csv_exported', {
          research_id: researchId,
          run_id: latestRunId,
          prompt_count: prompts.length,
          peec_skipped: peecSkipped,
          surface: 'footer',
        });
      } catch {
        // see doCopy
      }
    } catch {
      onToast('Export failed');
    } finally {
      setExporting(false);
    }
  }, [canExportCsv, latestRunId, researchId, onToast, prompts.length, peecSkipped]);

  const showPeecBanner = peecSkipped && !bannerDismissed && prompts.length > 0;

  return (
    <section className="flex flex-col h-full min-h-0 relative">
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">
                Prompt Portfolio
              </h2>
              <span className="text-[12px] text-[var(--ink-3)] whitespace-nowrap">
                {prompts.length} prompts
              </span>
            </div>
            <p className="text-[12px] text-[var(--ink-3)] mt-1 leading-snug">
              Generated from your sources. Copy a prompt to test it in ChatGPT, Perplexity, or Claude.
            </p>
          </div>
        </div>

        {/*
          Surface-rate card. Two modes:
            - peecSkipped: empty state pointing the user at Settings.
            - default: live X / Y engine surfaces with mini-chart.
        */}
        {peecSkipped ? (
          <div className="mt-3 px-3 py-2.5 rounded-xl bg-[var(--surface-2)]">
            <p className="text-[12px] font-medium text-[var(--ink-2)]">
              Run with Peec to see surface-rate analytics.
            </p>
            <p className="text-[11px] text-[var(--ink-3)] mt-0.5 leading-snug">
              Add a Peec key in Settings to score every prompt across live model channels — ChatGPT, Perplexity, Claude, and more.
            </p>
          </div>
        ) : (
          <div className="mt-3 px-3 py-2.5 rounded-xl bg-[var(--surface-2)] flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[18px] font-serif tracking-tight text-[var(--ink)]">
                  {totalHits}
                </span>
                <span className="text-[12px] text-[var(--ink-3)]">/ {possible} engine surfaces</span>
              </div>
              <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
                {channels.length > 0
                  ? `Across ${channels.length} live model channel${channels.length === 1 ? '' : 's'}`
                  : `Across ${denom} live channel${denom === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex items-end gap-px h-7">
              {prompts.slice(0, MAX_VISIBLE).map((p, i) => (
                <span
                  key={p.id || i}
                  className="w-1 rounded-[2px] bg-[var(--accent)]"
                  style={{
                    height: `${30 + Math.min(p.hits, 8) * 8}%`,
                    opacity: 0.35 + Math.min(p.hits, 8) * 0.07,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {(runStatus === 'running' || runStatus === 'pending') && (
          <div className="mt-2 px-3 py-2 rounded-xl border border-[var(--accent-soft)] bg-[var(--accent-softer)] flex items-center gap-2">
            <span className="w-3 h-3 rounded-full border border-[var(--accent)] border-t-transparent animate-spin" />
            <span className="text-[11.5px] text-[var(--accent-ink)]">
              Council deliberating — chat shows live progress
            </span>
          </div>
        )}
        {runStatus === 'failed' && (
          <div className="mt-2 px-3 py-2 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] text-[11.5px] text-[var(--ink-2)]">
            Last run failed — check the chat for details and retry.
          </div>
        )}

        {showPeecBanner && (
          <div className="mt-2 px-3 py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-[11.5px] font-medium text-[var(--ink-2)]">
                No live brand-mention scoring on this run.
              </p>
              <p className="text-[11px] text-[var(--ink-3)] mt-0.5 leading-snug">
                <a
                  href="/settings/api-keys"
                  className="text-[var(--accent-ink)] hover:underline"
                >
                  Add a Peec key
                </a>{' '}
                to see per-channel hit counts on every prompt.
              </p>
            </div>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label="Dismiss"
              className="btn-ghost p-1 rounded-full text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      <div className="px-5 pb-2 relative">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
          {PROMPT_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[12px] font-medium transition flex items-center gap-1.5
                ${
                  filter === f
                    ? 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]'
                    : 'text-[var(--ink-2)] hover:bg-[var(--surface-3)]'
                }`}
            >
              {f !== 'All' && <ClusterDot cluster={f} />}
              {f}
              <span
                className={`text-[10.5px] ${
                  filter === f ? 'text-[var(--btn-primary-fg)] opacity-70' : 'text-[var(--ink-3)]'
                }`}
              >
                {counts[f]}
              </span>
            </button>
          ))}
          <span className="flex-1" />
          {peecSkipped ? (
            <a
              href="/settings/api-keys"
              className="shrink-0 btn-ghost px-2.5 py-1 rounded-md text-[11.5px] text-[var(--ink-2)] flex items-center gap-1.5 hover:bg-[var(--surface-3)]"
              title="Add a Peec key in Settings to enable live brand-mention refresh."
            >
              <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
              Add Peec key
            </a>
          ) : (
            <button
              type="button"
              onClick={() => void doRefreshHits()}
              disabled={refreshing || runStatus !== 'complete' || prompts.length === 0}
              className="shrink-0 btn-ghost px-2.5 py-1 rounded-md text-[11.5px] text-[var(--ink-2)] flex items-center gap-1.5 hover:bg-[var(--surface-3)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title={
                runStatus !== 'complete'
                  ? 'Available once your run finishes.'
                  : 'Re-fetch the Peec brand-mention baseline for every prompt in this run.'
              }
            >
              {refreshing ? (
                <span className="w-3 h-3 rounded-full border border-[var(--accent)] border-t-transparent animate-spin" />
              ) : (
                <RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
              )}
              {refreshing ? 'Refreshing…' : 'Refresh hits'}
            </button>
          )}
          <div className="shrink-0 relative">
            <button
              type="button"
              onClick={() => setClusterPopoverOpen((v) => !v)}
              className="btn-ghost px-2.5 py-1 rounded-md text-[11.5px] text-[var(--ink-2)] flex items-center gap-1.5 hover:bg-[var(--surface-3)]"
              title="Generate a new cluster of prompts"
              aria-haspopup="menu"
              aria-expanded={clusterPopoverOpen}
            >
              <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" />
              Generate
            </button>
            <GenerateClusterPopover
              open={clusterPopoverOpen}
              onClose={() => setClusterPopoverOpen(false)}
              onPick={(c) => void doGenerateCluster(c)}
            />
          </div>
          <div className="shrink-0 relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'Cluster' | 'Intent' | 'Hits')}
              className="appearance-none pill bg-[var(--surface)] text-[11.5px] text-[var(--ink-2)] pl-2.5 pr-3 py-1 cursor-pointer"
              aria-label="Sort prompts"
            >
              <option>Cluster</option>
              <option>Intent</option>
              {/* "Hits" is meaningless without Peec data — hide it when peecSkipped. */}
              {!peecSkipped && <option>Hits</option>}
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 scroll-y px-5 pb-3 space-y-2.5">
        {visible.map((p, i) => (
          <PromptCard
            key={p.id}
            prompt={p}
            onCopy={doCopy}
            isNew={false}
            channels={channels}
            peecSkipped={peecSkipped}
            position={i + 1}
          />
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full py-2 rounded-xl border border-dashed border-[var(--line)] text-[12px] text-[var(--ink-2)] hover:border-[var(--accent)] hover:text-[var(--accent-ink)] transition flex items-center justify-center gap-1.5"
          >
            Show all {filtered.length} prompts
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        {filtered.length === 0 && (
          <p className="text-[12px] text-[var(--ink-3)] py-8 text-center">
            {prompts.length === 0
              ? 'Run research to generate your first portfolio.'
              : 'No prompts match this filter.'}
          </p>
        )}
      </div>

      <div className="px-5 py-5 border-t border-[var(--line-2)] mt-auto">
        <button
          type="button"
          onClick={() => void downloadReport()}
          disabled={!canDownloadReport || downloading}
          title={canDownloadReport ? 'Download Markdown report' : 'Available once your run finishes.'}
          className="w-full py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:border-[var(--accent)] hover:text-[var(--accent-ink)] text-[13px] font-medium text-[var(--ink-2)] transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--line)] disabled:hover:text-[var(--ink-2)]"
        >
          {downloading ? (
            <>
              <span className="w-3 h-3 rounded-full border border-[var(--accent)] border-t-transparent animate-spin" />
              Preparing download…
            </>
          ) : (
            <span>Download report</span>
          )}
        </button>
      </div>

      <ShowAllDrawer
        open={showAll}
        onClose={() => setShowAll(false)}
        prompts={filtered}
        channels={channels}
        peecSkipped={peecSkipped}
        onExportCsv={() => void exportCsv()}
        exporting={exporting}
        canExport={canExportCsv}
      />
    </section>
  );
}
