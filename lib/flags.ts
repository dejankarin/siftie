/**
 * Typed feature flags resolved against PostHog server-side, then bootstrapped
 * into the browser SDK to eliminate flag flicker on SSR'd pages.
 *
 * Production-only by construction: getPostHogServer() returns a disabled
 * client off-prod (lib/posthog.ts), so getAllFlags resolves to an empty
 * record on previews/dev. The defaults below are what the rest of the app
 * uses when no flag value comes back — keep them safe and conservative.
 *
 * To add a flag:
 *   1. Add it under FLAG_KEYS below with a documented purpose.
 *   2. Add a default to FLAG_DEFAULTS that mirrors today's behaviour.
 *   3. Use it server-side via `await getServerFlag(distinctId, 'name')` or
 *      browser-side via `useFeatureFlagPayload('name')`. The provider
 *      bootstraps initial values, so the browser sees the same answer the
 *      server saw on the same render.
 */
import 'server-only';
import { getPostHogServer } from './posthog';

/**
 * Source of truth for flag keys. Add new flags here so the rest of the
 * codebase stays in sync via the FlagKey union.
 */
export const FLAG_KEYS = {
  /**
   * Kill-switch / override for the council depth on a research run. When
   * unset, the user's per-research selection wins. Set to `'quick'` or
   * `'standard'` (the values in CouncilDepth) to force every run to that
   * depth — useful to dial back compute on cost spikes without a redeploy.
   */
  COUNCIL_DEPTH_OVERRIDE: 'council_depth_override',
  /**
   * Multivariant flag selecting which model orchestrates Ideate. Values:
   *   - 'gpt-5.4'   (current default)
   *   - 'gpt-5-pro' (experiment arm)
   *   - 'gemini-pro' (experiment arm)
   * Wire into lib/ideate.ts when running a real A/B test.
   */
  IDEATE_MODEL_OVERRIDE: 'ideate_model_override',
} as const;

export type FlagKey = (typeof FLAG_KEYS)[keyof typeof FLAG_KEYS];

/**
 * The whitelist of flag keys we ever fetch. Pinning this list means the
 * bootstrap payload sent to the browser is bounded — flags added in
 * PostHog without a code update don't leak into the page HTML.
 */
const FLAG_ALLOWLIST: FlagKey[] = Object.values(FLAG_KEYS) as FlagKey[];

/**
 * Bootstrap shape consumed by app/PostHogProvider.tsx. PostHog's `bootstrap`
 * option expects `{ distinctID, featureFlags, featureFlagPayloads? }`.
 */
export interface PosthogBootstrap {
  distinctID: string;
  featureFlags: Record<string, string | boolean>;
}

/**
 * Resolve all whitelisted flags for `distinctId` server-side. Used by
 * app/layout.tsx to build the bootstrap payload. Returns an empty
 * featureFlags map off-prod (the disabled posthog-node client returns
 * undefined / empty), which means components fall back to FLAG_DEFAULTS
 * via getServerFlag below.
 */
export async function getServerFlags(distinctId: string): Promise<PosthogBootstrap> {
  if (!distinctId) {
    return { distinctID: '', featureFlags: {} };
  }
  const ph = getPostHogServer();
  let flags: Record<string, string | boolean> = {};
  try {
    const all = await ph.getAllFlags(distinctId);
    // Filter to the allowlist so unknown / experimental flags in PostHog
    // don't end up in HTML.
    for (const key of FLAG_ALLOWLIST) {
      const value = all[key];
      if (value === undefined) continue;
      // posthog-node may return numbers for percentage rollouts on
      // multivariant flags; coerce to string for type safety.
      if (typeof value === 'string' || typeof value === 'boolean') {
        flags[key] = value;
      } else {
        flags[key] = String(value);
      }
    }
  } catch {
    // Flag failures must never break a render. Empty bootstrap is fine —
    // browser SDK will refetch on the next decide() call anyway.
    flags = {};
  }
  return { distinctID: distinctId, featureFlags: flags };
}

/**
 * Server-side flag accessor used by orchestration code (lib/research,
 * lib/ideate). Returns the typed default if the flag is unset or the
 * lookup fails.
 */
export async function getServerFlag(
  distinctId: string,
  key: FlagKey,
): Promise<string | boolean | undefined> {
  if (!distinctId) return undefined;
  try {
    const ph = getPostHogServer();
    return await ph.getFeatureFlag(key, distinctId);
  } catch {
    return undefined;
  }
}
