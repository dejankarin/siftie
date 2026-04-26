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
 *     2. If this is the very first message in the research AND the
 *        research has at least one source, calls Gemini Flash to draft
 *        the 6 opening interview questions and persists each as an
 *        agent message (sequenced, so Realtime delivers them one by
 *        one). Triggered exactly once per research.
 *     3. Returns the canonical persisted rows so the client can
 *        replace its optimistic placeholder + dedupe Realtime echoes.
 *
 * Subsequent agent replies (after the opening 6) are deferred to
 * Session 8's reply router. For now POST only ever produces the
 * opening questions.
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
import { getProjectIdForResearch } from '@/lib/workspace';
import { z } from 'zod';

export const runtime = 'nodejs';
// The interview generation can take 5-15s on Gemini Flash; cap headroom
// at 60s so a stuck call surfaces as a 504 rather than a frozen tab.
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

  // Quick exit when this isn't the first user message: interview reply
  // is deferred to Session 8.
  if (!interviewShouldFire) {
    return Response.json(
      {
        messages: [serializeMessage(userMessage)],
        agentReplyExpected: false,
      },
      { status: 201 },
    );
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
