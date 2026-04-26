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
 *     falls back to Gemini Flash on failure. This file is just the
 *     transport.
 */
import 'server-only';
import { OpenAI as PostHogOpenAI } from '@posthog/ai/openai';
import { ContextDoc, ContextDocJsonSchema } from './ingest/schema';
import { log } from './logger';
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
  /**
   * Run-level trace id so multi-step pipelines (e.g. Ideate + Council
   * for research, or Tavily + LLM for ingest) all show up under the
   * same trace in PostHog LLM Analytics. Optional because some
   * standalone callers don't have a meaningful trace id.
   */
  posthogTraceId?: string;
  /** Mirrors the user's `posthog_capture_llm` toggle. */
  posthogPrivacyMode: boolean;
  /** Free-form tags merged onto the event — e.g. { tag: 'ideate', stage: 'primary' }. */
  posthogProperties?: Record<string, unknown>;
}

/**
 * Subset of OpenAI's chat content parts we use. Plain text is the
 * default; `file` is used for inline PDF inputs (data URI, base64).
 * Other part types like `image_url` are not currently used.
 */
export type OpenAIUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface OpenAIJsonGenerationParams {
  /** OpenAI model id. Defaults to `OPENAI_IDEATE_MODEL`. */
  model?: string;
  /** System message that frames the role + rules. */
  system: string;
  /**
   * User message. Either a plain string (most cases) or an array of
   * content parts when we need to attach files like inline PDFs for
   * source ingestion fallback.
   */
  user: string | OpenAIUserContentPart[];
  /**
   * JSON Schema describing the expected response shape. Goes into
   * `response_format: { type: 'json_schema', ... }`.
   */
  schema: Record<string, unknown>;
  /** Schema name surfaced in the response_format payload. Helps debugging. */
  schemaName: string;
  /**
   * 0–2; defaults to 0.7 for non-reasoning models. **Ignored for
   * reasoning models** (gpt-5.x, o-series) which only support the
   * default value of 1 — passing a different value would 400 the call.
   */
  temperature?: number;
  /**
   * Output token cap. Defaults to 4000. For reasoning models this is
   * sent as `max_completion_tokens` (which counts reasoning + visible
   * tokens). For older chat models it's sent as `max_tokens`.
   */
  maxTokens?: number;
  /**
   * Reasoning effort for reasoning models (gpt-5.x, o-series). Lower
   * effort → faster + cheaper response. We default to `'low'` because
   * Ideate / Ingest are short, schema-bound tasks where deeper
   * reasoning rarely improves output but adds 5-30s of latency.
   * Ignored for non-reasoning models.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * True if the model id refers to a reasoning model (gpt-5.x family or
 * the o-series). Reasoning models have stricter parameter rules:
 *   - reject `temperature` other than the default of 1
 *   - require `max_completion_tokens` instead of `max_tokens`
 *   - support `reasoning_effort`
 *
 * Kept conservative — anything we don't recognise is treated as a
 * regular chat model so we don't accidentally drop temperature on
 * a model that does support it.
 */
function isReasoningModel(modelId: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(modelId);
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
  const reasoning = isReasoningModel(model);

  // Build the completion body. Reasoning models (gpt-5.x, o-series)
  // and chat models share most of the schema but diverge on three
  // fields:
  //   - temperature  : reasoning models reject anything but the
  //                    default; chat models default to 0.7.
  //   - token cap    : reasoning uses `max_completion_tokens`,
  //                    chat uses `max_tokens` (deprecated for newer
  //                    reasoning models).
  //   - reasoning_effort : reasoning-only knob; we default to 'low'
  //                    because Ideate and Ingest are short, schema-
  //                    bound tasks where deeper reasoning adds 5-30s
  //                    of latency without measurably better output.
  //
  // Mistakes here are *silent in our classifier* — OpenAI returns a
  // 400 "Unsupported value" / "Unsupported parameter" which our
  // generic provider-error fallback masks as "OpenAI request failed".
  // Keep this branch tight.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    model,
    messages: [
      { role: 'system', content: params.system },
      // The OpenAI SDK accepts either a string or a content-parts array
      // for `content`, but the union types get noisy when `file` parts
      // (added in 2025) are involved. Cast at the boundary so the rest
      // of our code keeps the cleaner `OpenAIUserContentPart` type.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: 'user', content: params.user as any },
    ],
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
      reasoning_model: reasoning,
      ...opts.posthogProperties,
    },
  };

  if (reasoning) {
    body.max_completion_tokens = params.maxTokens ?? 4000;
    body.reasoning_effort = params.reasoningEffort ?? 'low';
  } else {
    body.max_tokens = params.maxTokens ?? 4000;
    body.temperature = params.temperature ?? 0.7;
  }

  let completion;
  try {
    completion = await withResilience(
      // The completion body has a discriminated union type that varies
      // by reasoning vs. chat model. We've already enforced the right
      // params above, so cast at the boundary rather than thread two
      // typed paths through the SDK overloads.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => client.chat.completions.create(body as any),
      {
        timeoutMs: TIMEOUT_MS,
        retries: 2,
        minTimeoutMs: 1_000,
        maxTimeoutMs: 4_000,
        shouldAbort: (err) => {
          const msg = err instanceof Error ? err.message : String(err ?? '');
          // Bail out fast on any 4xx (auth, quota, missing model,
          // unsupported parameter, schema rejection). None of these get
          // better with another try, and the Ideate orchestrator falls
          // back to Gemini in milliseconds when we abort here.
          return /\b(400|401|403|404|429)\b|invalid_api_key|insufficient_quota|model_not_found|unsupported_value|unsupported_parameter|invalid_request_error/i.test(
            msg,
          );
        },
      },
    );
  } catch (err) {
    // Surface the *raw* SDK error (status + code + message) into the
    // logs so we can diagnose it from PostHog without re-running. The
    // user-facing classifier deliberately scrubs detail to avoid
    // leaking internal noise; this is the diagnostic pipe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apiErr = err as any;
    log.error('openai.call.failed', {
      model,
      reasoning_model: reasoning,
      status: typeof apiErr?.status === 'number' ? apiErr.status : undefined,
      code: typeof apiErr?.code === 'string' ? apiErr.code : undefined,
      type: typeof apiErr?.type === 'string' ? apiErr.type : undefined,
      param: typeof apiErr?.param === 'string' ? apiErr.param : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const text = completion.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`OpenAI (${model}) returned an empty response`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Source ingestion fallback — mirrors lib/gemini.ts:contextDoc
// ---------------------------------------------------------------------------

/**
 * Source-ingest input shape, mirroring `lib/gemini.ts:GeminiInput`.
 * Identical contract so `lib/ingest/index.ts` can switch providers
 * without changing callers.
 */
export type OpenAIIngestInput =
  | {
      kind: 'pdf';
      buffer: Buffer;
      filename: string;
      mimeType: 'application/pdf';
    }
  | {
      kind: 'text';
      text: string;
      contextHint?: string;
    };

/**
 * GPT-5.4 — same model used for Ideate. Ingest is a much cheaper task
 * (small text inputs, schema-bound output) so cost stays trivial.
 * Pinned here so future model bumps happen in one place.
 */
export const OPENAI_INGEST_MODEL = 'gpt-5.4' as const;

/**
 * Generate a ContextDoc from the given input using OpenAI GPT-5.4 as a
 * fallback when Gemini Flash is unavailable.
 *
 * Two paths depending on input kind:
 *   - `pdf`  → inline base64 file content part. OpenAI parses the PDF
 *              natively in Chat Completions (data URI, no Files API
 *              upload required), the same way Gemini's `inlineData`
 *              works.
 *   - `text` → plain text content. We optionally prepend a short
 *              `contextHint` so the model knows whether it's looking
 *              at a URL extraction, a Word doc, or a markdown note.
 *
 * Reuses the *same* JSON Schema as the Gemini path so the resulting
 * ContextDoc rows are interchangeable downstream — Ideate, Council,
 * and Surface don't know which provider produced the doc.
 */
export async function openAIContextDoc(
  apiKey: string,
  input: OpenAIIngestInput,
  opts: OpenAICallOptions,
): Promise<ContextDoc> {
  const userContent: OpenAIUserContentPart[] =
    input.kind === 'pdf'
      ? [
          {
            type: 'file',
            file: {
              filename: input.filename,
              file_data: `data:${input.mimeType};base64,${input.buffer.toString('base64')}`,
            },
          },
          { type: 'text', text: 'Index this PDF as a Siftie source.' },
        ]
      : [
          {
            type: 'text',
            text: input.contextHint
              ? `${input.contextHint}\n\n---\n\n${input.text}`
              : input.text,
          },
        ];

  const text = await generateOpenAIJson(
    apiKey,
    {
      model: OPENAI_INGEST_MODEL,
      system: INGEST_SYSTEM_INSTRUCTION,
      user: userContent,
      schema: ContextDocJsonSchema as Record<string, unknown>,
      schemaName: 'context_doc',
      // Ingest wants near-deterministic, neutral output (matches the
      // Gemini path's temperature: 0.2). The default 0.7 used for
      // Ideate would invite editorialising.
      temperature: 0.2,
      maxTokens: 4000,
    },
    {
      ...opts,
      posthogProperties: {
        feature: 'ingest',
        ingest_kind: input.kind,
        ...opts.posthogProperties,
      },
    },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('OpenAI returned non-JSON ContextDoc response');
  }
  return ContextDoc.parse(parsed);
}

/**
 * Identical wording to lib/gemini.ts so Gemini-vs-OpenAI ContextDocs
 * are stylistically interchangeable. If we tweak the indexer prompt we
 * should update both files in lockstep — tested manually because the
 * downstream parsers don't care about phrasing, only schema.
 */
const INGEST_SYSTEM_INSTRUCTION = `You are Siftie's source indexer.

Your job is to read a single research source (PDF, web page, document, or markdown) and produce a neutral, structured "context document" that the rest of the Siftie agent will use as ground truth when drafting prompt portfolios.

Hard rules:
- Be factual and neutral. No marketing language. No editorial commentary.
- "title" must be the canonical name of the source, not a description of it. If a clear title is present, use it verbatim. If not, generate a short descriptive title (max ~80 chars).
- "summary" is 2–3 plain-language sentences that a colleague could read in 10 seconds and know what's in the source.
- "words" is your best estimate of the source's word count.
- "topics" are 5–15 short tag-like phrases (e.g. "sustainability", "competitor pricing", "Gen Z buyers"). Lowercase. No punctuation.
- "entities" are named brands, products, people, places, or concepts mentioned. Use the closed kind set. Skip generic nouns.
- "facts" are 5–15 atomic, self-contained sentences quoted from or directly supported by the source. Each fact should stand on its own without surrounding context.
- "rawExcerpt" is the first ~500 characters of the source verbatim (no editing). For PDFs, take the first ~500 chars of the readable text content.

Respond ONLY with the structured JSON. No prose.`;
