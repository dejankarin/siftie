import { UserButton } from '@clerk/nextjs';
import { KeyRound } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import type { Theme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

type MobileTab = 'sources' | 'chat' | 'prompts';

interface MobileTopBarProps {
  tab: MobileTab;
  theme: Theme;
  onToggleTheme: () => void;
}

const titles: Record<MobileTab, string> = {
  sources: 'Sources',
  chat: 'Siftie',
  prompts: 'Prompt Portfolio',
};

/**
 * Mobile top bar.
 *
 * Mirrors the desktop TopBar's right-side cluster (theme toggle + Clerk
 * user menu w/ API Keys link) so the user has parity reach on mobile.
 * The previous "More" button was a placeholder that didn't do anything;
 * replacing it with `<UserButton />` lets the user open settings or
 * sign out without leaving the workspace.
 */
export function MobileTopBar({ tab, theme, onToggleTheme }: MobileTopBarProps) {
  const logo = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
  const online = useOnlineStatus();
  return (
    <header className="md:hidden border-b border-[var(--line)] bg-[var(--bg)]/90 backdrop-blur sticky top-0 z-20">
      {!online && (
        <div
          role="status"
          aria-live="polite"
          className="px-4 py-1.5 text-[11.5px] font-medium text-amber-900 bg-amber-100 border-b border-amber-200 dark:text-amber-100 dark:bg-amber-900/40 dark:border-amber-800/60"
        >
          You're offline.
        </div>
      )}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <img src={logo} alt="Siftie" style={{ height: '14px', width: 'auto' }} />
          <span className="w-px h-3.5 bg-[var(--line)]" aria-hidden="true"></span>
          <span className="text-[12.5px] text-[var(--ink-3)] truncate">{titles[tab]}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} compact />
          <UserButton appearance={{ elements: { avatarBox: 'w-7 h-7' } }}>
            <UserButton.MenuItems>
              <UserButton.Link
                label="API Keys"
                labelIcon={<KeyGlyph />}
                href="/settings/api-keys"
              />
            </UserButton.MenuItems>
          </UserButton>
        </div>
      </div>
    </header>
  );
}

function KeyGlyph() {
  return <KeyRound className="w-4 h-4" />;
}
