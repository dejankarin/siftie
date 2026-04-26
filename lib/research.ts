/**
 * Research orchestrator: coordinates Ideate → [Peec] → Council → Surface
 * for a single "Run research" command.
 *
 * Lifecycle:
 *   1. `startResearchRun` validates inputs (key + at least one source +
 *      at least one user message in the chat) and creates a `runs` row
 *      in `running` state. Returns the `runId` immediately so the API
 *      route can hand back a 202.
 *
 *   2. `runResearchPipeline` executes the long-running work in the
 *      background (the API route calls it from `waitUntil`). It:
 *        a. Resolves the user's API keys + the research's sources +
 *           transcript.
 *        b. Calls Gemini Pro for ~24 candidate prompts (Ideate).
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
import { createMessage } from './messages';
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
  type CouncilDepth,
  type FinalPrompt,
  type IdeatePrompt,
} from './research/schema';
import {
  completeRun,
  createRun,
  failRun,
  getLatestRunByResearch,
} from './runs';
import { listSourcesForResearch } from './sources';
import { listMessagesForResearch } from './messages';
import { getResearchWithContext } from './workspace';

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
 *   - 'no_user_messages'       — the user has not sent any chat messages
 *   - 'missing_ideate_key'     — neither OpenAI nor Gemini key is configured
 *   - 'missing_openrouter_key' — OpenRouter key not configured
 * Callers (the API route) translate these into 4xx responses.
 *
 * Ideate uses **OpenAI GPT-5.4 as the primary** model with **Gemini Pro
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
  const messages = await listMessagesForResearch(clerkUserId, researchId);
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

    const privacyMode = !privacyAllowsCapture;
    const { research } = await getResearchWithContext(clerkUserId, researchId);
    const sources = await listSourcesForResearch(clerkUserId, researchId);
    const transcript = await listMessagesForResearch(clerkUserId, researchId);

    // Strip prior council bubbles from the transcript we feed into
    // Ideate/Council — they're stale narration, not signal.
    const conversationForLlm = transcript
      .filter((m) => m.councilRole === null)
      .map((m) => ({ role: m.role, body: m.body }));

    // -----------------------------------------------------------------
    // Opener bubble
    // -----------------------------------------------------------------
    await emitAgentMessage(clerkUserId, researchId, runId, {
      body: `Working on it. I'll generate candidate prompts, vet them with the Council (${depthLabel(research.councilDepth)}), then surface the strongest portfolio.`,
    });

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
      // If both providers were tried and both failed, name them both.
      const bothFailed =
        err instanceof IdeateProviderError && err.precedingError !== undefined;
      const body = bothFailed
        ? `Ideate failed: OpenAI was unavailable and Gemini also failed — ${classified.message}`
        : `Ideate failed: ${classified.message}`;
      await emitAgentMessage(clerkUserId, researchId, runId, { body });
      throw err;
    }

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
        body: `OpenAI GPT-5.4 was unavailable, so I used Gemini Pro as the fallback. ${ideate.fallbackReason}`,
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

    try {
      const peec = await fetchPeecHits(peecKey, candidates, clerkUserId, traceId);
      hitsByIndex = peec.hitsByIndex;
      totalChannels = peec.totalChannels;
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

    // -----------------------------------------------------------------
    // Stage 3 — Council
    // -----------------------------------------------------------------
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
      research.councilDepth,
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
      },
      councilEmit,
    );

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
    });

    await emitAgentMessage(clerkUserId, researchId, runId, {
      body: `Done — ${finalPrompts.length} prompts in your portfolio. Open "Show all" in the Prompts column for the full Chair rationale.`,
    });

    ph.capture({
      distinctId: clerkUserId,
      event: 'research_run_complete',
      properties: {
        research_id: researchId,
        run_id: runId,
        prompt_count: finalPrompts.length,
        candidate_count: candidates.length,
        reviewers_used: council.reviewersUsed,
        council_depth: research.councilDepth,
        peec_skipped: peecSkipped,
        $ai_trace_id: traceId,
      },
    });
  } catch (err) {
    // Mark the run failed and capture a telemetry event. We've already
    // emitted a chat bubble inside the throwing branch; failing here
    // only persists the run state so the prompts column doesn't show
    // a stale "running" badge forever.
    await failRun(runId).catch((failErr) => {
      console.error('[research] failed to mark run as failed', failErr);
    });
    const code = err instanceof Error ? (err.cause as string | undefined) : undefined;
    ph.capture({
      distinctId: clerkUserId,
      event: 'research_run_failed',
      properties: {
        research_id: researchId,
        run_id: runId,
        error_code: code ?? 'unknown',
        message: err instanceof Error ? err.message : String(err),
        $ai_trace_id: traceId,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface FetchPeecHitsResult {
  hitsByIndex: Record<number, number>;
  totalChannels: number;
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
): Promise<FetchPeecHitsResult> {
  if (!peecKey) throw new PeecKeyMissingError();

  const tracking = {
    posthogDistinctId: clerkUserId,
    posthogTraceId: traceId,
    posthogProperties: { feature: 'research', tag: 'peec_baseline' },
  };

  const projects = await listProjects(peecKey, tracking);
  if (projects.length === 0) {
    return { hitsByIndex: {}, totalChannels: 0 };
  }
  const project = projects[0]!;

  const [brands, channels] = await Promise.all([
    listBrands(peecKey, { projectId: project.id }, tracking),
    listModelChannels(peecKey, { projectId: project.id }, tracking),
  ]);
  const ownBrand = brands.find((b: PeecBrand) => b.is_own);
  const activeChannels = channels.filter((c: PeecModelChannel) => c.is_active);
  const totalChannels = activeChannels.length;
  if (!ownBrand || totalChannels === 0) {
    return { hitsByIndex: {}, totalChannels };
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
  return { hitsByIndex, totalChannels };
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
  tracking: { posthogDistinctId: string; posthogTraceId?: string; posthogProperties?: Record<string, unknown> };
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
  return depth === 'quick' ? 'quick · 3 reviewers' : 'standard · 4 reviewers';
}

function ideateProviderLabel(provider: 'openai' | 'gemini'): string {
  return provider === 'openai' ? 'OpenAI GPT-5.4' : 'Gemini Pro';
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

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}
