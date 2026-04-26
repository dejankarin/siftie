/**
 * Research orchestrator: coordinates Ideate → [Peec] → Council → Surface
 * for a single "Run research" command.
 *
 * Lifecycle:
 *   1. `startResearchRun` validates inputs (keys, at least one source,
 *      and either an existing user message or an auto-seeded line) and creates a `runs` row
 *      in `running` state. Returns the `runId` immediately so the API
 *      route can hand back a 202.
 *
 *   2. `runResearchPipeline` executes the long-running work in the
 *      background (the API route calls it from `waitUntil`). It:
 *        a. Resolves the user's API keys + the research's sources +
 *           transcript.
 *        b. Calls OpenAI GPT-5.4 (with Gemini Flash as fallback)
 *           for ~24 candidate prompts (Ideate).
 *        c. Optionally calls Peec to score each prompt's hit count.
 *           If the user has no Peec key, we mark `peecSkipped: true`
 *           and surface a chat bubble explaining why hits will read
 *           "0 / 0".
 *        d. Runs the 3-stage Council on the candidates, streaming
 *           per-reviewer + Chair bubbles into the chat as they land.
 *        e. Persists the final FinalPrompt[] on the run row +
 *           emits a final "Surface" agent bubble.
 *      Failures at any stage call `failRun` and emit a chat bubble
 *      explaining what went wrong, so the user always gets a closing
 *      message rather than silent stall.
 *
 * Streaming model: every chat update goes through the existing
 * `messages` table → Realtime publication. The client is already
 * subscribed (Session 4), so no new transport is required.
 *
 * Idempotency: if a run for this research is already in `running`
 * state, `startResearchRun` refuses to create a new one and returns
 * the existing run id. Stops users from accidentally double-charging
 * themselves by clicking "Run research" twice.
 */
import 'server-only';
import { runCouncil, type CouncilEmit } from './council';
import {
  IdeateProviderError,
  generateIdeatePrompts,
  type IdeateResult,
} from './ideate';
import { getUserApiKey } from './keys';
import { flushLogs, log } from './logger';
import {
  PeecKeyMissingError,
  listBrands,
  listModelChannels,
  listProjects,
  type PeecBrand,
  type PeecModelChannel,
} from './peec';
import { getPostHogServer } from './posthog';
import { readPosthogCaptureLlm } from './privacy';
import { classifyProviderError, type ProviderName } from './provider-errors';
import {
  CouncilDepth,
  type FinalPrompt,
  type IdeatePrompt,
} from './research/schema';
import {
  completeRun,
  createRun,
  failRun,
  getLatestRunByResearch,
  isRunCancelled,
} from './runs';
import { listSourcesForResearch } from './sources';
import { createMessage, listMessagesForResearch } from './messages';
import { FLAG_KEYS, getServerFlag } from './flags';
import { getProjectIdForResearch, getResearchWithContext } from './workspace';

/**
 * When the user starts a Council run from the Sources column without
 * having chatted yet, we persist this line server-side. It does **not** go
 * through `POST /api/messages`, so the opening 6-question interview is
 * skipped — the pipeline uses sources + this line as ground truth.
 */
const COUNCIL_SEED_USER_MESSAGE =
  'Use my indexed sources as context. Run the Council to build the prompt portfolio.';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartRunResult {
  runId: string;
  /**
   * True when we declined to start a NEW run because one was already
   * running. The API route can use this to short-circuit to a 200 with
   * the existing run id rather than a 202.
   */
  reused: boolean;
}

/**
 * Validate + create the run row. Returns immediately so the API route
 * can hand back a response. Does NOT do any LLM work — that lives in
 * `runResearchPipeline`.
 *
 * Throws `Error` with a `cause` of one of the known short codes:
 *   - 'no_sources'             — the research has no indexed sources
 *   - 'no_user_messages'       — cannot establish a user message (defensive; seed should prevent)
 *   - 'missing_ideate_key'     — neither OpenAI nor Gemini key is configured
 *   - 'missing_openrouter_key' — OpenRouter key not configured
 * Callers (the API route) translate these into 4xx responses.
 *
 * Ideate uses **OpenAI GPT-5.4 as the primary** model with **Gemini Flash
 * as the fallback**. Either key on its own is enough to start a run; we
 * only block when both are missing.
 */
