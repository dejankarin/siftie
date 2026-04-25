import { useSession } from '@clerk/nextjs';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserSupabaseClient } from '../../lib/supabase/client';
import { blankIntroMessage, createBlankResearch } from '../data/workspace';
import type {
  ContextDoc,
  CouncilDepth,
  Message,
  PortfolioPrompt,
  Project,
  Research,
  Source,
  WorkspaceState,
} from '../types';

/**
 * Workspace hook — Supabase edition.
 *
 * Behaviour:
 *   - On mount: GETs /api/workspace which returns the user's projects,
 *     researches, every existing source AND every persisted message from
 *     Supabase in a single round-trip. Returns `null` while in flight so
 *     callers can show a loading state without the hooks-rules dance of
 *     conditionally calling other hooks.
 *   - Project + research CRUD goes through API routes that hit Supabase.
 *     Mutations are optimistic — local state updates first, the network
 *     call fires in the background. On failure we log + leave the optimistic
 *     update in place; the next reload re-syncs from Supabase as the source
 *     of truth, so any temporary divergence self-heals.
 *   - Source CRUD (Session 3) is also optimistic, but uses a `pending: true`
 *     flag on the temporary row so the UI can show the analyzing pulse for
 *     as long as the network call takes (Gemini ingest can be 5-30s).
 *     Failures roll back the optimistic insert and surface an error string
 *     to the caller.
 *   - Chat messages (Session 4): `sendMessage` POSTs to /api/messages,
 *     persists the user message, and (for the very first message of a
 *     research with sources) generates 6 opening interview questions via
 *     Gemini Flash. We optimistically insert the user message with a
 *     temp id, replace it with the canonical row from the POST response,
 *     then rely on the Supabase Realtime channel below for any future
 *     agent messages (e.g. council bubbles in Session 6) to stream in.
 *   - Realtime: a single channel subscribes to INSERTs on `public.messages`
 *     for the whole user (RLS already filters to messages they own). The
 *     handler dedupes by id against a `seenMessageIds` ref so a row that
 *     arrived via the POST response isn't appended twice.
 *   - Prompts inside a research stay client-side until Session 5/7 wires
 *     them up to their own table.
 *   - Active project/research IDs are persisted to localStorage (just the
 *     two strings, ~80 bytes) so reload returns to the same view without a
 *     second server round-trip.
 */

const ACTIVE_KEY = 'siftie.workspace.v1.active';

interface ActiveIds {
  projectId: string;
  researchId: string;
}

interface ApiSourceMeta {
  kind: 'pdf' | 'url' | 'doc' | 'md';
  // Per-kind fields are loose on the client because the UI only uses a
  // small subset (host for url, filename for pdf/doc) — keeping it as
  // `unknown` lets the server add fields without breaking client builds.
  [k: string]: unknown;
}

interface ApiSource {
  id: string;
  researchId: string;
  kind: 'pdf' | 'url' | 'doc' | 'md';
  title: string;
  meta: ApiSourceMeta;
  snippet: string;
  contextDoc: ContextDoc;
  createdAt: number;
  updatedAt: number;
}

interface ApiMessage {
  id: string;
  researchId: string;
  role: 'user' | 'agent';
  body: string;
  createdAt: number;
  councilRole: 'reviewer' | 'chair' | null;
  councilSeat: number | null;
  runId: string | null;
}

interface ApiRun {
  id: string;
  researchId: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  councilDepth: CouncilDepth;
  prompts: PortfolioPrompt[];
  totalChannels: number;
  peecSkipped: boolean;
  startedAt: number;
  finishedAt: number | null;
}

interface ApiWorkspaceResponse {
  projects: { id: string; name: string; createdAt: number }[];
  researches: {
    id: string;
    projectId: string;
    name: string;
    councilDepth: CouncilDepth;
    createdAt: number;
  }[];
  sources: ApiSource[];
  /**
   * Every persisted message for every research the user owns, ordered
   * oldest-first inside each research (chat order). Empty for fresh
   * researches — the UI swaps in a synthetic intro bubble in that case.
   */
  messages: ApiMessage[];
  /** Latest run per research; drives the Prompts column on first paint. */
  latestRuns: ApiRun[];
}

/**
 * Discriminated payload the modal hands to `addSource`. Mirrors the
 * `/api/sources` route's accepted shapes — File for binary uploads,
 * plain strings for text sources.
 */
export type AddSourcePayload =
  | { kind: 'pdf'; file: File }
  | { kind: 'url'; url: string }
  | { kind: 'doc'; file: File }
  | { kind: 'md'; text: string; title?: string };

