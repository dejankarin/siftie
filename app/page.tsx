import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { LandingThemeToggle } from './LandingThemeToggle';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

/**
 * Marketing landing page (Session 8).
 *
 * Three sections, all dark-mode aware via the existing design tokens:
 *   1. Hero — logo + tagline + Sign Up CTA + BYOK reassurance
 *   2. Three-step value prop ("Add sources → Chat with the agent →
 *      Get a tested portfolio")
 *   3. Workspace mock so visitors can see what they're signing up for
 *      without us having to ship a screenshot. Built from real tokens
 *      so it stays in lockstep with the actual app and looks crisp at
 *      any density.
 *
 * Signed-in visitors get bounced straight to /app. Anonymous visitors
 * see the marketing pitch with the Sign Up CTA. PostHog Web Analytics
 * autocaptures pageviews + link clicks, so the sign-up funnel
 * (`$pageview /` → `$pageview /sign-up` → `signed_up` → `key_added`)
 * is wired without any client-side capture calls here.
 */
export default async function LandingPage() {
  const { userId } = await auth();
  if (userId) redirect('/app');

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <SiteNav />
      <main>
        <Hero />
        <ValueProp />
        <WorkspacePreview />
      </main>
      <SiteFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top navigation — sticky so the Log in button is always reachable.
// ---------------------------------------------------------------------------
function SiteNav() {
  return (
    <nav
      className="sticky top-0 z-30 backdrop-blur bg-[var(--bg)]/85 border-b border-[var(--line-2)]"
      aria-label="Top"
    >
      <div className="mx-auto max-w-[1100px] px-5 sm:px-6 py-3 flex items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Siftie home">
          <span className="relative h-[18px] w-[58px] sm:h-[22px] sm:w-[71px]" aria-hidden="true">
            <img className="theme-logo-light h-full w-full object-contain" src={LIGHT_LOGO} alt="" />
            <img className="theme-logo-dark h-full w-full object-contain" src={DARK_LOGO} alt="" />
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <LandingThemeToggle />
          <Link
            href="/sign-in"
            className="px-3 py-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] text-[12.5px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--surface-2)] hover:border-[var(--line-strong)] transition-colors"
          >
            Log in
          </Link>
          <Link
            href="/sign-up"
            className="hidden sm:inline-flex items-center px-3 py-1.5 rounded-[10px] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] text-[12.5px] font-semibold hover:bg-[var(--btn-primary-hover)] transition-colors"
          >
            Sign up
          </Link>
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero section — primary message + CTA. Vertically padded but not full-height
// so visitors can see the value-prop strip starts below the fold.
// ---------------------------------------------------------------------------
function Hero() {
  return (
    <section className="px-5 sm:px-6 pt-12 sm:pt-20 pb-14 sm:pb-20">
      <div className="mx-auto max-w-[840px] flex flex-col items-center text-center gap-6">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11.5px] font-medium bg-[var(--accent-soft)] text-[var(--accent-ink)]">
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"
            aria-hidden="true"
          />
          Now in early access
        </span>
        <h1 className="font-[Inter] tracking-tight text-[var(--ink)] text-[34px] leading-[1.08] sm:text-[52px] sm:leading-[1.05] font-semibold max-w-[760px]">
          Your brand, in every AI answer.
        </h1>
        <p className="font-[Inter] text-[16px] sm:text-[18px] leading-[1.55] text-[var(--ink-2)] max-w-[640px]">
          Siftie builds and tests a prompt portfolio across different LLMs — from sources you already have. Drop in your brand brief, chat with the agent, and ship a tested set of prompts ready for ChatGPT, Gemini, Claude, and Perplexity.
        </p>
        <div className="flex flex-col items-center gap-2.5 mt-2">
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-[12px] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] font-semibold text-[14.5px] hover:bg-[var(--btn-primary-hover)] transition-colors shadow-[var(--shadow-card)]"
          >
            Get started — free with your own keys
            <span aria-hidden="true">→</span>
          </Link>
          <p className="text-[12.5px] text-[var(--ink-3)] max-w-[460px]">
            Bring your own AI provider keys — costs come out of your accounts, not ours.
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Three-step value prop. Numbered cards laid out as a grid that collapses
// to a single column on mobile.
// ---------------------------------------------------------------------------
function ValueProp() {
  const steps: Array<{
    n: string;
    title: string;
    body: string;
    accent: string;
  }> = [
    {
      n: '01',
      title: 'Add sources',
      body: 'Drop PDFs, paste URLs, or share Google Docs and markdown notes. Gemini indexes each one into a structured ContextDoc the agent can quote in chat.',
      accent: 'PDF · URL · Doc · Markdown',
    },
    {
      n: '02',
      title: 'Chat with the agent',
      body: 'Answer six tailored questions about your brand, then refine the context conversationally. The agent searches the web when your sources fall short.',
      accent: 'Interview · Refine · Web search',
    },
    {
      n: '03',
      title: 'Get a tested portfolio',
      body: 'Siftie ideates ~24 prompts, runs a multi-LLM Council to pick the strongest, and tests each one against live ChatGPT / Gemini / Claude / Perplexity baselines.',
      accent: 'Ideate · Council · Peec baseline',
    },
  ];
  return (
    <section className="px-5 sm:px-6 py-10 sm:py-16 border-t border-[var(--line-2)]">
      <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-col items-center gap-3 text-center mb-10 sm:mb-14">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-3)]">
            How it works
          </span>
          <h2 className="text-[24px] sm:text-[28px] tracking-tight font-semibold text-[var(--ink)]">
            From sources to a tested prompt portfolio in three steps.
          </h2>
        </div>
        <ol className="grid gap-4 sm:gap-5 grid-cols-1 md:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-6 flex flex-col gap-3 shadow-[var(--shadow-card)]"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-[11.5px] tracking-wider text-[var(--ink-3)]">
                  {s.n}
                </span>
                <span className="h-px flex-1 bg-[var(--line-2)]" aria-hidden="true" />
              </div>
              <h3 className="text-[17px] font-semibold text-[var(--ink)] tracking-tight">
                {s.title}
              </h3>
              <p className="text-[13.5px] leading-[1.55] text-[var(--ink-2)]">
                {s.body}
              </p>
              <p className="text-[11.5px] text-[var(--ink-3)] mt-auto pt-1">
                {s.accent}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workspace preview — pure HTML mockup of the 3-column app, built from the
// same tokens. Looks like a screenshot but stays in lockstep with the real
// app and switches with the theme toggle. Hidden behind `hidden sm:block`
// because at narrow widths the columns squish into something less honest
// than just a CTA.
// ---------------------------------------------------------------------------
function WorkspacePreview() {
  return (
    <section className="px-5 sm:px-6 py-12 sm:py-20 border-t border-[var(--line-2)]">
      <div className="mx-auto max-w-[1100px] flex flex-col items-center gap-8">
        <div className="flex flex-col items-center text-center gap-3 max-w-[640px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-3)]">
            A peek inside
          </span>
          <h2 className="text-[24px] sm:text-[28px] tracking-tight font-semibold text-[var(--ink)]">
            One workspace. Sources, chat, and the prompt portfolio side-by-side.
          </h2>
        </div>
        <div
          className="hidden sm:block w-full rounded-2xl border border-[var(--line)] bg-[var(--surface-2)] shadow-[var(--shadow-card)] overflow-hidden"
          aria-hidden="true"
        >
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--line-2)] bg-[var(--surface)]">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--surface-3)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--surface-3)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--surface-3)]" />
            <span className="ml-3 text-[11px] font-mono text-[var(--ink-3)]">
              siftie.app/app
            </span>
          </div>
          <div className="grid grid-cols-[260px_minmax(0,1fr)_300px] gap-3 p-3">
            <MockSourcesColumn />
            <MockChatColumn />
            <MockPromptsColumn />
          </div>
        </div>
        <Link
          href="/sign-up"
          className="inline-flex items-center gap-2 px-[18px] py-2.5 rounded-[12px] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] font-semibold text-[14px] hover:bg-[var(--btn-primary-hover)] transition-colors"
        >
          Build your portfolio
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}

function MockSourcesColumn() {
  const sources: Array<{ title: string; meta: string; chip: string }> = [
    { title: 'Brand brief 2026', meta: '4,180 words · just now', chip: 'pdf' },
    { title: 'tracksmith.com/about', meta: 'tracksmith.com · 2 min ago', chip: 'url' },
    { title: 'Voice + tone guide', meta: '1,640 words · 4 min ago', chip: 'doc' },
  ];
  return (
    <div className="rounded-xl bg-[var(--surface)] border border-[var(--line)] p-3.5 flex flex-col gap-3 min-h-[360px]">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-[var(--ink)] tracking-tight">
          Sources
        </h3>
        <span className="text-[10.5px] font-medium text-[var(--ink-3)]">
          3 indexed
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {sources.map((s) => (
          <li
            key={s.title}
            className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-[1px] rounded text-[9.5px] font-mono uppercase tracking-wider bg-[var(--surface-3)] text-[var(--ink-3)]">
                {s.chip}
              </span>
              <p className="text-[11.5px] font-medium text-[var(--ink)] truncate">
                {s.title}
              </p>
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--ink-3)]">{s.meta}</p>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-2">
        <span className="block w-full text-center px-3 py-2 rounded-lg bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] text-[11.5px] font-semibold">
          Run research
        </span>
      </div>
    </div>
  );
}

function MockChatColumn() {
  return (
    <div className="rounded-xl bg-[var(--surface)] border border-[var(--line)] p-3.5 flex flex-col gap-3 min-h-[360px]">
      <h3 className="text-[12px] font-semibold text-[var(--ink)] tracking-tight">
        Chat
      </h3>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-medium text-[var(--ink)]">
            Siftie
          </span>
          <p className="text-[11.5px] leading-[1.55] text-[var(--ink-2)] border-l-2 border-[var(--accent)] pl-2.5">
            Per the Brand brief: Tracksmith positions on craftsmanship and the amateur runner. Want me to weight the portfolio toward that voice, or keep it neutral?
          </p>
        </div>
        <div className="flex justify-end">
          <p className="max-w-[80%] text-[11.5px] leading-[1.55] text-[var(--ink)] bg-[var(--surface-2)] border border-[var(--line)] rounded-2xl rounded-tr-md px-3 py-2">
            Lean into craftsmanship — and add a Persona cluster for marathon trainers.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-medium text-[var(--ink)]">
            Siftie
          </span>
          <p className="text-[11.5px] leading-[1.55] text-[var(--ink-2)]">
            Got it — I'll add a Persona cluster on the next run, and bias all prompts toward craftsmanship language.
          </p>
        </div>
      </div>
      <div className="mt-auto pt-2">
        <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 flex items-center justify-between">
          <span className="text-[11px] text-[var(--ink-3)]">Reply to Siftie…</span>
          <span className="px-2.5 py-1 rounded-full bg-[var(--btn-disabled-bg)] text-[10.5px] text-[var(--btn-disabled-fg)]">
            Send
          </span>
        </div>
      </div>
    </div>
  );
}

function MockPromptsColumn() {
  const prompts: Array<{ cluster: string; intent: string; text: string; hits: number; total: number }> = [
    {
      cluster: 'Category',
      intent: 'High',
      text: 'Best running brands for marathon training in 2026',
      hits: 4,
      total: 6,
    },
    {
      cluster: 'Persona',
      intent: 'Med',
      text: 'Running gear that lasts for serious amateur athletes',
      hits: 3,
      total: 6,
    },
    {
      cluster: 'Comparison',
      intent: 'High',
      text: 'Tracksmith vs Bandit Running for long-distance training',
      hits: 5,
      total: 6,
    },
  ];
  return (
    <div className="rounded-xl bg-[var(--surface)] border border-[var(--line)] p-3.5 flex flex-col gap-3 min-h-[360px]">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-[var(--ink)] tracking-tight">
          Prompt portfolio
        </h3>
        <span className="text-[10.5px] font-medium text-[var(--ink-3)]">24 / 24</span>
      </div>
      <ul className="flex flex-col gap-2">
        {prompts.map((p) => (
          <li
            key={p.text}
            className="rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-[1px] rounded text-[9.5px] font-mono uppercase tracking-wider bg-[var(--accent-soft)] text-[var(--accent-ink)]">
                {p.cluster}
              </span>
              <span className="text-[10px] text-[var(--ink-3)]">{p.intent} intent</span>
            </div>
            <p className="text-[11.5px] leading-[1.45] text-[var(--ink)]">{p.text}</p>
            <div className="flex items-center gap-1 pt-0.5" aria-label={`${p.hits} of ${p.total} hits`}>
              {Array.from({ length: p.total }).map((_, i) => (
                <span
                  key={i}
                  className={`flex-1 h-[3px] rounded-sm ${
                    i < p.hits ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
                  }`}
                />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer — kept minimal: brand line, links to legal pages we don't have yet
// route to mailto so the user lands somewhere predictable.
// ---------------------------------------------------------------------------
function SiteFooter() {
  return (
    <footer
      className="sticky bottom-0 z-30 backdrop-blur bg-[var(--bg)]/85 border-t border-[var(--line-2)]"
      aria-label="Site footer"
    >
      <div className="mx-auto max-w-[1100px] px-5 sm:px-6 py-3 flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-[var(--ink-3)]">
          © {new Date().getFullYear()} Siftie. Bring your own keys.
        </span>
        <nav aria-label="Footer" className="flex items-center gap-4 text-[11.5px] text-[var(--ink-3)]">
          <Link href="/sign-up" className="hover:text-[var(--ink-2)] transition-colors">
            Sign up
          </Link>
          <Link href="/sign-in" className="hover:text-[var(--ink-2)] transition-colors">
            Log in
          </Link>
          <a
            href="mailto:hi@siftie.app"
            className="hover:text-[var(--ink-2)] transition-colors"
          >
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
