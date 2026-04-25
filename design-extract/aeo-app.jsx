// Top-level app: layout, mobile tabs, modal, state orchestration
const { useState, useEffect, useRef } = React;

function useViewport() {
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' ? window.innerWidth >= 1100 : true);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1100);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isDesktop;
}

function AddSourceModal({ open, onClose, onAdd }) {
  const [tab, setTab] = useState('upload'); // upload | url | text | db
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    if (!open) { setUrl(''); setText(''); setQuery(''); setTab('upload'); }
  }, [open]);

  if (!open) return null;

  const submit = () => {
    let payload = null;
    if (tab === 'upload') payload = { type: 'pdf', title: 'Competitor_Teardown_Q1.pdf', meta: '8 pages · just now', snippet: 'Lululemon, Athleta, Vuori, Outdoor Voices — pricing, sustainability claims, content positioning, customer review themes.' };
    if (tab === 'url' && url.trim()) payload = { type: 'url', title: url.replace(/^https?:\/\//, '').slice(0, 48), meta: 'Fetched · just now', snippet: 'Page indexed. Headings, body copy, and meta extracted. Page contains 1,240 words across 4 sections.' };
    if (tab === 'text' && text.trim()) payload = { type: 'paste', title: 'Pasted text', meta: `${text.trim().split(/\s+/).length} words · just now`, snippet: text.trim().slice(0, 200) + (text.length > 200 ? '…' : '') };
    if (tab === 'db' && query.trim()) payload = { type: 'db', title: `DB result — "${query.trim()}"`, meta: 'Internal database · 6 matches', snippet: 'Returned 6 records from the activewear AEO benchmark. Top match: "Sustainable running brands" — 247 query variants.' };
    if (payload) {
      onAdd(payload);
      onClose();
    }
  };

  const tabs = [
    { id: 'upload', label: 'Upload' },
    { id: 'url',    label: 'URL' },
    { id: 'text',   label: 'Paste text' },
    { id: 'db',     label: 'Database' },
  ];

  const canSubmit = tab === 'upload' || (tab === 'url' && url.trim()) || (tab === 'text' && text.trim()) || (tab === 'db' && query.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[oklch(20%_0.01_60/0.35)] backdrop-blur-[2px]"
         onClick={onClose}>
      <div className="w-full max-w-[520px] bg-white rounded-2xl border border-[var(--line)] shadow-[0_30px_80px_-30px_rgba(20,15,25,0.35)] overflow-hidden"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--line-2)]">
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--ink)]">Add a source</h3>
            <p className="text-[12px] text-[var(--ink-3)] mt-0.5">The agent will index it and reference it in the chat.</p>
          </div>
          <button onClick={onClose} className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">Close</button>
        </div>
        <div className="flex gap-1 px-3 pt-3 border-b border-[var(--line-2)]">
          {tabs.map(t => (
            <button key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-[12.5px] font-medium rounded-t-md border-b-2 transition
                ${tab === t.id ? 'border-[var(--ink)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-5">
          {tab === 'upload' && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
              onDragLeave={() => setDropping(false)}
              onDrop={(e) => { e.preventDefault(); setDropping(false); }}
              className={`rounded-xl border-2 border-dashed py-10 text-center transition
                ${dropping ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)] bg-[oklch(98%_0.004_70)]'}`}>
              <p className="text-[13.5px] font-medium text-[var(--ink)]">Drop a file, or click to browse</p>
              <p className="text-[11.5px] text-[var(--ink-3)] mt-1">PDF, DOCX, TXT, MD — up to 50 MB</p>
            </div>
          )}
          {tab === 'url' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">URL</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://competitor.com/about"
                className="mt-1 w-full rounded-xl border border-[var(--line)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]" />
              <p className="text-[11.5px] text-[var(--ink-3)] mt-2">Paste a competitor page, review article, or your own brand site.</p>
            </div>
          )}
          {tab === 'text' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Text</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Paste a customer interview transcript, brand brief, or notes…"
                className="mt-1 w-full rounded-xl border border-[var(--line)] px-3 py-2.5 text-[14px] leading-[1.55] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)] resize-none" />
            </div>
          )}
          {tab === 'db' && (
            <div>
              <label className="text-[11.5px] uppercase tracking-wider text-[var(--ink-3)] font-medium">Search internal database</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. sustainable activewear, recycled textiles, DTC pricing"
                className="mt-1 w-full rounded-xl border border-[var(--line)] px-3 py-2.5 text-[14px] focus-ring text-[var(--ink)] placeholder:text-[var(--ink-3)]" />
              <div className="mt-3 space-y-1.5">
                {['Activewear AEO benchmark', 'Sustainability claim audit', 'DTC challenger pricing'].map(s => (
                  <button key={s} onClick={() => setQuery(s)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-[oklch(97%_0.005_70)] text-[12.5px] text-[var(--ink-2)]">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 pb-5 pt-1 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost px-3 py-2 text-[13px] text-[var(--ink-2)]">Cancel</button>
          <button onClick={submit} disabled={!canSubmit}
            className={`px-3.5 py-2 rounded-xl text-[13px] font-medium transition
              ${canSubmit ? 'bg-[var(--ink)] text-white hover:bg-[oklch(28%_0.01_60)]' : 'bg-[oklch(94%_0.005_70)] text-[var(--ink-3)] cursor-not-allowed'}`}>
            Add source
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ text }) {
  if (!text) return null;
  return (
    <div className="toast fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-40 px-3.5 py-2 rounded-full bg-[var(--ink)] text-white text-[12.5px] shadow-[0_12px_32px_-12px_rgba(20,15,25,0.4)]">
      {text}
    </div>
  );
}

function MobileTabBar({ tab, setTab, sourcesCount, promptCount }) {
  const items = [
    { id: 'sources', label: 'Sources', count: sourcesCount },
    { id: 'chat',    label: 'Chat',    count: null },
    { id: 'prompts', label: 'Prompts', count: promptCount },
  ];
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/85 backdrop-blur-md border-t border-[var(--line)] tabbar-safe">
      <div className="grid grid-cols-3">
        {items.map(it => {
          const active = tab === it.id;
          return (
            <button key={it.id} onClick={() => setTab(it.id)}
              className="relative flex flex-col items-center justify-center py-3 gap-0.5">
              <span className={`text-[12.5px] font-medium ${active ? 'text-[var(--ink)]' : 'text-[var(--ink-3)]'}`}>
                {it.label}
                {it.count != null && it.count > 0 && (
                  <span className={`ml-1.5 text-[10.5px] ${active ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-3)]'}`}>{it.count}</span>
                )}
              </span>
              {active && <span className="absolute bottom-0 inset-x-6 h-[2px] rounded-full bg-[var(--ink)]"></span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function TopBar({ onAdd }) {
  return (
    <header className="hidden md:flex items-center justify-between px-6 py-3 border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
      <div className="flex items-center gap-3">
        <img src="assets/AEOagent-logo.svg" alt="AEOagent" height="18" style={{ height: '18px', width: 'auto' }} />
        <span className="w-px h-4 bg-[var(--line)]"></span>
        <span className="text-[12px] text-[var(--ink-3)]">Loftway · SS26 launch portfolio</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button className="btn-ghost px-2.5 py-1.5 text-[12.5px] text-[var(--ink-2)]">Saved 2 min ago</button>
        <span className="w-px h-5 bg-[var(--line)] mx-1"></span>
        <button className="btn-ghost px-2.5 py-1.5 text-[12.5px] text-[var(--ink-2)]">Share</button>
        <button className="btn-primary px-3 py-1.5 text-[12.5px]">New session</button>
      </div>
    </header>
  );
}

function MobileTopBar({ tab }) {
  const titles = { sources: 'Sources', chat: 'AEOagent', prompts: 'Prompt Portfolio' };
  return (
    <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-[var(--line)] bg-[var(--bg)]/90 backdrop-blur sticky top-0 z-20">
      <div className="flex items-center gap-2.5">
        <img src="assets/AEOagent-logo.svg" alt="AEOagent" height="14" style={{ height: '14px', width: 'auto' }} />
        <span className="w-px h-3.5 bg-[var(--line)]"></span>
        <span className="text-[12.5px] text-[var(--ink-3)]">{titles[tab]}</span>
      </div>
      <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)]">More</button>
    </header>
  );
}

function App() {
  const isDesktop = useViewport();
  const [tab, setTab] = useState('chat');
  const [sources, setSources] = useState(INITIAL_SOURCES);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [prompts, setPrompts] = useState(INITIAL_PROMPTS);
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingId, setAnalyzingId] = useState(null);
  const [newPromptId, setNewPromptId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const toastTimer = useRef(null);

  const showToast = (t) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  };

  const addSource = (payload) => {
    const id = 's' + Date.now();
    setSources(prev => [{ id, ...payload }, ...prev]);
    setAnalyzingId(id);
    setAnalyzing(true);
    setTimeout(() => { setAnalyzing(false); setAnalyzingId(null); }, 2400);
    showToast('Source added · indexing');
  };

  const sendMessage = (text) => {
    const now = new Date();
    const t = `${(now.getHours() % 12 || 12)}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;
    const userMsg = { id: 'u' + Date.now(), role: 'user', time: t, text };
    setMessages(prev => [...prev, userMsg]);
    setIsTyping(true);
    setTimeout(() => {
      const replies = [
        "Got it. I'll fold that into the next pass — adding two prompts that lean on the price gap and one that anchors on recycled-material credibility.",
        "Useful. That changes the persona prompts in particular — 'beginner' is doing a lot of work in the queries; I'll swap in 'late starter' and 'casual miler' variants.",
        "Noted. I'll re-cluster around that. Expect three new sustainability prompts and a refreshed comparison cluster within the next 30 seconds.",
      ];
      const reply = replies[Math.floor(Math.random() * replies.length)];
      setMessages(prev => [...prev, { id: 'a' + Date.now(), role: 'agent', time: t, text: reply }]);
      setIsTyping(false);
    }, 1400);
  };

  const generateMore = () => {
    setGenerating(true);
    setTimeout(() => {
      const newPrompts = [
        { id: 'np1' + Date.now(), cluster: 'Category', text: 'Activewear made from recycled ocean plastic — best-rated brands', hits: 0, intent: 'High' },
        { id: 'np2' + Date.now(), cluster: 'Category', text: 'Carbon-neutral running apparel under $100',                       hits: 0, intent: 'Med'  },
        { id: 'np3' + Date.now(), cluster: 'Persona',  text: 'Eco-conscious runners looking to switch from fast-fashion brands', hits: 0, intent: 'High' },
      ];
      setPrompts(prev => [...newPrompts, ...prev]);
      setNewPromptId(newPrompts[0].id);
      setGenerating(false);
      showToast('Added 3 sustainability prompts');
      setTimeout(() => setNewPromptId(null), 1200);
    }, 1600);
  };

  // Layout
  return (
    <div className="min-h-screen flex flex-col">
      <TopBar onAdd={() => setModalOpen(true)} />
      <MobileTopBar tab={tab} />

      {isDesktop ? (
        <main className="flex-1 px-4 lg:px-6 py-4 lg:py-5">
          <div className="grid h-[calc(100vh-72px)] gap-4 lg:gap-5"
               style={{ gridTemplateColumns: 'minmax(260px, 320px) minmax(380px, 1fr) minmax(280px, 360px)' }}>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <SourcesColumn sources={sources} setSources={setSources} onAdd={() => setModalOpen(true)} analyzingId={analyzingId} />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <ChatColumn messages={messages} onSend={sendMessage} isTyping={isTyping} sourcesCount={sources.length} analyzing={analyzing} />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <PromptsColumn prompts={prompts} setPrompts={setPrompts} onToast={showToast} newId={newPromptId} onGenerateMore={generateMore} generating={generating} />
            </div>
          </div>
        </main>
      ) : (
        <main className="flex-1 flex flex-col min-h-0 pb-[68px]">
          <div className="flex-1 min-h-0">
            {tab === 'sources' && (
              <div className="h-full">
                <SourcesColumn sources={sources} setSources={setSources} onAdd={() => setModalOpen(true)} analyzingId={analyzingId} />
              </div>
            )}
            {tab === 'chat' && (
              <div className="h-full">
                <ChatColumn messages={messages} onSend={sendMessage} isTyping={isTyping} sourcesCount={sources.length} analyzing={analyzing} />
              </div>
            )}
            {tab === 'prompts' && (
              <div className="h-full">
                <PromptsColumn prompts={prompts} setPrompts={setPrompts} onToast={showToast} newId={newPromptId} onGenerateMore={generateMore} generating={generating} />
              </div>
            )}
          </div>
        </main>
      )}

      <MobileTabBar tab={tab} setTab={setTab} sourcesCount={sources.length} promptCount={prompts.length} />

      <AddSourceModal open={modalOpen} onClose={() => setModalOpen(false)} onAdd={addSource} />
      <Toast text={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
