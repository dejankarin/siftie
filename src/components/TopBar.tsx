import { UserButton } from '@clerk/nextjs';
import { KeyRound } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import type { Theme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

interface TopBarProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function TopBar({ theme, onToggleTheme }: TopBarProps) {
  const logo = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
  const online = useOnlineStatus();
  return (
    <header className="hidden md:block border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
      {!online && <OfflineBanner />}
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Siftie" style={{ height: '18px', width: 'auto' }} />
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn-ghost px-2.5 py-1.5 text-[12.5px] text-[var(--ink-2)]">
            Saved 2 min ago
          </button>
          <span className="w-px h-5 bg-[var(--line)] mx-1"></span>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <span className="w-px h-5 bg-[var(--line)] mx-1"></span>
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

// Clerk's labelIcon expects a 16x16 SVG. Lucide icons render as SVGs and
// are tree-shaken, so a single import adds only this glyph to the bundle.
function KeyGlyph() {
  return <KeyRound size={16} strokeWidth={2} aria-hidden="true" />;
}