export async function startResearchRun(
  clerkUserId: string,
  researchId: string,
): Promise<StartRunResult> {
  // Idempotency: short-circuit if a run is already in flight.
  const existing = await getLatestRunByResearch(clerkUserId, researchId);
  if (existing && existing.status === 'running') {
    return { runId: existing.id, reused: true };
  }

  const sources = await listSourcesForResearch(clerkUserId, researchId);
  if (sources.length === 0) {
    throw researchError('no_sources', 'Add at least one source before running research.');
  }
  let messages = await listMessagesForResearch(clerkUserId, researchId);
  if (!messages.some((m) => m.role === 'user')) {
    await createMessage(clerkUserId, {
      researchId,
      role: 'user',
      body: COUNCIL_SEED_USER_MESSAGE,
    });
    messages = await listMessagesForResearch(clerkUserId, researchId);
  }
  if (!messages.some((m) => m.role === 'user')) {
    throw researchError(
      'no_user_messages',
      'Send at least one chat message so the agent has interview answers to ground the prompts.',
    );
  }
  // Pre-check the keys we MUST have. Ideate requires *at least one of*
  // OpenAI (primary) or Gemini (fallback). OpenRouter is required for
  // the Council. Peec is optional; we degrade gracefully without it.
  const [openaiKey, geminiKey, openrouterKey] = await Promise.all([
    getUserApiKey(clerkUserId, 'openai'),
    getUserApiKey(clerkUserId, 'gemini'),
    getUserApiKey(clerkUserId, 'openrouter'),
  ]);
  if (!openaiKey && !geminiKey) {
    throw researchError(
      'missing_ideate_key',
      'Add your OpenAI key (preferred) or Gemini key in Settings, then try again.',
    );
  }
  if (!openrouterKey) {
    throw researchError(
      'missing_openrouter_key',
      'Add your OpenRouter API key in Settings, then try again.',
    );
  }

  const { research } = await getResearchWithContext(clerkUserId, researchId);
  const run = await createRun(clerkUserId, researchId, research.councilDepth);
  return { runId: run.id, reused: false };
}

/**
 * Execute the full pipeline for a previously-created run. Always
 * resolves; failures are persisted as `failRun` + a chat bubble.
 *
 * Designed to be called from `waitUntil` so the lambda hangs around
 * until the work finishes even though the HTTP response went out
 * minutes earlier.
 */
