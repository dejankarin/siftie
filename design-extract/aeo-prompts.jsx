// Prompt Portfolio column — right
const { useState: useStateP, useMemo: useMemoP } = React;

function ClusterDot({ cluster }) {
  const map = {
    Category:   'oklch(60% 0.10 240)',
    Persona:    'oklch(58% 0.12 30)',
    Comparison: 'oklch(55% 0.10 300)',
  };
  return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: map[cluster] || 'gray' }}></span>;
}

function HitsBar({ hits }) {
  // 0–3 hits across the major answer engines (mock)
  const cells = [0, 1, 2].map(i => (
    <span key={i} className={`w-1.5 h-3.5 rounded-[2px] ${i < hits ? 'bg-[var(--accent)]' : 'bg-[oklch(94%_0.005_70)]'}`}></span>
  ));
  return <span className="flex items-end gap-[3px]" title={`${hits}/3 engines surfaced your brand`}>{cells}</span>;
}

function PromptCard({ prompt, onCopy, onTest, isNew }) {
  const [copied, setCopied] = useStateP(false);
  const [testing, setTesting] = useStateP(false);

  const doCopy = (e) => {
    e.stopPropagation();
    onCopy(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const doTest = (e) => {
    e.stopPropagation();
    setTesting(true);
    setTimeout(() => setTesting(false), 1600);
    onTest && onTest(prompt);
  };

  return (
    <div className={`src-card p-3.5 ${isNew ? 'anim-slide-up' : ''}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-3)]">
          <ClusterDot cluster={prompt.cluster} />
          <span className="font-medium text-[var(--ink-2)]">{prompt.cluster}</span>
          <span className="text-[var(--ink-3)]">·</span>
          <span>{prompt.intent} intent</span>
        </div>
        <HitsBar hits={prompt.hits} />
      </div>
      <p className="text-[13.5px] leading-[1.5] text-[var(--ink)]">
        <span className="text-[var(--ink-3)] font-mono text-[11px] mr-1.5">"</span>
        {prompt.text}
        <span className="text-[var(--ink-3)] font-mono text-[11px] ml-0.5">"</span>
      </p>
      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[var(--line-2)]">
        <button
          onClick={doCopy}
          className="text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)] btn-ghost px-1.5 py-1 -ml-1.5">
          {copied ? <span className="text-[oklch(45%_0.13_150)]">Copied</span> : <span>Copy</span>}
        </button>
        <button
          onClick={doTest}
          className="pill text-[11.5px] px-2.5 py-1 flex items-center gap-1.5 hover:border-[var(--accent)] hover:text-[var(--accent-ink)] transition">
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

function PromptsColumn({ prompts, setPrompts, onToast, newId, onGenerateMore, generating }) {
  const [filter, setFilter] = useStateP('All');
  const [sort, setSort] = useStateP('Cluster'); // Cluster | Intent | Hits

  const filtered = useMemoP(() => {
    let arr = filter === 'All' ? prompts : prompts.filter(p => p.cluster === filter);
    if (sort === 'Intent') {
      const order = { High: 0, Med: 1, Low: 2 };
      arr = [...arr].sort((a, b) => order[a.intent] - order[b.intent]);
    } else if (sort === 'Hits') {
      arr = [...arr].sort((a, b) => b.hits - a.hits);
    } else {
      const order = { Category: 0, Persona: 1, Comparison: 2 };
      arr = [...arr].sort((a, b) => order[a.cluster] - order[b.cluster]);
    }
    return arr;
  }, [prompts, filter, sort]);

  const counts = useMemoP(() => {
    const c = { All: prompts.length, Category: 0, Persona: 0, Comparison: 0 };
    prompts.forEach(p => c[p.cluster]++);
    return c;
  }, [prompts]);

  const totalHits = prompts.reduce((s, p) => s + p.hits, 0);
  const possible = prompts.length * 3;

  const copy = (text) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    onToast(`Copied to clipboard`);
  };

  return (
    <section className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">Prompt Portfolio</h2>
              <span className="text-[12px] text-[var(--ink-3)] whitespace-nowrap">{prompts.length} prompts</span>
            </div>
            <p className="text-[12px] text-[var(--ink-3)] mt-1 leading-snug">
              Generated from your sources. Test in ChatGPT, Perplexity, and Claude.
            </p>
          </div>
          <button className="btn-ghost px-2 py-1 shrink-0 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]" aria-label="More">
            More
          </button>
        </div>

        {/* Surface rate card */}
        <div className="mt-3 px-3 py-2.5 rounded-xl bg-[oklch(97%_0.005_70)] flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[18px] font-serif tracking-tight text-[var(--ink)]">{totalHits}</span>
              <span className="text-[12px] text-[var(--ink-3)]">/ {possible} engine surfaces</span>
            </div>
            <p className="text-[11px] text-[var(--ink-3)] mt-0.5">Across ChatGPT · Perplexity · Claude</p>
          </div>
          <div className="flex items-end gap-[3px] h-7">
            {prompts.slice(0, 12).map((p, i) => (
              <span key={i} className="w-1.5 rounded-[2px] bg-[var(--accent)]" style={{ height: `${30 + p.hits * 22}%`, opacity: 0.35 + p.hits * 0.22 }}></span>
            ))}
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="px-5 pb-2">
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
          {PROMPT_FILTERS.map(f => (
            <button key={f}
              onClick={() => setFilter(f)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[12px] font-medium transition flex items-center gap-1.5
                ${filter === f
                  ? 'bg-[var(--ink)] text-white'
                  : 'text-[var(--ink-2)] hover:bg-[oklch(95%_0.004_70)]'}`}>
              {f !== 'All' && <ClusterDot cluster={f} />}
              {f}
              <span className={`text-[10.5px] ${filter === f ? 'text-white/70' : 'text-[var(--ink-3)]'}`}>{counts[f]}</span>
            </button>
          ))}
          <span className="flex-1"></span>
          <div className="shrink-0 relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="appearance-none pill bg-white text-[11.5px] text-[var(--ink-2)] pl-2.5 pr-3 py-1 cursor-pointer">
              <option>Cluster</option>
              <option>Intent</option>
              <option>Hits</option>
            </select>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 scroll-y px-5 pb-3 space-y-2.5">
        {filtered.map(p => (
          <PromptCard key={p.id} prompt={p} onCopy={copy} isNew={p.id === newId} />
        ))}
      </div>

      {/* Footer action */}
      <div className="px-5 pb-5 pt-2 border-t border-[var(--line-2)] mt-auto">
        <button
          onClick={onGenerateMore}
          disabled={generating}
          className="w-full py-2.5 rounded-xl border border-[var(--line)] bg-white hover:border-[var(--accent)] hover:text-[var(--accent-ink)] text-[13px] font-medium text-[var(--ink-2)] transition flex items-center justify-center gap-2 disabled:opacity-60">
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

window.PromptsColumn = PromptsColumn;
