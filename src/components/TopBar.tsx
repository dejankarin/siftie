import type { Theme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

const LIGHT_LOGO = '/assets/Siftie-logo-light.svg';
const DARK_LOGO = '/assets/Siftie-logo-dark.svg';

interface TopBarProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function TopBar({ theme, onToggleTheme }: TopBarProps) {
  const logo = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
  return (
    <header className="hidden md:flex items-center justify-between px-6 py-3 border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
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
        <button
          type="button"
          className="btn-ghost w-8 h-8 p-0 rounded-full flex items-center justify-center"
          aria-label="User account"
        >
          <span className="w-7 h-7 rounded-full bg-[var(--surface-3)] text-[var(--ink-2)] text-[10.5px] font-semibold flex items-center justify-center overflow-hidden">
            EM
          </span>
        </button>
      </div>
    </header>
  );
}
