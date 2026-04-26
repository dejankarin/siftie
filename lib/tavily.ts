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
 *
 * Endpoints exposed:
 *   - `extractUrl(apiKey, url, …)`        Source ingestion (Session 3)
 *   - `searchWeb(apiKey, query, …)`       Reply router web_search action
 *                                         (Session 8) — fetches up to N
 *                                         search hits the agent then cites.
 */
import 'server-only';
import { tavily } from '@tavily/core';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';

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
  /** PostHog group analytics — typically `{ project: <siftieProjectId> }`. */
  posthogGroups?: Record<string, string>;
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
    // Wrap the SDK call in `withResilience` so a single transient flake
    // (Tavily timeout, brief 5xx) retries without us having to think
    // about it. Auth failures abort immediately — no point retrying a
    // bad key. We deliberately do NOT pass a `signature` because URL
    // extracts can legitimately be re-fetched (Re-index button).
    const response = await withResilience(
      () =>
        client.extract([url], {
          extractDepth: 'basic',
          format: 'markdown',
          // Tavily defaults to 60s; 30s is long enough for normal pages
          // and gives the resilience layer's own timer some headroom.
          timeout: 30,
        }),
      {
        timeoutMs: 35_000,
        retries: 2,
        minTimeoutMs: 500,
        maxTimeoutMs: 2_000,
        shouldAbort: (err) => {
          const msg = err instanceof Error ? err.message : String(err ?? '');
          return /401|403|invalid api key|unauthorized/i.test(msg);
        },
      },
    );

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
      groups: tracking.posthogGroups,
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

// ---------------------------------------------------------------------------
// searchWeb — used by the Session 8 reply router for the `web_search`
// action ("what did Tracksmith launch this week?", etc.).
// ---------------------------------------------------------------------------

export interface TavilySearchHit {
  /** Hit title from Tavily (sometimes empty for weird pages). */
  title: string;
  /** Canonical URL of the hit. */
  url: string;
  /** Short snippet Tavily extracted around the match. */
  snippet: string;
  /** ISO publish date if available, else empty string. */
  publishedDate: string;
  /** Tavily relevance score 0..1 — higher is better. */
  score: number;
}

export class TavilySearchError extends Error {
  constructor(
    message: string,
    public readonly query: string,
  ) {
    super(message);
    this.name = 'TavilySearchError';
  }
}

export interface TavilySearchOptionsLite {
  /** Tavily topic — 'general' is the right default for the reply router. */
  topic?: 'general' | 'news' | 'finance';
  /** How many hits to return; we cap at 5 to keep the LLM summary tight. */
  maxResults?: number;
  /** Optional time window — useful when the user asks "this week". */
  timeRange?: 'day' | 'week' | 'month' | 'year';
}

/**
 * Run a Tavily search and return up to `maxResults` hits with title /
 * url / snippet so the caller (typically the reply router) can hand
 * them to an LLM for a citation-heavy summary.
 *
 * Mirrors `extractUrl`: BYOK, classified errors, PostHog `tavily_call`
 * event with `endpoint: 'search'`. Wraps the SDK in `withResilience`
 * so a single transient flake retries; auth failures abort.
 */
export async function searchWeb(
  apiKey: string,
  query: string,
  tracking: TavilyTrackingOptions,
  options: TavilySearchOptionsLite = {},
): Promise<TavilySearchHit[]> {
  if (!apiKey || apiKey.length < 8) {
    throw new TavilySearchError('Tavily API key missing or too short', query);
  }
  const trimmed = query.trim();
  if (!trimmed) {
    throw new TavilySearchError('Tavily search query is empty', query);
  }

  const client = tavily({ apiKey });
  const start = Date.now();
  let success = false;
  let errorCode: string | undefined;
  const maxResults = Math.min(Math.max(options.maxResults ?? 5, 1), 10);
  const topic = options.topic ?? 'general';

  try {
    const response = await withResilience(
      () =>
        client.search(trimmed, {
          searchDepth: 'basic',
          topic,
          maxResults,
          // 30s ample for `basic`; matches extractUrl's posture.
          timeout: 30,
          ...(options.timeRange ? { timeRange: options.timeRange } : {}),
        }),
      {
        timeoutMs: 35_000,
        retries: 2,
        minTimeoutMs: 500,
        maxTimeoutMs: 2_000,
        shouldAbort: (err) => {
          const msg = err instanceof Error ? err.message : String(err ?? '');
          return /401|403|invalid api key|unauthorized/i.test(msg);
        },
      },
    );

    const results = response.results ?? [];
    if (results.length === 0) {
      // Empty results aren't an error from Tavily's POV; the caller can
      // surface a "couldn't find anything" message. Mark `success: true`
      // so analytics distinguishes "search ran, zero hits" from failures.
      success = true;
      return [];
    }

    success = true;
    return results.slice(0, maxResults).map((r) => ({
      title: r.title || '',
      url: r.url,
      // Tavily's `content` is the per-hit snippet; cap so we don't blow
      // the LLM context window when stitching 5 of them together.
      snippet: (r.content ?? '').slice(0, 1200),
      publishedDate: r.publishedDate || '',
      score: typeof r.score === 'number' ? r.score : 0,
    }));
  } catch (err) {
    if (!errorCode) errorCode = 'search_failed';
    if (err instanceof TavilySearchError) throw err;
    throw new TavilySearchError(
      err instanceof Error ? err.message : 'Tavily search failed',
      trimmed,
    );
  } finally {
    const ph = getPostHogServer();
    ph.capture({
      distinctId: tracking.posthogDistinctId,
      event: 'tavily_call',
      groups: tracking.posthogGroups,
      properties: {
        endpoint: 'search',
        topic,
        max_results: maxResults,
        latency_ms: Date.now() - start,
        success,
        error_code: errorCode ?? null,
        $ai_trace_id: tracking.posthogTraceId,
        ...tracking.posthogProperties,
      },
    });
  }
}
