/**
 * Chat messages API for the active research.
 *
 *   GET  /api/messages?researchId=…
 *     Returns every persisted message for the research, oldest-first.
 *     Mostly used to refresh after errors — the workspace bootstrap
 *     already includes messages in the initial payload.
 *
 *   POST /api/messages
 *     Body: { researchId: string, body: string }
 *     1. Persists the user message.
 *     2. **First-message branch** (interview): if this is the very first
 *        message AND the research has sources, call Gemini Flash to
 *        draft the 6 opening interview questions and persist each as
 *        an agent message (sequenced, so Realtime streams them in).
 *        Fires exactly once per research.
 *     3. **Non-first branch** (Session 8 reply router): for every
 *        subsequent message, run `routeReply()` to pick one of:
 *          - chat_only        → just persist the agent reply
 *          - refine_prompts   → persist the agent reply (cluster ack)
 *          - rebaseline       → persist reply + waitUntil(startResearchRun)
 *          - run_research     → persist reply + waitUntil(startResearchRun)
 *          - web_search       → persist reply + waitUntil(searchWeb +
 *                               summariseSearchHits + persist follow-up)
 *        Captures a `reply_router_decision` PostHog event so we can
 *        analyse what users actually ask the agent to do.
 *     4. Returns the canonical persisted rows so the client can
 *        replace its optimistic placeholder + dedupe Realtime echoes.
 */
import { withUser } from '@/lib/auth';
import {
  countMessagesForResearch,
  createMessage,
  createMessagesSequenced,
  listMessagesForResearch,
  type MessageRow,
} from '@/lib/messages';
import { listSourcesForResearch } from '@/lib/sources';
import { getUserApiKey } from '@/lib/keys';
import { generateInterviewQuestions } from '@/lib/interview';
import { readPosthogCaptureLlm } from '@/lib/privacy';
import { getPostHogServer } from '@/lib/posthog';
import { classifyProviderError } from '@/lib/provider-errors';
import { getLatestRunByResearch } from '@/lib/runs';
import { runResearchPipeline, startResearchRun } from '@/lib/research';
import { routeReply, summariseSearchHits, type ReplyAction } from '@/lib/reply-router';
import { searchWeb, TavilySearchError } from '@/lib/tavily';
import { getProjectIdForResearch } from '@/lib/workspace';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';

export const runtime = 'nodejs';
// The interview generation can take 5-15s on Gemini Flash; the reply
// router is faster (~1-3s). Cap headroom at 60s so a stuck call
// surfaces as a 504 rather than a frozen tab.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// GET — list messages for a research
// ---------------------------------------------------------------------------
export const GET = withUser(async ({ userId }, req) => {
  const { searchParams } = new URL(req.url);
  const researchId = searchParams.get('researchId');
  if (!researchId) {
    return Response.json({ error: 'researchId is required' }, { status: 400 });
  }
  const messages = await listMessagesForResearch(userId, researchId);
  return Response.json({ messages: messages.map(serializeMessage) });
});

// ---------------------------------------------------------------------------
// POST — send a chat message
// ---------------------------------------------------------------------------
const PostBody = z.object({
  researchId: z.string().min(1),
  body: z.string().min(1).max(8_000),
});

