import { useEffect } from 'react';

/**
 * Lock background scroll while a modal-style overlay is open.
 *
 * Without this, opening a fullscreen drawer or modal on iOS Safari (or
 * any touch browser) lets the underlying page scroll bleed through —
 * users see content shift behind the overlay when they swipe inside
 * it. Restoring the prior `overflow` value on cleanup means we don't
 * stomp on a parent stylesheet that already disabled scrolling for
 * other reasons.
 *
 * The lock is reference-counted at the module level so multiple
 * overlays open at the same time (e.g. modal opened from inside a
 * drawer) don't fight each other. The first lock takes a snapshot of
 * the body's `overflow`; the last unlock restores it.
 */
let lockCount = 0;
let savedOverflow: string | null = null;

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof document === 'undefined') return;
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.body.style.overflow = savedOverflow ?? '';
        savedOverflow = null;
      }
    };
  }, [active]);
}
