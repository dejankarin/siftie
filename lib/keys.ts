/**
 * Server-only helpers for the BYOK key store.
 *
 * `Provider` is the closed set of key types the user can store; mirroring
 * the CHECK constraint on user_api_keys.provider keeps the type and DB in
 * lockstep.
 */
import 'server-only';
import { decrypt, encrypt } from './crypto';
import { createServiceRoleSupabaseClient } from './supabase/server';

export type Provider = 'gemini' | 'openrouter' | 'tavily' | 'peec';
export const PROVIDERS: ReadonlyArray<Provider> = ['gemini', 'openrouter', 'tavily', 'peec'];

export interface KeyStatus {
  provider: Provider;
  hasKey: boolean;
  lastTestedAt: string | null;
  lastTestStatus: 'ok' | 'fail' | null;
}

/**
 * Read which keys the user has stored, *without* exposing the encrypted
 * blobs or any decrypted material to the caller. Used to render the
 * Settings → API Keys form initial state.
 */
export async function listKeyStatus(clerkUserId: string): Promise<KeyStatus[]> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('provider, last_tested_at, last_test_status')
    .eq('clerk_user_id', clerkUserId);
  if (error) throw error;

  const byProvider = new Map<Provider, { last_tested_at: string | null; last_test_status: 'ok' | 'fail' | null }>(
    (data ?? []).map((r) => [
      r.provider as Provider,
      { last_tested_at: r.last_tested_at, last_test_status: r.last_test_status },
    ]),
  );
  return PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return {
      provider,
      hasKey: row !== undefined,
      lastTestedAt: row?.last_tested_at ?? null,
      lastTestStatus: row?.last_test_status ?? null,
    };
  });
}

/**
 * Encrypts and stores a provider key. Idempotent: re-saving the same provider
 * overwrites the previous ciphertext and resets the test status to NULL,
 * because the previous test result was for a different key.
 */
export async function saveUserApiKey(
  clerkUserId: string,
  provider: Provider,
  plaintextKey: string,
): Promise<void> {
  const { ciphertext, iv, authTag } = encrypt(plaintextKey);
  const supabase = createServiceRoleSupabaseClient();
  // Postgres `bytea` over PostgREST expects hex-encoded `\x...` strings.
  const { error } = await supabase.from('user_api_keys').upsert(
    {
      clerk_user_id: clerkUserId,
      provider,
      encrypted_key: toHex(ciphertext),
      iv: toHex(iv),
      auth_tag: toHex(authTag),
      last_tested_at: null,
      last_test_status: null,
    },
    { onConflict: 'clerk_user_id,provider' },
  );
  if (error) throw error;
}

/**
 * Reads + decrypts a stored key. Returns null if the user hasn't saved one
 * for that provider, so callers can branch on "ask the user to add a key"
 * rather than crashing the request.
 */
export async function getUserApiKey(
  clerkUserId: string,
  provider: Provider,
): Promise<string | null> {
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('encrypted_key, iv, auth_tag')
    .eq('clerk_user_id', clerkUserId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return decrypt({
    ciphertext: fromHex(data.encrypted_key),
    iv: fromHex(data.iv),
    authTag: fromHex(data.auth_tag),
  });
}

/**
 * Updates the test result columns. Called from the Test endpoint after a
 * provider validation call, so the UI can show a green tick or a red error.
 */
export async function recordKeyTest(
  clerkUserId: string,
  provider: Provider,
  status: 'ok' | 'fail',
): Promise<void> {
  const supabase = createServiceRoleSupabaseClient();
  const { error } = await supabase
    .from('user_api_keys')
    .update({ last_tested_at: new Date().toISOString(), last_test_status: status })
    .eq('clerk_user_id', clerkUserId)
    .eq('provider', provider);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// bytea <-> Buffer helpers. PostgREST returns bytea as `\x...` hex strings.
// ---------------------------------------------------------------------------
function toHex(buf: Buffer): string {
  return '\\x' + buf.toString('hex');
}

function fromHex(hex: string): Buffer {
  // Strip the leading `\x` PostgREST adds.
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}
