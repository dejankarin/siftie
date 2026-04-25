import { useCallback, useEffect, useRef, useState } from 'react';
import { AddSourceModal, type AddTab } from './components/AddSourceModal';
import { ChatColumn } from './components/ChatColumn';
import { EditSourceModal } from './components/EditSourceModal';
import { MobileTabBar } from './components/MobileTabBar';
import { MobileTopBar } from './components/MobileTopBar';
import { PromptsColumn } from './components/PromptsColumn';
import { SourcesColumn } from './components/SourcesColumn';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { INITIAL_MESSAGES, INITIAL_PROMPTS, INITIAL_SOURCES } from './data/mock';
import { useTheme } from './hooks/useTheme';
import { useIsDesktop } from './hooks/useViewport';
import type { Message, PortfolioPrompt, Source } from './types';

type MobileTab = 'sources' | 'chat' | 'prompts';

export default function App() {
  const isDesktop = useIsDesktop();
  const { theme, toggle: toggleTheme } = useTheme();
  const [tab, setTab] = useState<MobileTab>('chat');
  const [sources, setSources] = useState<Source[]>(INITIAL_SOURCES);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [prompts, setPrompts] = useState<PortfolioPrompt[]>(INITIAL_PROMPTS);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitialTab, setModalInitialTab] = useState<AddTab>('upload');
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [toast, setToast] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [newPromptId, setNewPromptId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const openAdd = useCallback((initial?: AddTab) => {
    setModalInitialTab(initial ?? 'upload');
    setModalOpen(true);
  }, []);

  const addSource = (payload: Omit<Source, 'id'>) => {
    const id = 's' + Date.now();
    setSources((prev) => [{ id, ...payload }, ...prev]);
    setAnalyzingId(id);
    setAnalyzing(true);
    setTimeout(() => {
      setAnalyzing(false);
      setAnalyzingId(null);
    }, 2400);
    showToast('Source added · indexing');
  };

  const saveEditedSource = (next: Source) => {
    setSources((prev) => prev.map((s) => (s.id === next.id ? next : s)));
    showToast('Source updated');
  };

  const sendMessage = (text: string) => {
    const now = new Date();
    const t = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;
    const userMsg: Message = { id: 'u' + Date.now(), role: 'user', time: t, text };
    setMessages((prev) => [...prev, userMsg]);
    setIsTyping(true);
    setTimeout(() => {
      const replies = [
        "Got it. I'll fold that into the next pass — adding two prompts that lean on the price gap and one that anchors on recycled-material credibility.",
        "Useful. That changes the persona prompts in particular — 'beginner' is doing a lot of work in the queries; I'll swap in 'late starter' and 'casual miler' variants.",
        "Noted. I'll re-cluster around that. Expect three new sustainability prompts and a refreshed comparison cluster within the next 30 seconds.",
      ];
      const reply = replies[Math.floor(Math.random() * replies.length)]!;
      setMessages((prev) => [...prev, { id: 'a' + Date.now(), role: 'agent', time: t, text: reply }]);
      setIsTyping(false);
    }, 1400);
  };

  const generateMore = () => {
    setGenerating(true);
    setTimeout(() => {
      const newPrompts: PortfolioPrompt[] = [
        { id: 'np1' + Date.now(), cluster: 'Category', text: 'Activewear made from recycled ocean plastic — best-rated brands', hits: 0, intent: 'High' },
        { id: 'np2' + Date.now(), cluster: 'Category', text: 'Carbon-neutral running apparel under $100', hits: 0, intent: 'Med' },
        { id: 'np3' + Date.now(), cluster: 'Persona', text: 'Eco-conscious runners looking to switch from fast-fashion brands', hits: 0, intent: 'High' },
      ];
      setPrompts((prev) => [...newPrompts, ...prev]);
      setNewPromptId(newPrompts[0]!.id);
      setGenerating(false);
      showToast('Added 3 sustainability prompts');
      setTimeout(() => setNewPromptId(null), 1200);
    }, 1600);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar theme={theme} onToggleTheme={toggleTheme} />
      <MobileTopBar tab={tab} theme={theme} onToggleTheme={toggleTheme} />

      {isDesktop ? (
        <main className="flex-1 px-4 lg:px-6 py-4 lg:py-5">
          <div
            className="grid h-[calc(100vh-72px)] gap-4 lg:gap-5"
            style={{ gridTemplateColumns: 'minmax(260px, 320px) minmax(380px, 1fr) minmax(280px, 360px)' }}
          >
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <SourcesColumn
                sources={sources}
                setSources={setSources}
                onAdd={openAdd}
                onEdit={setEditingSource}
                analyzingId={analyzingId}
              />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <ChatColumn
                messages={messages}
                onSend={sendMessage}
                isTyping={isTyping}
                sourcesCount={sources.length}
                analyzing={analyzing}
              />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <PromptsColumn
                prompts={prompts}
                onToast={showToast}
                newId={newPromptId}
                onGenerateMore={generateMore}
                generating={generating}
              />
            </div>
          </div>
        </main>
      ) : (
        <main className="flex-1 flex flex-col min-h-0 pb-[68px]">
          <div className="flex-1 min-h-0">
            {tab === 'sources' && (
              <div className="h-full">
                <SourcesColumn
                  sources={sources}
                  setSources={setSources}
                  onAdd={openAdd}
                  onEdit={setEditingSource}
                  analyzingId={analyzingId}
                />
              </div>
            )}
            {tab === 'chat' && (
              <div className="h-full">
                <ChatColumn
                  messages={messages}
                  onSend={sendMessage}
                  isTyping={isTyping}
                  sourcesCount={sources.length}
                  analyzing={analyzing}
                />
              </div>
            )}
            {tab === 'prompts' && (
              <div className="h-full">
                <PromptsColumn
                  prompts={prompts}
                  onToast={showToast}
                  newId={newPromptId}
                  onGenerateMore={generateMore}
                  generating={generating}
                />
              </div>
            )}
          </div>
        </main>
      )}

      <MobileTabBar tab={tab} setTab={setTab} sourcesCount={sources.length} promptCount={prompts.length} />

      <AddSourceModal open={modalOpen} initialTab={modalInitialTab} onClose={() => setModalOpen(false)} onAdd={addSource} />
      <EditSourceModal source={editingSource} onClose={() => setEditingSource(null)} onSave={saveEditedSource} />
      <Toast text={toast} />
    </div>
  );
}
