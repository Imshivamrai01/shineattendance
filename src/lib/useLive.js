'use client';
import { useEffect } from 'react';

/**
 * Keeps a page's data fresh without reopening the app: runs `load` now, every `ms` while the page is visible,
 * the moment the app comes back to the front, and right after a check-in / check-out on this device.
 * `load` must be stable (useCallback) and should keep the old data on a failed refresh.
 */
export function useLive(load, ms = 20000) {
  useEffect(() => {
    load();
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    const timer = setInterval(refresh, ms);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('attendance:changed', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('attendance:changed', refresh);
    };
  }, [load, ms]);
}
