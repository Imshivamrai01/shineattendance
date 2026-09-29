'use client';
import { useEffect, useState } from 'react';
import Logo from '@/components/Logo';

const KEY = 'shine-install-dismissed';
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode */ } },
};

/** Registers the service worker and shows an "Install app" prompt (Chrome/Edge/Android) or an iOS hint. */
export default function Pwa() {
  const [evt, setEvt] = useState(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone || store.get()) return;
    const onPrompt = (e) => { e.preventDefault(); setEvt(e); setHidden(false); };
    const onInstalled = () => { setHidden(true); setEvt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)) { setIos(true); setHidden(false); }
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);

  if (hidden) return null;
  const dismiss = () => { store.set(); setHidden(true); };
  const install = async () => { await evt.prompt(); await evt.userChoice.catch(() => {}); setEvt(null); setHidden(true); };

  return (
    <div className="install" role="dialog" aria-label="Install app">
      <Logo size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>Install Shine Attendance</b>
        <div className="muted small">{ios && !evt ? 'Tap Share, then "Add to Home Screen".' : 'Add it to your home screen for quick access.'}</div>
      </div>
      {evt && <button className="btn primary sm" onClick={install}>Install</button>}
      <button className="btn sm" onClick={dismiss}>Not now</button>
    </div>
  );
}
