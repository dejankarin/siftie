/**
 * POST /api/sources/[id]/reindex
 *
 * Re-runs the ingest pipeline for a single existing source. Used by the
 * "Re-index" button in SourcesColumn.
 *
 * The original payload was discarded after ingest (we only kept the
 * markdown excerpt + ContextDoc), so the re-index strategy depends on
 * the source kind:
 *
 *   - `url`  → call Tavily again with the stored `originalUrl`. This is
 *             the cheapest path and the one that benefits most from
 *             re-indexing (the page may have changed).
 *   - `md`   → re-feed the stored `rawExcerpt` text to Gemini. Useful if
 *             we improve the system prompt; less useful if the user
 *             never edits the markdown.
 *   - `pdf` / `doc` → not yet supported. The original buffer wasn't
 *             persisted (Blob storage is a Session 5 task), so we
 *             return 501 and the UI hides the button for these kinds.
 *
 * If/when we add Vercel Blob in Session 5, we'll persist the original
 * buffer's blob URL in `meta` and re-fetch it here.
 */
import { withUser } from '@/lib/auth';
import { getUserApiKey } from '@/lib/keys';
import { flushLogs, log } from '@/lib/logger';
import { readPosthogCaptureLlm } from '@/lib/privacy';
import { getPostHogServer } from '@/lib/posthog';
import { getSource, updateSource } from '@/lib/sources';
import { getProjectIdForResearch } from '@/lib/workspace';
import {
  IngestError,
  runIngest,
  type IngestInput,
} from '@/lib/ingest';
import { after } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

export const POST = withUser(
  async ({ userId }, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const source = await getSource(userId, id);

    let input: IngestInput;
    if (source.kind === 'url' && source.meta.kind === 'url') {
      input = { kind: 'url', url: source.meta.originalUrl };
    } else if (source.kind === 'md') {
      input = {
        kind: 'md',
        text: source.contextDoc.rawExcerpt,
        title: source.contextDoc.title,
      };
    } else {
      return Response.json(
        {
          error: 'unsupported_kind',
          message:
            'Re-index for PDF and Word documents requires the original file. Re-upload the file to refresh.',
        },
        { status: 501 },
      );
    }

    // Same BYOK rules as POST /api/sources: either Gemini (preferred)
    // or OpenAI is acceptable; we only block when both are missing.
    const [geminiKey, openaiKey] = await Promise.all([
      getUserApiKey(userId, 'gemini'),
      getUserApiKey(userId, 'openai'),
    ]);
    if (!geminiKey && !openaiKey) {
      return Response.json(
        {
          error: 'missing_key',
          provider: 'gemini',
          message:
            'Add a Gemini key (preferred) or OpenAI key in Settings before re-indexing.',
        },
        { status: 400 },
      );
    }
    let tavilyKey: string | null = null;
    if (input.kind === 'url') {
      tavilyKey = await getUserApiKey(userId, 'tavily');
      if (!tavilyKey) {
        return Response.json(
          { error: 'missing_key', provider: 'tavily' },
          { status: 400 },
        );
      }
    }

    const privacyMode = !(await readPosthogCaptureLlm(userId));
    const ph = getPostHogServer();
    const start = Date.now();
    const traceId = `reindex_${id}_${Date.now().toString(36)}`;
    // PostHog group analytics — best-effort lookup so reindex events show
    // under the parent workspace funnel.
    const projectId = await getProjectIdForResearch(source.researchId);
    const phGroups = projectId ? { project: projectId } : undefined;

    log.info('source.reindex.start', {
      research_id: source.researchId,
      source_id: id,
      user_id: userId,
      kind: source.kind,
      has_gemini_key: !!geminiKey,
      has_openai_key: !!openaiKey,
      has_tavily_key: !!tavilyKey,
      trace_id: traceId,
    });
    after(async () => {
      await flushLogs();
    });

    try {
      const result = await runIngest(
        input,
        {
          geminiKey: geminiKey ?? undefined,
          openaiKey: openaiKey ?? undefined,
          tavilyKey: tavilyKey ?? undefined,
        },
        {
          posthogDistinctId: userId,
          posthogTraceId: traceId,
          posthogPrivacyMode: privacyMode,
          posthogProperties: {
            research_id: source.researchId,
            source_id: id,
            reindex: true,
          },
          posthogGroups: phGroups,
        },
      );

      const updated = await updateSource(userId, id, {
        title: result.contextDoc.title,
        meta: result.meta,
        snippet: result.snippet,
        contextDoc: result.contextDoc,
      });

      ph.capture({
        distinctId: userId,
        event: 'source_reindexed',
        groups: phGroups,
        properties: {
          kind: source.kind,
          words: result.contextDoc.words,
          latency_ms: Date.now() - start,
          success: true,
          source_id: id,
          research_id: source.researchId,
          $ai_trace_id: traceId,
        },
      });

      log.info('source.reindex.ok', {
        research_id: source.researchId,
        source_id: id,
        kind: source.kind,
        words: result.contextDoc.words,
        latency_ms: Date.now() - start,
        trace_id: traceId,
      });

      return Response.json({
        source: {
          id: updated.id,
          researchId: updated.researchId,
          kind: updated.kind,
          title: updated.title,
          meta: updated.meta,
          snippet: updated.snippet,
          contextDoc: updated.contextDoc,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (err) {
      const code = err instanceof IngestError ? err.code : 'unknown_error';
      const message = err instanceof Error ? err.message : 'Reindex failed';
      log.error('source.reindex.failed', {
        research_id: source.researchId,
        source_id: id,
        kind: source.kind,
        error_code: code,
        error_message: message,
        provider: err instanceof IngestError ? err.provider : undefined,
        latency_ms: Date.now() - start,
        trace_id: traceId,
      });
      ph.capture({
        distinctId: userId,
        event: 'source_failed',
        groups: phGroups,
        properties: {
          kind: source.kind,
          error_code: code,
          latency_ms: Date.now() - start,
          success: false,
          source_id: id,
          research_id: source.researchId,
          reindex: true,
          message,
        },
      });
      ph.captureException(err, userId, {
        route: 'POST /api/sources/[id]/reindex',
        research_id: source.researchId,
        source_id: id,
        kind: source.kind,
        error_code: code,
      });
      const status = err instanceof IngestError ? err.status : 500;
      const provider = err instanceof IngestError ? err.provider : undefined;
      return Response.json({ error: code, message, provider }, { status });
    }
  },
);