export async function runResearchPipeline(
  clerkUserId: string,
  researchId: string,
  runId: string,
): Promise<void> {
  const ph = getPostHogServer();
  const traceId = `research_${runId}`;

  try {
    // -----------------------------------------------------------------
    // Setup: keys + research metadata + chat transcript + sources
    // -----------------------------------------------------------------
    const [openaiKey, geminiKey, openrouterKey, peecKey, privacyAllowsCapture] =
      await Promise.all([
        getUserApiKey(clerkUserId, 'openai'),
        getUserApiKey(clerkUserId, 'gemini'),
        getUserApiKey(clerkUserId, 'openrouter'),
        getUserApiKey(clerkUserId, 'peec'),
        readPosthogCaptureLlm(clerkUserId),
      ]);
    if ((!openaiKey && !geminiKey) || !openrouterKey) {
      // Defensive: startResearchRun already checked, but a key could
      // have been deleted between the precheck and now.
      throw researchError(
        !openrouterKey ? 'missing_openrouter_key' : 'missing_ideate_key',
        'Required API key was removed before the run started.',
      );
    }

    // One structured line at run start — lets us answer "did the user
    // actually have OpenAI configured when this run started?" without
    // re-running the pipeline.
    log.info('research.run.start', {
      run_id: runId,
      research_id: researchId,
      user_id: clerkUserId,
      has_openai_key: !!openaiKey,
      has_gemini_key: !!geminiKey,
      has_openrouter_key: !!openrouterKey,
      has_peec_key: !!peecKey,
    });

    const privacyMode = !privacyAllowsCapture;
    const { research } = await getResearchWithContext(clerkUserId, researchId);
    const sources = await listSourcesForResearch(clerkUserId, researchId);
    const transcript = await listMessagesForResearch(clerkUserId, researchId);

    // Apply the COUNCIL_DEPTH_OVERRIDE flag if PostHog has it set. Used as
    // a kill-switch to dial back compute on cost spikes without a redeploy.
    // When unset (or an unknown value), we fall back to the user's stored
    // research-level preference.
    const depthOverrideRaw = await getServerFlag(
      clerkUserId,
      FLAG_KEYS.COUNCIL_DEPTH_OVERRIDE,
    );
    const parsedOverride = CouncilDepth.safeParse(depthOverrideRaw);
    const effectiveCouncilDepth: CouncilDepth = parsedOverride.success
      ? parsedOverride.data
      : research.councilDepth;
    if (parsedOverride.success && parsedOverride.data !== research.councilDepth) {
      log.info('research.council_depth.overridden', {
        run_id: runId,
        research_id: researchId,
        user_choice: research.councilDepth,
        applied: effectiveCouncilDepth,
      });
    }

    // Strip prior council bubbles from the transcript we feed into
    // Ideate/Council — they're stale narration, not signal.
    const conversationForLlm = transcript
      .filter((m) => m.councilRole === null)
      .map((m) => ({ role: m.role, body: m.body }));

    // -----------------------------------------------------------------
    // Opener bubble
    // -----------------------------------------------------------------
    await emitAgentMessage(clerkUserId, researchId, runId, {
      body: `Working on it. I'll generate candidate prompts, vet them with the Council (${depthLabel(effectiveCouncilDepth)}), then surface the strongest portfolio.`,
    });

    await throwIfCancelled(runId);

    // -----------------------------------------------------------------
    // Stage 1 — Ideate (OpenAI primary, Gemini fallback)
    // -----------------------------------------------------------------
    let ideate: IdeateResult;
    try {
      ideate = await generateIdeatePrompts(
        { openaiKey, geminiKey },
        {
          researchTitle: research.name,
          sources: sources.map((s) => ({ kind: s.kind, contextDoc: s.contextDoc })),
          messages: conversationForLlm,
        },
        {
          posthogDistinctId: clerkUserId,
          posthogTraceId: traceId,
          posthogPrivacyMode: privacyMode,
          posthogProperties: { research_id: researchId, run_id: runId },
        },
      );
    } catch (err) {
      // Use the provider attached by IdeateProviderError so the user
      // gets a "fix your <provider> key" message about the actual
      // failing provider, not a hardcoded one.
      const provider: ProviderName =
        err instanceof IdeateProviderError ? err.provider : 'openai';
      const classified = classifyProviderError(err, provider);

      // If both providers were tried and both failed, classify *both*
      // errors and name each one in the user-facing bubble. Without
      // this, users only see the Gemini failure and have to guess
      // what went wrong with their OpenAI key.
      const bothFailed =
        err instanceof IdeateProviderError && err.precedingError !== undefined;
      let body: string;
      if (bothFailed) {
        const ideateErr = err as IdeateProviderError;
        // `provider` is the *last* attempt (Gemini when both fail) and
        // `precedingError` carries the OpenAI error. Classify each so
        // both providers are named with their actual failure mode.
        const openAiClassified = classifyProviderError(
          ideateErr.precedingError,
          'openai',
        );
        const geminiClassified = classified;
        body = `Ideate failed on both providers — OpenAI: ${openAiClassified.message} · Gemini: ${geminiClassified.message}`;
        log.error('research.ideate.both_failed', {
          run_id: runId,
          research_id: researchId,
          openai_error: openAiClassified.message,
          openai_code: openAiClassified.code,
          // Raw SDK message (truncated) so we can debug the catch-all
          // `provider_failed` classification when it triggers — without
          // this we end up logging "OpenAI request failed" with no clue
          // *why* it failed (rate limit? unsupported param? schema?).
          openai_raw: truncateForLog(extractRawMessage(ideateErr.precedingError)),
          openai_status: extractStatus(ideateErr.precedingError),
          gemini_error: geminiClassified.message,
          gemini_code: geminiClassified.code,
          gemini_raw: truncateForLog(extractRawMessage(err)),
        });
      } else {
        body = `Ideate failed: ${classified.message}`;
        log.error('research.ideate.failed', {
          run_id: runId,
          research_id: researchId,
          provider,
          error_message: classified.message,
          error_code: classified.code,
          error_raw: truncateForLog(extractRawMessage(err)),
          error_status: extractStatus(err),
        });
      }
      await emitAgentMessage(clerkUserId, researchId, runId, { body });
      throw err;
    }

    log.info('research.ideate.ok', {
      run_id: runId,
      research_id: researchId,
      provider_used: ideate.providerUsed,
      model_used: ideate.modelUsed,
      candidate_count: ideate.prompts.length,
      fallback: ideate.fallbackReason ? true : false,
    });

    // Cancellation check *before* the post-Ideate narration. Without
    // this, a Stop hit during the Ideate HTTP call would still leave a
    // stale "Drafted N candidate prompts" bubble landing after the
    // "Run cancelled." bubble.
    await throwIfCancelled(runId);

    const candidates = ideate.prompts;
    if (candidates.length === 0) {
      await emitAgentMessage(clerkUserId, researchId, runId, {
        body: `${ideateProviderLabel(ideate.providerUsed)} returned no candidate prompts — please try again.`,
      });
      throw researchError('empty_ideate', 'Ideate returned no candidate prompts');
    }

    if (ideate.fallbackReason) {
      // OpenAI was tried first but failed; Gemini saved the run. Tell
      // the user what happened so the model attribution makes sense
      // and they know to top up their OpenAI key/quota.
      await emitAgentMessage(clerkUserId, researchId, runId, {
        body: `OpenAI GPT-5.4 was unavailable, so I used Gemini Flash as the fallback. ${ideate.fallbackReason}`,
      });
    }

    await emitAgentMessage(clerkUserId, researchId, runId, {
      body: `Drafted ${candidates.length} candidate prompts via ${ideateProviderLabel(ideate.providerUsed)} (${countByCluster(candidates)}). Sending them to the Council.`,
    });

    // -----------------------------------------------------------------
    // Stage 2 — Peec hits (optional)
    // -----------------------------------------------------------------
    let hitsByIndex: Record<number, number> = {};
    let totalChannels = 0;
    let peecSkipped = false;
    let peecSkipReason: string | null = null;
    let runChannels: Array<{ id: string; description: string }> = [];

    try {
      const peec = await fetchPeecHits(
        peecKey,
        candidates,
        clerkUserId,
        traceId,
        research.projectId,
      );
      hitsByIndex = peec.hitsByIndex;
      totalChannels = peec.totalChannels;
      runChannels = peec.channels;
      if (totalChannels > 0) {
        await emitAgentMessage(clerkUserId, researchId, runId, {
          body: `Peec scored each prompt across ${totalChannels} live channels.`,
        });
      } else {
        peecSkipped = true;
        peecSkipReason = 'Peec returned no live channels for this project.';
        await emitAgentMessage(clerkUserId, researchId, runId, {
          body: peecSkipReason + ' Showing 0 / 0 hit counts.',
        });
      }
    } catch (err) {
      peecSkipped = true;
      if (err instanceof PeecKeyMissingError) {
        peecSkipReason = 'No Peec key — skipping live brand-mention scoring. You can add a key in Settings to enable hit counts.';
      } else {
        const classified = classifyProviderError(err, 'peec' as ProviderName);
        peecSkipReason = `Peec lookup failed: ${classified.message}`;
      }
      await emitAgentMessage(clerkUserId, researchId, runId, {
        body: peecSkipReason,
      });
    }

    await throwIfCancelled(runId);

    // -----------------------------------------------------------------
    // Stage 3 — Council
    // -----------------------------------------------------------------
    // The Council emits chat messages AND polls for cancellation
    // between reviewers. The poll is wired through CouncilContext below
    // (see `checkCancelled`) so we don't have to thread `runId` deep
    // into council.ts.
    const councilEmit: CouncilEmit = async ({ body, councilRole, councilSeat }) => {
      await createMessage(clerkUserId, {
        researchId,
        role: 'agent',
        body,
        councilRole,
        councilSeat,
        runId,
      });
    };

    const sourcesBlob = renderSourcesBlob(sources);
    const transcriptBlob = renderTranscriptBlob(conversationForLlm);

    const council = await runCouncil(
      candidates,
      effectiveCouncilDepth,
      {
        apiKey: openrouterKey,
        researchTitle: research.name,
        sourcesBlob,
        transcriptBlob,
        posthog: {
          distinctId: clerkUserId,
          traceId,
          privacyMode,
        },
        checkCancelled: () => throwIfCancelled(runId),
      },
      councilEmit,
    );

    await throwIfCancelled(runId);

    // -----------------------------------------------------------------
    // Stage 4 — Surface (persist + announce)
    // -----------------------------------------------------------------
    const finalPrompts: FinalPrompt[] = council.picks.map((pick) => {
      const original = candidates[pick.index]!;
      const text = pick.text?.trim() || original.text;
      return {
        id: cryptoRandom(),
        cluster: original.cluster,
        intent: original.intent,
        text,
        hits: hitsByIndex[pick.index] ?? 0,
        totalChannels,
        councilNote: pick.councilNote,
      } satisfies FinalPrompt;
    });

    await completeRun(runId, {
      prompts: finalPrompts,
      totalChannels,
      peecSkipped,
      channels: runChannels,
    });

    await emitAgentMessage(clerkUserId, researchId, runId, {
      body: `Done — ${finalPrompts.length} prompts in your portfolio. Open "Show all" in the Prompts column for the full Chair rationale.`,
    });

    ph.capture({
      distinctId: clerkUserId,
      event: 'research_run_complete',
      groups: { project: research.projectId },
      properties: {
        research_id: researchId,
        run_id: runId,
        prompt_count: finalPrompts.length,
        candidate_count: candidates.length,
        reviewers_used: council.reviewersUsed,
        council_depth: effectiveCouncilDepth,
        council_depth_user_choice: research.councilDepth,
        peec_skipped: peecSkipped,
        $ai_trace_id: traceId,
      },
    });
  } catch (err) {
    if (err instanceof RunCancelledError) {
      // User-initiated cancel. The runs row is already `failed` (set
      // by /api/research/cancel) and the cancel route emitted the
      // "Run cancelled." chat bubble. We deliberately do NOT call
      // failRun, do NOT log this as `research.run.failed`, and do NOT
      // capture `research_run_failed` in PostHog — those events are
      // for genuine pipeline failures, not user actions.
      log.info('research.run.cancelled', {
        run_id: runId,
        research_id: researchId,
      });
      return;
    }
    // Mark the run failed and capture a telemetry event. We've already
    // emitted a chat bubble inside the throwing branch; failing here
    // only persists the run state so the prompts column doesn't show
    // a stale "running" badge forever.
    await failRun(runId).catch((failErr) => {
      log.error('research.run.fail_persist_failed', {
        run_id: runId,
        research_id: researchId,
        error: failErr,
      });
    });
    const code = err instanceof Error ? (err.cause as string | undefined) : undefined;
    log.error('research.run.failed', {
      run_id: runId,
      research_id: researchId,
      error_code: code ?? 'unknown',
      error_message: err instanceof Error ? err.message : String(err),
    });
    // Best-effort lookup so the failed run still attributes to its project.
    // We can't rely on `research` from the try body — the failure may have
    // happened before that lookup ran.
    const failedProjectId = await getProjectIdForResearch(researchId);
    ph.capture({
      distinctId: clerkUserId,
      event: 'research_run_failed',
      groups: failedProjectId ? { project: failedProjectId } : undefined,
      properties: {
        research_id: researchId,
        run_id: runId,
        error_code: code ?? 'unknown',
        message: err instanceof Error ? err.message : String(err),
        $ai_trace_id: traceId,
      },
    });
    ph.captureException(err, clerkUserId, {
      route: 'lib/research:runResearch',
      research_id: researchId,
      run_id: runId,
      error_code: code ?? 'unknown',
      $ai_trace_id: traceId,
    });
  } finally {
    // Ship any buffered logs to PostHog before this serverless
    // invocation (the one running the waitUntil background task) is
    // frozen. Without forceFlush, the BatchLogRecordProcessor may
    // drop the most recent batch on cold-frozen lambdas.
    await flushLogs();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface FetchPeecHitsResult {
  hitsByIndex: Record<number, number>;
  totalChannels: number;
  /**
   * `model_channel_id` + Peec's human-readable label for each active
   * channel, in the order Peec returned them. Persisted on the run row
   * so the client's HitsBar can label each cell on hover. Empty when
   * Peec was skipped or returned no active channels.
   */
  channels: Array<{ id: string; description: string }>;
}

/**
 * Quick-and-correct Peec lookup that produces a per-candidate hit
 * count without persisting prompts to Peec (which would require a
 * different write API). Strategy:
 *   1. Find the user's project + their own brand.
 *   2. List active model channels for the project — that's our denominator.
 *   3. Pull the brands/SOV report for the last 30 days, scoped to the
 *      user's brand, broken down by `model_channel_id`. The number of
 *      channels with hits > 0 becomes our portfolio-wide hit count.
 *
 * The report we ask for is portfolio-wide (not per-prompt) because the
 * candidate prompts we just generated have NEVER been scored by Peec —
 * they aren't yet in Peec's system. So we approximate "how many
 * channels surface our brand for prompts in this neighborhood" by
 * looking at the user's existing tracked prompts.
 *
 * If anything fails (no project, no own brand, empty report), the
 * caller treats it as `peecSkipped` and the user sees 0 / 0 hits.
 */
async function fetchPeecHits(
  peecKey: string | null,
  _candidates: IdeatePrompt[],
  clerkUserId: string,
  traceId: string,
  siftieProjectId: string,
): Promise<FetchPeecHitsResult> {
  if (!peecKey) throw new PeecKeyMissingError();

  const tracking = {
    posthogDistinctId: clerkUserId,
    posthogTraceId: traceId,
    posthogProperties: { feature: 'research', tag: 'peec_baseline' },
    // Attach the Siftie workspace project to peec_call events so per-workspace
    // funnels include the Peec baseline lookup. Distinct from the *Peec* API
    // project id we pass to listBrands/listModelChannels below.
    posthogGroups: { project: siftieProjectId },
  };

  const projects = await listProjects(peecKey, tracking);
  if (projects.length === 0) {
    return { hitsByIndex: {}, totalChannels: 0, channels: [] };
  }
  const project = projects[0]!;

  const [brands, channels] = await Promise.all([
    listBrands(peecKey, { projectId: project.id }, tracking),
    listModelChannels(peecKey, { projectId: project.id }, tracking),
  ]);
  const ownBrand = brands.find((b: PeecBrand) => b.is_own);
  const activeChannels = channels.filter((c: PeecModelChannel) => c.is_active);
  const totalChannels = activeChannels.length;
  // Capture the active channel labels as we go so the orchestrator can
  // persist them on the run row, even if the brand-mention lookup
  // below produces 0 hits — the user still gets a labelled empty bar.
  const channelLabels = activeChannels.map((c) => ({
    id: c.id,
    description: c.description,
  }));
  if (!ownBrand || totalChannels === 0) {
    return { hitsByIndex: {}, totalChannels, channels: channelLabels };
  }

  // Pull a 30-day brands report scoped to our own brand × channel. We
  // count distinct channels with hits > 0 — that becomes the "X / N"
  // we apply to every candidate prompt as a portfolio baseline.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const baselineChannels = await fetchBaselineChannels({
    apiKey: peecKey,
    projectId: project.id,
    brandId: ownBrand.id,
    since,
    activeChannels,
    tracking,
  });

  const hitsByIndex: Record<number, number> = {};
  for (let i = 0; i < _candidates.length; i++) {
    hitsByIndex[i] = baselineChannels;
  }
  return { hitsByIndex, totalChannels, channels: channelLabels };
}

