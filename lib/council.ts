/**
 * The LLM Council: 3-stage critique pipeline that turns the raw
 * Ideate output into a vetted, Chair-ranked portfolio.
 *
 * Why three stages and not one big "rank these prompts" call:
 *   1. **Independent review** removes "first opinion wins" bias —
 *      each reviewer scores the same input cold.
 *   2. **Cross review** lets each reviewer see the others' anonymised
 *      verdicts and revise. Catches the "everyone keeps prompt 7
 *      because the first reviewer raved about it" failure mode.
 *   3. **Chairman synthesis** condenses the whole conversation into
 *      a final 12-prompt portfolio with per-prompt rationales the user
 *      can actually read.
 *
 * Anonymisation: we never tell the reviewers which model they are
 * (Anthropic / Google / etc.) and we never tell them who else is on
 * the council. Each just sees "Reviewer A/B/C" labels. This avoids
 * a model deferring to "the OpenAI reviewer" or refusing to disagree
 * with "the Google one". The seat number that ends up on the chat
 * bubble (`council_seat: 1..3`) is purely UI scaffolding, not a hint
 * fed back into the prompt.
 *
 * Streaming: this module emits messages to the chat in real time via
 * the injected `emitMessage` callback. The orchestrator wires that
 * to `createMessage()` so each Realtime subscriber sees a new bubble
 * appear as soon as a reviewer finishes.
 *
 * Failure mode: a single reviewer failure (timeout, JSON garbage,
 * 5xx) does NOT fail the run. We log the failure as a chat bubble
 * ("Reviewer C timed out — proceeding with 2 verdicts") and fold the
 * remaining reviewers' picks into the Chair stage. Council with 2 of 3
 * reviewers is still vastly better than no council at all. Only the
 * Chair stage is non-recoverable.
 */
import 'server-only';
import {
  CouncilChairJsonSchema,
  CouncilChairResponse,
  CouncilDepth,
  CouncilReviewerJsonSchema,
  CouncilReviewerResponse,
  type CouncilChairPick,
  type CouncilReviewerResponse as CouncilReviewerResponseT,
  type IdeatePrompt,
} from './research/schema';
import { COUNCIL_MODELS, generateJson, type CouncilModelId } from './openrouter';

/**
 * `quick` runs the Council with just 2 reviewers (skip the 3rd seat).
 * `standard` runs all 3. Both depths run all 3 stages — depth controls
 * breadth of opinion, not depth of deliberation.
 *
 * Note: this used to be 3-vs-4 when the lineup had four reasoning-
 * model seats. We dropped to a 3-model fast demo lineup (see
 * `COUNCIL_MODELS` in `lib/openrouter.ts`) so the depth ratio
 * shifted with it. Keep these in sync if the lineup changes again.
 */
export const REVIEWER_COUNT_BY_DEPTH: Record<CouncilDepth, number> = {
  quick: 2,
  standard: 3,
};

export interface CouncilContext {
  /** OpenRouter API key, validated upstream by the orchestrator. */
  apiKey: string;
  /** Research title — passed into prompts so reviewers know the brand context. */
  researchTitle: string;
  /**
   * Source brief blob the reviewers read. We pass the same Markdown the
   * Ideate stage built (title + summary + topics + facts per source) so
   * reviewers and ideator see identical context.
   */
  sourcesBlob: string;
  /** User interview transcript blob, same format as Ideate's. */
  transcriptBlob: string;
  /** Posthog instrumentation passed to every council call. */
  posthog: {
    distinctId: string;
    /** Run-level trace id — every reviewer + chair call shares this. */
    traceId: string;
    privacyMode: boolean;
  };
  /**
   * Optional cancellation poll. The orchestrator wires this to a
   * single-row select against `runs` so the Council short-circuits
   * if the user has hit Stop. Called between stages, not in the hot
   * path of a single reviewer call. Throws `RunCancelledError` (or
   * any error — we just bubble it) when cancelled.
   */
  checkCancelled?: () => Promise<void>;
}

/**
 * Per-stage chat-message emitter. The orchestrator passes a function
 * that turns the (role, seat, body) into a `messages` row insert plus
 * a Realtime fan-out. Decoupling here keeps `lib/council.ts` testable
 * without spinning up Supabase.
 */
