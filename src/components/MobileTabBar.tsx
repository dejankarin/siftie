type MobileTab = 'sources' | 'chat' | 'prompts';

interface MobileTabBarProps {
  tab: MobileTab;
  setTab: (t: MobileTab) => void;
  sourcesCount: number;
  promptCount: number;
}

export function MobileTabBar({ tab, setTab, sourcesCount, promptCount }: MobileTabBarProps) {
  const items: { id: MobileTab; label: string; count: number | null }[] = [
    { id: 'sources', label: 'Sources', count: sourcesCount },
    { id: 'chat', label: 'Chat', count: null },
    { id: 'prompts', label: 'Output', count: promptCount },
  ];
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-[var(--surface)]/85 backdrop-blur-md border-t border-[var(--line)] tabbar-safe">
      <div className="grid grid-cols-3">
        {items.map((it) => {
          const active = tab === it.id;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => setTab(it.id)}
              aria-current={active ? 'page' : undefined}
              className="relative flex flex-col items-center justify-center py-3 gap-0.5 focus:outline-none focus-visible:bg-[var(--surface-2)]"
            >
              <span className={`text-[12.5px] font-medium ${active ? 'text-[var(--ink)]' : 'text-[var(--ink-3)]'}`}>
                {it.label}
                {it.count != null && it.count > 0 && (
                  <span className={`ml-1.5 text-[10.5px] ${active ? 'text-[var(--accent-ink)]' : 'text-[var(--ink-3)]'}`}>
                    {it.count}
                  </span>
                )}
              </span>
              {active && <span className="absolute bottom-0 inset-x-6 h-[2px] rounded-full bg-[var(--ink)]"></span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