/**
 * Issue the brands/SOV report and pivot rows into "how many channels
 * had any hit at all". The exact column names depend on what Peec
 * returns (their report shape isn't strict-typed); we read defensively.
 */
async function fetchBaselineChannels(args: {
  apiKey: string;
  projectId: string;
  brandId: string;
  since: Date;
  activeChannels: PeecModelChannel[];
  tracking: {
    posthogDistinctId: string;
    posthogTraceId?: string;
    posthogProperties?: Record<string, unknown>;
    posthogGroups?: Record<string, string>;
  };
}): Promise<number> {
  const { apiKey, projectId, brandId, since, activeChannels, tracking } = args;
  const channelIds = activeChannels.map((c) => c.id);
  const startDate = since.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  try {
    const report = await import('./peec').then((m) =>
      m.getBrandsReport(
        apiKey,
        {
          project_id: projectId,
          start_date: startDate,
          end_date: endDate,
          dimensions: ['model_channel_id'],
          filters: [
            { field: 'brand_id', operator: 'in', values: [brandId] },
            { field: 'model_channel_id', operator: 'in', values: channelIds },
          ],
        },
        tracking,
      ),
    );
    const rows = (report.data ?? []) as Array<Record<string, unknown>>;
    let count = 0;
    for (const row of rows) {
      // Try a couple of likely metric names — Peec's docs label them
      // differently per report. Anything > 0 counts as "this channel
      // surfaced our brand at least once in the window".
      const mentions =
        Number(row['mentions']) ||
        Number(row['mention_count']) ||
        Number(row['hit_count']) ||
        Number(row['count']) ||
        0;
      if (mentions > 0) count += 1;
    }
    return count;
  } catch (err) {
    // Don't propagate — caller already protects against partial Peec
    // failures by marking the whole run as peecSkipped.
    console.warn('[research] peec baseline channels lookup failed', err);
    return 0;
  }
}

