import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { SettingsSidebar } from './SettingsSidebar';

/**
 * Shared chrome for the /settings/* sub-tree:
 *   - Top bar with a Siftie wordmark (links back to /app) + UserButton
 *   - Left sidebar with the two sub-pages (API Keys, Privacy)
 *
 * Kept lightweight on purpose: settings are a low-traffic surface, so we
 * don't share the workspace's heavier client tree (SourcesColumn, ChatColumn,
 * etc.) — the sidebar is a tiny client component that uses usePathname() to
 * highlight the active link.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)] flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
        <Link href="/app" className="font-[Instrument_Serif] text-[22px] tracking-tight">
          Siftie
        </Link>
        <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7' } }} />
      </header>

      <div className="flex-1 flex flex-col md:flex-row max-w-[960px] w-full mx-auto px-6 py-10 gap-10">
        <aside className="md:w-[180px] shrink-0">
          <SettingsSidebar />
        </aside>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