export interface UseWorkspaceResult {
  state: WorkspaceState;
  projects: Project[];
  researchesForActiveProject: Research[];
  activeProject: Project;
  activeResearch: Research;
  setActiveProject: (id: string) => void;
  setActiveResearch: (id: string) => void;
  createProject: (name?: string) => Project;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  createResearch: (name?: string, projectId?: string) => Research;
  renameResearch: (id: string, name: string) => void;
  deleteResearch: (id: string) => void;
  updateActiveResearch: (updater: (r: Research) => Research) => void;
  /**
   * Add a source to the active research. Resolves with the persisted
   * source row on success, throws with a `{ code, message }` shape on
   * failure (so the UI can branch on `code === 'missing_key'`).
   *
   * The optimistic placeholder appears immediately; the analyzing pulse
   * stays on until this promise settles.
   */
  addSource: (payload: AddSourcePayload) => Promise<Source>;
  /** Remove a source by id (optimistic; rolls back on failure). */
  removeSource: (sourceId: string) => Promise<void>;
  /** Re-run the ingest pipeline for an existing source. */
  reindexSource: (sourceId: string) => Promise<Source>;
  /**
   * Send a chat message to the active research. Optimistically inserts
   * the user message, POSTs to /api/messages, replaces the optimistic
   * row with the canonical persisted row, and (when the server tells us
   * an agent reply is coming) keeps `isTyping` true while the agent
   * messages stream in via Realtime — or arrive in the POST response,
   * whichever lands first.
   *
   * Resolves with `void` once the POST settles. Throws on network /
   * server failures so the caller can show a toast.
   */
  sendMessage: (text: string) => Promise<void>;
  /**
   * Update the Council depth on the active research. Optimistic +
   * server-confirmed via PATCH /api/researches/{id}.
   */
  setCouncilDepth: (depth: CouncilDepth) => void;
  /**
   * Kick off a research run for the active research. Resolves once
   * the server has accepted the request (HTTP 202). Throws on
   * validation / server errors with `code` set to a stable short
   * string the caller can branch on.
   */
  runResearch: () => Promise<void>;
  /**
   * True while the active research has an agent reply in flight. Drives
   * the typing-bubble in `<ChatColumn />`.
   */
  isTyping: boolean;
}

function readActiveIds(): ActiveIds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.projectId === 'string' && typeof parsed?.researchId === 'string') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeActiveIds(ids: ActiveIds) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(ids));
  } catch {
    // ignore (private mode, quota)
  }
}

/**
 * Map the server's Source row into the client-side Source shape.
 *   - server `kind` → client `type` (the existing UI prop name).
 *   - server's structured `meta` JSONB → human-readable subtitle string.
 *   - full ContextDoc is preserved on `contextDoc`.
 *   - `pending` stays unset (server rows are by definition not in flight).
 */
function apiSourceToClient(s: ApiSource): Source {
  return {
    id: s.id,
    type: s.kind,
    title: s.title,
    meta: formatMeta(s.kind, s.meta, s.contextDoc, s.createdAt),
    snippet: s.snippet || s.contextDoc?.summary || '',
    contextDoc: s.contextDoc,
  };
}

/**
 * Compose the per-source subtitle the UI shows under the title.
 * Examples:
 *   pdf:  "12 pages · 2 min ago"
 *   url:  "competitor.com · just now"
 *   doc:  "1,840 words · just now"
 *   md:   "420 words · just now"
 *
 * We deliberately re-derive page/word counts at hydrate time so that
 * formatting tweaks ship via the client bundle (no DB migration needed).
 */
function formatMeta(
  kind: 'pdf' | 'url' | 'doc' | 'md',
  meta: ApiSourceMeta,
  contextDoc: ContextDoc | undefined,
  createdAt: number,
): string {
  const when = humanTime(createdAt);
  if (kind === 'url') {
    const host = typeof meta.host === 'string' && meta.host ? meta.host : 'web';
    return `${host} · ${when}`;
  }
  const words = contextDoc?.words ?? 0;
  if (kind === 'pdf') {
    // We don't have pages on the server (Gemini doesn't return them); use
    // word count as a proxy that's still meaningful to the user.
    return words > 0 ? `${words.toLocaleString()} words · ${when}` : `PDF · ${when}`;
  }
  if (kind === 'doc') {
    return words > 0 ? `${words.toLocaleString()} words · ${when}` : `Word doc · ${when}`;
  }
  return words > 0 ? `${words.toLocaleString()} words · ${when}` : `Markdown · ${when}`;
}

function humanTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 45) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Map a server message row → the client `Message` shape the chat UI
 * consumes. Carries `createdAt` through so per-run dividers in
 * Session 6 can group by run timestamp.
 */
function apiMessageToClient(m: ApiMessage): Message {
  return {
    id: m.id,
    role: m.role,
    text: m.body,
    time: formatMessageTime(m.createdAt),
    createdAt: m.createdAt,
    councilRole: m.councilRole,
    councilSeat: m.councilSeat,
    runId: m.runId,
  };
}

/**
 * Display-format a message timestamp the way the existing UI expects
 * (e.g. "2:45 PM"). Kept local so tests / Storybook don't need to mock
 * `toLocaleTimeString`.
 */
function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const hours12 = d.getHours() % 12 || 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `${hours12}:${minutes} ${ampm}`;
}

/**
 * Convert the API's flat shape into the in-memory WorkspaceState the
 * existing UI expects.
 *
 * Sources are bucketed by research_id, mapped into the client `Source`
 * shape (kind→type, structured meta→display string, full ContextDoc
 * preserved). Messages and prompts stay empty/intro until Sessions 4+5.
 */
