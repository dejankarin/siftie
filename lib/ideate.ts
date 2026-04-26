/**
 * The **Ideate** stage of the research orchestrator.
 *
 * Inputs:
 *   - the indexed sources (their ContextDocs)
 *   - the chat transcript so far (interview answers + any follow-ups)
 *   - the research title
 *
 * Output:
 *   - up to ~24 candidate prompts grouped by cluster (Category /
 *     Persona / Comparison) and intent (High / Med / Low). The Council
 *     then keeps ~12, refines, and ranks them in lib/council.ts.
 *
 * ## Two-provider strategy
 *
 * We try **OpenAI GPT-5.4 (primary)** first and **Gemini Flash
 * (fallback)** second. Why this order:
 *
 *   1. OpenAI is the strongest general-purpose model on prompt-design
 *      tasks today; the user explicitly asked for it as the primary.
 *   2. Gemini Flash covers the failure mode where OpenAI is rate-
 *      limited, the user's OpenAI key is missing/invalid, or OpenAI
 *      is having an outage. Both providers can answer the same JSON
 *      schema, so the fallback is fully transparent.
 *   3. The orchestrator returns metadata about which provider ran +
 *      why we fell back, so the chat bubble in `lib/research.ts` can
 *      tell the user "OpenAI was unavailable, so we used Gemini Flash".
 *
 * ## BYOK + PostHog
 *
 *   - apiKeys are always passed in; we never read process.env.
 *   - Each call is wrapped via `@posthog/ai` so a `$ai_generation`
 *     event is emitted with `feature: 'ideate'`, `provider:
 *     'openai'|'gemini'`, and the run-level traceId.
 *   - 60-90s hard timeouts via withResilience.
 */
import 'server-only';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import { ThinkingLevel } from '@google/genai';
import type { ContextDoc } from './ingest/schema';
import { generateOpenAIJson, OPENAI_IDEATE_MODEL } from './openai';
import { getPostHogServer } from './posthog';
import {
  IdeateResponse,
  IdeateResponseJsonSchema,
  type IdeatePrompt,
} from './research/schema';
import { withResilience } from './resilience';

/**
 * Gemini Flash fallback model. We pin to the explicit
 * `gemini-3-flash-preview` ID per the Gemini 3 docs — `*-latest`
 * aliases aren't documented for the 3-series and have caused
 * routing/quota oddities in earlier dev runs. Same family as the
 * source-ingestion + interview-question paths in `lib/ingest/*` and
 * `lib/interview.ts`, so a single working Gemini key unlocks every
 * Gemini-backed code path in the app.
 *
 * Note: this is a deliberate downgrade from the earlier
 * `gemini-3.1-pro-preview` lineup — Pro 3.1 was visibly slow
 * (~30–45s) on a 24-prompt portfolio and required a paid Gemini
 * tier, both of which made the fallback feel like a punishment.
 * Flash 3 finishes inside ~10s on the happy path and works on the
 * free tier, which keeps the fallback experience close to the
 * primary's latency budget.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview
 */
const GEMINI_MODEL = 'gemini-3-flash-preview';

/** Generous timeout for the Gemini fallback path. */
const GEMINI_TIMEOUT_MS = 90_000;

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
   * the model sees both the "what we asked" and the "what they
   * answered" sides. Council bubbles from prior runs are intentionally
   * excluded — they're stale narrative, not user signal.
   */
  messages: MessageBrief[];
}

/**
 * Caller-supplied keys. At least one must be present, enforced by
 * the orchestrator before this function is ever called.
 */
export interface IdeateKeys {
  openaiKey?: string | null;
  geminiKey?: string | null;
}

export interface IdeateCallOptions {
  posthogDistinctId: string;
  /** Run-level trace id so all 7 council calls + this ideate call share one trace. */
  posthogTraceId: string;
  posthogPrivacyMode: boolean;
  posthogProperties?: Record<string, unknown>;
}

export type IdeateProvider = 'openai' | 'gemini';

/**
 * Returned alongside the prompts so the orchestrator can decide
 * whether to emit a "we fell back" chat bubble. `fallbackReason` is
 * only set when we tried OpenAI first and it failed.
 */
export interface IdeateResult {
  prompts: IdeatePrompt[];
  providerUsed: IdeateProvider;
  modelUsed: string;
  fallbackReason?: string;
}

/**
 * Error thrown when *every* configured provider failed during Ideate.
 * Carries the last-attempted provider so the orchestrator can call
 * `classifyProviderError(err, err.provider)` and surface a precise
 * "fix your <provider> key" message in the chat.
 */
export class IdeateProviderError extends Error {
  readonly provider: IdeateProvider;
  /** Optional second-to-last error when both OpenAI *and* Gemini failed. */
  readonly precedingError?: unknown;
  constructor(provider: IdeateProvider, original: unknown, precedingError?: unknown) {
    const message = original instanceof Error ? original.message : String(original);
    super(message);
    this.name = 'IdeateProviderError';
    this.provider = provider;
    this.precedingError = precedingError;
    if (original instanceof Error) this.cause = original;
  }
}

