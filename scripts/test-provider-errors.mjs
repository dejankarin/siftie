import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(join(tmpdir(), 'siftie-provider-errors-'));

try {
  execFileSync(
    'npx',
    [
      'tsc',
      'lib/provider-errors.ts',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--outDir',
      outDir,
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );

  const mod = await import(pathToFileURL(join(outDir, 'provider-errors.js')).href);
  const rawQuotaError = new Error(
    '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
  );

  assert.deepEqual(mod.classifyProviderError(rawQuotaError, 'gemini'), {
    code: 'quota_exhausted',
    provider: 'gemini',
    message: 'Gemini quota is exhausted. Check your Gemini API key quota or billing, then try again.',
    status: 429,
  });

  const rawApiKeyError = new Error('API key not valid. Please pass a valid API key.');
  assert.deepEqual(mod.classifyProviderError(rawApiKeyError, 'gemini'), {
    code: 'provider_auth_failed',
    provider: 'gemini',
    message: 'Gemini API key was rejected. Update it in Settings, then try again.',
    status: 400,
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
