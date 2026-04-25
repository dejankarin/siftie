/**
 * Shared resilience layer for outbound provider calls (Gemini, Tavily, Peec).
 *
 * Why one helper instead of repeating the same pattern in three files:
 *   - **Consistency.** Every provider call gets the same timeout, retry,
 *     and dedup semantics. If we tune retry counts, we tune one place.
 *   - **Testability.** The interesting moving parts (when to abort, how
 *     long to wait, how to dedup) are all options, so each call site
 *     stays a single line.
 *   - **In-flight dedup.** If two API routes happen to call
 *     `peec.listProjects` for the same user concurrently we don't want
 *     to fire two HTTP requests; the second one piggy-backs on the
 *     first's promise. Keyed by an opt-in `signature` string so we only
 *     dedup when the caller is sure it's safe (idempotent reads only —
 *     POSTs that mutate state pass no signature).
 *
 * What this is NOT:
 *   - It's not a circuit breaker. If a provider is hard down we still
 *     try every request — the user-facing error layer (provider-errors)
 *     turns the failure into a friendly toast.
 *   - It's not a queue. Concurrency control for batched Peec calls
 *     (60% of remaining budget) lives in the orchestrator that uses
 *     this helper, not here.
 */
import 'server-only';
import pRetry, { AbortError } from 'p-retry';

/**
 * Tunable knobs per call. All fields are optional so the most common
 * shape — `withResilience(() => fetch(...))` — works without ceremony.
 */
export interface ResilienceOptions {
  /**
   * Hard wall-clock cap for the underlying fn. Counted per attempt, not
   * across the whole retry sequence — so 30s timeout + 2 retries can
   * still take up to ~90s in the worst case (which is fine: the user-
   * facing API route has its own `maxDuration` and will cut us off).
   *
   * Defaults to 30s. We use `Promise.race` with a manual setTimeout
   * because not every SDK we wrap exposes an AbortSignal — Google's
   * `@google/genai` notably doesn't (yet).
   */
  timeoutMs?: number;
  /** Number of retry attempts (so total tries = retries + 1). Defaults to 2. */
  retries?: number;
  /** Lower bound for backoff in ms (p-retry default is 1000). */
  minTimeoutMs?: number;
  /** Upper bound for backoff in ms (p-retry default is Infinity). */
  maxTimeoutMs?: number;
  /**
   * Predicate called on every failed attempt. If it returns true we abort
   * the retry loop immediately (turn the error into an `AbortError` so
   * `p-retry` re-throws the original underlying error). Use this for
   * 4xx-style errors that won't get better with another try (auth, quota).
   */
  shouldAbort?: (err: unknown) => boolean;
  /**
   * Stable string identifying this exact call. If two `withResilience`
   * invocations with the same signature run at the same time, the second
   * one waits on the first's promise instead of starting a new request.
   * Pass undefined to opt out of dedup (always do a fresh call).
   *
   * Convention: build it from method + URL + relevant body, e.g.
   * `peec:GET:/projects:limit=50` or `gemini:contextDoc:<sha256(body)>`.
   */
  signature?: string;
  /**
   * Optional hook fired when a 429-shaped error happens. We pass the
   * error so the caller can read provider-specific headers like
   * `Retry-After` or update its in-process budget tracker. Returning a
   * number tells `p-retry` to wait at least that many ms before the
   * next attempt (ignored if shorter than `minTimeoutMs`).
   */
  onRateLimit?: (err: unknown, attempt: number) => number | void;
}

/**
 * Module-level dedup table. Holds the *currently in-flight* promise for
 * each signature; entries are deleted when the promise settles so a
 * subsequent call gets a fresh request.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Wrap an arbitrary async fn with timeout + retry + dedup. Returns the
 * fn's resolved value or throws either:
 *   - the original error (if `shouldAbort` matched, or all retries failed)
 *   - a `Error('Timed out after Xms')` when the per-attempt timeout fires
 */
export async function withResilience<T>(
  fn: () => Promise<T>,
  opts: ResilienceOptions = {},
): Promise<T> {
  const { signature } = opts;

  // Dedup: only for opt-in signatures. We cast through unknown because
  // Map can't carry a generic value type per-entry.
  if (signature) {
    const existing = inFlight.get(signature) as Promise<T> | undefined;
    if (existing) return existing;
  }

  const promise = runWithRetries(fn, opts);

  if (signature) {
    inFlight.set(signature, promise as Promise<unknown>);
    // Use a typed `.then` so we don't accidentally swallow the value;
    // we only care about cleaning up the map.
    promise.finally(() => {
      // Guard: another call may have replaced the entry between our
      // start and finish (vanishingly unlikely but cheap to check).
      if (inFlight.get(signature) === (promise as Promise<unknown>)) {
        inFlight.delete(signature);
      }
    });
  }

  return promise;
}

async function runWithRetries<T>(
  fn: () => Promise<T>,
  opts: ResilienceOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;

  const attempt = async (): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return pRetry(attempt, {
    retries,
    minTimeout: opts.minTimeoutMs ?? 500,
    maxTimeout: opts.maxTimeoutMs ?? 4_000,
    onFailedAttempt: (ctx) => {
      if (opts.shouldAbort?.(ctx.error)) {
        // p-retry treats AbortError as "stop retrying, throw original".
        // We pass the original message so the catch site sees the same
        // string the SDK threw.
        const msg = ctx.error instanceof Error ? ctx.error.message : String(ctx.error);
        throw new AbortError(msg);
      }
      opts.onRateLimit?.(ctx.error, ctx.attemptNumber);
    },
  });
}

/**
 * Re-export so call sites that need to throw a "don't retry this" error
 * from inside `fn` itself can do so without re-importing p-retry.
 */
export { AbortError };
