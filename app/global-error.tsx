'use client';

/**
 * Root-layout error boundary.
 *
 * Next renders this file when the error originates in `app/layout.tsx`
 * itself (e.g. ClerkProvider crashes, PostHogProvider crashes) or when
 * `app/error.tsx` itself throws. Because the root layout is unavailable,
 * `global-error.tsx` MUST render its own `<html>` / `<body>` shell — it
 * fully replaces the document.
 *
 * We forward the error to PostHog. The PostHog browser SDK was likely
 * already initialised by `app/PostHogProvider.tsx` higher up in the
 * tree; if that provider itself was the source of the crash, captureException
 * silently no-ops and we still render the fallback UI.
 */
import { useEffect } from 'react';
import posthog from 'posthog-js';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    posthog.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: '#0b0b0c',
          color: '#f5f5f7',
          padding: '2rem',
          gap: '1rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '24px', fontWeight: 600, margin: 0 }}>Siftie hit a fatal error.</h1>
        <p style={{ fontSize: '14px', color: '#a1a1aa', maxWidth: '420px', margin: 0 }}>
          The app failed to render. We logged the error. Try reloading the page.
        </p>
        {error.digest ? (
          <p style={{ fontFamily: 'monospace', fontSize: '11px', color: '#71717a', margin: 0 }}>
            ref: {error.digest}
          </p>
        ) : null}
        <a
          href="/"
          style={{
            padding: '8px 14px',
            borderRadius: '10px',
            background: '#27272a',
            color: '#f5f5f7',
            fontSize: '13px',
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          Reload
        </a>
      </body>
    </html>
  );
}