function hydrate(api: ApiWorkspaceResponse): WorkspaceState {
  const projects: Project[] = api.projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
  }));

  const sourcesByResearch = new Map<string, Source[]>();
  for (const s of api.sources ?? []) {
    const existing = sourcesByResearch.get(s.researchId) ?? [];
    existing.push(apiSourceToClient(s));
    sourcesByResearch.set(s.researchId, existing);
  }

  const messagesByResearch = new Map<string, Message[]>();
  for (const m of api.messages ?? []) {
    const existing = messagesByResearch.get(m.researchId) ?? [];
    existing.push(apiMessageToClient(m));
    messagesByResearch.set(m.researchId, existing);
  }

  const latestRunByResearch = new Map<string, ApiRun>();
  for (const run of api.latestRuns ?? []) {
    latestRunByResearch.set(run.researchId, run);
  }

  const researches: Research[] = api.researches.map((r) => {
    // Use server messages when present; otherwise fall back to the
    // synthetic intro bubble so brand-new researches don't render as a
    // sad empty pane. The intro is client-only and disappears as soon
    // as the user sends their first message (which inserts a real row).
    const serverMessages = messagesByResearch.get(r.id);
    const run = latestRunByResearch.get(r.id);
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      createdAt: r.createdAt,
      sources: sourcesByResearch.get(r.id) ?? [],
      messages: serverMessages && serverMessages.length > 0 ? serverMessages : [blankIntroMessage()],
      // Hydrate the persisted portfolio from the latest run (Session 6).
      // For runs that completed we show the full prompt array; for
      // running/failed/pending runs we leave prompts empty (the bar
      // would be wrong) but still surface status so the UI can render
      // a "Working…" / "Failed" indicator.
      prompts: run && run.status === 'complete' ? run.prompts : [],
      councilDepth: r.councilDepth,
      runStatus: run?.status ?? null,
      latestRunId: run?.id ?? null,
      latestTotalChannels: run?.totalChannels ?? 0,
    };
  });

  const stored = readActiveIds();
  let activeProjectId = projects[0]?.id ?? '';
  let activeResearchId = researches[0]?.id ?? '';
  if (stored) {
    const proj = projects.find((p) => p.id === stored.projectId);
    if (proj) {
      activeProjectId = proj.id;
      const matchingResearch = researches.find(
        (r) => r.id === stored.researchId && r.projectId === proj.id,
      );
      if (matchingResearch) {
        activeResearchId = matchingResearch.id;
      } else {
        activeResearchId = researches.find((r) => r.projectId === proj.id)?.id ?? activeResearchId;
      }
    }
  }
  return { projects, researches, activeProjectId, activeResearchId };
}

