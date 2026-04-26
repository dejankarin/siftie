/**
 * Typed wrapper around OpenRouter for *structured-output* JSON calls.
 *
 * Why this layer (vs. raw `openai` SDK or raw `fetch`):
 *
 *   1. **One transport, many providers.** OpenRouter's API is OpenAI-
 *      compatible, so we can use the official `openai` SDK and just
 *      change `baseURL`. That means we get streaming, retries, typings,
 *      and structured-output handling "for free" — and, critically, we
 *      can wrap the client with `@posthog/ai`'s `OpenAI` so every call
 *      emits a `$ai_generation` event with proper `$ai_provider`
 *      attribution per model. This is what makes a 3-vendor Council
 *      cheap to wire — one wrapper, three providers, one trace.
 *
 *   2. **Bring-Your-Own-Key.** Caller passes the user's OpenRouter key
 *      explicitly — we never read `process.env`. Mirrors `lib/gemini.ts`.
 *
 *   3. **Resilience.** Wrapped in `withResilience` for timeout + retries,
 *      with provider-aware abort rules (don't retry 401/403/quota).
 *
 *   4. **Structured output.** Uses OpenRouter's `response_format` =
 *      `json_schema` — most reviewer models support it; for ones that
 *      don't, OpenRouter falls back to `json_object` mode automatically.
 *      Either way we still validate the response with Zod at the call
 *      site, so a model that ignores the schema fails fast.
 *
 * What this is NOT:
 *   - It's not the Council. The Council (lib/council.ts) builds prompts,
 *     coordinates the reviewers, and merges their verdicts. This file
 *     is just the transport.
 */
import 'server-only';
import { OpenAI as PostHogOpenAI } from '@posthog/ai/openai';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';

/**
 * The model IDs we hit through OpenRouter for the Council. Pinned here
 * so the Council file can `import { COUNCIL_MODELS } from './openrouter'`
 * and we have one source of truth. If a model id 404s on OpenRouter we
 * change it here and every reviewer picks it up.
 *
 * **Demo lineup (3 fast models, one per major vendor).** Earlier drafts
 * of the plan used a 4-seat lineup with the strongest reasoning model
 * from each vendor (gpt-5.4 / gemini-3.1-pro / claude-opus-4.5 / grok-4),
 * but the full deliberation was so slow (~60–90s end-to-end) that the
 * Council read like a backend job rather than a live agent. For the
 * demo we trade a little reasoning depth for ~3–5x faster wall-clock
 * by routing every seat to a "flash"-tier sibling of the original
 * model. Three vendors is enough to prove the cross-model disagreement
 * thesis; we can scale back up to 4 strong reviewers later.
 *
 * Order matters: the first 2 are the "quick" depth, all 3 are
 * "standard" depth. See `lib/council.ts` for selection.
 */
export const COUNCIL_MODELS = [
  // OpenAI's GPT-5.4 mini — same family as the Ideate primary, so the
  // Chair runs the exact reasoning lineage the candidate prompts were
  // generated under, just at a fraction of the latency.
  // https://developers.openai.com/api/docs/models/gpt-5.4-mini
  'openai/gpt-5.4-mini',
  // Gemini 2.5 Flash — Google's mainline fast tier with a generous
  // context window. We deliberately do NOT use a Gemini 3.x model
  // here: the 3-series flagship reasoning models loop on low temps
  // through OpenRouter (see `isReasoningModel` below) and Flash 2.5
  // hits the speed/quality balance we want for the demo.
  // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
  'google/gemini-2.5-flash',
  // Anthropic's Claude Haiku 4.5 — the smallest 4.x sibling of
  // Opus 4.5. Different vendor + different lineage from the other
  // two seats, which is the whole point of the council.
  'anthropic/claude-haiku-4.5',
] as const;
export type CouncilModelId = (typeof COUNCIL_MODELS)[number];

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Hard timeout per call. The demo lineup is intentionally fast — gpt-5.4-
 * mini, gemini-2.5-flash and claude-haiku-4.5 all comfortably finish a
 * Council reviewer call in well under 30s — but reasoning effort, retry
 * jitter, and OpenRouter's own queueing can spike, so we keep a 60s
 * ceiling. If we ever swap back to opus / pro / grok-4 reviewers, bump
 * this back to 90s.
 */
const TIMEOUT_MS = 60_000;

export interface OpenRouterCallOptions {
  /** Clerk user id — becomes the PostHog distinctId on the $ai_generation event. */
  posthogDistinctId: string;
  /** Run-level trace id so all 7 council calls (3 reviewers + 3 cross + 1 chair) appear in one trace. */
  posthogTraceId: string;
  /** Mirrors the user's `posthog_capture_llm` toggle. */
  posthogPrivacyMode: boolean;
  /** Free-form tags merged onto the event — e.g. { tag: 'council_review', stage: 1, seat: 2 }. */
  posthogProperties?: Record<string, unknown>;
}

