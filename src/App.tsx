'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import posthog from 'posthog-js';
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
import { useSaveStatus, type SaveStatus } from './hooks/useSaveStatus';
import { useTheme } from './hooks/useTheme';
import { useIsDesktop } from './hooks/useViewport';
import { useWorkspace, type AddSourcePayload, type UseWorkspaceResult } from './hooks/useWorkspace';
import type { Source } from './types';

interface AppProps {
  /**
   * Set when the user enters via `/app/<projectId>/<researchId>`. The
   * server route has already validated ownership; we forward to
   * `useWorkspace` so the initial paint lands on the deep-linked pair.
   */
  initialProjectId?: string;
  initialResearchId?: string;
}

type MobileTab = 'sources' | 'chat' | 'prompts';

/**
 * Gate component — calls useWorkspace and shows a loading state until the
 * Supabase fetch completes. Once loaded, hands the workspace to AppContent
 * as a prop so AppContent's internal hooks can assume non-null data and
 * stay rules-of-hooks-compliant.
 */
export default function App({ initialProjectId, initialResearchId }: AppProps = {}) {
  const saveStatus = useSaveStatus();
  const ws = useWorkspace({ initialProjectId, initialResearchId, saveStatus });
  if (!ws) {
    // CSS variables (--bg, --ink-2) cascade from the data-theme attribute
    // set on <html> by the bootstrap script in app/layout.tsx, so the
    // loading state honours the user's theme without re-running useTheme().
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--ink-2)] text-[13.5px] font-[Inter]">
        Loading workspace…
      </div>
    );
  }
  return <AppContent ws={ws} saveStatus={saveStatus.status} />;
}

