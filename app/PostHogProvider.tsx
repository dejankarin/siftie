'use client';

/**
 * Browser-side PostHog initialisation.
 *
 * Production-only: gated on `NEXT_PUBLIC_VERCEL_ENV === 'production'` so
 * preview deploys (siftie-*.vercel.app) and local dev never write to the
 * production analytics project. Vercel exposes VERCEL_ENV server-side; we
 * mirror it to the browser via NEXT_PUBLIC_VERCEL_ENV (set in Vercel project
 * env, Production scope: `production`, Preview scope: `preview`).
 *
 * - `api_host: '/ingest'` routes the browser SDK through a Next.js rewrite
 *   defined in next.config.mjs, which forwards to eu.i.posthog.com. Pairs
 *   with `ui_host` so the "view in PostHog" deep links keep resolving to
 *   the real dashboard.
 *
 * - `defaults: '2025-12-17'` opts into the current PostHog defaults
 *   (web vitals, dead-click + rage-click detection, exception autocapture).
 *   Without this we'd be frozen on legacy defaults forever.
 *
 * - `capture_pageview: 'history_change'` makes PostHog re-fire $pageview
 *   on Next.js client-side navigations (the App Router doesn't do a full
 *   page reload between routes).
 *
 * - `person_profiles: 'identified_only'` keeps anonymous visitors (e.g.
 *   landing-page traffic) out of the per-person profile billing tier.
 *   Once they sign in, the PostHogIdentify component below promotes them
 *   to a profile.
 *
 * - `autocapture: true` collects clicks + form submissions out of the box;
 *   we still emit explicit business events (key_added, research_started,
 *   prompt_copied, etc.) for the dashboards.
 *
 * - `session_recording` is explicitly configured: Siftie surfaces prompts,
 *   brand sources, and BYOK API keys — all PII-adjacent. `maskAllInputs`
 *   redacts every <input>/<textarea> by default, and the
 *   `[data-private]` opt-in selector lets us mark broader containers
 *   (composer, key forms, source viewers) for full redaction.
 */
import { useEffect, type ReactNode } from 'react';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';

let initialised = false;

function ensureInit() {
  if (initialised) return;
  if (typeof window === 'undefined') return;
  // Production-only gate. Off-prod we still mount the React provider so
  // children calling usePostHog() don't crash; capture calls become no-ops
  // because posthog never initialises.
  if (process.env.NEXT_PUBLIC_VERCEL_ENV !== 'production') return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  // The `defaults: '2025-12-17'` flag opts into modern PostHog
  // defaults (web vitals, dead-click + rage-click capture, exception
  // autocapture). The currently installed `posthog-js` types don't yet
  // include that string literal in the `ConfigDefaults` union, so we
  // cast — the runtime accepts the dated string per PostHog's docs.
  posthog.init(key, {
    api_host: '/ingest',
    ui_host: 'https://eu.posthog.com',
    defaults: '2025-12-17' as unknown as undefined,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: true,
    person_profiles: 'identified_only',
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-private]',
      recordCrossOriginIframes: false,
    },
  });
  initialised = true;
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    ensureInit();
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