export type CouncilEmit = (msg: {
  body: string;
  councilRole: 'reviewer' | 'chair';
  councilSeat: number | null;
}) => Promise<void>;

export interface CouncilResult {
  /**
   * The Chair's final picks, in the order it surfaced them. The
   * orchestrator turns these into FinalPrompts by joining with the
   * IdeatePrompt array (using `index`) + Peec hit counts.
   */
  picks: CouncilChairPick[];
  /** How many reviewers actually returned valid output (1..3). */
  reviewersUsed: number;
}

/**
 * Run the full 3-stage Council on a list of Ideate prompts. Returns
 * the Chair's picks + how many reviewers participated.
 *
 * Caller is responsible for:
 *   - Persisting messages emitted via `emit()` (we just call it)
 *   - Mapping `picks[i].index` back to the original IdeatePrompt
 *   - Joining hit counts (Peec) onto the final prompts
 */
export async function runCouncil(
  prompts: IdeatePrompt[],
  depth: CouncilDepth,
  ctx: CouncilContext,
  emit: CouncilEmit,
): Promise<CouncilResult> {
  if (prompts.length === 0) {
    throw new Error('Council requires at least one Ideate prompt');
  }

  const reviewerCount = REVIEWER_COUNT_BY_DEPTH[depth];
  // Anonymous seats are 1..N. Each seat is bound to a model id from
  // COUNCIL_MODELS in array order, but the reviewer never sees its own
  // model id (it only sees the seat number).
  const seats: Array<{ seat: number; model: CouncilModelId }> = [];
  for (let i = 0; i < reviewerCount; i++) {
    seats.push({ seat: i + 1, model: COUNCIL_MODELS[i]! });
  }

  // -----------------------------------------------------------------
  // Stage 1 — independent review
  // -----------------------------------------------------------------
  const numberedPrompts = prompts
    .map(
      (p, i) =>
        `[${i}] (${p.cluster} / ${p.intent}) ${p.text}`,
    )
    .join('\n');
  const stage1User = buildReviewerUserPrompt({
    stage: 1,
    researchTitle: ctx.researchTitle,
    sourcesBlob: ctx.sourcesBlob,
    transcriptBlob: ctx.transcriptBlob,
    promptsBlock: numberedPrompts,
    priorVerdictsBlock: '',
  });

  if (ctx.checkCancelled) await ctx.checkCancelled();

  const stage1Reviews = await runReviewersInParallel({
    seats,
    stage: 1,
    user: stage1User,
    ctx,
    emit,
  });

  // -----------------------------------------------------------------
  // Stage 2 — cross review
  //
  // Every reviewer sees an anonymised digest of every *other* seat's
  // verdicts, then re-issues their own. We deliberately don't show
  // each seat its own previous output — we want a fresh pass that
  // could disagree with itself, not a "yeah I still think the same"
  // rubber-stamp.
  // -----------------------------------------------------------------
  const validStage1 = stage1Reviews.filter(
    (r): r is { seat: number; model: CouncilModelId; review: CouncilReviewerResponseT } =>
      r.review !== null,
  );

  if (ctx.checkCancelled) await ctx.checkCancelled();

  const stage2Reviews = await runStage2(seats, validStage1, prompts.length, numberedPrompts, ctx, emit);

  // -----------------------------------------------------------------
  // Stage 3 — Chair synthesis
  // -----------------------------------------------------------------
  const validStage2 = stage2Reviews.filter(
    (r): r is { seat: number; model: CouncilModelId; review: CouncilReviewerResponseT } =>
      r.review !== null,
  );

  const reviewersUsed = validStage2.length || validStage1.length;
  if (reviewersUsed === 0) {
    throw new Error('All Council reviewers failed; cannot synthesize a portfolio');
  }

  // Concatenate every still-valid reviewer's stage-2 verdict (or fall
  // back to stage-1 if nobody made it through stage 2). This is the
  // raw material the Chair condenses into a final ranking.
  const finalReviews = validStage2.length > 0 ? validStage2 : validStage1;
  const reviewerDigest = renderAnonymisedDigest(finalReviews);

  const chairUser = buildChairUserPrompt({
    researchTitle: ctx.researchTitle,
    sourcesBlob: ctx.sourcesBlob,
    transcriptBlob: ctx.transcriptBlob,
    promptsBlock: numberedPrompts,
    reviewerDigest,
  });

  if (ctx.checkCancelled) await ctx.checkCancelled();

  // Pick the Chair model: prefer the strongest reasoning model
  // available. We use the first model in COUNCIL_MODELS (gpt-5.4-mini
  // in the demo lineup) by convention — same family as the Ideate
  // primary, so the Chair runs the exact reasoning lineage that
  // produced the candidate prompts. This is OK to leak in the system
  // prompt — there is no peer above the Chair to defer to.
  const chairModel = COUNCIL_MODELS[0];

  let chairResponse: CouncilChairResponse;
  try {
    const raw = await generateJson(
      ctx.apiKey,
      {
        model: chairModel,
        system: CHAIR_SYSTEM,
        user: chairUser,
        schema: CouncilChairJsonSchema as unknown as Record<string, unknown>,
        schemaName: 'council_chair_response',
        temperature: 0.5,
        maxTokens: 4000,
      },
      {
        posthogDistinctId: ctx.posthog.distinctId,
        posthogTraceId: ctx.posthog.traceId,
        posthogPrivacyMode: ctx.posthog.privacyMode,
        posthogProperties: { tag: 'council_chair', stage: 3, model_id: chairModel },
      },
    );
    chairResponse = CouncilChairResponse.parse(JSON.parse(raw));
  } catch (err) {
    // The Chair is the only stage we can't gracefully degrade past.
    // Surface the error as a chat bubble + bubble it up so the
    // orchestrator marks the run failed.
    await emit({
      body: 'Chair failed to synthesize the portfolio. The run has been stopped — please try again.',
      councilRole: 'chair',
      councilSeat: null,
    });
    throw err;
  }

  // Validate every pick references an existing Ideate prompt. The model
  // sometimes hallucinates indexes when prompted with a long list, so
  // we drop any that don't resolve. Better to ship fewer good prompts
  // than a "see all" drawer with a "Prompt #99" link to nothing.
  const picks = chairResponse.picks.filter((p) => p.index >= 0 && p.index < prompts.length);

  await emit({
    body: chairResponse.summary,
    councilRole: 'chair',
    councilSeat: null,
  });

  return { picks, reviewersUsed };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ReviewerOutcome {
  seat: number;
  model: CouncilModelId;
  review: CouncilReviewerResponseT | null;
}

/**
 * Fire all reviewers in parallel for a single stage. Each reviewer's
 * outcome is independent — one timing out or returning garbage doesn't
 * wait on or fail the others.
 *
 * We emit a chat bubble for every reviewer (success or failure) so the
 * user sees deterministic narration even when a model misbehaves.
 */
async function runReviewersInParallel(args: {
  seats: Array<{ seat: number; model: CouncilModelId }>;
  stage: 1 | 2;
  user: string;
  ctx: CouncilContext;
  emit: CouncilEmit;
}): Promise<ReviewerOutcome[]> {
  const { seats, stage, user, ctx, emit } = args;

  const tasks = seats.map(async ({ seat, model }) => {
    try {
      const raw = await generateJson(
        ctx.apiKey,
        {
          model,
          system: REVIEWER_SYSTEM,
          user,
          schema: CouncilReviewerJsonSchema as unknown as Record<string, unknown>,
          schemaName: `council_reviewer_response_stage_${stage}`,
          temperature: stage === 1 ? 0.4 : 0.5,
          maxTokens: 2500,
        },
        {
          posthogDistinctId: ctx.posthog.distinctId,
          posthogTraceId: ctx.posthog.traceId,
          posthogPrivacyMode: ctx.posthog.privacyMode,
          posthogProperties: {
            tag: 'council_review',
            stage,
            seat,
            model_id: model,
          },
        },
      );
      const review = CouncilReviewerResponse.parse(JSON.parse(raw));
      await emit({
        body: review.summary,
        councilRole: 'reviewer',
        councilSeat: seat,
      });
      return { seat, model, review } satisfies ReviewerOutcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await emit({
        body: `Reviewer ${seatLabel(seat)} couldn't return a verdict (${shorten(reason)}). Continuing without it.`,
        councilRole: 'reviewer',
        councilSeat: seat,
      });
      return { seat, model, review: null } satisfies ReviewerOutcome;
    }
  });

  return Promise.all(tasks);
}

/**
 * Stage 2 needs each seat's user-prompt to *exclude* its own stage-1
 * digest entry, so we build the digest once per recipient. The seat
 * map is small (≤4) so the O(n²) shape is fine.
 */
async function runStage2(
  seats: Array<{ seat: number; model: CouncilModelId }>,
  stage1: Array<{ seat: number; model: CouncilModelId; review: CouncilReviewerResponseT }>,
  promptCount: number,
  numberedPrompts: string,
  ctx: CouncilContext,
  emit: CouncilEmit,
): Promise<ReviewerOutcome[]> {
  // If only one reviewer made it through stage 1 there's nothing to
  // cross-review — skip stage 2 and let the Chair work from stage 1.
  if (stage1.length <= 1) return [];

  const tasks = seats
    // Skip seats that failed stage 1 — we don't want them to come back
    // online with nothing to cross-review against.
    .filter((s) => stage1.some((r) => r.seat === s.seat))
    .map(async ({ seat, model }) => {
      const others = stage1.filter((r) => r.seat !== seat);
      const digest = renderAnonymisedDigest(others);
      const user = buildReviewerUserPrompt({
        stage: 2,
        researchTitle: ctx.researchTitle,
        sourcesBlob: ctx.sourcesBlob,
        transcriptBlob: ctx.transcriptBlob,
        promptsBlock: numberedPrompts,
        priorVerdictsBlock: digest,
      });

      try {
        const raw = await generateJson(
          ctx.apiKey,
          {
            model,
            system: REVIEWER_SYSTEM,
            user,
            schema: CouncilReviewerJsonSchema as unknown as Record<string, unknown>,
            schemaName: 'council_reviewer_response_stage_2',
            temperature: 0.5,
            maxTokens: 2500,
          },
          {
            posthogDistinctId: ctx.posthog.distinctId,
            posthogTraceId: ctx.posthog.traceId,
            posthogPrivacyMode: ctx.posthog.privacyMode,
            posthogProperties: {
              tag: 'council_review',
              stage: 2,
              seat,
              model_id: model,
            },
          },
        );
        const review = CouncilReviewerResponse.parse(JSON.parse(raw));
        // Drop verdicts that point at indexes outside the prompt list —
        // protects the Chair from hallucinated indexes.
        review.verdicts = review.verdicts.filter(
          (v) => v.index >= 0 && v.index < promptCount,
        );
        await emit({
          body: review.summary,
          councilRole: 'reviewer',
          councilSeat: seat,
        });
        return { seat, model, review } satisfies ReviewerOutcome;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await emit({
          body: `Reviewer ${seatLabel(seat)} couldn't return a stage-2 verdict (${shorten(reason)}). Using their first opinion.`,
          councilRole: 'reviewer',
          councilSeat: seat,
        });
        // Fall back to stage-1 review so the Chair still sees a digest entry.
        const fallback = stage1.find((r) => r.seat === seat);
        return {
          seat,
          model,
          review: fallback?.review ?? null,
        } satisfies ReviewerOutcome;
      }
    });

  return Promise.all(tasks);
}

function renderAnonymisedDigest(
  reviews: Array<{ seat: number; review: CouncilReviewerResponseT }>,
): string {
  return reviews
    .map(({ seat, review }) => {
      const verdicts = review.verdicts
        .map((v) => `[${v.index}]=${v.action}`)
        .join(', ');
      return `Reviewer ${seatLabel(seat)}:\n  Summary: ${review.summary}\n  Verdicts: ${verdicts || '(none)'}`;
    })
    .join('\n\n');
}

function seatLabel(seat: number): string {
  // 1 → A, 2 → B, … keeps the chat bubbles human-friendly. Anything
  // beyond Z falls back to the raw number — we'll never have 27 seats.
  if (seat >= 1 && seat <= 26) {
    return String.fromCharCode(64 + seat);
  }
  return String(seat);
}

function shorten(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

interface BuildReviewerUserPromptArgs {
  stage: 1 | 2;
  researchTitle: string;
  sourcesBlob: string;
  transcriptBlob: string;
  promptsBlock: string;
  priorVerdictsBlock: string;
}

function buildReviewerUserPrompt(args: BuildReviewerUserPromptArgs): string {
  const stageBlurb =
    args.stage === 1
      ? 'This is the FIRST review pass — judge each prompt cold, on its own merits.'
      : 'This is the CROSS review pass — you have just seen the other reviewers\' first opinions below. Decide whether their critiques change your mind. You are free to disagree.';

  const priorBlock = args.priorVerdictsBlock
    ? `\n\nOther reviewers' first opinions (anonymised):\n\n${args.priorVerdictsBlock}`
    : '';

  return `Research title: ${args.researchTitle}

Sources:

${args.sourcesBlob}

Conversation so far:

${args.transcriptBlob}

Candidate prompts (each prefixed with [index]):

${args.promptsBlock}

${stageBlurb}${priorBlock}

Return your verdicts following every rule in the system instruction.`;
}

interface BuildChairUserPromptArgs {
  researchTitle: string;
  sourcesBlob: string;
  transcriptBlob: string;
  promptsBlock: string;
  reviewerDigest: string;
}

function buildChairUserPrompt(args: BuildChairUserPromptArgs): string {
  return `Research title: ${args.researchTitle}

Sources:

${args.sourcesBlob}

Conversation so far:

${args.transcriptBlob}

Candidate prompts (each prefixed with [index]):

${args.promptsBlock}

Reviewer verdicts (anonymised):

${args.reviewerDigest}

Synthesise a final portfolio of 8–12 prompts following every rule in the system instruction.`;
}

const REVIEWER_SYSTEM = `You are an anonymised reviewer on Siftie's prompt-portfolio Council.

Your job: read the brand's sources, the user interview, and a list of candidate prompts. Decide which prompts to keep, refine, or drop, and explain why in 1-3 sentences.

Hard rules:
- Be opinionated. "Looks fine" is not useful — say what would make a strong prompt stronger.
- A prompt should be DROPPED if it: repeats another, leaks the brand name, asks about realtime data, or is too vague to filter results.
- A prompt should be REFINED if the underlying angle is good but the wording is off. (You don't rewrite — that's the Chair's job. Just flag it.)
- A prompt should be KEPT if it's a thing a real human would type and it tests an angle the rest of the portfolio doesn't.
- Verdicts must reference the prompt's [index] from the user message. Use only indexes that exist; do not invent new prompts.
- Your "summary" goes into a chat bubble visible to the user. Be punchy. No "as your reviewer" filler.

Respond ONLY with the structured JSON ({ "summary": string, "verdicts": [{ index, action }] }). No prose.`;

const CHAIR_SYSTEM = `You are the Chair of Siftie's prompt-portfolio Council.

Your job: read the brand's sources, the user interview, the candidate prompts, and the (anonymised) reviewer verdicts. Then pick the final portfolio of 8–12 prompts the user will see in the Prompts column.

Hard rules:
- Pick by [index] — every "index" you return must reference an existing candidate. Do NOT invent prompts.
- You MAY rewrite a chosen prompt by setting its "text" field. If "text" is omitted, the original is used. Rewrite only when the rewrite is meaningfully better — don't reword for the sake of reword.
- Every pick MUST include a "councilNote" (1-2 sentences) explaining why it made the cut. This appears in a "Show all N" drawer the user can inspect.
- Aim for 8–12 picks total. Spread roughly evenly across Category / Persona / Comparison clusters; bias toward High-intent prompts but include enough Med + Low for funnel breadth.
- Your "summary" is a 1-3 sentence narrative the user will see in the Chair chat bubble. Mention what you cut, what you kept, and what stood out.

Respond ONLY with the structured JSON ({ "summary": string, "picks": [{ index, text?, councilNote }] }). No prose.`;
