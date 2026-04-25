import { withUser } from '@/lib/auth';
import { listKeyStatus, PROVIDERS, saveUserApiKey, type Provider } from '@/lib/keys';
import { z } from 'zod';

/**
 * GET /api/keys
 * Returns which providers the signed-in user has stored a key for, along
 * with each provider's most recent test result. Never returns the keys
 * themselves — only the metadata the Settings UI needs to render row
 * status (placeholder bullets, green tick, red error).
 */
export const GET = withUser(async ({ userId }) => {
  const status = await listKeyStatus(userId);
  return Response.json({ keys: status });
});

const SaveKeyBody = z.object({
  provider: z.enum(PROVIDERS as readonly [Provider, ...Provider[]]),
  // Loose minimum length — providers all use 30+ char keys, but we let the
  // Test endpoint do the real validation rather than trying to maintain a
  // per-provider regex that drifts from reality.
  key: z.string().min(8).max(2048),
});

/**
 * POST /api/keys
 * Body: { provider, key }
 * Encrypts the key with AES-256-GCM and upserts it. Resets the test
 * status because the previous result was for a different key.
 */
export const POST = withUser(async ({ userId }, req) => {
  const json = await req.json().catch(() => null);
  const parsed = SaveKeyBody.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body', details: parsed.error.format() }, { status: 400 });
  }
  await saveUserApiKey(userId, parsed.data.provider, parsed.data.key.trim());
  return Response.json({ ok: true });
});