export function useWorkspace(): UseWorkspaceResult | null {
  const [state, setState] = useState<WorkspaceState | null>(null);
  // Keep a ref of the latest state so async mutators can compute rollbacks
  // without stale closures pinning the React state at hook-creation time.
  const stateRef = useRef<WorkspaceState | null>(null);
  stateRef.current = state;

  // Track the set of research ids that have a pending POST /api/messages
  // in flight. The chat column reads `isTyping` (derived from this set
  // membership for the active research) to decide whether to render the
  // typing bubble.
  const [pendingMessageResearchIds, setPendingMessageResearchIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Track every message id we've already inserted into local state so
  // the Realtime handler can dedupe rows that also arrived via a POST
  // response. A Set is fine — message ids are UUIDs, and the chat
  // history is bounded by what one user can read.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());

  // Clerk session is required to mint Supabase JWTs for the Realtime
  // channel. The client is recreated whenever the session reference
  // changes (sign-out/sign-in), but stays stable across renders.
  const { session } = useSession();
  const supabase = useMemo<SupabaseClient | null>(
    () => (session ? createBrowserSupabaseClient(session) : null),
    [session],
  );

  // -------------------------------------------------------------------------
  // Initial fetch
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspace', { method: 'GET' });
        if (!res.ok) throw new Error(`GET /api/workspace failed (${res.status})`);
        const api = (await res.json()) as ApiWorkspaceResponse;
        if (cancelled) return;
        setState(hydrate(api));
      } catch (err) {
        console.error('[useWorkspace] initial load failed:', err);
        // Fall back to a minimal in-memory workspace so the UI doesn't get
        // stuck on the loading state. Reloading once the network recovers
        // will pull the real workspace from Supabase.
        if (cancelled) return;
        const projectId = 'p_offline';
        const research = createBlankResearch(projectId, 'Untitled research');
        setState({
          projects: [{ id: projectId, name: 'Offline workspace', createdAt: Date.now() }],
          researches: [research],
          activeProjectId: projectId,
          activeResearchId: research.id,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Persist active IDs whenever they change so reload returns to same view.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!state) return;
    writeActiveIds({ projectId: state.activeProjectId, researchId: state.activeResearchId });
  }, [state]);

  // -------------------------------------------------------------------------
  // Track every message id that's currently in state so the Realtime
  // handler below can dedupe rows that arrived via a POST response.
  // We re-derive on each state change rather than try to surgically
  // maintain the Set — cheap, and the state is bounded.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!state) return;
    const seen = seenMessageIdsRef.current;
    for (const r of state.researches) {
      for (const m of r.messages) seen.add(m.id);
    }
  }, [state]);

  // -------------------------------------------------------------------------
  // Realtime subscription — listen for `INSERT` events on the messages
  // table for any research the user owns (RLS handles the filtering)
  // and append new rows to the right research. Skips rows whose id is
  // already in `seenMessageIdsRef`, which catches the common case where
  // the POST response added the row first.
  //
  // Also listens for INSERT/UPDATE on the `runs` table so the Prompts
  // column reflects status flips (`running` → `complete`/`failed`) and
  // the persisted prompts portfolio without a page reload.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!supabase) return;
    let channel: RealtimeChannel | null = null;
    try {
      channel = supabase
        .channel('siftie-messages')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'runs' },
          (payload) => {
            // Postgres-changes payloads have `new` for INSERT/UPDATE
            // and `old` for DELETE. Runs are never deleted by the app,
            // so we only handle INSERT/UPDATE.
            const row = payload.new as
              | {
                  id: string;
                  research_id: string;
                  status: 'pending' | 'running' | 'complete' | 'failed';
                  council_depth: CouncilDepth;
                  prompts: PortfolioPrompt[] | unknown;
                  total_channels: number;
                  peec_skipped: boolean;
                }
              | undefined;
            if (!row?.id) return;
            const safePrompts = Array.isArray(row.prompts)
              ? (row.prompts as PortfolioPrompt[])
              : [];
            setState((s) => {
              if (!s) return s;
              return {
                ...s,
                researches: s.researches.map((r) => {
                  if (r.id !== row.research_id) return r;
                  // Only adopt this run's prompts if it's the latest
                  // run for this research — guards against an
                  // out-of-order UPDATE for an old run racing the new
                  // one. We treat "newer than what we have" as
                  // "matches latestRunId OR we have no run yet".
                  const isLatest = r.latestRunId == null || r.latestRunId === row.id;
                  return {
                    ...r,
                    runStatus: isLatest ? row.status : r.runStatus,
                    latestRunId: isLatest ? row.id : r.latestRunId,
                    latestTotalChannels: isLatest ? row.total_channels : r.latestTotalChannels,
                    // Only swap the displayed portfolio when the run
                    // completes — half-baked prompts arrays from a
                    // mid-flight update would briefly empty the column.
                    prompts:
                      isLatest && row.status === 'complete' ? safePrompts : r.prompts,
                  };
                }),
              };
            });
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const row = payload.new as {
              id: string;
              research_id: string;
              role: 'user' | 'agent';
              body: string;
              created_at: string;
              council_role: 'reviewer' | 'chair' | null;
              council_seat: number | null;
              run_id: string | null;
            };
            if (seenMessageIdsRef.current.has(row.id)) return;
            seenMessageIdsRef.current.add(row.id);
            const message = apiMessageToClient({
              id: row.id,
              researchId: row.research_id,
              role: row.role,
              body: row.body,
              createdAt: new Date(row.created_at).getTime(),
              councilRole: row.council_role,
              councilSeat: row.council_seat,
              runId: row.run_id,
            });
            setState((s) => {
              if (!s) return s;
              return {
                ...s,
                researches: s.researches.map((r) => {
                  if (r.id !== row.research_id) return r;
                  // Drop the synthetic intro bubble the moment a real
                  // server message lands — its only job is to fill the
                  // empty state.
                  const realExisting = r.messages.filter((m) => !m.id.startsWith('m_'));
                  return { ...r, messages: [...realExisting, message] };
                }),
              };
            });
            // If this is an agent message, the typing bubble can stop
            // for this research — the agent has spoken.
            if (row.role === 'agent') {
              setPendingMessageResearchIds((prev) => {
                if (!prev.has(row.research_id)) return prev;
                const next = new Set(prev);
                next.delete(row.research_id);
                return next;
              });
            }
          },
        )
        .subscribe();
    } catch (err) {
      console.error('[useWorkspace] realtime subscribe failed:', err);
    }
    return () => {
      if (channel && supabase) supabase.removeChannel(channel);
    };
  }, [supabase]);

  // -------------------------------------------------------------------------
  // Derived selectors (only valid once state is loaded)
  // -------------------------------------------------------------------------
  const projects = state?.projects ?? [];
  const researchesForActiveProject = useMemo(
    () => (state ? state.researches.filter((r) => r.projectId === state.activeProjectId) : []),
    [state],
  );
  const activeProject = useMemo(
    () => state?.projects.find((p) => p.id === state.activeProjectId) ?? state?.projects[0] ?? null,
    [state],
  );
  const activeResearch = useMemo(
    () =>
      state?.researches.find((r) => r.id === state.activeResearchId) ??
      researchesForActiveProject[0] ??
      null,
    [state, researchesForActiveProject],
  );

  // -------------------------------------------------------------------------
  // Mutators — local optimistic update + background API call.
  // -------------------------------------------------------------------------
  const setActiveProject = useCallback((id: string) => {
    setState((s) => {
      if (!s) return s;
      const project = s.projects.find((p) => p.id === id);
      if (!project) return s;
      const firstResearch = s.researches.find((r) => r.projectId === id);
      if (!firstResearch) return s;
      return { ...s, activeProjectId: id, activeResearchId: firstResearch.id };
    });
  }, []);

  const setActiveResearch = useCallback((id: string) => {
    setState((s) => {
      if (!s) return s;
      const research = s.researches.find((r) => r.id === id);
      if (!research) return s;
      return { ...s, activeProjectId: research.projectId, activeResearchId: research.id };
    });
  }, []);

  const createProject = useCallback((name?: string): Project => {
    // Synchronous return contract is part of the legacy API (callers use the
    // returned id immediately). We optimistically generate a temporary id
    // and reconcile with the server-assigned UUID once the POST resolves.
    const tempId = 'p_tmp_' + Math.random().toString(36).slice(2, 10);
    const tempResearchId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
    const finalName = name?.trim() || 'New project';
    const optimisticProject: Project = { id: tempId, name: finalName, createdAt: Date.now() };
    const optimisticResearch = createBlankResearch(tempId, 'Untitled research');
    optimisticResearch.id = tempResearchId;

    setState((s) =>
      s
        ? {
            projects: [...s.projects, optimisticProject],
            researches: [...s.researches, optimisticResearch],
            activeProjectId: tempId,
            activeResearchId: tempResearchId,
          }
        : s,
    );

    (async () => {
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: finalName }),
        });
        if (!res.ok) throw new Error(`POST /api/projects failed (${res.status})`);
        const { project, research } = (await res.json()) as {
          project: { id: string; name: string; createdAt: number };
          research: {
            id: string;
            projectId: string;
            name: string;
            councilDepth: CouncilDepth;
            createdAt: number;
          };
        };
        setState((s) => {
          if (!s) return s;
          return {
            projects: s.projects.map((p) =>
              p.id === tempId ? { id: project.id, name: project.name, createdAt: project.createdAt } : p,
            ),
            researches: s.researches.map((r) =>
              r.id === tempResearchId
                ? {
                    ...r,
                    id: research.id,
                    projectId: research.projectId,
                    name: research.name,
                    createdAt: research.createdAt,
                    councilDepth: research.councilDepth,
                  }
                : r.projectId === tempId
                  ? { ...r, projectId: research.projectId }
                  : r,
            ),
            activeProjectId: s.activeProjectId === tempId ? project.id : s.activeProjectId,
            activeResearchId: s.activeResearchId === tempResearchId ? research.id : s.activeResearchId,
          };
        });
      } catch (err) {
        console.error('[useWorkspace] createProject failed:', err);
      }
    })();

    return optimisticProject;
  }, []);

  const renameProject = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) =>
      s
        ? {
            ...s,
            projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
          }
        : s,
    );
    void fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch((err) => console.error('[useWorkspace] renameProject failed:', err));
  }, []);

  const deleteProject = useCallback((id: string) => {
    const previous = stateRef.current;
    if (!previous || previous.projects.length <= 1) return;
    const remainingProjects = previous.projects.filter((p) => p.id !== id);
    const remainingResearches = previous.researches.filter((r) => r.projectId !== id);
    const fallbackProject = remainingProjects[0]!;
    const fallbackResearch =
      remainingResearches.find((r) => r.projectId === fallbackProject.id) ??
      remainingResearches[0]!;
    setState({
      projects: remainingProjects,
      researches: remainingResearches,
      activeProjectId: fallbackProject.id,
      activeResearchId: fallbackResearch.id,
    });
    void fetch(`/api/projects/${id}`, { method: 'DELETE' }).catch((err) =>
      console.error('[useWorkspace] deleteProject failed:', err),
    );
  }, []);

  const createResearch = useCallback((name?: string, projectId?: string): Research => {
    const targetProjectId = projectId ?? stateRef.current?.activeProjectId;
    if (!targetProjectId) {
      // Should never happen — state is guaranteed non-null when consumers can
      // call this — but TS demands the guard.
      throw new Error('createResearch called without an active project');
    }
    const finalName = name?.trim() || 'Untitled research';
    const tempId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
    const optimistic = createBlankResearch(targetProjectId, finalName);
    optimistic.id = tempId;

    setState((s) =>
      s
        ? {
            ...s,
            researches: [...s.researches, optimistic],
            activeProjectId: targetProjectId,
            activeResearchId: tempId,
          }
        : s,
    );

    (async () => {
      try {
        const res = await fetch('/api/researches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: targetProjectId, name: finalName }),
        });
        if (!res.ok) throw new Error(`POST /api/researches failed (${res.status})`);
        const { research } = (await res.json()) as {
          research: {
            id: string;
            projectId: string;
            name: string;
            councilDepth: CouncilDepth;
            createdAt: number;
          };
        };
        setState((s) => {
          if (!s) return s;
          return {
            ...s,
            researches: s.researches.map((r) =>
              r.id === tempId
                ? {
                    ...r,
                    id: research.id,
                    projectId: research.projectId,
                    name: research.name,
                    createdAt: research.createdAt,
                    councilDepth: research.councilDepth,
                  }
                : r,
            ),
            activeResearchId: s.activeResearchId === tempId ? research.id : s.activeResearchId,
          };
        });
      } catch (err) {
        console.error('[useWorkspace] createResearch failed:', err);
      }
    })();

    return optimistic;
  }, []);

  const renameResearch = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => (r.id === id ? { ...r, name: trimmed } : r)),
          }
        : s,
    );
    void fetch(`/api/researches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    }).catch((err) => console.error('[useWorkspace] renameResearch failed:', err));
  }, []);

  const deleteResearch = useCallback((id: string) => {
    const previous = stateRef.current;
    if (!previous) return;
    const target = previous.researches.find((r) => r.id === id);
    if (!target) return;
    const projectId = target.projectId;
    const remaining = previous.researches.filter((r) => r.id !== id);
    const sameProject = remaining.filter((r) => r.projectId === projectId);

    if (sameProject.length === 0) {
      // Last research in this project — replace it with a fresh blank so the
      // UI never lands on an empty project. Optimistically swap with a temp
      // research, then reconcile against the server-created one.
      const tempId = 'r_tmp_' + Math.random().toString(36).slice(2, 10);
      const blank = createBlankResearch(projectId, 'Untitled research');
      blank.id = tempId;
      const nextResearches = [...remaining, blank];
      setState({
        ...previous,
        researches: nextResearches,
        activeResearchId: tempId,
      });

      (async () => {
        try {
          await fetch(`/api/researches/${id}`, { method: 'DELETE' });
          const res = await fetch('/api/researches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, name: 'Untitled research' }),
          });
          if (!res.ok) throw new Error(`POST /api/researches failed (${res.status})`);
          const { research } = (await res.json()) as {
            research: {
              id: string;
              projectId: string;
              name: string;
              councilDepth: CouncilDepth;
              createdAt: number;
            };
          };
          setState((s) => {
            if (!s) return s;
            return {
              ...s,
              researches: s.researches.map((r) =>
                r.id === tempId
                  ? {
                      ...r,
                      id: research.id,
                      projectId: research.projectId,
                      name: research.name,
                      createdAt: research.createdAt,
                      councilDepth: research.councilDepth,
                    }
                  : r,
              ),
              activeResearchId: s.activeResearchId === tempId ? research.id : s.activeResearchId,
            };
          });
        } catch (err) {
          console.error('[useWorkspace] deleteResearch (last) failed:', err);
        }
      })();
      return;
    }

    const nextActiveResearchId =
      previous.activeResearchId === id ? sameProject[0]!.id : previous.activeResearchId;
    setState({ ...previous, researches: remaining, activeResearchId: nextActiveResearchId });
    void fetch(`/api/researches/${id}`, { method: 'DELETE' }).catch((err) =>
      console.error('[useWorkspace] deleteResearch failed:', err),
    );
  }, []);

  const updateActiveResearch = useCallback((updater: (r: Research) => Research) => {
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => (r.id === s.activeResearchId ? updater(r) : r)),
          }
        : s,
    );
  }, []);

  // -------------------------------------------------------------------------
  // Source mutators (Session 3) — optimistic with rollback on failure.
  // -------------------------------------------------------------------------
  const addSource = useCallback(async (payload: AddSourcePayload): Promise<Source> => {
    const targetResearchId = stateRef.current?.activeResearchId;
    if (!targetResearchId) throw new Error('No active research');

    // Build an optimistic placeholder so the source card appears
    // immediately. The `pending: true` flag tells SourcesColumn to render
    // the analyzing pulse for as long as the network call takes.
    const tempId = 's_tmp_' + Math.random().toString(36).slice(2, 10);
    const optimistic: Source = {
      id: tempId,
      type: payload.kind,
      title: optimisticTitle(payload),
      meta: 'Indexing…',
      snippet: '',
      pending: true,
    };
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) =>
              r.id === targetResearchId
                ? { ...r, sources: [optimistic, ...r.sources] }
                : r,
            ),
          }
        : s,
    );

    try {
      const persisted = await postSource(targetResearchId, payload);
      const client = apiSourceToClient(persisted);
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) =>
                r.id === targetResearchId
                  ? {
                      ...r,
                      sources: r.sources.map((src) => (src.id === tempId ? client : src)),
                    }
                  : r,
              ),
            }
          : s,
      );
      return client;
    } catch (err) {
      // Rollback the optimistic insert. We don't try to "merge" partial
      // state because the user has no way to recover an in-flight ingest
      // mid-failure — they just need to retry.
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) =>
                r.id === targetResearchId
                  ? { ...r, sources: r.sources.filter((src) => src.id !== tempId) }
                  : r,
              ),
            }
          : s,
      );
      throw err;
    }
  }, []);

  const removeSource = useCallback(async (sourceId: string): Promise<void> => {
    const previous = stateRef.current;
    if (!previous) return;
    let removed: { researchId: string; source: Source } | null = null;
    for (const r of previous.researches) {
      const found = r.sources.find((s) => s.id === sourceId);
      if (found) {
        removed = { researchId: r.id, source: found };
        break;
      }
    }
    if (!removed) return;

    // Optimistic local removal.
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) =>
              r.id === removed!.researchId
                ? { ...r, sources: r.sources.filter((src) => src.id !== sourceId) }
                : r,
            ),
          }
        : s,
    );

    // Don't fire the DELETE for temp ids — those never existed server-side.
    if (sourceId.startsWith('s_tmp_')) return;

    try {
      const res = await fetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE /api/sources/${sourceId} failed (${res.status})`);
    } catch (err) {
      // Restore on failure so the user can retry.
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) =>
                r.id === removed!.researchId
                  ? { ...r, sources: [removed!.source, ...r.sources] }
                  : r,
              ),
            }
          : s,
      );
      throw err;
    }
  }, []);

  const reindexSource = useCallback(async (sourceId: string): Promise<Source> => {
    if (sourceId.startsWith('s_tmp_')) {
      throw new Error('Cannot re-index a source that hasn\'t finished its first ingest');
    }

    // Mark the row as pending so the analyzing pulse re-appears; we
    // restore the saved meta on success/failure.
    let savedMeta = '';
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => ({
              ...r,
              sources: r.sources.map((src) => {
                if (src.id !== sourceId) return src;
                savedMeta = src.meta;
                return { ...src, meta: 'Re-indexing…', pending: true };
              }),
            })),
          }
        : s,
    );

    try {
      const res = await fetch(`/api/sources/${sourceId}/reindex`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (body as { error?: string })?.error ?? 'unknown_error';
        const message = (body as { message?: string })?.message ?? `Reindex failed (${res.status})`;
        const error: Error & { code?: string } = new Error(message);
        error.code = code;
        throw error;
      }
      const client = apiSourceToClient((body as { source: ApiSource }).source);
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) => ({
                ...r,
                sources: r.sources.map((src) => (src.id === sourceId ? client : src)),
              })),
            }
          : s,
      );
      return client;
    } catch (err) {
      // Restore the previous meta + clear the pending flag.
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) => ({
                ...r,
                sources: r.sources.map((src) =>
                  src.id === sourceId ? { ...src, meta: savedMeta || src.meta, pending: false } : src,
                ),
              })),
            }
          : s,
      );
      throw err;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Chat mutators (Session 4) — optimistic user message + POST + Realtime.
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const targetResearchId = stateRef.current?.activeResearchId;
    if (!targetResearchId) throw new Error('No active research');

    const tempId = 'm_tmp_' + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    const optimistic: Message = {
      id: tempId,
      role: 'user',
      text: trimmed,
      time: formatMessageTime(now),
      createdAt: now,
      pending: true,
    };

    // Insert the optimistic user bubble; drop the synthetic intro
    // bubble (id starts with 'm_') the moment we have a real message
    // to render so the chat doesn't show both.
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) => {
              if (r.id !== targetResearchId) return r;
              const real = r.messages.filter((m) => !m.id.startsWith('m_'));
              return { ...r, messages: [...real, optimistic] };
            }),
          }
        : s,
    );

    // Mark this research as having a reply in flight. The chat column
    // shows the typing bubble until either the response lands with
    // `agentReplyExpected: false` or the agent's first message arrives
    // (cleared inside the Realtime handler above).
    setPendingMessageResearchIds((prev) => {
      const next = new Set(prev);
      next.add(targetResearchId);
      return next;
    });

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ researchId: targetResearchId, body: trimmed }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        messages?: ApiMessage[];
        agentReplyExpected?: boolean;
        warning?: string;
        provider?: string;
        message?: string;
        error?: string;
      };

      if (!res.ok) {
        // Roll back the optimistic insert so the user can retry.
        setState((s) =>
          s
            ? {
                ...s,
                researches: s.researches.map((r) =>
                  r.id === targetResearchId
                    ? { ...r, messages: r.messages.filter((m) => m.id !== tempId) }
                    : r,
                ),
              }
            : s,
        );
        const error: Error & { code?: string; provider?: string } = new Error(
          payload.message ?? `Send failed (${res.status})`,
        );
        error.code = payload.error;
        error.provider = payload.provider;
        throw error;
      }

      const incoming = payload.messages ?? [];
      // Mark all canonical ids as seen BEFORE the setState so any
      // Realtime echo that fires between now and the next render is
      // dropped by the dedupe check.
      for (const m of incoming) seenMessageIdsRef.current.add(m.id);

      setState((s) => {
        if (!s) return s;
        const incomingIds = new Set(incoming.map((m) => m.id));
        return {
          ...s,
          researches: s.researches.map((r) => {
            if (r.id !== targetResearchId) return r;
            // Replace the optimistic bubble with the canonical user row,
            // and append any agent rows that came back in the same
            // response (typically the 6 interview questions). Also drop
            // any rows whose ids are about to be re-added — the
            // Realtime channel may have already delivered them while
            // the POST was awaiting, and we don't want duplicates.
            const real = r.messages.filter(
              (m) => m.id !== tempId && !incomingIds.has(m.id),
            );
            return {
              ...r,
              messages: [...real, ...incoming.map(apiMessageToClient)],
            };
          }),
        };
      });

      // Clear the typing bubble unless the server said an agent reply
      // is still pending (rare in Session 4 — agent reply currently
      // arrives in the same POST response — but Sessions 6+ may
      // background the heavy work).
      if (!payload.agentReplyExpected) {
        setPendingMessageResearchIds((prev) => {
          if (!prev.has(targetResearchId)) return prev;
          const next = new Set(prev);
          next.delete(targetResearchId);
          return next;
        });
      }
    } catch (err) {
      // Drop the typing bubble; the optimistic row is rolled back
      // already (above) when res.ok was false.
      setPendingMessageResearchIds((prev) => {
        if (!prev.has(targetResearchId)) return prev;
        const next = new Set(prev);
        next.delete(targetResearchId);
        return next;
      });
      throw err;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Research mutators (Session 6) — Council depth + run research.
  // -------------------------------------------------------------------------

  /**
   * Update the composer's "Council depth" dropdown for the active
   * research. Optimistic: flips local state immediately, fires the
   * PATCH in the background. On failure we just log — next reload
   * pulls the truth from Supabase, so transient failures self-heal.
   */
  const setCouncilDepth = useCallback((depth: CouncilDepth) => {
    const targetId = stateRef.current?.activeResearchId;
    if (!targetId) return;
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) =>
              r.id === targetId ? { ...r, councilDepth: depth } : r,
            ),
          }
        : s,
    );
    void fetch(`/api/researches/${targetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ councilDepth: depth }),
    }).catch((err) => console.error('[useWorkspace] setCouncilDepth failed:', err));
  }, []);

  /**
   * Trigger a research run for the active research. POSTs
   * `/api/research`, which returns 202 and continues the work in
   * `waitUntil`. Council narration messages stream in via the existing
   * Realtime channel; the runs subscription below flips
   * `runStatus` to `complete`/`failed` and writes the final prompts.
   *
   * Throws an Error with `code` set to one of the server's known
   * error codes (`no_sources`, `no_user_messages`, `missing_*_key`)
   * so the caller can show a targeted toast.
   */
  const runResearch = useCallback(async (): Promise<void> => {
    const targetId = stateRef.current?.activeResearchId;
    if (!targetId) throw new Error('No active research');
    // Optimistic indicator: flip to `pending` until the server's 202
    // lands (which gives us the runId) and Realtime takes over.
    setState((s) =>
      s
        ? {
            ...s,
            researches: s.researches.map((r) =>
              r.id === targetId ? { ...r, runStatus: 'pending' } : r,
            ),
          }
        : s,
    );
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ researchId: targetId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        runId?: string;
        reused?: boolean;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        // Roll back the indicator so the Run button comes back.
        setState((s) =>
          s
            ? {
                ...s,
                researches: s.researches.map((r) =>
                  r.id === targetId ? { ...r, runStatus: null } : r,
                ),
              }
            : s,
        );
        const err: Error & { code?: string } = new Error(
          body.message ?? `Run failed (${res.status})`,
        );
        err.code = body.error ?? 'unknown';
        throw err;
      }
      // Bind the runId locally so we can match Realtime events. The
      // server has now created the run row; flip indicator to
      // `running`. The Realtime UPDATE handler below will move it to
      // `complete` / `failed` when the orchestration finishes.
      const runId = body.runId ?? null;
      setState((s) =>
        s
          ? {
              ...s,
              researches: s.researches.map((r) =>
                r.id === targetId ? { ...r, runStatus: 'running', latestRunId: runId } : r,
              ),
            }
          : s,
      );
    } catch (err) {
      // Re-throw so the caller can toast. State has already been
      // rolled back above on the !res.ok branch.
      throw err;
    }
  }, []);

  if (!state || !activeProject || !activeResearch) {
    return null;
  }

  return {
    state,
    projects,
    researchesForActiveProject,
    activeProject,
    activeResearch,
    setActiveProject,
    setActiveResearch,
    createProject,
    renameProject,
    deleteProject,
    createResearch,
    renameResearch,
    deleteResearch,
    updateActiveResearch,
    addSource,
    removeSource,
    reindexSource,
    sendMessage,
    setCouncilDepth,
    runResearch,
    isTyping: pendingMessageResearchIds.has(state.activeResearchId),
  };
}

/**
 * Pick a sensible title for the optimistic placeholder while we wait for
 * Gemini to return the canonical one. URLs use the host, files use the
 * filename, markdown shows a generic label.
 */
function optimisticTitle(payload: AddSourcePayload): string {
  switch (payload.kind) {
    case 'url':
      try {
        return new URL(payload.url).host;
      } catch {
        return payload.url.slice(0, 60);
      }
    case 'pdf':
    case 'doc':
      return payload.file.name || (payload.kind === 'pdf' ? 'Uploading PDF…' : 'Uploading document…');
    case 'md':
      return payload.title || 'Markdown note';
  }
}

/**
 * POST a new source to the API. JSON for url/md, multipart for pdf/doc.
 * Throws with `error.code` set to the server's stable code on non-2xx.
 */
async function postSource(researchId: string, payload: AddSourcePayload): Promise<ApiSource> {
  let res: Response;
  if (payload.kind === 'pdf' || payload.kind === 'doc') {
    const form = new FormData();
    form.set('researchId', researchId);
    form.set('kind', payload.kind);
    form.set('file', payload.file);
    res = await fetch('/api/sources', { method: 'POST', body: form });
  } else if (payload.kind === 'url') {
    res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ researchId, kind: 'url', url: payload.url }),
    });
  } else {
    res = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        researchId,
        kind: 'md',
        text: payload.text,
        title: payload.title,
      }),
    });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (body as { error?: string })?.error ?? 'unknown_error';
    const message = (body as { message?: string; provider?: string })?.message
      ?? (code === 'missing_key'
        ? `Missing ${(body as { provider?: string }).provider ?? ''} API key`.trim()
        : `Add source failed (${res.status})`);
    const error: Error & { code?: string; provider?: string } = new Error(message);
    error.code = code;
    error.provider = (body as { provider?: string })?.provider;
    throw error;
  }
  return (body as { source: ApiSource }).source;
}
