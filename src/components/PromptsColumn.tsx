import { useMemo, useState, type MouseEvent } from 'react';
import { PROMPT_FILTERS } from '../data/mock';
import type { PortfolioPrompt, PromptCluster, PromptFilter } from '../types';

function ClusterDot({ cluster }: { cluster: PortfolioPrompt['cluster'] | 'All' }) {
  if (cluster === 'All') return null;
  const map: Record<PromptCluster, string> = {
    Category: 'oklch(60% 0.10 240)',
    Persona: 'oklch(58% 0.12 30)',
    Comparison: 'oklch(55% 0.10 300)',
  };
  return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: map[cluster] || 'gray' }}></span>;
}

/**
 * Render N cells where the first `hits` are filled. Total comes from
 * the latest run's `total_channels` (= number of Peec model channels).
 * If Peec was skipped, both `hits` and `total` are 0 and we render
 * 3 muted cells so the layout doesn't shift — the parent shows a
 * banner explaining why.
 *
 * For very wide totals (>10) we cap visual cells to keep the row
 * compact; the title attribute always shows the real count.
 */
function HitsBar({ hits, total }: { hits: number; total: number }) {
  const visualTotal = total === 0 ? 3 : Math.min(total, 10);
  const visualHits = total === 0 ? 0 : Math.round((hits / total) * visualTotal);
  const cells = Array.from({ length: visualTotal }, (_, i) => (
    <span
      key={i}
      className={`w-1.5 h-3.5 rounded-[2px] ${
        i < visualHits ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
      }`}
    ></span>
  ));
  const titleSuffix = total === 0 ? 'no live channels — add a Peec key for hit counts' : 'channels surfaced your brand';
  return (
    <span
      className="flex items-end gap-[3px]"
      title={`${hits}/${total || 0} ${titleSuffix}`}
    >
      {cells}
    </span>
  );
}

