import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

/**
 * Marketing landing skeleton. Session 8 builds the full hero
 * (screenshot + three-step value prop + dark-mode-aware imagery); this is
 * the placeholder version that gets us to a deployed siftie.app on day 1.
 *
 * Signed-in visitors get bounced straight to /app. Anonymous visitors
 * see the marketing pitch with a Sign Up CTA.
 */
export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect('/app');

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-12 px-6 py-12 bg-[var(--bg)] text-[var(--ink)]">
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="font-[Instrument_Serif] text-[64px] sm:text-[88px] leading-none tracking-tight">
          Siftie
        </h1>
        <p className="font-[Inter] text-[15px] sm:text-[17px] text-[var(--ink-2)] max-w-[520px]">
          A chat-driven prompt-portfolio builder for AI-engine optimisation.
          Turn your brand sources into a tested set of prompts that win in
          ChatGPT, Perplexity, and Claude.
        </p>
      </header>

      <ol className="flex flex-col sm:flex-row gap-4 sm:gap-3 max-w-[720px] text-[13.5px] text-[var(--ink-2)]">
        <li className="flex-1 px-4 py-3 rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)]">
          <span className="block text-[var(--ink)] font-semibold mb-1">1 · Add sources</span>
          PDF, URL, Word doc, or Markdown — Siftie reads them all.
        </li>
        <li className="flex-1 px-4 py-3 rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)]">
          <span className="block text-[var(--ink)] font-semibold mb-1">2 · Chat with the agent</span>
          The agent asks gap-attributed questions to refine your brief.
        </li>
        <li className="flex-1 px-4 py-3 rounded-[14px] border border-[var(--line)] bg-[var(--surface-1)]">
          <span className="block text-[var(--ink)] font-semibold mb-1">3 · Get a tested portfolio</span>
          ~150 prompts reviewed by a four-model LLM Council.
        </li>
      </ol>

      <div className="flex flex-col items-center gap-3">
        <Link
          href="/sign-up"
          className="px-5 py-2.5 rounded-[12px] bg-[var(--accent)] text-white font-semibold text-[14px] hover:opacity-90 transition-opacity"
        >
          Get started — free with your own keys
        </Link>
        <p className="text-[12px] text-[var(--ink-3)]">
          Bring your own AI provider keys. Costs come out of your accounts, not ours.
        </p>
        <Link href="/sign-in" className="text-[12.5px] text-[var(--ink-2)] underline-offset-4 hover:underline">
          Already have an account? Sign in
        </Link>
      </div>
    </main>
  );
}
