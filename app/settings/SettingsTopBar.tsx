'use client';

import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { ThemeToggle } from '@/src/components/ThemeToggle';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { useTheme } from '@/src/hooks/useTheme';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

export function SettingsTopBar() {
  const { theme, toggle } = useTheme();
  const logo = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
  const online = useOnlineStatus();
  return (
    <header className="border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
      {!online && <OfflineBanner />}
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/app" aria-label="Back to workspace" className="inline-flex items-center">
            <img src={logo} alt="Siftie" style={{ height: '18px', width: 'auto' }} />
          </Link>
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            href="/app"
            className="btn-primary inline-flex items-center gap-1.5 px-3 h-8 text-[12.5px] font-medium"
          >
            <ArrowLeftIcon />
            Back to home
          </Link>
          <span className="w-px h-5 bg-[var(--line)] mx-1" />
          <ThemeToggle theme={theme} onToggle={toggle} />
          <span className="w-px h-5 bg-[var(--line)] mx-1" />
          <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7' } }} />
        </div>
      </div>
    </header>
  );
}

function ArrowLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function OfflineBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="px-6 py-1.5 text-[12px] font-medium text-amber-900 bg-amber-100 border-b border-amber-200 dark:text-amber-100 dark:bg-amber-900/40 dark:border-amber-800/60"
    >
      You're offline. Siftie can't reach Gemini, Tavily, or Peec until your
      connection is back.
    </div>
  );
}
