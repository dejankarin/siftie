import type { Theme } from '../hooks/useTheme';

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
  compact?: boolean;
}

function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
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
        {isDark ? <SunIcon /> : <MoonIcon />}
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
        <SunIcon size={12} />
      </span>
      <span
        className={`relative z-10 flex items-center justify-center w-[22px] h-5 rounded-full transition-colors ${
          isDark ? 'text-[var(--ink)]' : 'text-[var(--ink-3)]'
        }`}
      >
        <MoonIcon size={12} />
      </span>
    </button>
  );
}
