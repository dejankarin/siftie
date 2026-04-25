/**
 * Gemini Flash wrapper that produces the *opening interview questions*
 * for a research — six gap-attributed questions the agent asks once the
 * user has loaded sources and sent their first message.
 *
 * Why a separate file from `lib/gemini.ts`:
 *   The existing `contextDoc()` wrapper is hard-coded to the
 *   `ContextDoc` Zod schema and a "source indexer" system prompt.
 *   The interview generator needs a different schema, a different
 *   system prompt, and different tags. Rather than turn `contextDoc()`
 *   into a generic helper today (premature), we mirror its shape
 *   here and refactor in Session 6 once we have a third LLM call to
 *   compare against (Ideate / Council).
 *
 * BYOK + PostHog patterns are identical to `lib/gemini.ts`:
 *   - Always takes the user's API key as the first argument.
 *   - Wraps the GenAI client with `@posthog/ai/gemini` so each call
 *     emits a `$ai_generation` event tagged
 *     `{ tag: 'interview_questions', research_id }` — that's what the
 *     Session 4 plan asks for so LLM Analytics dashboards filter cleanly.
 *   - 60s hard timeout via `Promise.race` + 2 retries via `p-retry`,
 *     aborting on auth/quota errors so we don't burn quota retrying
 *     errors that won't recover.
 *
 * Inputs:
 *   - `sources` — the ContextDocs of every source the user has added.
 *     We pass title + summary + topics + first 8 facts each; that's
 *     enough signal for Flash to find gaps without blowing the context
 *     window when the user has 20 sources.
 *   - `userMessage` — the user's first chat message. Used as steering
 *     context (e.g. "I'm researching activewear for runners").
 *   - `researchTitle` — the research name for extra grounding.
 *
 * Output:
 *   - `string[]` of length 6 — the question bodies, ready to insert
 *     into `messages` with `role: 'agent'`.
 */
import 'server-only';
import { PostHogGoogleGenAI } from '@posthog/ai/gemini';
import pRetry, { AbortError } from 'p-retry';
import { z } from 'zod';
import type { ContextDoc } from './ingest/schema';
import { getPostHogServer } from './posthog';

const GEMINI_MODEL = 'gemini-flash-latest';
const TIMEOUT_MS = 60_000;
const QUESTION_COUNT = 6;

/**
 * What we pass to Gemini for each source. Trimmed-down ContextDoc to
 * keep the prompt compact when the user has many sources loaded.
 */
interface SourceBrief {
  title: string;
  kind: 'pdf' | 'url' | 'doc' | 'md';
  summary: string;
  topics: string[];
  facts: string[];
}

export interface InterviewInput {
  sources: Array<{
    kind: 'pdf' | 'url' | 'doc' | 'md';
    contextDoc: ContextDoc;
  }>;
  userMessage: string;
  researchTitle: string;
}

export interface InterviewCallOptions {
  posthogDistinctId: string;
  posthogTraceId?: string;
  posthogPrivacyMode: boolean;
  posthogProperties?: Record<string, unknown>;
}

const ResponseSchema = z.object({
  questions: z.array(z.string().min(8).max(400)).length(QUESTION_COUNT),
});

const ResponseJsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: QUESTION_COUNT,
      maxItems: QUESTION_COUNT,
      items: { type: 'string', minLength: 8, maxLength: 400 },
    },
  },
  required: ['questions'],
} as const;

/**
 * Generate the 6 opening interview questions for a research. Returns
 * an array of plain question strings the route handler can wrap into
 * `agent` messages. Throws on auth/quota/timeout errors after retries.
 */
export async function generateInterviewQuestions(
  apiKey: string,
  input: InterviewInput,
  opts: InterviewCallOptions,
): Promise<string[]> {
  if (!apiKey || apiKey.length < 8) {
    throw new Error('Gemini API key missing or too short');
  }
  if (input.sources.length === 0) {
    throw new Error('Cannot generate interview questions without any sources');
  }

  const phClient = getPostHogServer();
  const ai = new PostHogGoogleGenAI({ apiKey, posthog: phClient });

  const briefs = input.sources.map((s) => buildSourceBrief(s.kind, s.contextDoc));
  const userPrompt = buildUserPrompt(input.researchTitle, input.userMessage, briefs);

  const run = async () => {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    );

    const callPromise = ai.models.generateContent({
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
        responseJsonSchema: ResponseJsonSchema,
        temperature: 0.4,
      },
      posthogDistinctId: opts.posthogDistinctId,
      posthogTraceId: opts.posthogTraceId,
      posthogPrivacyMode: opts.posthogPrivacyMode,
      posthogProperties: {
        feature: 'interview',
        tag: 'interview_questions',
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

  return ResponseSchema.parse(parsed).questions;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSourceBrief(kind: SourceBrief['kind'], doc: ContextDoc): SourceBrief {
  return {
    title: doc.title,
    kind,
    summary: doc.summary,
    topics: doc.topics.slice(0, 8),
    // Cap facts per source so 20 sources × 15 facts doesn't bloat the prompt.
    facts: doc.facts.slice(0, 8),
  };
}

function buildUserPrompt(researchTitle: string, userMessage: string, briefs: SourceBrief[]): string {
  const sourcesBlock = briefs
    .map((b, i) => {
      const facts = b.facts.length > 0 ? `\n  Facts:\n  - ${b.facts.join('\n  - ')}` : '';
      const topics = b.topics.length > 0 ? `\n  Topics: ${b.topics.join(', ')}` : '';
      return `Source ${i + 1} (${b.kind}): ${b.title}\n  Summary: ${b.summary}${topics}${facts}`;
    })
    .join('\n\n');

  return `Research title: ${researchTitle}

The user just sent their first message:
"${userMessage}"

They have loaded ${briefs.length} source(s):

${sourcesBlock}

Generate exactly ${QUESTION_COUNT} opening interview questions that probe the highest-leverage gaps in the brief. Follow every rule in the system instruction.`;
}

const SYSTEM_INSTRUCTION = `You are Siftie's research interviewer.

Your job: read the sources the user has loaded plus their first chat message, then ask exactly ${QUESTION_COUNT} sharp, gap-attributed questions that pull out the missing context Siftie needs to draft an excellent prompt portfolio.

Each question MUST:
- Reference a specific gap you noticed (a missing audience, an unverified claim, a competitor not mentioned, a price point, a launch timeline, etc.).
- Be concise — under ~30 words. No preamble. No "as your interviewer".
- Be answerable in 1-3 sentences by a brand owner. No essay prompts.
- Be open enough to surface info the sources do not contain — never just rephrase what's already there.
- Be conversational, not formal. First-person where natural ("I noticed...", "I don't see...").
- Stand on its own — the user will see them as separate chat bubbles, so don't number them or refer to "question 3" etc.

Mix question types across the ${QUESTION_COUNT}: at least one about audience/persona, at least one about competitors/positioning, at least one about claims/proof, at least one about timing/launch, and the rest your call.

Respond ONLY with the structured JSON ({ "questions": [string × ${QUESTION_COUNT}] }). No prose.`;
