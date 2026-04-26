/**
 * Reply router (Session 8).
 *
 * After the opening 6-question interview fires once per research, every
 * subsequent user message comes through here. The router's job is to
 * decide what action best serves the user's reply, then write the
 * agent's chat response.
 *
 * Architecture:
 *
 *   POST /api/messages (non-first)
 *     ├── persist user message
 *     ├── routeReply()  ← this file
 *     │     ├── Gemini 3 Flash with structured JSON output
 *     │     ├── Reads: brand context, recent chat, portfolio summary
 *     │     └── Returns { kind, responseText, … }
 *     ├── persist agent reply
 *     ├── if kind=web_search   → searchWeb() + summariseSearchHits()
 *     ├── if kind=run_research → waitUntil(startResearchRun)
 *     └── ph.capture('reply_router_decision', …)
 *
 * Why one structured-output call (vs. tool calls):
 *   - Gemini 3 Flash with `responseJsonSchema` is reliable and cheap.
 *   - Tool calls would round-trip the LLM twice for the chat_only case
 *     (the common path), which is wasteful.
 *   - The router never *executes* an action — it just *decides*. The
 *     route handler does the side effects.
 *
 * Action menu:
 *   - chat_only       — most replies; just post `responseText`.
 *   - refine_prompts  — user wants a new cluster (Category/Persona/
 *                       Comparison). The synthetic phrase
 *                       "Generate a new <cluster> cluster of prompts."
 *                       from Session 7's popover always maps here.
 *   - rebaseline      — user wants to retest the existing portfolio
 *                       against the latest LLM responses. Currently
 *                       implemented as a fresh research run on the
 *                       server side; can be tightened to Peec-only
 *                       later without changing the router.
 *   - run_research    — user explicitly asks to (re)run the research.
 *   - web_search      — user asks something the indexed sources can't
 *                       answer; router returns a focused search query.
 *
 * PostHog instrumentation:
 *   - `$ai_generation` event from `PostHogGoogleGenAI` tagged with
 *     `tag: 'reply_router'` so it shows up in LLM Analytics.
 *   - The route handler captures a `reply_router_decision` product
 *     event with `{ action, message_length, sources_count, messages_count,
 *     research_id }` for the funnel analytics.
 */
import 'server-only';
import { z } from 'zod';
import { ThinkingLevel } from '@google/genai';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import type { ContextDoc } from './ingest/schema';
import type { MessageRow } from './messages';
import type { FinalPrompt } from './research/schema';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';
import type { TavilySearchHit } from './tavily';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplyAction =
  | { kind: 'chat_only'; responseText: string }
  | {
      kind: 'refine_prompts';
      responseText: string;
      cluster: 'Category' | 'Persona' | 'Comparison';
    }
  | { kind: 'rebaseline'; responseText: string }
  | { kind: 'run_research'; responseText: string }
  | { kind: 'web_search'; responseText: string; query: string };

export interface RouteReplyInput {
  /** Raw text the user just sent. */
  userMessage: string;
  /** Up to ~10 most-recent chat messages (oldest-first), excluding the latest user reply. */
  recentMessages: Array<Pick<MessageRow, 'role' | 'body'>>;
  /** Title of the research the chat lives in — handy for system prompt grounding. */
  researchTitle: string;
  /** ContextDocs from each indexed source — the router compresses these into a brand summary. */
  sourceContextDocs: Array<{ title: string; kind: 'pdf' | 'url' | 'doc' | 'md'; contextDoc: ContextDoc }>;
  /** Latest persisted prompts (or empty if no run completed yet). */
  prompts: FinalPrompt[];
  /** Whether the user has a Tavily key configured — gates the `web_search` action. */
  hasTavilyKey: boolean;
}

