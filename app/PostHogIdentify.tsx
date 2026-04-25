'use client';

/**
 * Bridges Clerk's signed-in user state to PostHog's identify() call so
 * every server-side capture using `distinctId = clerkUserId` resolves to
 * the same person profile as the browser-side captures.
 *
 * Runs once on sign-in (when `user` becomes defined), then again on
 * sign-out to reset the distinct id back to anonymous. This keeps shared
 * devices from carrying one user's events into the next user's profile.
 *
 * The person properties we set here are bootstrap values; the Settings
 * pages in Session 2 update `has_<provider>_key`, `keys_count`, and
 * `posthog_capture_llm` via posthog.setPersonProperties() as the user
 * configures their account.
 */
import { useEffect } from 'react';
import { useUser } from '@clerk/nextjs';
import posthog from 'posthog-js';

export function PostHogIdentify() {
  const { isLoaded, isSignedIn, user } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && user) {
      posthog.identify(user.id, {
        signup_at: user.createdAt?.toISOString(),
        has_gemini_key: false,
        has_openrouter_key: false,
        has_tavily_key: false,
        has_peec_key: false,
        keys_count: 0,
        council_depth_default: 'standard',
        posthog_capture_llm: true,
      });
    } else {
      posthog.reset();
    }
  }, [isLoaded, isSignedIn, user]);

  return null;
}
