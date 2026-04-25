import { withUser } from '@/lib/auth';
import { getUserApiKey, recordKeyTest, type Provider, PROVIDERS } from '@/lib/keys';

/**
 * POST /api/keys/test/[provider]
 * Decrypts the user's stored key for `provider` and runs the cheapest
 * possible read against that provider to confirm the key works. Updates
 * `last_tested_at` + `last_test_status` so the Settings UI can render a
 * green tick or a red error reason next to the row.
 *
 * Provider-specific calls (chosen for cheapness — none consume LLM tokens):
 *   gemini      GET https://generativelanguage.googleapis.com/v1beta/models?key=...
 *   openrouter  GET https://openrouter.ai/api/v1/models with Authorization
 *   tavily      POST https://api.tavily.com/search { query:'hello', max_results:1 }
 *               (Tavily has no free /models endpoint; a 1-result search costs the
 *                same as one search credit, ~$0.005)
 *   peec        GET https://app.peec.ai/api/v1/projects with Authorization
 *
 * A 10s timeout caps the function's wall-clock cost when a provider is slow.
 */
export const POST = withUser(async ({ userId }, _req, ctx: { params: Promise<{ provider: string }> }) => {
  const { provider: rawProvider } = await ctx.params;
  if (!isProvider(rawProvider)) {
    return Response.json({ error: `Unknown provider "${rawProvider}"` }, { status: 400 });
  }
  const provider = rawProvider;

  const key = await getUserApiKey(userId, provider);
  if (!key) {
    return Response.json(
      { ok: false, message: 'No key stored for this provider yet — Save first, then Test.' },
      { status: 400 },
    );
  }

  try {
    await runProviderTest(provider, key);
    await recordKeyTest(userId, provider, 'ok');
    return Response.json({ ok: true, message: 'Key works.' });
  } catch (err) {
    await recordKeyTest(userId, provider, 'fail');
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ ok: false, message }, { status: 200 });
  }
});

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

const TIMEOUT_MS = 10_000;

async function runProviderTest(provider: Provider, key: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    switch (provider) {
      case 'gemini': {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (!res.ok) {
          throw new Error(await readProviderError(res, 'Gemini'));
        }
        return;
      }
      case 'openrouter': {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) throw new Error(await readProviderError(res, 'OpenRouter'));
        return;
      }
      case 'tavily': {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ api_key: key, query: 'hello', max_results: 1 }),
        });
        if (!res.ok) throw new Error(await readProviderError(res, 'Tavily'));
        return;
      }
      case 'peec': {
        const res = await fetch('https://app.peec.ai/api/v1/projects', {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        });
        if (!res.ok) throw new Error(await readProviderError(res, 'Peec'));
        return;
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function readProviderError(res: Response, providerName: string): Promise<string> {
  const text = await res.text().catch(() => '');
  // Try to pull a sensible message out of common error JSON shapes; fall back
  // to a status-code-only message to keep the UI tidy.
  let detail = text.slice(0, 200);
  try {
    const json = JSON.parse(text);
    detail = json.error?.message || json.message || json.error || detail;
  } catch {
    // not JSON — keep the truncated raw text
  }
  return `${providerName} returned ${res.status}: ${detail}`;
}
