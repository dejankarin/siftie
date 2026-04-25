/**
 * Server-side PostHog client for capturing events from API routes,
 * Server Actions, and the LLM wrappers (lib/gemini.ts, lib/tavily.ts,
 * lib/peec.ts) once those land in Sessions 3+.
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
 *   function alive until pending promises settle. Locally (no Vercel
 *   runtime), the import is a no-op and the singleton is flushed on
 *   process exit.
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
  cached = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
    waitUntil,
  });
  return cached;
}
