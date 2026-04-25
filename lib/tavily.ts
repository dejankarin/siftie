/**
 * Typed wrapper around Tavily's `extract` and `search` endpoints.
 *
 * Why this layer exists:
 *   - **BYOK.** Like the Gemini wrapper, this takes the user's API key
 *     as the first argument. The route handler resolves it via
 *     `getUserApiKey(userId, 'tavily')` per request.
 *   - **Sane defaults.** Picks `extract_depth: 'basic'` (cheaper) and
 *     `format: 'markdown'` (Gemini Flash digests markdown well) so callers
 *     don't have to remember.
 *   - **PostHog instrumentation.** Captures a `tavily_call` event with
 *     latency and success — *not* an `$ai_generation` event because Tavily
 *     isn't an LLM.
 *   - **Graceful failure surface.** If Tavily can't extract a URL we
 *     surface a typed error so the caller can fall back to a plain
 *     `fetch().text()` rather than failing the whole ingest.
 */
import 'server-only';
import { tavily } from '@tavily/core';
import { getPostHogServer } from './posthog';

export interface TavilyExtractResult {
  /** Page title from Tavily (often missing on weird/SPA pages — caller should fall back to URL). */
  title: string | null;
  /** Markdown-rendered page content. */
  markdown: string;
  /** The canonical URL Tavily fetched (may differ from the input after redirects). */
  rawUrl: string;
  /** ISO timestamp of when Tavily fetched the page. */
  fetchedAt: string;
}

export class TavilyExtractError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'TavilyExtractError';
  }
}

export interface TavilyTrackingOptions {
  /** Clerk user id — distinctId on the captured event. */
  posthogDistinctId: string;
  /** Optional research-level trace id for grouping. */
  posthogTraceId?: string;
  /** Free-form extras merged onto the event (e.g. { research_id, source_id }). */
  posthogProperties?: Record<string, unknown>;
}

/**
 * Extract a single web page and return Markdown plus the page title.
 * Throws `TavilyExtractError` if the URL can't be fetched/parsed — the
 * caller can then decide whether to fall back to a plain HTTP fetch.
 */
export async function extractUrl(
  apiKey: string,
  url: string,
  tracking: TavilyTrackingOptions,
): Promise<TavilyExtractResult> {
  if (!apiKey || apiKey.length < 8) {
    throw new TavilyExtractError('Tavily API key missing or too short', url);
  }

  const client = tavily({ apiKey });
  const start = Date.now();
  let success = false;
  let errorCode: string | undefined;

  try {
    const response = await client.extract([url], {
      extractDepth: 'basic',
      format: 'markdown',
      // Reasonable per-request timeout — Tavily defaults to 60s server-side
      // but we want to surface failures faster on slow pages.
      timeout: 30,
    });

    const failure = response.failedResults?.find((r) => r.url === url);
    if (failure) {
      errorCode = 'extract_failed';
      throw new TavilyExtractError(failure.error || 'Tavily failed to extract page', url);
    }

    const result = response.results?.[0];
    if (!result || !result.rawContent) {
      errorCode = 'empty_result';
      throw new TavilyExtractError('Tavily returned no content for URL', url);
    }

    success = true;
    return {
      title: result.title,
      markdown: result.rawContent,
      rawUrl: result.url ?? url,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (!errorCode) errorCode = 'unknown_error';
    if (err instanceof TavilyExtractError) throw err;
    throw new TavilyExtractError(
      err instanceof Error ? err.message : 'Tavily extract failed',
      url,
    );
  } finally {
    // Fire-and-forget event capture. PostHog batches; flushing happens via
    // the Vercel waitUntil hook in lib/posthog.ts.
    const ph = getPostHogServer();
    ph.capture({
      distinctId: tracking.posthogDistinctId,
      event: 'tavily_call',
      properties: {
        endpoint: 'extract',
        latency_ms: Date.now() - start,
        success,
        error_code: errorCode ?? null,
        $ai_trace_id: tracking.posthogTraceId,
        ...tracking.posthogProperties,
      },
    });
  }
}
