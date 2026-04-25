'use client';

/**
 * Browser-side PostHog initialisation.
 *
 * - `capture_pageview: 'history_change'` makes PostHog re-fire $pageview
 *   on Next.js client-side navigations (the App Router doesn't do a full
 *   page reload between routes). Without it, the funnel analytics in
 *   Session 9 would show only the very first landing pageview per session.
 *
 * - `person_profiles: 'identified_only'` keeps anonymous visitors (e.g.
 *   landing-page traffic) out of the per-person profile billing tier.
 *   Once they sign in, the PostHogIdentify component below promotes them
 *   to a profile.
 *
 * - `autocapture: true` collects clicks + form submissions out of the box;
 *   we still emit explicit business events (key_added, research_started,
 *   prompt_copied, etc.) for the dashboards in Session 9.
 *
 * The provider is mounted high in app/layout.tsx so that route-change
 * pageviews fire from the very first navigation. The `<PostHogIdentify />`
 * sibling listens to Clerk's session and stitches the browser distinct id
 * to the Clerk user id once signed in.
 */
import { useEffect, type ReactNode } from 'react';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';

let initialised = false;

function ensureInit() {
  if (initialised) return;
  if (typeof window === 'undefined') return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key) return;
  posthog.init(key, {
    api_host: host,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: true,
    person_profiles: 'identified_only',
  });
  initialised = true;
}

export function PostHogProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    ensureInit();
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