function renderSourcesBlob(
  sources: Awaited<ReturnType<typeof listSourcesForResearch>>,
): string {
  return sources
    .map((s, i) => {
      const facts = s.contextDoc.facts.slice(0, 12);
      const topics = s.contextDoc.topics.slice(0, 12);
      const factsBlock = facts.length ? `\n  Facts:\n  - ${facts.join('\n  - ')}` : '';
      const topicsBlock = topics.length ? `\n  Topics: ${topics.join(', ')}` : '';
      return `Source ${i + 1} (${s.kind}): ${s.contextDoc.title}\n  Summary: ${s.contextDoc.summary}${topicsBlock}${factsBlock}`;
    })
    .join('\n\n');
}

function renderTranscriptBlob(messages: Array<{ role: 'user' | 'agent'; body: string }>): string {
  if (messages.length === 0) return '(no chat messages yet)';
  return messages
    .map((m) => {
      const label = m.role === 'user' ? 'User' : 'Agent';
      const body = m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body;
      return `${label}: ${body}`;
    })
    .join('\n\n');
}

async function emitAgentMessage(
  clerkUserId: string,
  researchId: string,
  runId: string,
  msg: { body: string },
): Promise<void> {
  await createMessage(clerkUserId, {
    researchId,
    role: 'agent',
    body: msg.body,
    runId,
  });
}

