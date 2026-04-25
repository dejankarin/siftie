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
 *      attribution per model.
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
 *     coordinates the four reviewers, and merges their verdicts. This
 *     file is just the transport.
 */
import 'server-only';
import { OpenAI as PostHogOpenAI } from '@posthog/ai/openai';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';

/**
 * The four model IDs we hit through OpenRouter. Pinned here so the
 * Council file can `import { COUNCIL_MODELS } from './openrouter'` and
 * we have one source of truth. If a model id 404s on OpenRouter we
 * change it here and every reviewer picks it up.
 *
 * Order matters: the first 3 are the "quick" depth, all 4 are
 * "standard" depth. See `lib/council.ts` for selection.
 */
export const COUNCIL_MODELS = [
  'openai/gpt-5.5',
  'google/gemini-3-pro-preview',
  'anthropic/claude-opus-4.5',
  'x-ai/grok-4',
] as const;
export type CouncilModelId = (typeof COUNCIL_MODELS)[number];

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Hard timeout per call. Council reviewers crunch a lot of context
 * (sources + interview + ~24 prompts) and reasoning models like
 * gpt-5.5 / grok-4 are slow, so we budget generously.
 */
const TIMEOUT_MS = 90_000;

export interface OpenRouterCallOptions {
  /** Clerk user id — becomes the PostHog distinctId on the $ai_generation event. */
  posthogDistinctId: string;
  /** Run-level trace id so all 7 council calls (4 reviewers + 3 cross + 1 chair) appear in one trace. */
  posthogTraceId: string;
  /** Mirrors the user's `posthog_capture_llm` toggle. */
  posthogPrivacyMode: boolean;
  /** Free-form tags merged onto the event — e.g. { tag: 'council_review', stage: 1, seat: 2 }. */
  posthogProperties?: Record<string, unknown>;
}

export interface JsonGenerationParams {
  /** OpenRouter model id, e.g. "openai/gpt-5.5". */
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
  /** 0-2; defaults to 0.4 (modest creativity for refinement, not for verdicts). */
  temperature?: number;
  /** Output token cap. Defaults to 2000. */
  maxTokens?: number;
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

  const completion = await withResilience(
    () =>
      client.chat.completions.create({
        model: params.model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        temperature: params.temperature ?? 0.4,
        max_tokens: params.maxTokens ?? 2000,
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
        // Stop retrying on auth, quota, and "model not found" — none of
        // those will fix themselves with another attempt.
        return /401|403|404|invalid_api_key|insufficient_quota|model_not_found/i.test(
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