export interface RouteReplyOptions {
  posthogDistinctId: string;
  posthogTraceId?: string;
  posthogPrivacyMode: boolean;
  posthogProperties?: Record<string, unknown>;
  posthogGroups?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Same model as the rest of Siftie — Pro-level intelligence at Flash speed/price. */
const GEMINI_MODEL = 'gemini-3-flash-preview';
/** 30s is plenty for a structured-output reply; gives p-retry headroom. */
const TIMEOUT_MS = 30_000;
/** How many chat messages we hand to the router. 12 ≈ 3 user-agent exchanges + the interview. */
const RECENT_MESSAGES_WINDOW = 12;

// ---------------------------------------------------------------------------
// Structured-output schema
//
// Gemini's `responseJsonSchema` dialect doesn't support `oneOf`/`anyOf`,
// so we use a flat shape with sentinel values ("none" / "") for fields
// that don't apply to the chosen action. The router prompt explicitly
// tells the model when to leave them blank, and the Zod schema below
// validates whatever arrived. The route handler narrows to the
// discriminated `ReplyAction` shape via `narrowDecision()`.
// ---------------------------------------------------------------------------

const ReplyDecisionRaw = z.object({
  action: z.enum([
    'chat_only',
    'refine_prompts',
    'rebaseline',
    'run_research',
    'web_search',
  ]),
  responseText: z.string().min(1).max(2000),
  cluster: z.enum(['Category', 'Persona', 'Comparison', 'none']),
  searchQuery: z.string(),
  reason: z.string(),
});
type ReplyDecisionRaw = z.infer<typeof ReplyDecisionRaw>;

const ReplyDecisionJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['chat_only', 'refine_prompts', 'rebaseline', 'run_research', 'web_search'],
    },
    responseText: { type: 'string' },
    cluster: {
      type: 'string',
      enum: ['Category', 'Persona', 'Comparison', 'none'],
    },
    searchQuery: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action', 'responseText', 'cluster', 'searchQuery', 'reason'],
} as const;

// ---------------------------------------------------------------------------
// routeReply
// ---------------------------------------------------------------------------

/**
 * Run the reply router and return the agent's chosen action + reply text.
 *
 * Throws on missing key, timeouts, schema mismatches. The caller (the
 * messages route) is expected to catch and degrade to a friendly chat
 * bubble explaining the failure rather than 500.
 */
export async function routeReply(
  apiKey: string,
  input: RouteReplyInput,
  opts: RouteReplyOptions,
): Promise<ReplyAction> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('Gemini API key missing or too short');
  }

  const ai = new PostHogGoogleGenAI({
    apiKey,
    posthog: getPostHogServer(),
  });

  const userPrompt = buildUserPrompt(input);

  const response = await withResilience(
    () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: buildSystemPrompt(input.hasTavilyKey),
          responseMimeType: 'application/json',
          responseJsonSchema: ReplyDecisionJsonSchema,
          // Low thinking is more than enough for routing; keeps
          // latency in the 1–3s range so the chat feels responsive.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
        posthogDistinctId: opts.posthogDistinctId,
        posthogTraceId: opts.posthogTraceId,
        posthogPrivacyMode: opts.posthogPrivacyMode,
        posthogProperties: {
          tag: 'reply_router',
          ...opts.posthogProperties,
        },
        posthogGroups: opts.posthogGroups,
      }),
    {
      timeoutMs: TIMEOUT_MS,
      retries: 1,
      minTimeoutMs: 500,
      maxTimeoutMs: 1_500,
      shouldAbort: (err) => {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        return /401|403|API key|invalid_api_key|PERMISSION_DENIED|quota/i.test(msg);
      },
    },
  );

  const text = response.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Reply router returned an empty response');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Reply router returned non-JSON');
  }
  const decision = ReplyDecisionRaw.parse(parsed);
  return narrowDecision(decision, input.hasTavilyKey);
}

// ---------------------------------------------------------------------------
// summariseSearchHits — second-stage Gemini call for the web_search action.
// Takes the search results + original user question and writes a concise
// chat reply with inline `[n]` citations and a Markdown footer of sources.
// ---------------------------------------------------------------------------

export interface SummariseSearchInput {
  userMessage: string;
  query: string;
  hits: TavilySearchHit[];
  researchTitle: string;
}

