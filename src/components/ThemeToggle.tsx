import { Moon, Sun } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
  compact?: boolean;
}

export function ThemeToggle({ theme, onToggle, compact = false }: ThemeToggleProps) {
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  if (compact) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        title={label}
        className="btn-ghost flex items-center justify-center h-7 w-7 text-[var(--ink-2)] hover:text-[var(--ink)]"
      >
        {isDark ? (
          <Sun size={14} strokeWidth={1.6} aria-hidden="true" />
        ) : (
          <Moon size={14} strokeWidth={1.6} aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={isDark}
      aria-label={label}
      title={label}
      className="pill relative flex items-center gap-1 h-7 px-1 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] transition"
    >
      <span
        className="absolute top-1 bottom-1 w-[22px] rounded-full bg-[var(--surface)] shadow-sm transition-transform duration-200 ease-out"
        style={{ transform: isDark ? 'translateX(24px)' : 'translateX(2px)' }}
        aria-hidden="true"
      />
      <span
        className={`relative z-10 flex items-center justify-center w-[22px] h-5 rounded-full transition-colors ${
          isDark ? 'text-[var(--ink-3)]' : 'text-[var(--ink)]'
        }`}
      >
        <Sun size={12} strokeWidth={1.6} aria-hidden="true" />
      </span>
      <span
        className={`relative z-10 flex items-center justify-center w-[22px] h-5 rounded-full transition-colors ${
          isDark ? 'text-[var(--ink)]' : 'text-[var(--ink-3)]'
        }`}
      >
        <Moon size={12} strokeWidth={1.6} aria-hidden="true" />
      </span>
    </button>
  );
}
