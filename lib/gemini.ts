/**
 * Typed wrapper around Gemini 3 Flash for *structured-output* generation.
 *
 * Why this layer exists (vs. calling `@google/genai` directly):
 *
 *   1. **Bring-Your-Own-Key.** Every call takes `apiKey` as the first
 *      argument — never reads `process.env.GEMINI_API_KEY`. The route
 *      handler is responsible for fetching the user's key from
 *      `getUserApiKey(userId, 'gemini')` and passing it in. This keeps
 *      key handling local to the request, makes it impossible to
 *      accidentally fall back to a server-wide key, and means each user
 *      pays for their own Gemini calls.
 *
 *   2. **PostHog LLM Analytics.** We construct `PostHogGoogleGenAI` per
 *      call so every generation emits a `$ai_generation` event with
 *      tokens, cost, latency, and the model id. Each call accepts
 *      `posthogDistinctId` (= Clerk user id) and a `posthogPrivacyMode`
 *      flag so the user's `posthog_capture_llm` preference decides
 *      whether prompts/responses are captured. Tags like
 *      `{ tag: 'context_doc', source_id, kind }` flow through
 *      `posthogProperties` so we can filter dashboards by ingest type.
 *
 *   3. **Structured output.** Every call goes through `responseJsonSchema`
 *      so Gemini returns JSON that matches our `ContextDoc` schema
 *      directly — no flaky "please respond in JSON" prompting.
 *
 *   4. **Retries + timeout.** Wrapped in `p-retry` with 2 retries on 5xx
 *      / network errors. We don't retry on 4xx (auth, quota, bad input)
 *      because they won't get better.
 */
import 'server-only';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import pRetry, { AbortError } from 'p-retry';
import { ContextDoc, ContextDocJsonSchema } from './ingest/schema';
import { getPostHogServer } from './posthog';

/**
 * Model used for every ContextDoc generation. We pin to a Flash model so
 * cost stays trivial (~$0.001 per source). If Google ships a cheaper
 * tier later we can flip this in one place.
 */
const GEMINI_MODEL = 'gemini-flash-latest';

/**
 * Hard timeout per call. 60s is enough for a ~50-page PDF on Flash;
 * anything longer almost certainly indicates a stuck request that
 * should be retried or surfaced as a failure.
 */
const TIMEOUT_MS = 60_000;

export type GeminiInput =
  | {
      kind: 'pdf';
      buffer: Buffer;
      mimeType: 'application/pdf';
    }
  | {
      kind: 'text';
      text: string;
      /** Optional surrounding label so Gemini knows the source context (e.g. "From URL https://…", "From .docx file …"). */
      contextHint?: string;
    };

export interface ContextDocCallOptions {
  /** Clerk user id — becomes the PostHog distinctId on the $ai_generation event. */
  posthogDistinctId: string;
  /** Optional research-level trace id so multiple calls in one ingest can be grouped in LLM Analytics. */
  posthogTraceId?: string;
  /** When true, PostHog will NOT capture the prompt + response bodies (just metadata). Reflects the user's privacy toggle. */
  posthogPrivacyMode: boolean;
  /** Free-form tags merged onto the event — e.g. { tag: 'context_doc', source_id, kind }. */
  posthogProperties?: Record<string, unknown>;
}

/**
 * Generate a ContextDoc from the given input. Returns the parsed,
 * validated object — throws if Gemini returned malformed JSON or the
 * model errored out after retries.
 *
 * The system prompt asks Gemini to act as an "indexer" rather than a
 * summariser; we want neutral, quotable facts, not editorial commentary.
 */
export async function contextDoc(
  apiKey: string,
  input: GeminiInput,
  opts: ContextDocCallOptions,
): Promise<ContextDoc> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('Gemini API key missing or too short');
  }

  // Construct a fresh wrapped client per call. The wrapping is cheap (no
  // network) and per-request keys mean we can't safely cache the client
  // across users anyway.
  const phClient = getPostHogServer();
  const ai = new PostHogGoogleGenAI({
    apiKey,
    posthog: phClient,
  });

  const userParts = buildUserParts(input);

  const run = async () => {
    // We use `Promise.race` for a hard timeout because the Google SDK
    // doesn't expose an AbortSignal on generateContent today.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    );

    const callPromise = ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: userParts,
        },
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: ContextDocJsonSchema,
        temperature: 0.2,
      },
      // PostHog tracking params (typed via @posthog/ai's MonitoringParams).
      posthogDistinctId: opts.posthogDistinctId,
      posthogTraceId: opts.posthogTraceId,
      posthogPrivacyMode: opts.posthogPrivacyMode,
      posthogProperties: {
        feature: 'ingest',
        ...opts.posthogProperties,
      },
    });

    return Promise.race([callPromise, timeoutPromise]);
  };

  const response = await pRetry(run, {
    retries: 2,
    minTimeout: 500,
    maxTimeout: 2000,
    onFailedAttempt: (ctx) => {
      // Don't retry on auth / quota errors — they won't get better.
      const msg = ctx.error instanceof Error ? ctx.error.message : String(ctx.error ?? '');
      if (/401|403|API key|invalid_api_key|PERMISSION_DENIED|quota/i.test(msg)) {
        throw new AbortError(msg);
      }
    },
  });

  const text = response.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Gemini returned an empty response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned non-JSON response');
  }

  // Trust nothing — validate the shape against our Zod schema. If Gemini
  // missed a required field we'd rather fail loudly than persist garbage.
  return ContextDoc.parse(parsed);
}

/**
 * Build the `parts` array Gemini expects.
 *   - PDFs go in as `inlineData` with the application/pdf mimeType — the
 *     model parses the file natively (text + layout + images).
 *   - Plain text just becomes a `text` part. We prepend an optional
 *     `contextHint` so Gemini knows whether it's looking at a URL, a docx,
 *     or pasted markdown — that nudges title selection in the right
 *     direction.
 */
function buildUserParts(input: GeminiInput) {
  if (input.kind === 'pdf') {
    return [
      {
        inlineData: {
          mimeType: input.mimeType,
          data: input.buffer.toString('base64'),
        },
      },
      { text: 'Index this PDF as a Siftie source.' },
    ];
  }

  const prefix = input.contextHint ? `${input.contextHint}\n\n---\n\n` : '';
  return [
    {
      text: `${prefix}${input.text}`,
    },
  ];
}

const SYSTEM_INSTRUCTION = `You are Siftie's source indexer.

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
