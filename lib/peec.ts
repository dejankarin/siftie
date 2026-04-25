/**
 * Typed wrappers around the Peec AI Customer REST API.
 * Docs: https://docs.peec.ai/api/introduction
 *
 * Why this layer exists:
 *   - **BYOK.** Like every other provider wrapper, every function takes
 *     the user's Peec key as the first argument. The route handler that
 *     calls us is responsible for resolving it via
 *     `getUserApiKey(userId, 'peec')` and deciding what to do when it's
 *     missing (the orchestrator skips the Peec step entirely).
 *   - **Stable surfaces.** Peec exposes both `model_id` (the underlying
 *     model name, which changes when they upgrade) and
 *     `model_channel_id` (a stable id like `openai-0`, `perplexity-0`).
 *     We always filter on `model_channel_id` so historical hit counts
 *     stay coherent across model swaps.
 *   - **Rate-limit awareness.** Peec enforces 200 req/min per project
 *     and returns `X-RateLimit-Limit / -Remaining / -Reset` on every
 *     response. We parse these into an in-process budget tracker that
 *     the orchestrator (Session 6) reads to size its batch concurrency.
 *   - **Resilience.** Reuses the shared `withResilience` helper so a
 *     transient 5xx or network blip retries with backoff, and 4xx auth
 *     errors abort immediately (no point retrying a bad key).
 *
 * What this layer does NOT do:
 *   - Adaptive batching (e.g. "stay under 60% of remaining budget"). The
 *     wrappers expose `getRateBudget()`; the orchestrator decides how
 *     many concurrent requests to fire based on that.
 *   - Caching. Every call is live, same as the rest of the stack.
 */
import 'server-only';
import { getPostHogServer } from './posthog';
import { withResilience } from './resilience';

const PEEC_BASE_URL = 'https://api.peec.ai/customer/v1';

/** Hard wall-clock cap per Peec request — they're metadata reads, should be quick. */
const PEEC_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by every wrapper when the user hasn't saved a Peec key. The
 * orchestrator catches this specifically and skips the Peec step (it
 * still runs Ideate + Council, just without live mention data).
 */
export class PeecKeyMissingError extends Error {
  readonly code = 'peec_key_missing';
  constructor() {
    super('Peec API key is not configured for this user');
    this.name = 'PeecKeyMissingError';
  }
}

/**
 * Thrown for any non-2xx HTTP response from Peec. Carries the status
 * code so `classifyProviderError` can map 401/403 to "auth failed" and
 * 429 to "quota exhausted".
 */
