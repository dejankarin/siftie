#!/usr/bin/env node
/**
 * Postbuild hook: upload Next.js sourcemaps to PostHog so Error tracking
 * shows symbolicated stack traces (real file/line numbers, not
 * `_next/static/chunks/...`).
 *
 * Production-only: gates on `VERCEL_ENV === 'production'`. On Vercel
 * preview builds and local `npm run build` runs we exit cleanly without
 * uploading. This keeps the prod symbol set clean and avoids needing
 * `POSTHOG_CLI_API_KEY` to exist locally.
 *
 * Required env (set in Vercel → Project → Settings → Environment Variables
 * → Production scope, NOT in `.env.local`):
 *   - POSTHOG_CLI_API_KEY  : personal API key with `error_tracking:write`
 *   - POSTHOG_CLI_PROJECT_ID (optional but recommended)
 *
 * Vercel exposes `VERCEL_GIT_COMMIT_SHA` during builds; we pass it as
 * `--release-version` so each deploy is symbolicated against its own
 * commit. Without it, the CLI tries to derive from local git.
 */
import { spawnSync } from 'node:child_process';

if (process.env.VERCEL_ENV !== 'production') {
  console.log('[sourcemaps] VERCEL_ENV !== production — skipping upload.');
  process.exit(0);
}

if (!process.env.POSTHOG_CLI_API_KEY) {
  console.warn(
    '[sourcemaps] POSTHOG_CLI_API_KEY is not set — skipping upload. ' +
      'Add it in Vercel → Project → Settings → Environment Variables (Production).',
  );
  // Not a hard failure: a missing token shouldn't break a successful prod
  // deploy. The user gets symbolless stacks until they add the token.
  process.exit(0);
}

const args = ['posthog-cli', 'sourcemap', 'process', '--directory', '.next'];

if (process.env.VERCEL_GIT_COMMIT_SHA) {
  args.push('--release-version', process.env.VERCEL_GIT_COMMIT_SHA);
}

console.log(`[sourcemaps] Running: npx ${args.join(' ')}`);
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  env: process.env,
});

// Don't fail the build on upload errors — Vercel has already produced a
// valid bundle, the only consequence is that newer errors won't be
// symbolicated until the next successful upload.
if (result.status !== 0) {
  console.warn(
    `[sourcemaps] posthog-cli exited ${result.status}; deploy continues without fresh symbols.`,
  );
}
process.exit(0);
