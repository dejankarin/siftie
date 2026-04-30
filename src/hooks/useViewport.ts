import { useEffect, useState } from 'react';

export function useIsDesktop(breakpoint = 1100) {
  const [isDesktop, setIsDesktop] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth >= breakpoint : true)
  );
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isDesktop;
}

/**
 * True when the primary input doesn't support hover (touch screens).
 * Used by hover-only affordances that need a non-hover fallback so
 * touch users can discover the action — e.g. the Stop label on the
 * Run-research button, which would otherwise stay hidden behind a
 * hover-only morph that touch never triggers.
 *
 * Defaults to `false` for SSR so the desktop layout is the safer
 * server render; the effect re-syncs on the client.
 */
export function useIsCoarsePointer(): boolean {
  const [isCoarse, setIsCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: none), (pointer: coarse)');
    const update = () => setIsCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isCoarse;
}
