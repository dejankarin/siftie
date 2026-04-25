/**
 * Schemas for the research orchestrator.
 *
 * Three concerns live in this file:
 *
 *   1. **Prompt** — the unit of output the Council eventually emits and
 *      that the Prompts column reads. Mirrors the client-side
 *      `PortfolioPrompt` type but adds the optional `councilNote`
 *      (filled by the Chair) so the "Show all N" drawer can show
 *      reasoning per prompt. This is also the row shape persisted to
 *      `runs.prompts` JSONB.
 *
 *   2. **IdeatePrompt** — what Gemini Pro returns from the Ideate step.
 *      No `hits` / `councilNote` yet — those are filled later by
 *      Peec + Council. We keep this as a separate type to make the
 *      pipeline stages obvious in code (Ideate ⇒ Baseline ⇒ Council).
 *
 *   3. **CouncilDepth** — the closed set the user can pick in the
 *      composer dropdown and the column on `researches.council_depth` /
 *      `runs.council_depth`. Keeping it here means the API route, the
 *      orchestrator, and the schema all agree by import rather than by
 *      stringly-typed convention.
 */
import { z } from 'zod';

export const PromptCluster = z.enum(['Category', 'Persona', 'Comparison']);
export type PromptCluster = z.infer<typeof PromptCluster>;

export const PromptIntent = z.enum(['High', 'Med', 'Low']);
export type PromptIntent = z.infer<typeof PromptIntent>;

export const CouncilDepth = z.enum(['quick', 'standard']);
export type CouncilDepth = z.infer<typeof CouncilDepth>;

/**
 * Raw output of the Ideate step. Hits + councilNote come later.
 *
 * `id` is generated server-side at parse time (Gemini doesn't need to
 * mint UUIDs), but the JSON schema we hand to Gemini doesn't include
 * `id` — see `IdeatePromptJsonSchema` below.
 */
export const IdeatePrompt = z.object({
  cluster: PromptCluster,
  intent: PromptIntent,
  text: z.string().min(8).max(400),
});
export type IdeatePrompt = z.infer<typeof IdeatePrompt>;

/**
 * Final shape persisted to `runs.prompts`. The orchestrator builds these
 * by combining IdeatePrompt + Peec hit counts (or 0 if Peec was skipped)
 * + the Chair's councilNote.
 *
 * `totalChannels` is denormalized onto each prompt so the client doesn't
 * have to read the parent run row to render the HitsBar. It's a small
 * cost (1 int per prompt) for a meaningful query simplification.
 */
export const FinalPrompt = z.object({
  id: z.string().min(1),
  cluster: PromptCluster,
  intent: PromptIntent,
  text: z.string().min(1),
  hits: z.number().int().min(0),
  totalChannels: z.number().int().min(0),
  councilNote: z.string().max(800).optional(),
});
export type FinalPrompt = z.infer<typeof FinalPrompt>;

// ---------------------------------------------------------------------------
// JSON Schemas for Gemini structured output. Hand-written (rather than
// derived from Zod) because Gemini's schema dialect is restricted —
// no $ref, no union types, no enums-on-strings via anyOf.
// Keep these in lockstep with the Zod schemas above.
// ---------------------------------------------------------------------------

export const IdeatePromptJsonSchema = {
  type: 'object',
  properties: {
    cluster: {
      type: 'string',
      enum: ['Category', 'Persona', 'Comparison'],
    },
    intent: {
      type: 'string',
      enum: ['High', 'Med', 'Low'],
    },
    text: { type: 'string' },
  },
  required: ['cluster', 'intent', 'text'],
} as const;

export const IdeateResponseJsonSchema = {
  type: 'object',
  properties: {
    prompts: {
      type: 'array',
      items: IdeatePromptJsonSchema,
    },
  },
  required: ['prompts'],
} as const;

export const IdeateResponse = z.object({
  prompts: z.array(IdeatePrompt),
});
export type IdeateResponse = z.infer<typeof IdeateResponse>;

// ---------------------------------------------------------------------------
// Council schemas
// ---------------------------------------------------------------------------

/**
 * What each reviewer returns in Stage 1 + Stage 2.
 *
 * `verdicts` is an array of `{ index, action }` rows where `index` is
 * the position of the prompt in the Ideate list (0..N-1). We use index
 * (not id) because models are notoriously bad at echoing exact UUID
 * strings; an int is much more reliable in structured output.
 */
export const CouncilVerdict = z.object({
  index: z.number().int().min(0),
  action: z.enum(['keep', 'refine', 'drop']),
});
export type CouncilVerdict = z.infer<typeof CouncilVerdict>;

export const CouncilReviewerResponse = z.object({
  /** 1-3 sentence narrative summary; goes into the chat bubble body. */
  summary: z.string().min(1).max(800),
  verdicts: z.array(CouncilVerdict),
});
export type CouncilReviewerResponse = z.infer<typeof CouncilReviewerResponse>;

export const CouncilReviewerJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          action: { type: 'string', enum: ['keep', 'refine', 'drop'] },
        },
        required: ['index', 'action'],
      },
    },
  },
  required: ['summary', 'verdicts'],
} as const;

/**
 * What the Chair returns in Stage 3. The Chair re-orders, optionally
 * rewrites, and adds a per-prompt `councilNote` explaining the keep/
 * refine reasoning. Chair never invents new prompts — `index` always
 * refers back to one of the Ideate originals.
 */
export const CouncilChairPick = z.object({
  index: z.number().int().min(0),
  /** Optional rewritten text. If absent, use the original. */
  text: z.string().min(8).max(400).optional(),
  /** 1-2 sentence rationale. */
  councilNote: z.string().min(1).max(800),
});
export type CouncilChairPick = z.infer<typeof CouncilChairPick>;

export const CouncilChairResponse = z.object({
  /** 1-3 sentence Chair narrative; goes into the chat bubble body. */
  summary: z.string().min(1).max(1200),
  picks: z.array(CouncilChairPick),
});
export type CouncilChairResponse = z.infer<typeof CouncilChairResponse>;

export const CouncilChairJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          text: { type: 'string' },
          councilNote: { type: 'string' },
        },
        required: ['index', 'councilNote'],
      },
    },
  },
  required: ['summary', 'picks'],
} as const;
