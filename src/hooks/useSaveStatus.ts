'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

export type SaveStatus = 'saved' | 'saving' | 'error';

export interface SaveStatusController {
  status: SaveStatus;
  beginSave: () => void;
  endSave: () => void;
  errorSave: () => void;
}

/**
 * Tracks in-flight server mutations so the TopBar pill can render
 * "Saving…" / "Saved" / "Save failed". Designed to be called from a
 * single instrumentation point inside useWorkspace.trackedFetch.
 *
 * Concurrency: a counter handles overlapping mutations — the pill only
 * leaves "Saving…" once every in-flight call has resolved.
 *
 * Failure stickiness: once any mutation errors, status stays at
 * 'error' until the next beginSave() clears it. That makes the
 * failure visible long enough to matter without flickering.
 */
export function useSaveStatus(): SaveStatusController {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const inFlightRef = useRef(0);
  const errorRef = useRef(false);

  const recompute = useCallback(() => {
    if (inFlightRef.current > 0) {
      setStatus('saving');
    } else if (errorRef.current) {
      setStatus('error');
    } else {
      setStatus('saved');
    }
  }, []);

  const beginSave = useCallback(() => {
    inFlightRef.current += 1;
    errorRef.current = false;
    recompute();
  }, [recompute]);

  const endSave = useCallback(() => {
    inFlightRef.current = Math.max(0, inFlightRef.current - 1);
    recompute();
  }, [recompute]);

  const errorSave = useCallback(() => {
    inFlightRef.current = Math.max(0, inFlightRef.current - 1);
    errorRef.current = true;
    recompute();
  }, [recompute]);

  return useMemo(
    () => ({ status, beginSave, endSave, errorSave }),
    [status, beginSave, endSave, errorSave]
  );
}