export class PeecHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`Peec ${endpoint} returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'PeecHttpError';
  }
}

// ---------------------------------------------------------------------------
// Rate-limit budget tracking
// ---------------------------------------------------------------------------

export interface RateBudget {
  /** Total requests allowed in the current window. */
  limit: number;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets (Peec returns this directly). */
  resetSeconds: number;
  /** When we observed these numbers (ms epoch); lets the caller see staleness. */
  observedAt: number;
}

/**
 * Per-API-key rate budget. We key on the API key (not the project id)
 * because a single Siftie user has one Peec key but may target multiple
 * projects, and Peec rate-limits per project — so the safest signal is
 * "the most recent headers we saw on a call using this key".
 */
const budgetByKey = new Map<string, RateBudget>();

/**
 * Returns the most recent rate-limit headers we've observed for this
 * key. Null if we haven't made any calls yet (caller should assume a
 * fresh budget = full 200/min).
 */
export function getRateBudget(apiKey: string): RateBudget | null {
  return budgetByKey.get(apiKey) ?? null;
}

function recordRateBudget(apiKey: string, headers: Headers): void {
  const limit = numericHeader(headers.get('x-ratelimit-limit'));
  const remaining = numericHeader(headers.get('x-ratelimit-remaining'));
  const reset = numericHeader(headers.get('x-ratelimit-reset'));
  // If a header is missing (Peec hasn't documented edge cases) we just
  // skip the update — the orchestrator will treat the budget as unknown.
  if (limit === null || remaining === null || reset === null) return;
  budgetByKey.set(apiKey, {
    limit,
    remaining,
    resetSeconds: reset,
    observedAt: Date.now(),
  });
}

function numericHeader(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Tracking options shared with the orchestrator
// ---------------------------------------------------------------------------

export interface PeecTrackingOptions {
  /** Clerk user id — distinctId on the captured event. */
  posthogDistinctId: string;
  /** Optional research-level trace id for grouping with the LLM trace. */
  posthogTraceId?: string;
  /** Free-form extras merged onto the captured event. */
  posthogProperties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public response shapes — small, only fields we actually consume.
// Peec returns extra metadata we ignore on purpose (forward-compat).
// ---------------------------------------------------------------------------

export interface PeecProject {
  id: string;
  name: string;
  status: string;
  external_id?: string;
}

export interface PeecBrand {
  id: string;
  name: string;
  domains?: string[];
  aliases?: string[];
  is_own: boolean;
  color: string;
}

export interface PeecModelChannel {
  id: string;
  description: string;
  current_model: { id: string };
  is_active: boolean;
}

/**
 * Peec returns reports as `{ data: [...rows] }` with each row carrying
 * the dimension columns the request asked for plus aggregate metric
 * columns. We pass through `unknown[]` for `data` because the shape
 * varies by `dimensions` and we'd rather not over-type a moving target.
 */
export interface PeecReport {
  data: unknown[];
  totalCount?: number;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /projects — used during Settings "Test" and at the top of an
 * orchestrator run to validate the user's Peec key still works.
 */
export async function listProjects(
  apiKey: string,
  tracking: PeecTrackingOptions,
): Promise<PeecProject[]> {
  const json = await peecGet<{ data: PeecProject[] }>(
    apiKey,
    '/projects',
    {},
    tracking,
    `peec:GET:/projects`,
  );
  return json.data;
}

/**
 * GET /brands — list the brands tracked in a Peec project. The
 * orchestrator finds the user's own brand here (`is_own === true`) so
 * we know which brand's mentions to score against.
 */
export async function listBrands(
  apiKey: string,
  opts: { projectId?: string },
  tracking: PeecTrackingOptions,
): Promise<PeecBrand[]> {
  const json = await peecGet<{ data: PeecBrand[]; totalCount?: number }>(
    apiKey,
    '/brands',
    opts.projectId ? { project_id: opts.projectId } : {},
    tracking,
    opts.projectId ? `peec:GET:/brands:${opts.projectId}` : `peec:GET:/brands`,
  );
  return json.data;
}

/**
 * GET /model-channels — the stable surface ids (e.g. `openai-0`,
 * `perplexity-0`) that we filter reports by. Cached by the orchestrator
 * for the duration of a run; one call lists ~16 channels.
 */
export async function listModelChannels(
  apiKey: string,
  opts: { projectId?: string },
  tracking: PeecTrackingOptions,
): Promise<PeecModelChannel[]> {
  const json = await peecGet<{ data: PeecModelChannel[] }>(
    apiKey,
    '/model-channels',
    opts.projectId ? { project_id: opts.projectId } : {},
    tracking,
    opts.projectId
      ? `peec:GET:/model-channels:${opts.projectId}`
      : `peec:GET:/model-channels`,
  );
  return json.data;
}

/**
 * Body shape for the URLs report. We type the few fields the
 * orchestrator actually sets and let extra Peec-specific knobs flow
 * through as `Record<string, unknown>` so callers can use them without
 * bumping this file every release.
 */
export interface UrlsReportBody {
  project_id?: string;
  start_date?: string;
  end_date?: string;
  /**
   * Dimensions to break down the report by. The orchestrator typically
   * asks for `['prompt_id', 'model_channel_id']` so it can compute
   * "how many channels surfaced our brand for each prompt".
   */
  dimensions?: ReadonlyArray<
    'prompt_id' | 'model_id' | 'model_channel_id' | 'tag_id' | 'topic_id' | 'date' | 'country_code' | 'chat_id'
  >;
  /**
   * Filters to scope the report. We always filter on `model_channel_id`
   * (not `model_id`) so historical hits stay coherent across upstream
   * model upgrades.
   */
  filters?: Array<{
    field: string;
    operator: 'in' | 'not_in';
    values: string[];
  }>;
  // Forward-compat: anything else Peec accepts.
  [extra: string]: unknown;
}

/**
 * POST /reports/urls — the per-prompt brand-mention report. The
 * orchestrator calls this once per Ideate batch with prompt ids in the
 * filters and `dimensions: ['prompt_id', 'model_channel_id']`, then
 * pivots the rows into "X channels surfaced your brand for prompt Y".
 *
 * NOTE: this is a POST (not GET) because the body can carry many
 * filters and dimensions — too long for a query string.
 */
export async function getUrlsReport(
  apiKey: string,
  body: UrlsReportBody,
  tracking: PeecTrackingOptions,
): Promise<PeecReport> {
  return peecPost<PeecReport>(apiKey, '/reports/urls', body, tracking);
}

/**
 * POST /reports/brands — share-of-voice / visibility per brand. The
 * orchestrator uses this to compare the user's brand against tracked
 * competitors.
 */
export async function getBrandsReport(
  apiKey: string,
  body: UrlsReportBody,
  tracking: PeecTrackingOptions,
): Promise<PeecReport> {
  return peecPost<PeecReport>(apiKey, '/reports/brands', body, tracking);
}

// ---------------------------------------------------------------------------
// Core HTTP helpers
// ---------------------------------------------------------------------------

async function peecGet<T>(
  apiKey: string,
  path: string,
  query: Record<string, string>,
  tracking: PeecTrackingOptions,
  signature?: string,
): Promise<T> {
  if (!apiKey || apiKey.length < 8) throw new PeecKeyMissingError();
  const url = buildUrl(path, query);
  return performCall<T>(apiKey, 'GET', path, url, undefined, tracking, signature);
}

async function peecPost<T>(
  apiKey: string,
  path: string,
  body: unknown,
  tracking: PeecTrackingOptions,
): Promise<T> {
  if (!apiKey || apiKey.length < 8) throw new PeecKeyMissingError();
  const url = buildUrl(path, {});
  // Mutating-style POSTs are NOT deduped — same body could legitimately
  // be requested twice in a row and we want both to fire.
  return performCall<T>(apiKey, 'POST', path, url, body, tracking, undefined);
}

async function performCall<T>(
  apiKey: string,
  method: 'GET' | 'POST',
  endpoint: string,
  url: string,
  body: unknown | undefined,
  tracking: PeecTrackingOptions,
  signature: string | undefined,
): Promise<T> {
  const start = Date.now();
  let success = false;
  let status = 0;
  let rateRemaining: number | null = null;

  try {
    const result = await withResilience<T>(
      async () => {
        const res = await fetch(url, {
          method,
          headers: {
            'x-api-key': apiKey,
            accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        status = res.status;
        recordRateBudget(apiKey, res.headers);
        rateRemaining = numericHeader(res.headers.get('x-ratelimit-remaining'));

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new PeecHttpError(res.status, endpoint, text);
        }
        return (await res.json()) as T;
      },
      {
        timeoutMs: PEEC_TIMEOUT_MS,
        retries: 2,
        signature,
        // Don't retry auth/permission errors — they won't get better.
        // Quota errors (429) could in principle retry after the window
        // resets, but we'd rather surface them quickly to the user than
        // hold the orchestrator open for ~60s.
        shouldAbort: (err) => {
          if (err instanceof PeecHttpError) {
            return err.status === 401 || err.status === 403 || err.status === 404 || err.status === 429;
          }
          return false;
        },
      },
    );
    success = true;
    return result;
  } finally {
    const ph = getPostHogServer();
    ph.capture({
      distinctId: tracking.posthogDistinctId,
      event: 'peec_call',
      properties: {
        endpoint,
        method,
        status,
        latency_ms: Date.now() - start,
        success,
        ratelimit_remaining: rateRemaining,
        $ai_trace_id: tracking.posthogTraceId,
        ...tracking.posthogProperties,
      },
    });
  }
}

function buildUrl(path: string, query: Record<string, string>): string {
  const url = new URL(`${PEEC_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}
