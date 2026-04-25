// Sources column — left
const { useState: useStateS } = React;

function AddMethodTile({ label, hint, onClick }) {
  return (
    <button onClick={onClick}
      className="group w-full text-left p-3 rounded-xl border border-[var(--line)] bg-white hover:border-[oklch(85%_0.005_70)] hover:bg-[oklch(99%_0.003_70)] transition">
      <span className="block text-[13px] font-medium text-[var(--ink)] leading-tight">{label}</span>
      <span className="block text-[11.5px] text-[var(--ink-3)] mt-0.5 leading-snug">{hint}</span>
    </button>
  );
}

function SourceCard({ source, onRemove, analyzing }) {
  const t = SOURCE_TYPES[source.type];
  return (
    <div className="src-card p-3.5 group relative">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="chip" style={{ background: `color-mix(in oklch, ${t.dot} 8%, white)`, color: t.dot }}>{t.label}</span>
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
        <button onClick={() => onRemove(source.id)}
          aria-label="Remove source"
          className="opacity-0 group-hover:opacity-100 transition shrink-0 px-2 py-1 rounded-md text-[11px] font-medium text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[oklch(95%_0.004_70)]">
          Remove
        </button>
      </div>
    </div>
  );
}

function SourcesColumn({ sources, setSources, onAdd, analyzingId }) {
  const removeSource = (id) => setSources(prev => prev.filter(s => s.id !== id));
  const totalWords = 4280; // mock

  return (
    <section className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="px-5 pt-5 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">Sources</h2>
            <span className="text-[12px] text-[var(--ink-3)]">{sources.length}</span>
          </div>
          <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]" aria-label="More">
            More
          </button>
        </div>
        <p className="mt-1 text-[12px] text-[var(--ink-3)] leading-snug">
          The agent will analyze these to generate your prompt portfolio.
        </p>
      </header>

      {/* Add sources */}
      <div className="px-5 pb-3">
        <button onClick={onAdd}
          className="btn-primary w-full py-2.5 text-[13.5px] font-medium">
          Add sources
        </button>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <AddMethodTile label="Upload"     hint="Drop a PDF or doc"     onClick={onAdd} />
          <AddMethodTile label="Paste URL"  hint="Site, article, brand"  onClick={onAdd} />
          <AddMethodTile label="Paste text" hint="Notes, transcripts"    onClick={onAdd} />
          <AddMethodTile label="Database"   hint="Search internal index" onClick={onAdd} />
        </div>
      </div>

      {/* Stats strip */}
      <div className="mx-5 mb-3 px-3 py-2 rounded-xl bg-[oklch(97%_0.005_70)] flex items-center justify-between text-[11.5px] text-[var(--ink-3)]">
        <span><span className="text-[var(--ink-2)] font-medium">{sources.length}</span> sources · <span className="text-[var(--ink-2)] font-medium">{totalWords.toLocaleString()}</span> words indexed</span>
        <button className="text-[var(--ink-2)] hover:text-[var(--ink)]">
          Re-index
        </button>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 scroll-y px-5 pb-6 space-y-2.5">
        {sources.length === 0 ? (
          <div className="border border-dashed border-[var(--line)] rounded-2xl p-8 text-center">
            <p className="text-[13px] font-medium text-[var(--ink)]">No sources yet</p>
            <p className="text-[12px] text-[var(--ink-3)] mt-1">Add a brand brief, competitor URLs, or customer interviews to get started.</p>
          </div>
        ) : (
          sources.map(s => (
            <SourceCard key={s.id} source={s} onRemove={removeSource} analyzing={s.id === analyzingId} />
          ))
        )}
      </div>
    </section>
  );
}

window.SourcesColumn = SourcesColumn;