export const POST = withUser(async ({ userId }, req) => {
  const raw = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { researchId, body } = parsed.data;

  const ph = getPostHogServer();
  const start = Date.now();
  // PostHog group analytics — best-effort lookup so per-workspace funnels
  // pick up message activity. Missing project id → no group attribution
  // (still distinct-id-attributed via posthog.group on the client).
  const projectId = await getProjectIdForResearch(researchId);
  const phGroups = projectId ? { project: projectId } : undefined;

  // Decide whether the opening interview should fire BEFORE persisting
  // the user message — once we insert, the count goes from 0 to 1 and
  // the trigger condition stops being meaningful.
  let interviewShouldFire = false;
  try {
    const existingCount = await countMessagesForResearch(userId, researchId);
    interviewShouldFire = existingCount === 0;
  } catch (err) {
    // Ownership / database errors — surface as 403/500 via withUser.
    throw err;
  }

  // Persist the user message first. If this fails, we don't even try to
  // generate the interview.
  const userMessage = await createMessage(userId, {
    researchId,
    role: 'user',
    body,
  });

  ph.capture({
    distinctId: userId,
    event: 'message_sent',
    groups: phGroups,
    properties: {
      role: 'user',
      research_id: researchId,
      message_id: userMessage.id,
      length: body.length,
    },
  });

  // -----------------------------------------------------------------
  // Non-first messages: hand off to the Session 8 reply router.
  // -----------------------------------------------------------------
  if (!interviewShouldFire) {
    return handleReplyRouter({
      userId,
      researchId,
      userMessage,
      userMessageBody: body,
      phGroups,
      start,
    });
  }

  // Pull sources for this research; if there are none, we don't have
  // grounding for an interview, so skip and return early.
  const sources = await listSourcesForResearch(userId, researchId);
  if (sources.length === 0) {
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
      },
      { status: 201 },
    );
  }

  // Resolve the user's Gemini key — required for the interview.
  const geminiKey = await getUserApiKey(userId, 'gemini');
  if (!geminiKey) {
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
        warning: 'missing_key',
        provider: 'gemini',
      },
      { status: 201 },
    );
  }

  const privacyMode = !(await readPosthogCaptureLlm(userId));
  const traceId = `interview_${cryptoRandom()}`;
  const researchTitle = await fetchResearchTitle(userId, researchId);

  let questions: string[];
  try {
    questions = await generateInterviewQuestions(
      geminiKey,
      {
        sources: sources.map((s) => ({ kind: s.kind, contextDoc: s.contextDoc })),
        userMessage: body,
        researchTitle,
      },
      {
        posthogDistinctId: userId,
        posthogTraceId: traceId,
        posthogPrivacyMode: privacyMode,
        posthogProperties: { research_id: researchId, source_count: sources.length },
      },
    );
  } catch (err) {
    const classified = classifyProviderError(err, 'gemini');
    ph.capture({
      distinctId: userId,
      event: 'interview_failed',
      groups: phGroups,
      properties: {
        research_id: researchId,
        error_code: classified.code,
        latency_ms: Date.now() - start,
        $ai_trace_id: traceId,
        message: classified.message,
      },
    });
    ph.captureException(err, userId, {
      route: 'POST /api/messages',
      research_id: researchId,
      error_code: classified.code,
      $ai_trace_id: traceId,
    });
    // Still return the user message so the chat reflects what they sent;
    // include the warning so the client can surface a toast.
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
        warning: classified.code,
        provider: classified.provider,
        message: classified.message,
      },
      { status: 201 },
    );
  }

  const agentMessages = await createMessagesSequenced(
    userId,
    researchId,
    questions.map((q) => ({ role: 'agent' as const, body: q })),
  );

  ph.capture({
    distinctId: userId,
    event: 'interview_generated',
    groups: phGroups,
    properties: {
      research_id: researchId,
      question_count: agentMessages.length,
      source_count: sources.length,
      latency_ms: Date.now() - start,
      $ai_trace_id: traceId,
    },
  });

  return Response.json(
    {
      messages: [serializeMessage(userMessage), ...agentMessages.map(serializeMessage)],
      agentReplyExpected: true,
    },
    { status: 201 },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeMessage(row: MessageRow) {
  return {
    id: row.id,
    researchId: row.researchId,
    role: row.role,
    body: row.body,
    createdAt: row.createdAt,
    councilRole: row.councilRole,
    councilSeat: row.councilSeat,
    runId: row.runId,
  };
}

/**
 * Pull the research title for prompt grounding. We use the service-role
 * client via the existing message helper to avoid a second auth round
 * trip; ownership has already been verified upstream.
 */
async function fetchResearchTitle(userId: string, researchId: string): Promise<string> {
  // Lazy-import to avoid pulling Supabase into the client bundle.
  const { createServiceRoleSupabaseClient } = await import('@/lib/supabase/server');
  const supabase = createServiceRoleSupabaseClient();
  const { data } = await supabase
    .from('researches')
    .select('name, projects!inner(clerk_user_id)')
    .eq('id', researchId)
    .eq('projects.clerk_user_id', userId)
    .maybeSingle();
  return (data as { name?: string } | null)?.name ?? 'Untitled research';
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

// ===========================================================================
// Reply router (Session 8) — runs for every non-first user message.
// ===========================================================================

interface ReplyRouterContext {
  userId: string;
  researchId: string;
  userMessage: MessageRow;
  userMessageBody: string;
  phGroups: { project: string } | undefined;
  start: number;
}

/**
 * The non-first-message branch of POST /api/messages. Validates inputs,
 * runs the structured-output reply router, persists the agent reply,
 * and (for actions that have side effects) kicks off a `waitUntil`
 * background task. Returns the same `{ messages, agentReplyExpected }`
 * shape as the interview branch so the client doesn't have to branch.
 */
async function handleReplyRouter(ctx: ReplyRouterContext): Promise<Response> {
  const { userId, researchId, userMessage, userMessageBody, phGroups, start } = ctx;
  const ph = getPostHogServer();

  // Resolve the user's Gemini key first — without it the router can't
  // run at all. Surface the same `missing_key` warning shape the
  // interview branch uses so the client deep-links to Settings.
  const geminiKey = await getUserApiKey(userId, 'gemini');
  if (!geminiKey) {
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
        warning: 'missing_key',
        provider: 'gemini',
      },
      { status: 201 },
    );
  }
  // Tavily is optional — its presence just unlocks the `web_search`
  // action. The router is told via `hasTavilyKey` so it doesn't pick
  // that branch when the key isn't there.
  const tavilyKey = await getUserApiKey(userId, 'tavily');

  // Build context: sources + recent messages (excluding the just-inserted
  // user message) + latest persisted portfolio.
  const [sources, allMessages, latestRun, researchTitle] = await Promise.all([
    listSourcesForResearch(userId, researchId),
    listMessagesForResearch(userId, researchId),
    getLatestRunByResearch(userId, researchId),
    fetchResearchTitle(userId, researchId),
  ]);
  const recentMessages = allMessages
    .filter((m) => m.id !== userMessage.id)
    .slice(-12)
    .map((m) => ({ role: m.role, body: m.body }));
  const prompts = latestRun?.status === 'complete' ? latestRun.prompts : [];

  const privacyMode = !(await readPosthogCaptureLlm(userId));
  const traceId = `reply_router_${cryptoRandom()}`;

  // ---- Step 1: route the reply via Gemini Flash structured output. ----
  let decision: ReplyAction;
  try {
    decision = await routeReply(
      geminiKey,
      {
        userMessage: userMessageBody,
        recentMessages,
        researchTitle,
        sourceContextDocs: sources.map((s) => ({
          title: s.title,
          kind: s.kind,
          contextDoc: s.contextDoc,
        })),
        prompts,
        hasTavilyKey: !!tavilyKey,
      },
      {
        posthogDistinctId: userId,
        posthogTraceId: traceId,
        posthogPrivacyMode: privacyMode,
        posthogProperties: {
          research_id: researchId,
          source_count: sources.length,
          messages_count: recentMessages.length,
          has_portfolio: prompts.length > 0,
        },
        posthogGroups: phGroups,
      },
    );
  } catch (err) {
    const classified = classifyProviderError(err, 'gemini');
    ph.capture({
      distinctId: userId,
      event: 'reply_router_failed',
      groups: phGroups,
      properties: {
        research_id: researchId,
        error_code: classified.code,
        latency_ms: Date.now() - start,
        $ai_trace_id: traceId,
        message: classified.message,
      },
    });
    ph.captureException(err, userId, {
      route: 'POST /api/messages (reply router)',
      research_id: researchId,
      error_code: classified.code,
      $ai_trace_id: traceId,
    });
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
        warning: classified.code,
        provider: classified.provider,
        message: classified.message,
      },
      { status: 201 },
    );
  }

  // ---- Step 2: capture the funnel event so we know what users ask. ----
  ph.capture({
    distinctId: userId,
    event: 'reply_router_decision',
    groups: phGroups,
    properties: {
      action: decision.kind,
      research_id: researchId,
      message_length: userMessageBody.length,
      sources_count: sources.length,
      messages_count: recentMessages.length,
      has_portfolio: prompts.length > 0,
      has_tavily: !!tavilyKey,
      cluster: decision.kind === 'refine_prompts' ? decision.cluster : null,
      $ai_trace_id: traceId,
      latency_ms: Date.now() - start,
    },
  });

  // ---- Step 3: persist the lead-in agent reply. ----
  const agentMessage = await createMessage(userId, {
    researchId,
    role: 'agent',
    body: decision.responseText,
  });

  // ---- Step 4: side effects per action, all in waitUntil so the
  //              POST returns fast and Realtime delivers any follow-up
  //              messages (web search summary, council bubbles, etc.).
  let agentReplyExpected = false;

  if (decision.kind === 'web_search' && tavilyKey) {
    agentReplyExpected = true;
    waitUntil(
      runWebSearchFollowup({
        userId,
        researchId,
        researchTitle,
        userMessageBody,
        query: decision.query,
        tavilyKey,
        geminiKey,
        privacyMode,
        traceId,
        phGroups,
      }),
    );
  } else if (decision.kind === 'run_research' || decision.kind === 'rebaseline') {
    // Validate + create the runs row synchronously; the heavy
    // pipeline runs in waitUntil. Errors get surfaced as a follow-up
    // chat bubble so the user isn't left hanging after the lead-in.
    try {
      const started = await startResearchRun(userId, researchId);
      if (!started.reused) {
        agentReplyExpected = true;
        waitUntil(
          runResearchPipeline(userId, researchId, started.runId).catch((err) => {
            console.error('[api/messages] background pipeline crashed', err);
          }),
        );
      }
      // If reused, the existing run is still going — Council bubbles
      // already streaming via Realtime. No extra setup needed.
    } catch (err) {
      const cause = (err as Error & { cause?: unknown })?.cause;
      const reason = err instanceof Error ? err.message : 'Could not start the research run';
      ph.capture({
        distinctId: userId,
        event: 'reply_router_run_research_failed',
        groups: phGroups,
        properties: {
          research_id: researchId,
          error_code: typeof cause === 'string' ? cause : 'unknown',
          $ai_trace_id: traceId,
        },
      });
      // Persist a follow-up so the user understands why the run
      // they just confirmed didn't actually start. Use the retry
      // helper instead of letting a persist failure 500 the POST —
      // the user already got the lead-in bubble at line 435; a 500
      // here would erase their typing-dots context AND their reason.
      const followupBody = `I couldn't start the run — ${reason}. ${
        cause === 'no_sources'
          ? 'Add at least one source first.'
          : cause === 'missing_ideate_key'
            ? 'Add an OpenAI or Gemini key in Settings.'
            : cause === 'missing_openrouter_key'
              ? 'Add your OpenRouter key in Settings.'
              : 'Try again in a moment.'
      }`;
      const persisted = await persistFollowupBubbleWithRetry(userId, researchId, {
        role: 'agent',
        body: followupBody,
      });
      if (!persisted) {
        console.error(
          '[api/messages] run_research failure bubble persistence exhausted retries',
          { research_id: researchId },
        );
      }
    }
  }

  return Response.json(
    {
      messages: [serializeMessage(userMessage), serializeMessage(agentMessage)],
      agentReplyExpected,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// runWebSearchFollowup — runs in waitUntil after the POST has already
// returned. Calls Tavily search, hands the hits to a second Gemini
// call for citation-heavy summarisation, and persists the result as a
// new agent message. Failures get persisted as a chat bubble too so
// the user always sees a closing reply rather than silent stall.
// ---------------------------------------------------------------------------

interface WebSearchFollowupContext {
  userId: string;
  researchId: string;
  researchTitle: string;
  userMessageBody: string;
  query: string;
  tavilyKey: string;
  geminiKey: string;
  privacyMode: boolean;
  traceId: string;
  phGroups: { project: string } | undefined;
}

async function runWebSearchFollowup(ctx: WebSearchFollowupContext): Promise<void> {
  const ph = getPostHogServer();
  const start = Date.now();
  try {
    const hits = await searchWeb(
      ctx.tavilyKey,
      ctx.query,
      {
        posthogDistinctId: ctx.userId,
        posthogTraceId: ctx.traceId,
        posthogProperties: { research_id: ctx.researchId, feature: 'reply_router' },
        posthogGroups: ctx.phGroups,
      },
      { topic: 'general', maxResults: 5 },
    );

    const summary = await summariseSearchHits(
      ctx.geminiKey,
      {
        userMessage: ctx.userMessageBody,
        query: ctx.query,
        hits,
        researchTitle: ctx.researchTitle,
      },
      {
        posthogDistinctId: ctx.userId,
        posthogTraceId: ctx.traceId,
        posthogPrivacyMode: ctx.privacyMode,
        posthogProperties: { research_id: ctx.researchId, hit_count: hits.length },
        posthogGroups: ctx.phGroups,
      },
    );

    await createMessage(ctx.userId, {
      researchId: ctx.researchId,
      role: 'agent',
      body: summary,
    });

    ph.capture({
      distinctId: ctx.userId,
      event: 'reply_router_websearch_completed',
      groups: ctx.phGroups,
      properties: {
        research_id: ctx.researchId,
        query: ctx.query,
        hit_count: hits.length,
        latency_ms: Date.now() - start,
        $ai_trace_id: ctx.traceId,
      },
    });
  } catch (err) {
    const provider = err instanceof TavilySearchError ? 'tavily' : 'gemini';
    const classified = classifyProviderError(err, provider);
    ph.capture({
      distinctId: ctx.userId,
      event: 'reply_router_websearch_failed',
      groups: ctx.phGroups,
      properties: {
        research_id: ctx.researchId,
        query: ctx.query,
        error_code: classified.code,
        provider,
        latency_ms: Date.now() - start,
        $ai_trace_id: ctx.traceId,
      },
    });
    ph.captureException(err, ctx.userId, {
      route: 'POST /api/messages (web_search followup)',
      research_id: ctx.researchId,
      $ai_trace_id: ctx.traceId,
    });
    // Follow-up so the user always sees a closing message. The first
    // attempt usually succeeds, but a transient DB blip used to leave
    // the typing dots and the lead-in bubble dangling forever (only a
    // console.error in logs). Retry with a small linear backoff so we
    // ride out routine connection recycles.
    const persisted = await persistFollowupBubbleWithRetry(ctx.userId, ctx.researchId, {
      role: 'agent',
      body: `I couldn't finish the web search — ${classified.message}`,
    });
    if (!persisted) {
      console.error(
        '[api/messages] websearch failure bubble persistence exhausted retries',
        { research_id: ctx.researchId },
      );
    }
  }
}

/**
 * Best-effort `createMessage` retry used by waitUntil follow-up paths
 * (web search summary, run-research lead-in failure). The tradeoff:
 * spending up to ~1.2s on retries is much better than leaving the user
 * staring at a stranded "Searching the web…" lead-in bubble with no
 * closing line — those are the cases where a missed bubble pairs with
 * stuck typing dots and produces an apparent dead-end.
 */
async function persistFollowupBubbleWithRetry(
  userId: string,
  researchId: string,
  payload: { role: 'agent'; body: string; runId?: string },
): Promise<boolean> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await createMessage(userId, { researchId, ...payload });
      return true;
    } catch (err) {
      console.error('[api/messages] follow-up bubble persist failed', {
        research_id: researchId,
        attempt,
        error: err,
      });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  return false;
}
