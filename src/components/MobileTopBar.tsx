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
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="Siftie" style={{ height: '14px', width: 'auto' }} />
          <span className="w-px h-3.5 bg-[var(--line)]"></span>
          <span className="text-[12.5px] text-[var(--ink-3)]">{titles[tab]}</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} compact />
          <button type="button" className="btn-ghost px-2 py-1 text-[11.5px] text-[var(--ink-3)]">
            More
          </button>
        </div>
      </div>
    </header>
  );
}
