/**
 * Gemini Pro wrapper that runs the **Ideate** stage of the research
 * orchestrator.
 *
 * Inputs:
 *   - the indexed sources (their ContextDocs)
 *   - the chat transcript so far (interview answers + any follow-ups)
 *   - the research title
 *
 * Output:
 *   - up to ~24 candidate prompts grouped by cluster (Category /
 *     Persona / Comparison) and intent (High / Med / Low). The Council
 *     will then keep ~12, refine, and rank them in lib/council.ts.
 *
 * Why a separate file from `lib/gemini.ts` and `lib/interview.ts`:
 *   We're now juggling three different Gemini call sites (ContextDoc
 *   ingest, opening interview, ideate). Trying to express all three
 *   through one helper would mean a soup of optional schema/prompt
 *   parameters. Keeping them separate makes each prompt + schema easy
 *   to reason about; we'll DRY up only when there are 5+ call sites
 *   doing genuinely identical setup.
 *
 * BYOK + PostHog patterns identical to `lib/interview.ts`:
 *   - apiKey is always the first argument; never reads process.env.
 *   - Wraps GenAI in `@posthog/ai/gemini` so each call emits a
 *     `$ai_generation` event tagged `feature: 'ideate'`.
 *   - 90s hard timeout (Pro is slower than Flash) + 2 retries via
 *     p-retry, aborting on auth/quota errors.
 */
import 'server-only';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import type { ContextDoc } from './ingest/schema';
import { getPostHogServer } from './posthog';
import {
  IdeateResponse,
  IdeateResponseJsonSchema,
  type IdeatePrompt,
} from './research/schema';
import { withResilience } from './resilience';

/**
 * We use the Pro tier (not Flash) for Ideate because the prompt-design
 * step benefits noticeably from stronger reasoning — and we only call
 * it once per run, so the extra cost is bounded (~$0.05/run).
 *
 * `gemini-pro-latest` rolls forward whenever Google ships a new Pro
 * model. If we ever want to pin (e.g. for reproducible council
 * outputs in QA), we'd swap this for an explicit version like
 * `gemini-3-pro-preview`.
 */
const GEMINI_MODEL = 'gemini-pro-latest';

/**
 * Generous timeout: Pro can take 60-80s on a long input + 24-prompt
 * structured output. The orchestrator runs in `waitUntil` so we're
 * not blocking the request handler.
 */
const TIMEOUT_MS = 90_000;

/**
 * Target number of candidate prompts. We aim for 24 (8 per cluster) so
 * the Council has enough variety to pick a strong final 12 from. The
 * model often returns slightly fewer or more — we take whatever it
 * gives us, then trim to TARGET_MAX downstream.
 */
const TARGET_PROMPT_COUNT = 24;
const TARGET_MAX = 30;

interface SourceBrief {
  title: string;
  kind: 'pdf' | 'url' | 'doc' | 'md';
  summary: string;
  topics: string[];
  facts: string[];
}

interface MessageBrief {
  role: 'user' | 'agent';
  body: string;
}

export interface IdeateInput {
  researchTitle: string;
  sources: Array<{
    kind: 'pdf' | 'url' | 'doc' | 'md';
    contextDoc: ContextDoc;
  }>;
  /**
   * Plain transcript of the chat so far. We pass user replies + the
   * interview questions the agent asked, in chronological order, so
   * Gemini sees both the "what we asked" and the "what they answered"
   * sides. Council bubbles from prior runs are intentionally excluded
   * — they're stale narrative, not user signal.
   */
  messages: MessageBrief[];
}

export interface IdeateCallOptions {
  posthogDistinctId: string;
  /** Run-level trace id so all 7 council calls + this ideate call share one trace. */
  posthogTraceId: string;
  posthogPrivacyMode: boolean;
  posthogProperties?: Record<string, unknown>;
}

/**
 * Generate the candidate prompts for a research run. Returns the parsed
 * + Zod-validated array. Throws on auth/quota/timeout/JSON errors.
 */