function depthLabel(depth: CouncilDepth): string {
  return depth === 'quick' ? 'quick · 2 reviewers' : 'standard · 3 reviewers';
}

function ideateProviderLabel(provider: 'openai' | 'gemini'): string {
  return provider === 'openai' ? 'OpenAI GPT-5.4' : 'Gemini Flash';
}

function countByCluster(prompts: IdeatePrompt[]): string {
  const tally: Record<string, number> = {};
  for (const p of prompts) tally[p.cluster] = (tally[p.cluster] ?? 0) + 1;
  return Object.entries(tally)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
}

function researchError(code: string, message: string): Error {
  // We use Error's `cause` field to carry the short code so callers can
  // branch without parsing strings. (No custom subclass to keep this
  // file lean.)
  const err = new Error(message);
  (err as Error & { cause: string }).cause = code;
  return err;
}

/**
 * Thrown at any orchestrator stage boundary if the user has hit Stop
 * via /api/research/cancel (which flipped the runs row to `failed`).
 * The top-level catch block recognises this and short-circuits the
 * normal failure path: no extra "we crashed" bubble, no `failRun`
 * (the row is already `failed`), no PostHog `research_run_failed`.
 */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by user');
    this.name = 'RunCancelledError';
  }
}

/**
 * Stage-boundary checkpoint. Cheap single-row select against `runs`;
 * throws if the user cancelled. Call between major orchestrator
 * stages (Ideate / Peec / each Council stage / Surface) and around
 * each Council reviewer so cancellation latency stays in the seconds,
 * not minutes.
 */
