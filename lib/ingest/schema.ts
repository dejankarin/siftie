/**
 * The "ContextDoc" — the structured representation of a single source after
 * Gemini Flash has read it. Every ingest path (pdf / url / doc / md) ends in
 * the same shape so the rest of the app can stay storage-agnostic.
 *
 * This schema is also the *contract* we hand to Gemini via
 * `responseJsonSchema`, so the model returns JSON that already validates —
 * no fragile prompt-engineering to "please respond in JSON format". The
 * schema constrains:
 *   - field names + types
 *   - array sizes (so the model doesn't dump 200 facts and blow our payload)
 *   - the closed set of `entity.kind` values
 *
 * Any field added here MUST also be safe to nest in JSONB on the
 * `sources.context_doc` column. Avoid binary data — use base64 or URLs.
 */
import { z } from 'zod';

export const EntityKind = z.enum(['brand', 'product', 'person', 'place', 'concept']);
export type EntityKind = z.infer<typeof EntityKind>;

export const Entity = z.object({
  kind: EntityKind,
  name: z.string().min(1).max(200),
});
export type Entity = z.infer<typeof Entity>;

export const ContextDoc = z.object({
  /**
   * Canonical, human-readable title for the source. We show this in the UI
   * so it should be sensible even when the original file/URL had a useless
   * filename like "Document_2.pdf".
   */
  title: z.string().min(1).max(300),

  /**
   * 2–3 sentence neutral summary the agent can quote when introducing this
   * source in chat. Plain text, no markdown.
   */
  summary: z.string().min(1).max(1500),

  /**
   * Estimated word count of the underlying source. Used for the "X words
   * indexed" stats strip and to weight prompts later.
   */
  words: z.number().int().min(0).max(10_000_000),

  /**
   * 5–15 short topic tags. Drives later prompt-clustering ("Category" /
   * "Persona" / "Comparison") and lets us show topic chips on each source
   * card without re-running Gemini.
   */
  topics: z.array(z.string().min(1).max(80)).min(0).max(20),

  /**
   * Named entities the agent can reference. Optional and capped — Gemini
   * tends to over-extract on long PDFs, so we cap at 30 to keep the JSONB
   * payload bounded.
   */
  entities: z.array(Entity).min(0).max(30).default([]),

  /**
   * 5–15 atomic, quotable facts. Each fact is a single self-contained
   * sentence. Used by the chat agent in Session 4 as retrievable context
   * snippets ("Per the brief: …").
   */
  facts: z.array(z.string().min(1).max(500)).min(0).max(20),

  /**
   * First ~500 chars of the underlying source verbatim. Lets the UI show
   * a real preview without re-fetching the original file.
   */
  rawExcerpt: z.string().min(0).max(2000),
});
export type ContextDoc = z.infer<typeof ContextDoc>;

/**
 * Convert the Zod schema into the JSON Schema shape that
 * `@google/genai` expects in `responseJsonSchema`. We hand-write this
 * (rather than autogenerating from Zod) because Gemini's schema dialect
 * is more restrictive than full JSON Schema — no `$ref`, no `anyOf`, no
 * extra fields. Keep this in lockstep with the Zod schema above.
 */
export const ContextDocJsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    words: { type: 'integer' },
    topics: {
      type: 'array',
      items: { type: 'string' },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['brand', 'product', 'person', 'place', 'concept'],
          },
          name: { type: 'string' },
        },
        required: ['kind', 'name'],
      },
    },
    facts: {
      type: 'array',
      items: { type: 'string' },
    },
    rawExcerpt: { type: 'string' },
  },
  required: ['title', 'summary', 'words', 'topics', 'entities', 'facts', 'rawExcerpt'],
} as const;