export async function generateIdeatePrompts(
  apiKey: string,
  input: IdeateInput,
  opts: IdeateCallOptions,
): Promise<IdeatePrompt[]> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('Gemini API key missing or too short');
  }
  if (input.sources.length === 0) {
    throw new Error('Cannot ideate without any sources');
  }

  const phClient = getPostHogServer();
  const ai = new PostHogGoogleGenAI({ apiKey, posthog: phClient });

  const briefs = input.sources.map((s) => buildSourceBrief(s.kind, s.contextDoc));
  const userPrompt = buildUserPrompt(input.researchTitle, briefs, input.messages);

  const response = await withResilience(
    () =>
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }],
          },
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: IdeateResponseJsonSchema,
          temperature: 0.7,
        },
        posthogDistinctId: opts.posthogDistinctId,
        posthogTraceId: opts.posthogTraceId,
        posthogPrivacyMode: opts.posthogPrivacyMode,
        posthogProperties: {
          feature: 'ideate',
          tag: 'ideate_prompts',
          target_count: TARGET_PROMPT_COUNT,
          ...opts.posthogProperties,
        },
      }),
    {
      timeoutMs: TIMEOUT_MS,
      retries: 2,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 4_000,
      shouldAbort: (err) => {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        return /401|403|API key|invalid_api_key|PERMISSION_DENIED|quota/i.test(msg);
      },
    },
  );

  const text = response.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Gemini returned an empty Ideate response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON Ideate response');
  }

  const validated = IdeateResponse.parse(parsed);
  // Trim to keep the council's workload bounded. We don't shuffle — the
  // model already orders by perceived strength in most runs.
  return validated.prompts.slice(0, TARGET_MAX);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSourceBrief(kind: SourceBrief['kind'], doc: ContextDoc): SourceBrief {
  return {
    title: doc.title,
    kind,
    summary: doc.summary,
    topics: doc.topics.slice(0, 12),
    // Cap facts per source so 20 sources × 15 facts doesn't blow the
    // prompt window. Pro has a 1M token context but we don't need it.
    facts: doc.facts.slice(0, 12),
  };
}

function buildUserPrompt(
  researchTitle: string,
  briefs: SourceBrief[],
  messages: MessageBrief[],
): string {
  const sourcesBlock = briefs
    .map((b, i) => {
      const facts = b.facts.length > 0 ? `\n  Facts:\n  - ${b.facts.join('\n  - ')}` : '';
      const topics = b.topics.length > 0 ? `\n  Topics: ${b.topics.join(', ')}` : '';
      return `Source ${i + 1} (${b.kind}): ${b.title}\n  Summary: ${b.summary}${topics}${facts}`;
    })
    .join('\n\n');

  // Render the conversation as a simple labelled transcript. We trim
  // very long messages so a user who pasted a wall of text doesn't blow
  // out the prompt budget for everyone else.
  const transcriptBlock = messages.length
    ? messages
        .map((m) => {
          const label = m.role === 'user' ? 'User' : 'Agent';
          const body = m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body;
          return `${label}: ${body}`;
        })
        .join('\n\n')
    : '(no chat messages yet)';

  return `Research title: ${researchTitle}

Sources the user has indexed (${briefs.length} total):

${sourcesBlock}

Conversation so far:

${transcriptBlock}

Generate ${TARGET_PROMPT_COUNT} candidate prompts following every rule in the system instruction.`;
}

const SYSTEM_INSTRUCTION = `You are Siftie's prompt strategist.

Your job: read a brand's research sources + interview answers, then draft a portfolio of generative-search prompts a real buyer might type into ChatGPT, Perplexity, or Gemini. The portfolio is later vetted by an LLM Council, so quality matters more than coverage — submit your strongest ideas, not filler.

Aim for ~24 prompts split across three clusters:

- "Category" — discovery/exploratory queries about the product space the brand competes in. Examples: "best running jackets for cold weather", "softest organic cotton tees".
- "Persona" — queries shaped by a specific buyer persona. Examples: "running gear for marathon training in winter", "minimalist t-shirts for new dads".
- "Comparison" — head-to-head or "vs." style queries. Examples: "Allbirds vs Veja for sustainable sneakers", "Patagonia vs Arc'teryx for hiking shells".

Each prompt MUST:
- Be a thing a real human would actually type or ask. Conversational, not formal. No marketing language.
- Be 8–400 chars. Specific enough to filter, general enough to surface multiple brands.
- Be answerable by an LLM today (no future events, no realtime data).
- Be tagged with an "intent" level:
   - "High" = strong purchase intent ("buy", "where can I get", "best X under $Y").
   - "Med"  = comparison or research ("vs", "how does X compare", "is X worth it").
   - "Low"  = exploratory ("what is X", "what are the trends in Y").
- NOT include the brand's own name explicitly — we want to see whether the brand surfaces organically.
- NOT repeat the same idea reworded. Each prompt should test a meaningfully different angle.

Spread the ${TARGET_PROMPT_COUNT} prompts roughly evenly across the three clusters. Mix intent levels within each cluster (~50% High, ~30% Med, ~20% Low is a good default but adjust to the brand's stage).

Respond ONLY with the structured JSON ({ "prompts": [{ cluster, intent, text }, …] }). No prose.`;