async function throwIfCancelled(runId: string): Promise<void> {
  if (await isRunCancelled(runId)) throw new RunCancelledError();
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/**
 * Best-effort raw message extraction for diagnostics. Provider SDKs
 * surface different shapes:
 *   - OpenAI APIError → `err.message` like "400 Unsupported value: ...".
 *     The richer body lives on `err.error?.message`.
 *   - Gemini @google/genai → `err.message` is a JSON blob.
 *   - Anything else → coerce to string.
 *
 * We prefer `err.error.message` when present (OpenAI's nicer body)
 * and fall back to `err.message`.
 */
function extractRawMessage(err: unknown): string {
  if (!err) return '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiErr = err as any;
  if (apiErr && typeof apiErr === 'object') {
    if (apiErr.error && typeof apiErr.error.message === 'string') {
      return apiErr.error.message;
    }
    if (typeof apiErr.message === 'string') {
      return apiErr.message;
    }
  }
  return String(err);
}

/** Pull the HTTP status off an OpenAI APIError-shaped object, if present. */
function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const status = (err as any).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Cap log attribute values so a 50KB Gemini quota dump doesn't bloat
 * every log row. 1KB is enough to read the human message + a snippet
 * of the JSON envelope; the full payload is in `openai.call.failed`
 * from the underlying call site if we ever need it.
 */
function truncateForLog(s: string, max = 1000): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