export async function summariseSearchHits(
  apiKey: string,
  input: SummariseSearchInput,
  opts: RouteReplyOptions,
): Promise<string> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('Gemini API key missing or too short');
  }
  if (input.hits.length === 0) {
    return `I searched the web for "${input.query}" but couldn't find anything relevant. Want me to try a different angle, or stick with what your sources say?`;
  }

  const ai = new PostHogGoogleGenAI({
    apiKey,
    posthog: getPostHogServer(),
  });

  const numbered = input.hits
    .map((hit, i) => {
      const date = hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : '';
      return `[${i + 1}] ${hit.title || hit.url}${date}\nURL: ${hit.url}\nSnippet: ${hit.snippet}`;
    })
    .join('\n\n');

  const prompt = `Research: ${input.researchTitle}
User asked: "${input.userMessage}"
Web search query I ran: "${input.query}"

Search results (use ONLY these as evidence):

${numbered}

Write a 2–4 sentence chat reply summarising what's relevant to the user's question. Use inline numeric citations like [1], [2] that match the sources above. Be specific and grounded — quote dates, names, numbers when you have them. After the prose, add a single blank line, then a Markdown bullet list titled "Sources:" with one bullet per cited source in the format "- [Title](URL)" (use the URL exactly as given). Do not include sources you didn't actually cite. If nothing in the results answers the question, say so honestly.`;

  const response = await withResilience(
    () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction:
            "You are Siftie, a brand-research assistant. You're summarising web search results for the user. Be concise, factual, and always cite. Never invent URLs or facts.",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
        posthogDistinctId: opts.posthogDistinctId,
        posthogTraceId: opts.posthogTraceId,
        posthogPrivacyMode: opts.posthogPrivacyMode,
        posthogProperties: {
          tag: 'reply_router_websearch_summary',
          hit_count: input.hits.length,
          ...opts.posthogProperties,
        },
        posthogGroups: opts.posthogGroups,
      }),
    {
      timeoutMs: TIMEOUT_MS,
      retries: 1,
      minTimeoutMs: 500,
      maxTimeoutMs: 1_500,
      shouldAbort: (err) => {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        return /401|403|API key|invalid_api_key|PERMISSION_DENIED|quota/i.test(msg);
      },
    },
  );

  const text = response.text;
  if (typeof text !== 'string' || text.length === 0) {
    // Fall back to a deterministic citation list so the user still gets
    // something useful even if the second LLM call returned empty.
    return buildFallbackSummary(input);
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(hasTavilyKey: boolean): string {
  return `You are Siftie's reply router for an AI brand-research workspace.

The user is in a chat with you (Siftie). Your job is to:
  1. Decide what ONE action best serves the user's latest message.
  2. Write the chat reply Siftie will post back to the user.

You have access to:
  - Brand context: indexed facts/topics/entities from the user's uploaded sources.
  - Recent chat history (oldest-first).
  - The current prompt portfolio if a research run has completed.

Pick exactly one action:
  - "chat_only": A normal conversational reply — clarification, follow-ups, brand-strategy questions, or you have enough source context to answer directly. Most replies fit here.
  - "refine_prompts": The user wants to add or change one cluster (Category, Persona, or Comparison) of prompts. The synthetic phrase "Generate a new <Cluster> cluster of prompts." (sent by the Generate-cluster popover) ALWAYS maps to this. Set "cluster" to "Category", "Persona", or "Comparison" matching the request.
  - "run_research": The user explicitly asks for a new full research run — e.g. "rerun the research", "go again with the new sources", "build a fresh portfolio". Use this when they've added new sources or want a clean restart.
  - "rebaseline": The user wants to re-test the existing portfolio against the latest LLM responses without re-doing Ideate/Council — e.g. "test the portfolio again", "check if hits changed", "rebaseline".
  - "web_search": The user is asking about something the indexed sources clearly cannot answer — recent news, competitor announcements, market data not in their docs. Set "searchQuery" to a focused, specific web query. ${hasTavilyKey ? 'You may pick this when a quick web lookup would meaningfully help the answer.' : 'NOTE: The user has no Tavily key configured, so you MUST NOT pick "web_search". Use "chat_only" and either answer from sources or tell them they\'d need a Tavily key for live web lookups.'}

Rules for "responseText":
  - 1–4 sentences, conversational tone, no markdown bullets unless absolutely needed.
  - Cite specific source titles when paraphrasing them ("…per the Brand Brief…").
  - For "run_research" / "rebaseline" / "refine_prompts", briefly confirm what you're about to do.
  - For "web_search", responseText is just the lead-in — e.g. "Let me check the latest on that — one moment." The actual answer with citations is generated separately.
  - Never include URLs you didn't search for.

Rules for the optional fields (always present in the output, but use sentinels when not applicable):
  - "cluster": one of "Category", "Persona", "Comparison" when action="refine_prompts"; otherwise "none".
  - "searchQuery": a focused web query when action="web_search"; otherwise "".
  - "reason": a one-sentence note (for analytics) explaining why you picked this action. Always non-empty.

Respond ONLY with the structured JSON. No prose outside the schema.`;
}

function buildUserPrompt(input: RouteReplyInput): string {
  const { sourceContextDocs, prompts, recentMessages, userMessage, researchTitle } = input;

  const brandSummary =
    sourceContextDocs.length === 0
      ? '(none — the user has not added any sources yet)'
      : sourceContextDocs
          .slice(0, 8)
          .map((s, i) => {
            const facts = (s.contextDoc.facts ?? []).slice(0, 4).map((f) => `   • ${f}`).join('\n');
            const topics = (s.contextDoc.topics ?? []).slice(0, 6).join(', ');
            return `Source ${i + 1} [${s.kind}] "${s.title}"
   Summary: ${s.contextDoc.summary ?? '(no summary)'}
   Topics: ${topics || '—'}
   Key facts:
${facts || '   • (none)'}`;
          })
          .join('\n\n');

  const portfolioSummary =
    prompts.length === 0
      ? '(no run completed yet — the portfolio is empty)'
      : `${prompts.length} prompts persisted from the latest run.
Sample (first 5):
${prompts
  .slice(0, 5)
  .map((p, i) => `   ${i + 1}. [${p.cluster} · ${p.intent}] ${p.text}`)
  .join('\n')}`;

  const transcript =
    recentMessages.length === 0
      ? '(no prior messages)'
      : recentMessages
          .slice(-RECENT_MESSAGES_WINDOW)
          .map((m) => `${m.role === 'user' ? 'User' : 'Siftie'}: ${truncateMessageBody(m.body)}`)
          .join('\n\n');

  return `Research title: ${researchTitle}

==== Brand context (from indexed sources) ====
${brandSummary}

==== Current prompt portfolio ====
${portfolioSummary}

==== Recent chat history ====
${transcript}

==== User's latest message ====
${userMessage}`;
}

/** Cap an individual message body so a long agent reply doesn't dominate the prompt. */
function truncateMessageBody(body: string, max = 600): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…`;
}

/**
 * Translate the loosely-typed Gemini output into the strict
 * `ReplyAction` discriminated union the route handler consumes.
 *
 * Defensive: if Gemini picks `web_search` despite no Tavily key being
 * configured, downgrade to `chat_only` so the user still gets a useful
 * reply rather than a silent failure.
 */
function narrowDecision(raw: ReplyDecisionRaw, hasTavilyKey: boolean): ReplyAction {
  switch (raw.action) {
    case 'chat_only':
      return { kind: 'chat_only', responseText: raw.responseText };
    case 'refine_prompts': {
      const cluster: 'Category' | 'Persona' | 'Comparison' =
        raw.cluster === 'Category' || raw.cluster === 'Persona' || raw.cluster === 'Comparison'
          ? raw.cluster
          : 'Category';
      return { kind: 'refine_prompts', responseText: raw.responseText, cluster };
    }
    case 'rebaseline':
      return { kind: 'rebaseline', responseText: raw.responseText };
    case 'run_research':
      return { kind: 'run_research', responseText: raw.responseText };
    case 'web_search': {
      if (!hasTavilyKey || raw.searchQuery.trim().length === 0) {
        return {
          kind: 'chat_only',
          responseText:
            raw.responseText ||
            "I'd love to check the web for that, but I don't see a Tavily key in your settings — add one and I can pull live results.",
        };
      }
      return { kind: 'web_search', responseText: raw.responseText, query: raw.searchQuery.trim() };
    }
  }
}

/**
 * Deterministic fallback used when the second-stage summariser returns
 * an empty body (rare). Lists the hits as a Markdown bullet list so the
 * user still sees the URLs Tavily found and can click through.
 */
function buildFallbackSummary(input: SummariseSearchInput): string {
  const bullets = input.hits
    .map((hit) => `- [${hit.title || hit.url}](${hit.url})`)
    .join('\n');
  return `Here's what I found for "${input.query}":\n\n${bullets}`;
}
