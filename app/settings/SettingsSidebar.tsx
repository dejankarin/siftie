'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/settings/api-keys', label: 'API Keys' },
  { href: '/settings/privacy', label: 'Privacy' },
] as const;

export function SettingsSidebar() {
  const pathname = usePathname();
  return (
    <nav className="flex md:flex-col gap-1">
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              'px-3 py-2 rounded-[10px] text-[13.5px] transition-colors ' +
              (active
                ? 'bg-[var(--surface-2)] text-[var(--ink)] font-semibold'
                : 'text-[var(--ink-2)] hover:bg-[var(--surface-1)] hover:text-[var(--ink)]')
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
