import type { Theme } from '../hooks/useTheme';
import { ThemeToggle } from './ThemeToggle';

const LIGHT_LOGO = '/assets/AEOagent-logo.svg';
const DARK_LOGO = '/assets/AEOagent-logo-dark.svg';

interface TopBarProps {
  theme: Theme;
  onToggleTheme: () => void;
}

export function TopBar({ theme, onToggleTheme }: TopBarProps) {
  const logo = theme === 'dark' ? DARK_LOGO : LIGHT_LOGO;
  return (
    <header className="hidden md:flex items-center justify-between px-6 py-3 border-b border-[var(--line)] bg-[var(--bg)]/80 backdrop-blur sticky top-0 z-20">
      <div className="flex items-center gap-3">
        <img src={logo} alt="AEOagent" style={{ height: '18px', width: 'auto' }} />
        <span className="w-px h-4 bg-[var(--line)]"></span>
        <span className="text-[12px] text-[var(--ink-3)]">Loftway · SS26 launch portfolio</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-[12.5px] text-[var(--ink-2)]">
          Saved 2 min ago
        </button>
        <span className="w-px h-5 bg-[var(--line)] mx-1"></span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <span className="w-px h-5 bg-[var(--line)] mx-1"></span>
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-[12.5px] text-[var(--ink-2)]">
          Share
        </button>
        <button type="button" className="btn-primary px-3 py-1.5 text-[12.5px]">
          New session
        </button>
      </div>
    </header>
  );
}
