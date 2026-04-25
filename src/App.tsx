'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AddSourceModal, type AddTab } from './components/AddSourceModal';
import { ChatColumn } from './components/ChatColumn';
import { EditSourceModal } from './components/EditSourceModal';
import { MobileTabBar } from './components/MobileTabBar';
import { MobileTopBar } from './components/MobileTopBar';
import { PromptsColumn } from './components/PromptsColumn';
import { ResearchNav } from './components/ResearchNav';
import { SourcesColumn } from './components/SourcesColumn';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useTheme } from './hooks/useTheme';
import { useIsDesktop } from './hooks/useViewport';
import { useWorkspace } from './hooks/useWorkspace';
import type { Message, PortfolioPrompt, Source } from './types';

type MobileTab = 'sources' | 'chat' | 'prompts';

export default function App() {
  const isDesktop = useIsDesktop();
  const { theme, toggle: toggleTheme } = useTheme();
  const ws = useWorkspace();

  const [tab, setTab] = useState<MobileTab>('chat');
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitialTab, setModalInitialTab] = useState<AddTab>('upload');
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [toast, setToast] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [newPromptId, setNewPromptId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [pendingRenameId, setPendingRenameId] = useState<string | null>(null);
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

  // Reset transient UI state when switching research sessions.
  useEffect(() => {
    setIsTyping(false);
    setAnalyzing(false);
    setAnalyzingId(null);
    setGenerating(false);
    setNewPromptId(null);
    setEditingSource(null);
  }, [ws.activeResearch.id]);

  const sources = ws.activeResearch.sources;
  const messages = ws.activeResearch.messages;
  const prompts = ws.activeResearch.prompts;

  const setSources: Dispatch<SetStateAction<Source[]>> = useCallback(
    (next) => {
      ws.updateActiveResearch((r) => ({
        ...r,
        sources: typeof next === 'function' ? (next as (p: Source[]) => Source[])(r.sources) : next,
      }));
    },
    [ws]
  );

  const openAdd = useCallback((initial?: AddTab) => {
    setModalInitialTab(initial ?? 'upload');
    setModalOpen(true);
  }, []);

  const addSource = (payload: Omit<Source, 'id'>) => {
    const id = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    ws.updateActiveResearch((r) => ({ ...r, sources: [{ id, ...payload }, ...r.sources] }));
    setAnalyzingId(id);
    setAnalyzing(true);
    setTimeout(() => {
      setAnalyzing(false);
      setAnalyzingId(null);
    }, 2400);
    showToast('Source added · indexing');
  };

  const saveEditedSource = (next: Source) => {
    ws.updateActiveResearch((r) => ({
      ...r,
      sources: r.sources.map((s) => (s.id === next.id ? next : s)),
    }));
    showToast('Source updated');
  };

  const sendMessage = (text: string) => {
    const now = new Date();
    const t = `${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;
    const userMsg: Message = { id: 'u_' + Date.now().toString(36), role: 'user', time: t, text };
    ws.updateActiveResearch((r) => ({ ...r, messages: [...r.messages, userMsg] }));
    setIsTyping(true);
    setTimeout(() => {
      const replies = [
        "Got it. I'll fold that into the next pass — adding two prompts that lean on the price gap and one that anchors on recycled-material credibility.",
        "Useful. That changes the persona prompts in particular — 'beginner' is doing a lot of work in the queries; I'll swap in 'late starter' and 'casual miler' variants.",
        "Noted. I'll re-cluster around that. Expect three new sustainability prompts and a refreshed comparison cluster within the next 30 seconds.",
      ];
      const reply = replies[Math.floor(Math.random() * replies.length)]!;
      const replyMsg: Message = { id: 'a_' + Date.now().toString(36), role: 'agent', time: t, text: reply };
      ws.updateActiveResearch((r) => ({ ...r, messages: [...r.messages, replyMsg] }));
      setIsTyping(false);
    }, 1400);
  };

  const generateMore = () => {
    setGenerating(true);
    setTimeout(() => {
      const stamp = Date.now().toString(36);
      const newPrompts: PortfolioPrompt[] = [
        { id: 'np1_' + stamp, cluster: 'Category', text: 'Activewear made from recycled ocean plastic — best-rated brands', hits: 0, intent: 'High' },
        { id: 'np2_' + stamp, cluster: 'Category', text: 'Carbon-neutral running apparel under $100', hits: 0, intent: 'Med' },
        { id: 'np3_' + stamp, cluster: 'Persona', text: 'Eco-conscious runners looking to switch from fast-fashion brands', hits: 0, intent: 'High' },
      ];
      ws.updateActiveResearch((r) => ({ ...r, prompts: [...newPrompts, ...r.prompts] }));
      setNewPromptId(newPrompts[0]!.id);
      setGenerating(false);
      showToast('Added 3 sustainability prompts');
      setTimeout(() => setNewPromptId(null), 1200);
    }, 1600);
  };

  const handleCreateProject = useCallback(() => {
    const project = ws.createProject('New project');
    showToast('Project created');
    // Switching to a fresh project also creates a blank research; flag it for inline rename.
    const blankResearch = ws.state.researches.find((r) => r.projectId === project.id);
    if (blankResearch) setPendingRenameId(blankResearch.id);
    else setPendingRenameId(ws.activeResearch.id);
    if (!isDesktop) setTab('sources');
  }, [ws, isDesktop, showToast]);

  const handleCreateResearch = useCallback(() => {
    const research = ws.createResearch('Untitled research');
    setPendingRenameId(research.id);
    showToast('Research started');
    if (!isDesktop) setTab('sources');
  }, [ws, isDesktop, showToast]);

  const handleRenameActiveResearch = useCallback(
    (name: string) => {
      ws.renameResearch(ws.activeResearch.id, name);
    },
    [ws]
  );

  const clearPendingRename = useCallback(() => {
    setPendingRenameId(null);
  }, []);

  const nav = (
    <ResearchNav
      projects={ws.projects}
      allResearches={ws.state.researches}
      activeProject={ws.activeProject}
      activeResearch={ws.activeResearch}
      onSelectProject={ws.setActiveProject}
      onSelectResearch={ws.setActiveResearch}
      onCreateProject={handleCreateProject}
      onRenameProject={ws.renameProject}
      onDeleteProject={ws.deleteProject}
      onCreateResearch={handleCreateResearch}
      onRenameResearch={ws.renameResearch}
      onDeleteResearch={ws.deleteResearch}
    />
  );

  const renameOnMount = pendingRenameId === ws.activeResearch.id;

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
                key={ws.activeResearch.id}
                sources={sources}
                setSources={setSources}
                onAdd={openAdd}
                onEdit={setEditingSource}
                analyzingId={analyzingId}
                navSlot={nav}
                researchName={ws.activeResearch.name}
                onRenameResearch={handleRenameActiveResearch}
                renameOnMount={renameOnMount}
                onRenameConsumed={clearPendingRename}
              />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <ChatColumn
                key={ws.activeResearch.id}
                messages={messages}
                onSend={sendMessage}
                isTyping={isTyping}
                sourcesCount={sources.length}
                analyzing={analyzing}
              />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <PromptsColumn
                key={ws.activeResearch.id}
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
                  key={ws.activeResearch.id}
                  sources={sources}
                  setSources={setSources}
                  onAdd={openAdd}
                  onEdit={setEditingSource}
                  analyzingId={analyzingId}
                  navSlot={nav}
                  researchName={ws.activeResearch.name}
                  onRenameResearch={handleRenameActiveResearch}
                  renameOnMount={renameOnMount}
                  onRenameConsumed={clearPendingRename}
                />
              </div>
            )}
            {tab === 'chat' && (
              <div className="h-full">
                <ChatColumn
                  key={ws.activeResearch.id}
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
                  key={ws.activeResearch.id}
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
