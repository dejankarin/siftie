'use client';

import { useEffect, useState } from 'react';
import { ThemeToggle } from '../src/components/ThemeToggle';
import { useTheme } from '../src/hooks/useTheme';

export function LandingThemeToggle() {
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <span className="block h-7 w-[58px]" aria-hidden="true" />;
  }

  return <ThemeToggle theme={theme} onToggle={toggle} />;
}
