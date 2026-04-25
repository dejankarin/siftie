/**
 * AES-256-GCM encryption helpers for BYOK provider keys at rest.
 *
 * Each user's Gemini / OpenRouter / Tavily / Peec API key is encrypted with
 * a fresh 12-byte IV per row before being persisted to user_api_keys. The
 * master key is loaded from KEY_ENCRYPTION_KEY (a 32-byte / 256-bit value
 * encoded as base64). Loss of that env var renders every encrypted row
 * unrecoverable, which is why we only ever store the ciphertext + iv +
 * authTag in the database, never the plaintext.
 *
 * GCM is preferred over CBC because it provides authenticated encryption:
 * any tampering with the ciphertext, IV, or auth tag is detected on
 * decryption and surfaces as an exception rather than producing garbage
 * plaintext silently.
 *
 * This module is server-only ("import 'server-only'") so it cannot be
 * accidentally bundled into a client-side route — even importing this from
 * a `'use client'` file would throw at build time.
 */
import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32; // 256 bits
const IV_LENGTH_BYTES = 12;  // recommended GCM IV length

let cachedKey: Buffer | null = null;

/**
 * Load and validate KEY_ENCRYPTION_KEY exactly once. Throws loudly if the
 * env var is missing or not the right length, so a misconfigured deploy
 * fails fast at first use rather than silently generating ciphertexts that
 * a future correctly-keyed deploy can't read.
 */
function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.KEY_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'KEY_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to Vercel Production + Preview env (and your local .env.local).',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `KEY_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${buf.length}). Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  cachedKey = buf;
  return buf;
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * Encrypt a UTF-8 plaintext (typically a provider API key the user just
 * pasted into Settings) with a fresh per-call IV.
 */
export function encrypt(plaintext: string): EncryptedPayload {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Reverse of {@link encrypt}. Throws if the auth tag does not validate,
 * which means either the ciphertext was tampered with or the master key
 * has changed since the row was written.
 */
export function decrypt(payload: EncryptedPayload): string {
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