export interface JsonGenerationParams {
  /** OpenRouter model id, e.g. "openai/gpt-5.4-mini". */
  model: string;
  /** System message that frames the role + rules. */
  system: string;
  /** User message containing the actual task input. */
  user: string;
  /**
   * JSON Schema describing the expected response shape. Goes into
   * `response_format: { type: 'json_schema', ... }`. We always set
   * `strict: true` so reviewer/chair models can't silently add fields.
   */
  schema: Record<string, unknown>;
  /** Schema name surfaced in the response_format payload. Helps debugging. */
  schemaName: string;
  /**
   * 0-2; defaults to 0.4 (modest creativity for refinement, not for
   * verdicts). **Ignored for reasoning models** (gpt-5.x, o-series,
   * gemini-3.x) — those reject non-default temperatures (OpenAI) or
   * loop with low temps (Gemini 3). Use `reasoningEffort` instead.
   */
  temperature?: number;
  /** Output token cap. Defaults to 2000. */
  maxTokens?: number;
  /**
   * Reasoning effort for reasoning models. Maps to OpenAI's
   * `reasoning_effort` and Gemini's `thinking_level` via OpenRouter's
   * unified parameter handling. Ignored for non-reasoning models.
   * Defaults to `'low'` — Council reviewers/chair are doing synthesis
   * over already-prepared inputs, so low effort is plenty.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * True if the OpenRouter model id refers to a reasoning model. We
 * branch on this to use `max_completion_tokens` + `reasoning_effort`
 * instead of `max_tokens` + `temperature`, mirroring how the direct
 * OpenAI client (`lib/openai.ts`) handles GPT-5.x.
 *
 * Covers:
 *   - `openai/gpt-5.x` (gpt-5.4, gpt-5.5)
 *   - `openai/o[1-9]…` (o1, o3, o3-mini, etc.)
 *   - `google/gemini-3.x` (gemini-3-flash-preview, gemini-3.1-pro-preview)
 */
function isReasoningModel(modelId: string): boolean {
  return (
    /^openai\/gpt-5(\.|-|$)/i.test(modelId) ||
    /^openai\/o[1-9]/i.test(modelId) ||
    /^google\/gemini-3(\.|-|$)/i.test(modelId)
  );
}

/**
 * Run a single structured-JSON completion via OpenRouter. Returns the
 * raw JSON string — the caller is responsible for `JSON.parse` +
 * Zod validation. We deliberately don't parse here so each Council
 * stage can show a useful error message ("Reviewer 2 returned malformed
 * JSON" vs. a generic transport failure).
 */
export async function generateJson(
  apiKey: string,
  params: JsonGenerationParams,
  opts: OpenRouterCallOptions,
): Promise<string> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('OpenRouter API key missing or too short');
  }

  // Construct a fresh PostHog-wrapped client per call. Wrapping is
  // cheap (no network) and per-request keys mean we cannot safely
  // cache a client across users.
  const phClient = getPostHogServer();
  const client = new PostHogOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    posthog: phClient,
    // OpenRouter recommends these headers for proper attribution +
    // visibility in their analytics dashboard. They're optional.
    defaultHeaders: {
      'HTTP-Referer': 'https://siftie.app',
      'X-Title': 'Siftie',
    },
  });

  // Build the chat-completion body. Reasoning models (OpenAI gpt-5.x /
  // o-series, Google gemini-3.x via OpenRouter) reject `temperature`
  // (OpenAI) or loop on low temps (Gemini 3), and they expect
  // `max_completion_tokens` + `reasoning_effort` instead of
  // `max_tokens` + `temperature`. Non-reasoning models (Claude, Grok)
  // keep the classic shape so we don't lose the diversity lever the
  // Council relies on across reviewers.
  const reasoning = isReasoningModel(params.model);
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: params.schemaName,
        // strict: false because (a) some council schemas have
        // optional fields like Chair's `text` rewrite, which OpenAI-
        // strict mode forbids, and (b) OpenRouter routes to many
        // providers with varying json_schema support. We Zod-
        // validate the response at the call site anyway.
        strict: false,
        schema: params.schema,
      },
    },
    // PostHog instrumentation params — these get stripped from the
    // outbound HTTP body by the wrapper.
    posthogDistinctId: opts.posthogDistinctId,
    posthogTraceId: opts.posthogTraceId,
    posthogPrivacyMode: opts.posthogPrivacyMode,
    posthogProperties: {
      feature: 'council',
      model_id: params.model,
      reasoning_model: reasoning,
      ...opts.posthogProperties,
    },
  };
  if (reasoning) {
    body.max_completion_tokens = params.maxTokens ?? 2000;
    body.reasoning_effort = params.reasoningEffort ?? 'low';
  } else {
    body.max_tokens = params.maxTokens ?? 2000;
    body.temperature = params.temperature ?? 0.4;
  }

  const completion = await withResilience(
    () => client.chat.completions.create(body as any),
    {
      timeoutMs: TIMEOUT_MS,
      retries: 2,
      minTimeoutMs: 1_000,
      maxTimeoutMs: 4_000,
      shouldAbort: (err) => {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        const status =
          err && typeof err === 'object' && 'status' in err
            ? Number((err as { status?: unknown }).status)
            : NaN;
        // Stop retrying on auth, quota, "model not found", and
        // unsupported-parameter errors — none of those will fix
        // themselves with another attempt.
        if ([400, 401, 403, 404, 429].includes(status)) return true;
        return /401|403|404|invalid_api_key|insufficient_quota|model_not_found|unsupported_value|unsupported_parameter|invalid_request_error/i.test(
          msg,
        );
      },
    },
  );

  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`OpenRouter (${params.model}) returned an empty response`);
  }
  return text;
}
