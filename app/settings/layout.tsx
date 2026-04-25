import { SettingsSidebar } from './SettingsSidebar';
import { SettingsTopBar } from './SettingsTopBar';

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
      <SettingsTopBar />

      <div className="flex-1 flex flex-col md:flex-row max-w-[960px] w-full mx-auto px-6 py-10 gap-10">
        <aside className="md:w-[180px] shrink-0">
          <SettingsSidebar />
        </aside>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
    </div>
  );
}
