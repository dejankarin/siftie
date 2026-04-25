// Chat column — center
const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

function AgentAvatar({ size = 28 }) {
  return (
    <div className="rounded-full flex items-center justify-center shrink-0 font-serif italic"
         style={{ width: size, height: size, background: 'var(--accent-soft)', color: 'var(--accent-ink)', fontSize: size * 0.5 }}>
      æ
    </div>
  );
}

function UserAvatar({ size = 28 }) {
  return (
    <div className="rounded-full flex items-center justify-center shrink-0 bg-[oklch(94%_0.005_70)] text-[var(--ink-2)] text-[11px] font-semibold"
         style={{ width: size, height: size }}>
      EM
    </div>
  );
}

function MessageBubble({ msg }) {
  const isAgent = msg.role === 'agent';
  return (
    <div className={`flex gap-3 ${isAgent ? '' : 'flex-row-reverse'}`}>
      {isAgent ? <AgentAvatar /> : <UserAvatar />}
      <div className={`flex-1 min-w-0 ${isAgent ? '' : 'flex flex-col items-end'}`}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[12px] font-medium text-[var(--ink)]">{isAgent ? 'AEOagent' : 'You'}</span>
          <span className="text-[11px] text-[var(--ink-3)]">{msg.time}</span>
        </div>
        <div className={
          isAgent
            ? 'max-w-[92%] text-[14px] leading-[1.6] text-[var(--ink)]'
            : 'max-w-[88%] text-[14px] leading-[1.55] text-[var(--ink)] bg-[oklch(96.5%_0.005_70)] border border-[var(--line)] rounded-2xl rounded-tr-md px-3.5 py-2.5'
        }>
          {msg.text}
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex gap-3">
      <AgentAvatar />
      <div className="flex items-center gap-1.5 px-3.5 py-3 rounded-2xl rounded-tl-md bg-[oklch(97%_0.005_70)] border border-[var(--line)]">
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--ink-3)]"></span>
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--ink-3)]"></span>
        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--ink-3)]"></span>
      </div>
    </div>
  );
}

function AnalyzingStrip({ sourcesCount }) {
  return (
    <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl border border-[var(--line)] bg-white flex items-center gap-2.5">
      <span className="relative w-4 h-4 flex items-center justify-center shrink-0">
        <span className="absolute inset-0 rounded-full border border-[var(--accent-soft)]"></span>
        <span className="absolute inset-0 rounded-full border-t border-[var(--accent)] animate-spin"></span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-[var(--ink-2)]">
          Analyzing <span className="font-medium text-[var(--ink)]">{sourcesCount} sources</span> · cross-referencing brand voice with competitor positioning
        </p>
        <div className="mt-1.5 h-[2px] rounded-full bg-[oklch(95%_0.005_70)] overflow-hidden">
          <div className="h-full w-1/2 shimmer-bar"></div>
        </div>
      </div>
    </div>
  );
}

function ChatColumn({ messages, onSend, isTyping, sourcesCount, analyzing }) {
  const [draft, setDraft] = useStateC('');
  const scrollRef = useRefC(null);
  const taRef = useRefC(null);

  useEffectC(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, isTyping]);

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onInput = (e) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  };

  return (
    <section className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="px-5 pt-5 pb-3 border-b border-[var(--line-2)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AgentAvatar size={34} />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold tracking-tight text-[var(--ink)]">AEOagent</h2>
                <span className="chip bg-[var(--accent-soft)] text-[var(--accent-ink)]">Research</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[oklch(65%_0.13_150)]"></span>
                <span className="text-[11.5px] text-[var(--ink-3)]">Active · analyzing {sourcesCount} sources</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">History</button>
            <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">More</button>
          </div>
        </div>
      </header>

      {/* Analyzing strip */}
      {analyzing && <AnalyzingStrip sourcesCount={sourcesCount} />}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 scroll-y px-5 py-5 space-y-5">
        {/* Conversation start marker */}
        <div className="flex items-center gap-3 text-[11px] text-[var(--ink-3)]">
          <span className="flex-1 dot-divider text-[var(--ink-3)]"></span>
          <span className="font-mono uppercase tracking-wider">Session · Apr 25, 2026</span>
          <span className="flex-1 dot-divider text-[var(--ink-3)]"></span>
        </div>
        {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
        {isTyping && <TypingBubble />}
      </div>

      {/* Composer */}
      <div className="px-4 pb-4 pt-2">
        <div className="rounded-2xl border border-[var(--line)] bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(20,15,25,0.02),0_8px_24px_-20px_rgba(20,15,25,0.15)] focus-within:border-[oklch(85%_0.005_70)]">
          <textarea
            ref={taRef}
            value={draft}
            onChange={onInput}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Reply to AEOagent…"
            className="w-full resize-none bg-transparent outline-none text-[14px] leading-[1.55] text-[var(--ink)] placeholder:text-[var(--ink-3)] max-h-[140px]"
          />
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-1">
              <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">Attach</button>
              <button className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)] hover:text-[var(--ink)]">{sourcesCount} sources</button>
            </div>
            <button
              onClick={submit}
              disabled={!draft.trim()}
              className={`rounded-full px-4 h-8 text-[12px] font-medium transition
                ${draft.trim() ? 'bg-[var(--ink)] text-white hover:bg-[oklch(28%_0.01_60)]' : 'bg-[oklch(94%_0.005_70)] text-[var(--ink-3)] cursor-not-allowed'}`}
              aria-label="Send"
            >
              Send
            </button>
          </div>
        </div>
        <p className="text-center mt-2 text-[10.5px] text-[var(--ink-3)]">
          AEOagent uses your sources as the only context. Replies cite source IDs.
        </p>
      </div>
    </section>
  );
}

window.ChatColumn = ChatColumn;