function AppContent({ ws, saveStatus }: { ws: UseWorkspaceResult; saveStatus: SaveStatus }) {
  const isDesktop = useIsDesktop();
  const { theme, toggle: toggleTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  // True until we've performed the very first URL alignment after the
  // workspace finishes hydrating. The first sync uses `replace` so the
  // user can still hit the browser back button to escape /app entirely;
  // subsequent project/research switches use `push` so back returns to
  // the previous research.
  const initialUrlSyncRef = useRef(true);
  // Tracks the path the URL effect last reconciled to, so a back/forward
  // navigation can be distinguished from our own router.push echo.
  const lastSyncedPathRef = useRef<string | null>(null);

  const [tab, setTab] = useState<MobileTab>('chat');
  const [modalOpen, setModalOpen] = useState(false);
  const [modalInitialTab, setModalInitialTab] = useState<AddTab>('pdf');
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [toast, setToast] = useState('');
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

  const sources = ws.activeResearch.sources;
  const messages = ws.activeResearch.messages;
  const prompts = ws.activeResearch.prompts;
  const isTyping = ws.isTyping;
  const pendingSource = useMemo(() => sources.find((s) => s.pending), [sources]);
  const analyzing = Boolean(pendingSource);
  const analyzingId = pendingSource?.id ?? null;
  // Run research needs at least one indexed source (a seed user line is
  // inserted server-side when the chat is still empty).
  const canRunResearch = sources.length > 0;
  // Run id used to download the Markdown report once a run completes.
  const latestRunId = ws.activeResearch.latestRunId ?? null;

  // Reset transient UI state when switching research sessions.
  // `isTyping` is per-research inside `useWorkspace`, so it doesn't need
  // a manual reset here — switching just reads a different slot.
  useEffect(() => {
    setEditingSource(null);
  }, [ws.activeResearch.id]);

  // PostHog group analytics: attach the current Siftie project (workspace)
  // to every subsequent browser event. Server-side ph.capture sites pass
  // `groups: { project }` explicitly per call. Off-prod posthog.init never
  // ran (see app/PostHogProvider.tsx), so this is a no-op on previews/dev.
  useEffect(() => {
    const projectId = ws.activeProject?.id;
    if (!projectId) return;
    if (projectId === 'p_offline') return;
    posthog.group('project', projectId, {
      name: ws.activeProject.name,
    });
  }, [ws.activeProject?.id, ws.activeProject?.name]);

  // ---------------------------------------------------------------------
  // URL ⇄ active-pair sync (bidirectional).
  //
  // Persists the current project/research as a deep-linkable
  // `/app/<projectId>/<researchId>` URL so:
  //   • Sharing a link lands the recipient on the same research (the
  //     server route validates ownership and falls back to /app on a
  //     mismatch — no information leak).
  //   • The browser back/forward buttons walk through recent research
  //     switches naturally — when the URL changes externally we adopt
  //     it into workspace state instead of pushing back to where we were.
  //   • Hard refresh restores the same view without depending on
  //     localStorage.
  //
  // Skips temp/optimistic ids and the offline fallback so the URL never
  // contains `r_tmp_xxx` / `p_offline` — those reconcile to real UUIDs
  // within a network round-trip and the effect re-runs to push the
  // canonical URL.
  // ---------------------------------------------------------------------
  const activeProjectId = ws.activeProject?.id;
  const activeResearchId = ws.activeResearch?.id;
  useEffect(() => {
    if (!activeProjectId || !activeResearchId) return;
    if (
      activeProjectId === 'p_offline' ||
      activeProjectId.startsWith('p_tmp_') ||
      activeResearchId.startsWith('r_tmp_')
    ) {
      return;
    }
    const desired = `/app/${activeProjectId}/${activeResearchId}`;

    // URL → state: pathname diverged from the last value we ourselves
    // pushed AND from the current state — that means the browser
    // navigated us (back/forward, hash, deep link) and we should adopt
    // it. We only adopt when the URL points at a research/project pair
    // that actually exists locally; otherwise the server route would
    // already have redirected, and we leave state alone so the
    // state→URL branch below pushes the canonical pair.
    if (pathname !== desired && pathname !== lastSyncedPathRef.current) {
      const match = pathname.match(/^\/app\/([^/]+)\/([^/]+)$/);
      if (match) {
        const urlPid = match[1];
        const urlRid = match[2];
        const exists = ws.state.researches.some(
          (r) => r.id === urlRid && r.projectId === urlPid,
        );
        if (exists && urlRid !== activeResearchId) {
          ws.setActiveResearch(urlRid);
          lastSyncedPathRef.current = pathname;
          initialUrlSyncRef.current = false;
          return;
        }
      }
    }

    // State → URL.
    if (pathname === desired) {
      lastSyncedPathRef.current = desired;
      initialUrlSyncRef.current = false;
      return;
    }
    lastSyncedPathRef.current = desired;
    if (initialUrlSyncRef.current) {
      initialUrlSyncRef.current = false;
      router.replace(desired);
    } else {
      router.push(desired);
    }
  }, [activeProjectId, activeResearchId, pathname, router, ws]);

  const openAdd = useCallback((initial?: AddTab) => {
    setModalInitialTab(initial ?? 'pdf');
    setModalOpen(true);
  }, []);

  const addSource = useCallback(
    async (payload: AddSourcePayload) => {
      showToast('Source indexing…');
      try {
        await ws.addSource(payload);
        showToast('Source indexed');
      } catch (err) {
        const maybe = err as Error & { code?: string; provider?: string };
        if (maybe.code === 'missing_key') {
          showToast(`Missing ${maybe.provider ?? 'provider'} key`);
          window.location.href = '/settings/api-keys?onboarding=1';
        } else {
          // postSource() preserves the server's `message` (and trims it) on
          // the thrown error, so surfacing it gives the toast real context
          // instead of a generic "Source failed" — the modal stays open
          // with the same message either way.
          showToast(maybe.message || 'Source failed');
        }
        throw err;
      }
    },
    [ws, showToast]
  );

  const removeSource = useCallback(
    async (id: string) => {
      try {
        await ws.removeSource(id);
        showToast('Source removed');
      } catch {
        showToast('Could not remove source');
      }
    },
    [ws, showToast]
  );

  const reindexSource = useCallback(
    async (id: string) => {
      try {
        await ws.reindexSource(id);
        showToast('Source re-indexed');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not re-index source';
        showToast(message);
      }
    },
    [ws, showToast]
  );

  const saveEditedSource = (next: Source) => {
    ws.updateActiveResearch((r) => ({
      ...r,
      sources: r.sources.map((s) => (s.id === next.id ? next : s)),
    }));
    showToast('Source updated');
  };

  const sendMessage = useCallback(
    async (text: string) => {
      try {
        await ws.sendMessage(text);
      } catch (err) {
        const maybe = err as Error & { code?: string; provider?: string };
        // The interview generator needs Gemini — surface a guided
        // error if the user hasn't configured it yet so they don't
        // wonder why nothing happened.
        if (maybe.code === 'missing_key') {
          showToast(`Missing ${maybe.provider ?? 'provider'} key`);
          window.location.href = '/settings/api-keys?onboarding=1';
        } else if (maybe.code === 'quota_exhausted') {
          showToast('Provider quota exhausted — try a different key');
        } else {
          showToast('Send failed');
        }
      }
    },
    [ws, showToast],
  );

  const cancelResearch = useCallback(async () => {
    try {
      await ws.cancelResearch();
      showToast('Stopping run…');
    } catch {
      // useWorkspace.cancelResearch already swallows fetch failures
      // and logs them — it never throws — but keep the catch defensive.
    }
  }, [ws, showToast]);

  const runResearch = useCallback(async () => {
    showToast('Starting research…');
    try {
      await ws.runResearch();
      showToast('Council is working');
    } catch (err) {
      const maybe = err as Error & { code?: string };
      // Map server-side validation codes to friendly toasts. The
      // first three are recoverable (user can fix in-app); the
      // missing key codes deep-link to settings the same way
      // sendMessage does so the user doesn't have to hunt.
      switch (maybe.code) {
        case 'no_sources':
          showToast('Add at least one source first');
          break;
        case 'no_user_messages':
          showToast('Could not add a starter message for this run');
          break;
        case 'missing_ideate_key':
        case 'missing_openrouter_key':
          showToast(
            maybe.code === 'missing_ideate_key'
              ? 'Add your OpenAI key (preferred) or Gemini key'
              : 'Missing OpenRouter key',
          );
          window.location.href = '/settings/api-keys?onboarding=1';
          break;
        default:
          showToast('Could not start research');
      }
    }
  }, [ws, showToast]);

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
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar theme={theme} onToggleTheme={toggleTheme} saveStatus={saveStatus} />
      <MobileTopBar tab={tab} theme={theme} onToggleTheme={toggleTheme} />

      {isDesktop ? (
        <main className="flex-1 min-h-0 px-4 lg:px-6 py-4 lg:py-5">
          <div
            className="grid h-full min-h-0 gap-4 lg:gap-5"
            style={{ gridTemplateColumns: 'minmax(260px, 320px) minmax(380px, 1fr) minmax(280px, 360px)' }}
          >
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <SourcesColumn
                key={ws.activeResearch.id}
                sources={sources}
                onRemoveSource={removeSource}
                onReindexSource={reindexSource}
                onAdd={openAdd}
                onEdit={setEditingSource}
                analyzingId={analyzingId}
                navSlot={nav}
                researchName={ws.activeResearch.name}
                onRenameResearch={handleRenameActiveResearch}
                renameOnMount={renameOnMount}
                onRenameConsumed={clearPendingRename}
                onRunResearch={runResearch}
                onCancelResearch={cancelResearch}
                runStatus={ws.activeResearch.runStatus}
                canRunResearch={canRunResearch}
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
                runStatus={ws.activeResearch.runStatus}
              />
            </div>
            <div className="col-card overflow-hidden flex flex-col min-h-0">
              <PromptsColumn
                key={ws.activeResearch.id}
                researchId={ws.activeResearch.id}
                prompts={prompts}
                onToast={showToast}
                totalChannels={ws.activeResearch.latestTotalChannels ?? 0}
                channels={ws.activeResearch.latestChannels ?? []}
                peecSkipped={ws.activeResearch.latestPeecSkipped ?? false}
                runStatus={ws.activeResearch.runStatus}
                latestRunId={latestRunId}
                onSendChatMessage={sendMessage}
                onRefreshHits={ws.refreshHits}
              />
            </div>
          </div>
        </main>
      ) : (
        // Reserve room for the fixed MobileTabBar (~58px content + safe-area).
        // calc() with env(safe-area-inset-bottom) keeps the chat composer
        // above the iPhone home indicator instead of underneath it.
        <main className="flex-1 flex flex-col min-h-0 pb-[calc(58px+env(safe-area-inset-bottom))]">
          <div className="flex-1 min-h-0">
            {tab === 'sources' && (
              <div className="h-full">
                <SourcesColumn
                  key={ws.activeResearch.id}
                  sources={sources}
                  onRemoveSource={removeSource}
                  onReindexSource={reindexSource}
                  onAdd={openAdd}
                  onEdit={setEditingSource}
                  analyzingId={analyzingId}
                  navSlot={nav}
                  researchName={ws.activeResearch.name}
                  onRenameResearch={handleRenameActiveResearch}
                  renameOnMount={renameOnMount}
                  onRenameConsumed={clearPendingRename}
                  onRunResearch={runResearch}
                  onCancelResearch={cancelResearch}
                  runStatus={ws.activeResearch.runStatus}
                  canRunResearch={canRunResearch}
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
                  runStatus={ws.activeResearch.runStatus}
                />
              </div>
            )}
            {tab === 'prompts' && (
              <div className="h-full">
                <PromptsColumn
                  key={ws.activeResearch.id}
                  researchId={ws.activeResearch.id}
                  prompts={prompts}
                  onToast={showToast}
                  totalChannels={ws.activeResearch.latestTotalChannels ?? 0}
                  channels={ws.activeResearch.latestChannels ?? []}
                  peecSkipped={ws.activeResearch.latestPeecSkipped ?? false}
                  runStatus={ws.activeResearch.runStatus}
                  latestRunId={latestRunId}
                  onSendChatMessage={sendMessage}
                  onRefreshHits={ws.refreshHits}
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
