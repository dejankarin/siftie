/**
 * Typed wrapper around the OpenAI Platform API for *structured-output* JSON
 * calls — used as the **primary Ideate model** (GPT-5.4).
 *
 * Why a dedicated layer (vs. routing through `lib/openrouter.ts`):
 *
 *   1. **Direct provider, direct billing.** The user supplies their own
 *      `platform.openai.com` key; OpenAI invoices them directly. No
 *      OpenRouter middleman, no marketplace markup, no second BYOK to
 *      manage when they already have OpenAI usage.
 *
 *   2. **Same SDK, same instrumentation.** OpenAI Platform is the
 *      canonical OpenAI API, so we just use the official `openai` SDK
 *      with no `baseURL` override. PostHog `$ai_generation` events still
 *      fire via `@posthog/ai/openai`, so Ideate calls show up beside
 *      Council calls in the LLM analytics view.
 *
 *   3. **Structured output.** Uses OpenAI's `response_format` =
 *      `json_schema`. GPT-5.x supports it natively. We Zod-validate the
 *      response at the call site so a model that ignores the schema
 *      fails fast.
 *
 *   4. **Bring-Your-Own-Key.** Caller passes the user's OpenAI key
 *      explicitly — we never read `process.env`. Mirrors `lib/gemini.ts`
 *      and `lib/openrouter.ts`.
 *
 * What this is NOT:
 *   - It's not the Ideate stage. The Ideate stage (`lib/ideate.ts`)
 *     builds the prompt, calls *this* file with the OpenAI key, and
 *     falls back to Gemini Pro on failure. This file is just the
 *     transport.
 */
import 'server-only';
import { OpenAI as PostHogOpenAI } from '@posthog/ai/openai';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';

/**
 * The OpenAI model id we use for Ideate. GPT-5.4 is the latest
 * general-purpose model on the OpenAI Platform; centralised here so
 * the Ideate file stays free of model literals.
 */
export const OPENAI_IDEATE_MODEL = 'gpt-5.4' as const;

/**
 * Hard timeout per call. Ideate produces ~24 prompts at once which is
 * a moderately-large response; 60s is generous but safe under
 * Vercel's 300s function ceiling.
 */
const TIMEOUT_MS = 60_000;

export interface OpenAICallOptions {
  /** Clerk user id — becomes the PostHog distinctId on the $ai_generation event. */
  posthogDistinctId: string;
  /** Run-level trace id so Ideate appears in the same trace as Council calls. */
  posthogTraceId: string;
  /** Mirrors the user's `posthog_capture_llm` toggle. */
  posthogPrivacyMode: boolean;
  /** Free-form tags merged onto the event — e.g. { tag: 'ideate', stage: 'primary' }. */
  posthogProperties?: Record<string, unknown>;
}

export interface OpenAIJsonGenerationParams {
  /** OpenAI model id. Defaults to `OPENAI_IDEATE_MODEL`. */
  model?: string;
  /** System message that frames the role + rules. */
  system: string;
  /** User message containing the actual task input. */
  user: string;
  /**
   * JSON Schema describing the expected response shape. Goes into
   * `response_format: { type: 'json_schema', ... }`.
   */
  schema: Record<string, unknown>;
  /** Schema name surfaced in the response_format payload. Helps debugging. */
  schemaName: string;
  /** 0-2; defaults to 0.7 (Ideate benefits from creative diversity). */
  temperature?: number;
  /** Output token cap. Defaults to 4000 — enough for ~24 prompt objects. */
  maxTokens?: number;
}

/**
 * Run a single structured-JSON completion via the OpenAI Platform.
 * Returns the raw JSON string — caller is responsible for `JSON.parse`
 * + Zod validation. We deliberately don't parse here so callers can
 * surface useful messages ("Ideate returned malformed JSON" vs. a
 * generic transport failure) and decide whether to fall back.
 */
export async function generateOpenAIJson(
  apiKey: string,
  params: OpenAIJsonGenerationParams,
  opts: OpenAICallOptions,
): Promise<string> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('OpenAI API key missing or too short');
  }

  // Construct a fresh PostHog-wrapped client per call. Wrapping is
  // cheap and per-request keys mean we cannot safely cache a client
  // across users.
  const phClient = getPostHogServer();
  const client = new PostHogOpenAI({
    apiKey,
    posthog: phClient,
  });

  const model = params.model ?? OPENAI_IDEATE_MODEL;

  const completion = await withResilience(
    () =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 4000,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: params.schemaName,
            // strict: false because Ideate's optional fields (e.g.
            // candidate notes/strategy) are easier to evolve without a
            // strict schema lock. We Zod-validate the response anyway.
            strict: false,
            schema: params.schema,
          },
        },
        // PostHog instrumentation params — stripped from the outbound
        // HTTP body by the wrapper.
        posthogDistinctId: opts.posthogDistinctId,
        posthogTraceId: opts.posthogTraceId,
        posthogPrivacyMode: opts.posthogPrivacyMode,
        posthogProperties: {
          feature: 'ideate',
          model_id: model,
          provider: 'openai',
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
        // Stop retrying on auth, quota, and "model not found" — those
        // won't fix themselves on retry, and we want to fall back to
        // Gemini *fast* in the Ideate orchestrator.
        return /401|403|404|invalid_api_key|insufficient_quota|model_not_found/i.test(
          msg,
        );
      },
    },
  );

  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`OpenAI (${model}) returned an empty response`);
  }
  return text;
}
