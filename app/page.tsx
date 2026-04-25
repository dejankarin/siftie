import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { LandingThemeToggle } from './LandingThemeToggle';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

/**
 * Marketing landing skeleton. Session 8 builds the full hero
 * (screenshot + value prop + dark-mode-aware imagery); this is the
 * placeholder version that gets us to a deployed siftie.app on day 1.
 *
 * Signed-in visitors get bounced straight to /app. Anonymous visitors
 * see the marketing pitch with a Sign Up CTA.
 */
export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect('/app');

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-12 px-6 py-20 bg-[var(--bg)] text-[var(--ink)]">
      <nav className="absolute inset-x-0 top-0 flex items-center justify-end gap-3 px-6 py-5">
        <LandingThemeToggle />
        <Link
          href="/sign-in"
          className="px-3.5 py-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface-1)] text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-2)] hover:border-[var(--line-strong)] transition-colors"
        >
          Log in
        </Link>
      </nav>

      <header className="flex flex-col items-center gap-6 text-center">
        <h1 className="sr-only">Siftie</h1>
        <div className="relative h-[88px] w-[268px] sm:h-[120px] sm:w-[366px]" aria-hidden="true">
          <img className="theme-logo-light h-full w-full object-contain" src={LIGHT_LOGO} alt="" />
          <img className="theme-logo-dark h-full w-full object-contain" src={DARK_LOGO} alt="" />
        </div>
        <p className="font-[Inter] text-[15px] sm:text-[17px] text-[var(--ink-2)] max-w-[520px] leading-relaxed">
          Your brand, in every AI answer. Siftie builds and tests a prompt
          portfolio across different LLMs — from sources you already have.
        </p>
      </header>

      <div className="flex flex-col items-center gap-2.5">
        <Link
          href="/sign-up"
          className="px-5 py-2.5 rounded-[12px] bg-[var(--accent)] text-[var(--accent-fg)] font-semibold text-[14px] hover:opacity-90 transition-opacity"
        >
          Get started — free with your own keys
        </Link>
        <p className="text-[12px] text-[var(--ink-3)]">
          Bring your own AI provider keys.
        </p>
      </div>
    </main>
  );
}
