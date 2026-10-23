'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import Icon from '@/components/Icon';
import { Badge, Field, Modal } from '@/components/ui';
import { fmtDur } from '@/components/SalesCall';

/*
 * Calling an employee, the same two ways as a sales lead:
 *  - Call: through the office line, your phone rings first from the company number, then the employee's; recorded.
 *    Afterwards you note what they said.
 *  - AI call: the voice agent rings them, asks why they didn't come in and when they'll be back, and the answer
 *    comes back as a notification and in their call history.
 */

let lineCache = null; // { enabled, needsNumber, reason, ai } — shared by every button on the page
export const loadLine = () => (lineCache ||= api('/staff-calls/line').catch((e) => { lineCache = null; return { enabled: false, reason: e.message, ai: false }; }));
const changed = () => window.dispatchEvent(new Event('staffcalls:changed'));

const OFFICE_TEXT = {
  STARTING: ['Starting the call…', 'warn'], CALLING_AGENT: ['Calling your phone — pick up to be connected', 'warn'],
  RINGING_LEAD: ['Ringing them…', 'warn'], CONNECTED: ['On the call', 'ok'], ENDED: ['Call ended', ''],
  NO_ANSWER: ['They did not pick up', 'bad'], BUSY: ['Their line was busy', 'bad'],
  FAILED: ['The call could not go through', 'bad'], AGENT_NO_ANSWER: ['You did not pick up, so they were not called', 'bad'],
};
const LIVE = ['STARTING', 'CALLING_AGENT', 'RINGING_LEAD', 'CONNECTED'];

const callEmployee = (person) => () => api(`/users/${person._id}/calls`, { method: 'POST', body: { mode: 'OFFICE' } });

/**
 * Office-line call in progress: live status, Hang up, then "what did they say". `start()` places the call and resolves
 * to { call } (a StaffCall); by default it calls the employee `person`.
 */
