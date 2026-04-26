'use client';

/**
 * Route-level error boundary for the App Router.
 *
 * Next 15 wraps every segment in an implicit error boundary. When a
 * client-side render throws inside `app/**`, Next renders this file
 * instead of the segment. We forward the error to PostHog so it shows
 * up in Error tracking with stack + breadcrumb context.
 *
 * `captureException` is independent of the user's `posthog_capture_llm`
 * privacy toggle — that toggle gates LLM payload bodies, not exception
 * telemetry.
 *
 * For root-layout / unrecoverable errors (e.g. ClerkProvider crashes),
 * Next falls back to `app/global-error.tsx` instead, which has its own
 * `<html>`/`<body>` shell.
 */
import { useEffect } from 'react';
import posthog from 'posthog-js';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    posthog.captureException(error);
  }, [error]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 py-20 bg-[var(--bg)] text-[var(--ink)]">
      <div className="flex flex-col items-center gap-3 text-center max-w-[420px]">
        <h1 className="font-[Instrument_Serif] text-[32px] leading-tight">Something broke.</h1>
        <p className="font-[Inter] text-[14px] text-[var(--ink-2)]">
          We logged the error and are looking into it. You can try again, or head back to the app.
        </p>
        {error.digest ? (
          <p className="font-[JetBrains_Mono] text-[11px] text-[var(--ink-3)]">ref: {error.digest}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={reset}
          className="px-3.5 py-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-2)] hover:border-[var(--line-strong)] transition-colors"
        >
          Try again
        </button>
        <a
          href="/app"
          className="px-3.5 py-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-2)] hover:border-[var(--line-strong)] transition-colors"
        >
          Back to app
        </a>
      </div>
    </main>
  );
}