/**
 * Generate the candidate prompts for a research run. Tries OpenAI
 * GPT-5.4 first; on any error, falls back to Gemini Flash (provided
 * a Gemini key is available). Returns the parsed + Zod-validated
 * array along with metadata about which provider answered.
 */
export async function generateIdeatePrompts(
  keys: IdeateKeys,
  input: IdeateInput,
  opts: IdeateCallOptions,
): Promise<IdeateResult> {
  if (input.sources.length === 0) {
    throw new Error('Cannot ideate without any sources');
  }

  const hasOpenAI = !!(keys.openaiKey && keys.openaiKey.length >= 8);
  const hasGemini = !!(keys.geminiKey && keys.geminiKey.length >= 8);

  if (!hasOpenAI && !hasGemini) {
    throw new Error(
      'No Ideate provider available. Add an OpenAI key (preferred) or a Gemini key in Settings.',
    );
  }

  const briefs = input.sources.map((s) => buildSourceBrief(s.kind, s.contextDoc));
  const userPrompt = buildUserPrompt(input.researchTitle, briefs, input.messages);

  // ---- Primary: OpenAI GPT-5.4 ------------------------------------------
  if (hasOpenAI) {
    try {
      const prompts = await runOpenAIIdeate(keys.openaiKey!, userPrompt, opts);
      return {
        prompts,
        providerUsed: 'openai',
        modelUsed: OPENAI_IDEATE_MODEL,
      };
    } catch (openAiErr) {
      // No Gemini fallback configured — bubble the OpenAI error up so
      // the orchestrator can show a precise "fix your OpenAI key"
      // message via classifyProviderError.
      if (!hasGemini) {
        throw new IdeateProviderError('openai', openAiErr);
      }
      // Continue to Gemini fallback below; remember why.
      const reason = openAiErr instanceof Error ? openAiErr.message : String(openAiErr);
      try {
        const prompts = await runGeminiIdeate(keys.geminiKey!, userPrompt, opts);
        return {
          prompts,
          providerUsed: 'gemini',
          modelUsed: GEMINI_MODEL,
          fallbackReason: reason,
        };
      } catch (geminiErr) {
        // Both providers failed. Surface the Gemini error (the latest
        // one) but keep OpenAI's around for diagnostic logs.
        throw new IdeateProviderError('gemini', geminiErr, openAiErr);
      }
    }
  }

  // ---- No OpenAI key at all → straight Gemini ---------------------------
  try {
    const prompts = await runGeminiIdeate(keys.geminiKey!, userPrompt, opts);
    return {
      prompts,
      providerUsed: 'gemini',
      modelUsed: GEMINI_MODEL,
    };
  } catch (geminiErr) {
    throw new IdeateProviderError('gemini', geminiErr);
  }
}

// ---------------------------------------------------------------------------
// Provider-specific runners
// ---------------------------------------------------------------------------

async function runOpenAIIdeate(
  apiKey: string,
  userPrompt: string,
  opts: IdeateCallOptions,
): Promise<IdeatePrompt[]> {
  const text = await generateOpenAIJson(
    apiKey,
    {
      system: SYSTEM_INSTRUCTION,
      user: userPrompt,
      schema: IdeateResponseJsonSchema as Record<string, unknown>,
      schemaName: 'ideate_response',
      temperature: 0.7,
      maxTokens: 4000,
    },
    {
      posthogDistinctId: opts.posthogDistinctId,
      posthogTraceId: opts.posthogTraceId,
      posthogPrivacyMode: opts.posthogPrivacyMode,
      posthogProperties: {
        tag: 'ideate_prompts',
        target_count: TARGET_PROMPT_COUNT,
        ideate_role: 'primary',
        ...opts.posthogProperties,
      },
    },
  );
  return parseAndTrim(text);
}

async function runGeminiIdeate(
  apiKey: string,
  userPrompt: string,
  opts: IdeateCallOptions,
): Promise<IdeatePrompt[]> {
  const phClient = getPostHogServer();
  const ai = new PostHogGoogleGenAI({ apiKey, posthog: phClient });

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
          // Gemini 3 docs strongly recommend keeping temperature at the
          // default (1.0). Setting it lower can cause looping or
          // degraded performance on complex reasoning tasks.
          // `ThinkingLevel.MEDIUM` keeps the latency reasonable while
          // still giving the model room to plan a 24-prompt portfolio.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        },
        posthogDistinctId: opts.posthogDistinctId,
        posthogTraceId: opts.posthogTraceId,
        posthogPrivacyMode: opts.posthogPrivacyMode,
        posthogProperties: {
          feature: 'ideate',
          tag: 'ideate_prompts',
          target_count: TARGET_PROMPT_COUNT,
          provider: 'gemini',
          ideate_role: 'fallback',
          ...opts.posthogProperties,
        },
      }),
    {
      timeoutMs: GEMINI_TIMEOUT_MS,
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
  return parseAndTrim(text);
}

function parseAndTrim(text: string): IdeatePrompt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Ideate model returned non-JSON response');
  }
  const validated = IdeateResponse.parse(parsed);
  // Trim to keep the council's workload bounded. We don't shuffle —
  // the model already orders by perceived strength in most runs.
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
    // prompt window. Both Pro and GPT-5.4 have huge contexts but we
    // don't need them.
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