function PromptCard({
  prompt,
  onCopy,
  onTest,
  isNew,
  totalChannels,
}: {
  prompt: PortfolioPrompt;
  onCopy: (text: string) => void;
  onTest?: (p: PortfolioPrompt) => void;
  isNew: boolean;
  /** Fallback when the prompt itself doesn't carry it (legacy rows). */
  totalChannels: number;
}) {
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showNote, setShowNote] = useState(false);

  const doCopy = (e: MouseEvent) => {
    e.stopPropagation();
    onCopy(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const doTest = (e: MouseEvent) => {
    e.stopPropagation();
    setTesting(true);
    setTimeout(() => setTesting(false), 1600);
    onTest?.(prompt);
  };

  // Prefer the prompt's own totalChannels; fall back to the run-level
  // value passed from the parent for older rows that pre-date this field.
  const effectiveTotal = prompt.totalChannels ?? totalChannels;

  return (
    <div className={`src-card p-3.5 ${isNew ? 'anim-slide-up' : ''}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-3)]">
          <ClusterDot cluster={prompt.cluster} />
          <span className="font-medium text-[var(--ink-2)]">{prompt.cluster}</span>
          <span className="text-[var(--ink-3)]">·</span>
          <span>{prompt.intent} intent</span>
        </div>
        <HitsBar hits={prompt.hits} total={effectiveTotal} />
      </div>
      <p className="text-[13.5px] leading-[1.5] text-[var(--ink)]">
        <span className="text-[var(--ink-3)] font-mono text-[11px] mr-1.5">"</span>
        {prompt.text}
        <span className="text-[var(--ink-3)] font-mono text-[11px] ml-0.5">"</span>
      </p>
      {/*
        Council note disclosure — only renders when the Chair attached
        a rationale (always for Session 6 runs; legacy/mock prompts
        won't have one). Click to expand so the column stays compact
        by default.
      */}
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
        <button
          type="button"
          onClick={doTest}
          className="pill text-[11.5px] px-2.5 py-1 flex items-center gap-1.5 hover:border-[var(--accent)] hover:text-[var(--accent-ink)] transition"
        >
          {testing ? (
            <>
              <span className="w-2 h-2 rounded-full border border-[var(--accent)] border-t-transparent animate-spin"></span>
              <span>Testing</span>
            </>
          ) : (
            <span>Test</span>
          )}
        </button>
      </div>
    </div>
  );
}

export interface PromptsColumnProps {
  prompts: PortfolioPrompt[];
  onToast: (msg: string) => void;
  newId: string | null;
  onGenerateMore: () => void;
  generating: boolean;
  /**
   * Total channels for the latest run (used as fallback when an
   * individual prompt has no `totalChannels` field). 0 when Peec was
   * skipped — the parent renders a banner about that.
   */
  totalChannels: number;
  /** Latest run status; drives the "Working…" / "Failed" banner. */
  runStatus: 'pending' | 'running' | 'complete' | 'failed' | null | undefined;
}

export function PromptsColumn({
  prompts,
  onToast,
  newId,
  onGenerateMore,
  generating,
  totalChannels,
  runStatus,
}: PromptsColumnProps) {
  const [filter, setFilter] = useState<PromptFilter>('All');
  const [sort, setSort] = useState<'Cluster' | 'Intent' | 'Hits'>('Cluster');

  const filtered = useMemo(() => {
    let arr = filter === 'All' ? prompts : prompts.filter((p) => p.cluster === filter);
    if (sort === 'Intent') {
      const order: Record<PortfolioPrompt['intent'], number> = { High: 0, Med: 1, Low: 2 };
      arr = [...arr].sort((a, b) => order[a.intent] - order[b.intent]);
    } else if (sort === 'Hits') {
      arr = [...arr].sort((a, b) => b.hits - a.hits);
    } else {
      const order: Record<PromptCluster, number> = { Category: 0, Persona: 1, Comparison: 2 };
      arr = [...arr].sort((a, b) => order[a.cluster] - order[b.cluster]);
    }
    return arr;
  }, [prompts, filter, sort]);

  const counts = useMemo(() => {
    const c: Record<PromptFilter, number> = { All: prompts.length, Category: 0, Persona: 0, Comparison: 0 };
    prompts.forEach((p) => c[p.cluster]++);
    return c;
  }, [prompts]);

  const totalHits = prompts.reduce((s, p) => s + p.hits, 0);
  // The "X / Y engine surfaces" headline scales with the actual
  // number of channels Peec returned. When totalChannels is 0 (Peec
  // skipped) we still want a non-zero denominator so the bar isn't
  // a div-by-zero — fall back to 3 (matches the visual cell count
  // and the legacy "ChatGPT · Perplexity · Claude" copy below).
  const denominatorPerPrompt = totalChannels > 0 ? totalChannels : 3;
  const possible = prompts.length * denominatorPerPrompt;

  const copy = (text: string) => {
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {});
    onToast('Copied to clipboard');
  };

  return (
    <section className="flex flex-col h-full min-h-0">
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">Prompt Portfolio</h2>
              <span className="text-[12px] text-[var(--ink-3)] whitespace-nowrap">{prompts.length} prompts</span>
            </div>
            <p className="text-[12px] text-[var(--ink-3)] mt-1 leading-snug">Generated from your sources. Test in ChatGPT, Perplexity, and Claude.</p>
          </div>
          <button type="button" className="btn-ghost px-2 py-1 shrink-0 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]" aria-label="More">
            More
          </button>
        </div>

        <div className="mt-3 px-3 py-2.5 rounded-xl bg-[var(--surface-2)] flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[18px] font-serif tracking-tight text-[var(--ink)]">{totalHits}</span>
              <span className="text-[12px] text-[var(--ink-3)]">/ {possible} engine surfaces</span>
            </div>
            <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
              {totalChannels > 0
                ? `Across ${totalChannels} live model channel${totalChannels === 1 ? '' : 's'}`
                : 'Add a Peec key to see live brand-mention counts'}
            </p>
          </div>
          <div className="flex items-end gap-[3px] h-7">
            {prompts.slice(0, 12).map((p, i) => (
              <span
                key={i}
                className="w-1.5 rounded-[2px] bg-[var(--accent)]"
                style={{ height: `${30 + p.hits * 22}%`, opacity: 0.35 + p.hits * 0.22 }}
              ></span>
            ))}
          </div>
        </div>

        {/*
          Run status banner. Three modes:
            - running/pending: spinner banner so the user knows the
              Council is deliberating (chat messages explain the steps).
            - failed:          muted banner pointing them at chat for the
              specific failure message.
            - default:         no banner.
        */}
        {(runStatus === 'running' || runStatus === 'pending') && (
          <div className="mt-2 px-3 py-2 rounded-xl border border-[var(--accent-soft)] bg-[var(--accent-softer)] flex items-center gap-2">
            <span className="w-3 h-3 rounded-full border border-[var(--accent)] border-t-transparent animate-spin"></span>
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
      </header>

      <div className="px-5 pb-2">
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
              <span className={`text-[10.5px] ${filter === f ? 'text-[var(--btn-primary-fg)] opacity-70' : 'text-[var(--ink-3)]'}`}>{counts[f]}</span>
            </button>
          ))}
          <span className="flex-1"></span>
          <div className="shrink-0 relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as 'Cluster' | 'Intent' | 'Hits')}
              className="appearance-none pill bg-[var(--surface)] text-[11.5px] text-[var(--ink-2)] pl-2.5 pr-3 py-1 cursor-pointer"
            >
              <option>Cluster</option>
              <option>Intent</option>
              <option>Hits</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 scroll-y px-5 pb-3 space-y-2.5">
        {filtered.map((p) => (
          <PromptCard
            key={p.id}
            prompt={p}
            onCopy={copy}
            isNew={p.id === newId}
            totalChannels={totalChannels}
          />
        ))}
      </div>

      <div className="px-5 pb-5 pt-2 border-t border-[var(--line-2)] mt-auto">
        <button
          type="button"
          onClick={onGenerateMore}
          disabled={generating}
          className="w-full py-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:border-[var(--accent)] hover:text-[var(--accent-ink)] text-[13px] font-medium text-[var(--ink-2)] transition flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {generating ? (
            <>
              <span className="w-3 h-3 rounded-full border border-[var(--accent)] border-t-transparent animate-spin"></span>
              Drafting from sources…
            </>
          ) : (
            <span>Generate sustainability cluster</span>
          )}
        </button>
      </div>
    </section>
  );
}
