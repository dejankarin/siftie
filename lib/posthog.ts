/**
 * Server-side PostHog client for capturing events from API routes,
 * Server Actions, and the LLM wrappers (lib/gemini.ts, lib/tavily.ts,
 * lib/peec.ts, etc.).
 *
 * Production-only: gated on `VERCEL_ENV === 'production'`. Off-prod we
 * still construct a real `PostHog` instance (so the `@posthog/ai`
 * wrappers — which type-require a PostHog client — keep working) but
 * immediately call `client.disable()` so no events ship. Call sites
 * stay clean: they always get a working client, no `if (ph) ...` guards
 * needed.
 *
 * Why a module-level singleton:
 *   PostHog Node batches events in memory and flushes asynchronously.
 *   Creating a new PostHog instance per request would waste batch
 *   capacity, never flush most events before the lambda froze, and burn
 *   more outbound network calls than necessary.
 *
 * Why we pass `waitUntil` from @vercel/functions:
 *   Without it, PostHog's flush would race the lambda's "frozen" state on
 *   Vercel — the request would return, the function would suspend, and
 *   any not-yet-sent batch would be lost. Vercel's `waitUntil` keeps the
 *   function alive until pending promises settle.
 *
 * We deliberately do NOT call `posthog.shutdown()` from request handlers.
 * Closing a singleton between requests would mean every subsequent request
 * tried to write to a closed client. Use the local-script pattern (create
 * an instance, capture, await shutdown) for one-shot scripts.
 */
import { PostHog } from 'posthog-node';
import { waitUntil } from '@vercel/functions';

let cached: PostHog | null = null;

export function getPostHogServer(): PostHog {
  if (cached) return cached;
  const isProd = process.env.VERCEL_ENV === 'production';
  cached = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY ?? 'phc_disabled', {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    waitUntil,
  });
  if (!isProd) {
    // Fire-and-forget: disable() is async but we don't need to await — the
    // first capture call comes after this synchronous tick anyway, and the
    // implementation flips an internal flag synchronously before its
    // returned promise resolves.
    cached.disable();
  }
  return cached;
}