export function OfficeCallModal({ person, start, onClose, noteLabel = 'Why they did not come in / what they said',
  notePlaceholder = 'Fever since last night, will come on Monday; told the manager on WhatsApp' }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const status = err ? 'FAILED' : c?.bridge?.status || 'STARTING';
  const started = useRef(false); // once, even when React runs effects twice in development
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (start || callEmployee(person))().then((d) => { setC(d.call); changed(); }).catch((e) => setErr(e.message));
  }, [person, start]);
  useEffect(() => {
    if (!c?._id || !LIVE.includes(status)) return undefined;
    const t = setInterval(() => api(`/staff-calls/${c._id}`).then((d) => setC(d.call)).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [c?._id, status]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [label, tone] = OFFICE_TEXT[status] || [status, ''];
  const talk = c?.bridge?.leadAnsweredAt ? Math.round(((status === 'CONNECTED' ? now : new Date(c.updatedAt).getTime()) - new Date(c.bridge.leadAnsweredAt).getTime()) / 1000) : null;
  const hangup = () => api(`/staff-calls/${c._id}/hangup`, { method: 'POST' }).catch(() => {});
  const save = async () => {
    setBusy(true);
    try { await api(`/staff-calls/${c._id}`, { method: 'PATCH', body: { reason } }); changed(); onClose(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={`Call ${person.name}`} onClose={onClose}>
      <div className={`office-status ${tone}`} role="status" aria-live="polite">
        <div className="row between">
          <div>
            <b>{label}</b>{status === 'CONNECTED' && talk != null ? <span className="office-timer"> {fmtDur(Math.max(0, talk))}</span> : null}
            <div className="muted small">{err || 'Office line · they see the company number · this call is recorded'}</div>
          </div>
          {LIVE.includes(status) && c?._id && <button type="button" className="btn danger sm" onClick={hangup}>Hang up</button>}
        </div>
      </div>
      {['CONNECTED', 'ENDED'].includes(status) && (
        <Field label={noteLabel} hint="Saved with the call. The recording's summary is added automatically if you leave this empty.">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={notePlaceholder} />
        </Field>
      )}
      <div className="row modal-actions">
        <button type="button" className="btn" onClick={onClose}>{LIVE.includes(status) ? 'Close (call continues)' : 'Close'}</button>
        {['CONNECTED', 'ENDED'].includes(status) && <button type="button" className="btn primary" disabled={busy || !reason.trim()} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>}
      </div>
    </Modal>
  );
}

/** First office-line call with no calling number: ask for the phone the call should ring first. */
export function NumberModal({ person, onSaved, onClose }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const l = await api('/staff-calls/line', { method: 'PUT', body: { phone } });
      lineCache = Promise.resolve(l);
      if (!l.enabled) throw new Error(l.reason || 'Office line is not available');
      onSaved();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Your phone for office calls" onClose={onClose}>
      <form onSubmit={go}>
        <p style={{ marginTop: 0 }}>Your phone rings first, then <b>{person.name}</b>. They see the company number and the call is recorded.</p>
        <Field label="Your mobile number" hint="Asked once. Sales calls use the same number.">
          <input type="tel" inputMode="numeric" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98xxxxxxxx" autoFocus required />
        </Field>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row modal-actions">
          <button type="submit" className="btn primary" disabled={busy || phone.replace(/\D/g, '').length < 10}>{busy ? 'Saving…' : 'Save and call'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AiCallModal({ person, onClose }) {
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try { await api(`/users/${person._id}/calls`, { method: 'POST', body: { mode: 'AI', purpose } }); setDone(true); changed(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={`AI call to ${person.name}`} onClose={onClose}>
      {done ? <p style={{ marginTop: 0 }}>The AI agent is calling <b>{person.name}</b> now. You&apos;ll get a notification with the reason they give, and it is saved in their call history.</p> : (
        <>
          <p style={{ marginTop: 0 }}>The agent asks why they did not come to the office today, whether they told their manager, and when they will be back.</p>
          <Field label="Anything else to ask or mention (optional)">
            <textarea rows={2} value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. also absent yesterday without informing" />
          </Field>
        </>
      )}
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row modal-actions">
        <button type="button" className="btn" onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        {!done && <button type="button" className="btn primary" disabled={busy} onClick={go}>{busy ? 'Calling…' : 'Start AI call'}</button>}
      </div>
    </Modal>
  );
}

/** "Call" (office line) and "AI call" buttons for one employee. `person` = { _id, name }. */
export function StaffCallButtons({ person, small }) {
  const [line, setLine] = useState(null);
  const [open, setOpen] = useState(null); // 'OFFICE' | 'NUMBER' | 'AI'
  useEffect(() => { loadLine().then(setLine); }, []);
  if (!line) return null;
  const cls = `btn ${small ? 'sm' : ''}`;
  const office = () => setOpen(line.enabled ? 'OFFICE' : 'NUMBER');
  return (
    <>
      {(line.enabled || line.needsNumber) && <button type="button" className={cls} onClick={office} title="Your phone rings first, then theirs"><Icon name="phone" size={14} /> Call</button>}
      {line.ai && <button type="button" className={cls} onClick={() => setOpen('AI')} title="The AI agent asks why they did not come in">AI call</button>}
      {open === 'NUMBER' && <NumberModal person={person} onSaved={() => { loadLine().then(setLine); setOpen('OFFICE'); }} onClose={() => setOpen(null)} />}
      {open === 'OFFICE' && <OfficeCallModal person={person} onClose={() => setOpen(null)} />}
      {open === 'AI' && <AiCallModal person={person} onClose={() => setOpen(null)} />}
    </>
  );
}

/** One "IVR call" button for anyone: your phone first, then theirs. `start()` places the call (see OfficeCallModal). */
export function IvrButton({ person, start, small, label = 'Call', noteLabel, notePlaceholder, disabled }) {
  const [line, setLine] = useState(null);
  const [open, setOpen] = useState(null); // 'OFFICE' | 'NUMBER'
  useEffect(() => { loadLine().then(setLine); }, []);
  const off = line && !line.enabled && !line.needsNumber;
  return (
    <>
      <button type="button" className={`btn ${small ? 'sm' : ''}`} disabled={disabled || !line || off} title={off ? line.reason : 'Your phone rings first, then theirs'}
        onClick={() => setOpen(line.enabled ? 'OFFICE' : 'NUMBER')}><Icon name="phone" size={14} /> {label}</button>
      {open === 'NUMBER' && <NumberModal person={person} onSaved={() => { loadLine().then(setLine); setOpen('OFFICE'); }} onClose={() => setOpen(null)} />}
      {open === 'OFFICE' && <OfficeCallModal person={person} start={start} noteLabel={noteLabel} notePlaceholder={notePlaceholder} onClose={() => setOpen(null)} />}
    </>
  );
}

const STATUS = { IN_PROGRESS: ['In progress', 'warn'], COMPLETED: ['Talked', 'ok'], NO_ANSWER: ['No answer', 'bad'], FAILED: ['Failed', 'bad'] };

/** Calls to one employee: who called, how, and what they said. */
export function StaffCallHistory({ userId }) {
  const [calls, setCalls] = useState(null);
  const load = useCallback(() => api(`/users/${userId}/calls`).then((d) => setCalls(d.calls)).catch(() => setCalls([])), [userId]);
  useEffect(() => {
    load();
    window.addEventListener('staffcalls:changed', load);
    return () => window.removeEventListener('staffcalls:changed', load);
  }, [load]);
  // Refresh while an AI call is still running, so its answer shows up without a reload.
  useEffect(() => {
    if (!calls?.some((c) => c.status === 'IN_PROGRESS')) return undefined;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [calls, load]);
  if (!calls?.length) return null;
  return (
    <div className="card">
      <h2>Calls</h2>
      {calls.map((c) => {
        const [l, tone] = STATUS[c.status] || [c.status, ''];
        const transcript = c.bridge?.transcript?.length ? c.bridge.transcript.map((m) => ({ them: m.role === 'customer', text: m.content }))
          : (c.aiCall?.transcript || []).map((m) => ({ them: m.role === 'user', text: m.content }));
        const hasRec = !!(c.bridge?.recordingId || c.aiCall?.recordingId);
        const dur = c.durationSec ?? c.aiCall?.durationSec;
        return (
          <div key={c._id} className="li" style={{ alignItems: 'flex-start' }}>
            <span className="avatar sm"><Icon name="phone" size={14} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <b>{c.mode === 'AI' ? 'AI call' : 'Office line'}</b><Badge tone={tone}>{l}</Badge>
                <span className="muted small">by {c.by?.name || '—'} · {fmtDateTime(c.createdAt)}{dur ? ` · ${fmtDur(dur)}` : ''}</span>
              </div>
              {c.reason ? <div style={{ marginTop: 4 }}><b className="small">Reason:</b> {c.reason}</div>
                : c.status === 'IN_PROGRESS' ? <div className="muted small" style={{ marginTop: 4 }}>Waiting for the call to finish…</div> : null}
              {c.note && <div className="muted small">{c.note}</div>}
              {(hasRec || transcript.length > 0) && (
                <div className="call-media">
                  {hasRec && <audio controls preload="none" src={`/api/staff-calls/${c._id}/recording`}>Your browser cannot play this recording.</audio>}
                  {transcript.length > 0 && (
                    <details><summary className="small">Transcript</summary>
                      <ol className="ai-transcript">{transcript.map((m, i) => <li key={i} className={m.them ? 'them' : 'agent'}><span className="muted small">{m.them ? 'Employee' : c.mode === 'AI' ? 'AI agent' : (c.by?.name || 'Team')}</span>{m.text}</li>)}</ol>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
