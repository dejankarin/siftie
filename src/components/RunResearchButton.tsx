import { useState } from 'react';
import { useIsCoarsePointer } from '../hooks/useViewport';

/**
 * Run / Stop control for a research pipeline. The same component drives
 * Sources (the primary CTA) and any other surface that wants to kick off
 * or interrupt a run.
 *
 * Visual states:
 *   - `disabled` → muted pill, can't click
 *   - `pending` / `running` → spinner + "Working…", morphs to "Stop" on
 *     hover/focus on desktop. On touch (no hover) we render "Stop"
 *     immediately so the cancel affordance is actually discoverable.
 *   - `failed` → "Retry research" outline pill
 *   - `complete` / null → primary `primaryLabel` pill
 *
 * @param primaryLabel - Copy for the idle, non-failed state (e.g. column-specific CTA).
 * @param className - Extra classes for the button (e.g. `w-full`).
 */
export function RunResearchButton({
  onClick,
  onCancel,
  status,
  disabled,
  primaryLabel = 'Start research',
  className = '',
}: {
  onClick: () => void;
  onCancel: () => void;
  status: 'pending' | 'running' | 'complete' | 'failed' | null | undefined;
  disabled: boolean;
  primaryLabel?: string;
  className?: string;
}) {
  const busy = status === 'pending' || status === 'running';
  const failed = status === 'failed';
  const [hoverStop, setHoverStop] = useState(false);
  const coarsePointer = useIsCoarsePointer();
  // On touch screens the hover-only morph is invisible — show Stop
  // immediately so users can actually discover the cancel affordance.
  const showStop = hoverStop || coarsePointer;

  if (busy) {
    return (
      <button
        type="button"
        onClick={onCancel}
        onMouseEnter={() => setHoverStop(true)}
        onMouseLeave={() => setHoverStop(false)}
        onFocus={() => setHoverStop(true)}
        onBlur={() => setHoverStop(false)}
        title="Stop the current research run"
        aria-label="Stop research run"
        className={`rounded-full px-3.5 h-8 text-[12px] font-medium transition flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]
          ${
            showStop
              ? 'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent)] cursor-pointer'
              : 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-fg)] cursor-pointer'
          } ${className}`.trim()}
      >
        {showStop ? (
          <>
            <span aria-hidden="true" className="w-2.5 h-2.5 rounded-[2px] bg-current"></span>
            Stop
          </>
        ) : (
          <>
            <span className="w-3 h-3 rounded-full border border-current border-t-transparent animate-spin"></span>
            Working…
          </>
        )}
      </button>
    );
  }

  const label = failed ? 'Retry research' : primaryLabel;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? 'Add at least one indexed source first.'
          : 'Generate a fresh prompt portfolio from your sources'
      }
      className={`rounded-full px-3.5 h-8 text-[12px] font-medium transition flex items-center gap-1.5
        ${
          disabled
            ? 'bg-[var(--btn-disabled-bg)] text-[var(--btn-disabled-fg)] cursor-not-allowed'
            : failed
              ? 'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--accent)]'
              : 'bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] hover:bg-[var(--btn-primary-hover)]'
        } ${className}`.trim()}
    >
      {label}
    </button>
  );
}
