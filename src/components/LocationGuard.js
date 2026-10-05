'use client';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/client';

const PING_MS = 30000;

/*
 * Runs on every page of the app (not just the dashboard). While the person is checked in it keeps
 * sending their position; leaving the office radius checks them out automatically (see lib/attendance ping).
 * Browsers pause web apps that are closed, so it also re-checks the moment the app is opened or brought back.
 * Results are broadcast as a window `attendance:ping` event; pages fire `attendance:changed` after check-in/out.
 * In the Android app the native background service (android/) takes over while the app is closed.
 */
export default function LocationGuard() {
  const state = useRef({ open: false, watch: null, last: null, sentAt: 0, checkedAt: 0, busy: false });

  useEffect(() => {
    const s = state.current;
    if (!navigator.geolocation) return undefined;

    const send = async (coords) => {
      if (s.busy) return;
      s.busy = true; s.sentAt = Date.now();
      try {
        const r = await api('/attendance/ping', { method: 'POST', body: coords || {} });
        s.open = !!r.open;
        window.dispatchEvent(new CustomEvent('attendance:ping', { detail: r }));
        if (s.open) startWatch(); else stopWatch();
        syncNative();
      } catch { /* offline or signed out: try again on the next tick */ }
      s.busy = false;
    };
    // Inside the Android app (window.ShineNative): its background service keeps reporting with the app closed.
    // It needs its own token because it runs without this page's login cookie.
    const syncNative = async () => {
      const app = window.ShineNative;
      if (!app) return;
      try {
        if (!s.open) { if (app.isTracking()) app.stopTracking(); return; }
        if (app.isTracking()) return;
        const { token } = await api('/attendance/track-token', { method: 'POST' });
        app.startTracking(token);
      } catch { /* try again on the next ping */ }
    };
    const startWatch = () => {
      if (s.watch != null) return;
      s.watch = navigator.geolocation.watchPosition((p) => {
        s.last = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        if (Date.now() - s.sentAt >= PING_MS) send(s.last);
      }, () => { s.last = null; }, { enableHighAccuracy: true, maximumAge: 10000 });
    };
    const stopWatch = () => {
      if (s.watch != null) navigator.geolocation.clearWatch(s.watch);
      s.watch = null; s.last = null;
    };
    // App opened / brought to the front: learn whether we're checked in, then send a fresh fix right away.
    const checkNow = async (force) => {
      if (force !== true && Date.now() - s.checkedAt < 3000) return; // focus + visibilitychange fire together
      s.checkedAt = Date.now();
      await send(null);
      if (!s.open) return;
      navigator.geolocation.getCurrentPosition(
        (p) => send({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    };

    const onVisible = () => { if (document.visibilityState === 'visible') checkNow(); };
    const onChanged = () => checkNow(true);
    const timer = setInterval(() => { if (s.open && s.last && Date.now() - s.sentAt >= PING_MS) send(s.last); }, PING_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('attendance:changed', onChanged);
    checkNow();
    return () => {
      clearInterval(timer); stopWatch();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('attendance:changed', onChanged);
    };
  }, []);
  return null;
}
