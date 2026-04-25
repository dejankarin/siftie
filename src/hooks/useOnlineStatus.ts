'use client';

/**
 * Tiny client hook that reflects the browser's online/offline state.
 *
 * Why this exists:
 *   Every Siftie action (add source, send message, run research) hits a
 *   server route which in turn hits a paid third-party API. If the
 *   user's WiFi just dropped we'd rather tell them upfront than let
 *   them watch a spinner stall for 30s.
 *
 * What this does NOT detect:
 *   - "Peec is down" or "Gemini is rate-limiting us" — those are
 *     server-side problems and surface as toast errors from the
 *     individual API routes.
 *   - "DNS resolves but the network drops packets" — the browser's
 *     own `navigator.onLine` is conservative; if it says we're online
 *     we trust it. The actual fetch will fail loudly if it's wrong.
 *
 * Implementation notes:
 *   - We initialise to `true` to match SSR (server is always "online"
 *     from its own perspective). The first `online`/`offline` event
 *     after hydration corrects the value.
 *   - `navigator.onLine` is widely supported but only flips on certain
 *     OS-level events (cable unplugged, WiFi toggled). It will NOT
 *     detect a captive portal — by design.
 */
import { useEffect, useState } from 'react';

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // Sync once on mount in case we hydrated while already offline.
    setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return online;
}
