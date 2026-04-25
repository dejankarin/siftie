import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';

/**
 * Settings → API Keys placeholder. Session 2 fills in the real form
 * (4 password inputs + per-key Test buttons + the encrypt-via-/api/keys
 * Save handler). For Session 1, this just confirms the route resolves
 * after the Clerk middleware redirect from /app when a user has no keys.
 */
export const metadata = {
  title: 'API Keys · Siftie',
};

export default function ApiKeysPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
        <Link href="/app" className="font-[Instrument_Serif] text-[22px] tracking-tight">
          Siftie
        </Link>
        <UserButton />
      </header>

      <main className="max-w-[640px] mx-auto px-6 py-12 flex flex-col gap-6">
        <div>
          <h1 className="font-[Inter] text-[24px] font-semibold tracking-tight">API Keys</h1>
          <p className="text-[14px] text-[var(--ink-2)] mt-1">
            Bring your own provider keys. Siftie encrypts each key at rest with
            AES-256-GCM and decrypts it server-side only when a request needs it.
          </p>
        </div>

        <div className="rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)] px-5 py-4">
          <p className="text-[13px] text-[var(--ink-2)]">
            This page will accept Gemini, OpenRouter, Tavily (required) and Peec
            (optional, Enterprise) keys in the next build session.
          </p>
        </div>
      </main>
    </div>
  );
}
