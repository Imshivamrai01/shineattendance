'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '@/lib/client';
import { Modal } from '@/components/ui';

// A quick position for the answer (it is compared with what the person says). No fix is fine too.
const position = () => new Promise((resolve) => {
  if (!navigator.geolocation) return resolve({});
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => resolve({}), { enableHighAccuracy: true, maximumAge: 15000, timeout: 8000 });
});

/**
 * "Still in office?" — shown on any page when the location signal was lost or showed the person outside.
 * The session stays open whatever happens here; "I have left" (or no answer) sends it to HR / Manager for review.
 */
export default function PresencePrompt() {
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const snoozed = useRef({ id: null, until: 0 });

  useEffect(() => {
    const onPing = (e) => {
      const c = e.detail?.check;
      if (c?.status !== 'ASKED') { setCheck(null); return; }
      if (snoozed.current.id === c.id && Date.now() < snoozed.current.until) return;
      setDone(''); setCheck(c);
    };
    window.addEventListener('attendance:ping', onPing);
    return () => window.removeEventListener('attendance:ping', onPing);
  }, []);

  if (!check && !done) return null;
  const close = () => { if (check) snoozed.current = { id: check.id, until: Date.now() + 120000 }; setCheck(null); setDone(''); };
  const answer = async (value) => {
    setBusy(true);
    try {
      const r = await api('/attendance/presence', { method: 'POST', body: { answer: value, ...(await position()) } });
      setDone(r.status === 'RESOLVED' ? 'Thanks, noted. You are still checked in.' : 'Sent to your HR / Manager to review. You are still checked in until they decide.');
      setCheck(null);
      window.dispatchEvent(new Event('attendance:changed'));
    } catch (e) { setDone(e.message); setCheck(null); }
    setBusy(false);
  };
  const exit = check?.reason === 'GEOFENCE_EXIT';

  return (
    <Modal title={check ? 'Still in office?' : 'Attendance'} onClose={close}>
      {check ? (
        <>
          <p style={{ marginTop: 0 }}>
            {exit
              ? <>Your phone&apos;s location showed you about <b>{check.distance} m</b> from the office at {fmtTime(check.since)}.</>
              : <>We have not received your phone&apos;s location since <b>{fmtTime(check.since)}</b>.</>}
            {' '}You are still checked in. Please confirm.
          </p>
          {!exit && (
            <div className="alert warn">
              To keep this from happening, let the app run in the background: in your phone&apos;s Settings &gt; Apps &gt; Shine Attendance, allow background activity (turn off battery optimisation), turn on Auto launch, and set Location to &quot;Allow all the time&quot;.
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" className="btn primary" disabled={busy} onClick={() => answer('IN_OFFICE')}>{busy ? 'Please wait…' : 'Yes, I am in the office'}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => answer('LEFT')}>I have left</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>{done}</p>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn primary" onClick={close}>OK</button></div>
        </>
      )}
    </Modal>
  );
}
