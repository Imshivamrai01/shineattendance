'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtTime, toLocalInput } from '@/lib/client';
import { useMe } from '@/components/Shell';
import Icon from '@/components/Icon';
import { Field, Modal } from '@/components/ui';
import { STATUS, OUTCOMES, waNumber } from '@/components/SalesBits';

/*
 * Click-to-call. With the office line on (and a mobile number in the caller's profile), pressing a number rings the
 * caller's own phone first from the company number, then the lead; the popup shows the live status and a Hang up
 * button, the call is recorded, and a lead who doesn't pick up is saved as "No answer" automatically.
 * Otherwise (or if the office line can't start the call), pressing a number:
 *  1. records the call on the server right away (who called, when, which number) as "not updated yet",
 *  2. opens the phone's dialer (tel:; the Android app hands it to the dialer),
 *  3. shows "How did the call go?" — waiting when the caller comes back to the app — for the outcome, what was said,
 *     next follow-up and status. Time spent away from the app is saved as the rough call length.
 * The open call is kept in localStorage so it survives the app being reloaded while the dialer is open.
 */
const Ctx = createContext(null);
export const useCall = () => useContext(Ctx);
const KEY = 'sales:call';
const save = (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* private mode */ } };
const restore = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
export const fmtDur = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const telOf = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
const changed = () => window.dispatchEvent(new Event('sales:changed'));

const at11 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(11, 0, 0, 0); return toLocalInput(d); };
const QUICK = [['In 1 hour', () => toLocalInput(new Date(Date.now() + 3600000))], ['This evening', () => { const d = new Date(); d.setHours(17, 0, 0, 0); return toLocalInput(d < new Date() ? new Date(Date.now() + 3600000) : d); }],
  ['Tomorrow', () => at11(1)], ['In 3 days', () => at11(3)], ['Next week', () => at11(7)]];
// Outcomes that usually need a call back later: pre-fill "Tomorrow" so it isn't forgotten.
const RETRY = ['NO_ANSWER', 'CALL_CUT', 'BUSY', 'SWITCHED_OFF', 'CALL_BACK'];

const OFFICE_TEXT = {
  STARTING: ['Starting the call…', 'warn'], CALLING_AGENT: ['Calling your phone — pick up to be connected', 'warn'],
  RINGING_LEAD: ['Ringing the lead…', 'warn'], CONNECTED: ['On the call', 'ok'], ENDED: ['Call ended', ''],
  NO_ANSWER: ['The lead did not pick up — saved as "No answer"', 'bad'], BUSY: ['The lead was busy — saved as "Busy"', 'bad'],
  FAILED: ['The call could not go through', 'bad'], AGENT_NO_ANSWER: ['You did not pick up, so the lead was not called', 'bad'],
};
const OFFICE_LIVE = ['STARTING', 'CALLING_AGENT', 'RINGING_LEAD', 'CONNECTED'];

/** Live status of an office-line call, polled while it runs. Calls onUpdate(activity) on every change. */
function OfficeStatus({ call, onUpdate, onUsePhone }) {
  const [a, setA] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const status = call.officeError ? 'FAILED' : (a?.bridge?.status || (call.activityId ? 'CALLING_AGENT' : 'STARTING'));
  useEffect(() => {
    if (!call.activityId || !OFFICE_LIVE.includes(status)) return undefined;
    let stop = false;
    const tick = async () => {
      try { const r = await api(`/sales/calls/${call.activityId}`); if (!stop) { setA(r.activity); onUpdate?.(r.activity); } } catch { /* keep polling */ }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [call.activityId, status, onUpdate]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [label, tone] = OFFICE_TEXT[status] || [status, ''];
  const talk = a?.bridge?.leadAnsweredAt ? Math.round(((status === 'CONNECTED' ? now : new Date(a.updatedAt).getTime()) - new Date(a.bridge.leadAnsweredAt).getTime()) / 1000) : null;
  const hangup = async () => { setBusy(true); try { await api(`/sales/calls/${call.activityId}/hangup`, { method: 'POST' }); } catch { /* the status poll shows the result */ } setBusy(false); };
  return (
    <div className={`office-status ${tone}`} role="status" aria-live="polite">
      <div className="row between">
        <div>
          <b>{label}</b>{status === 'CONNECTED' && talk != null ? <span className="office-timer"> {fmtDur(Math.max(0, talk))}</span> : null}
          <div className="muted small">{call.officeError || 'Office line · the lead sees the company number · this call is recorded'}</div>
        </div>
        {OFFICE_LIVE.includes(status) && call.activityId && <button type="button" className="btn danger sm" disabled={busy} onClick={hangup}>Hang up</button>}
      </div>
      {(['STARTING', 'CALLING_AGENT'].includes(status) || call.officeError) && onUsePhone && (
        <button type="button" className="linkish small" style={{ marginTop: 6 }} onClick={async () => {
          if (call.activityId && !call.officeError) { try { await api(`/sales/calls/${call.activityId}/hangup`, { method: 'POST' }); } catch { /* ringing ends anyway */ } }
          onUsePhone();
        }}>Call from my phone instead</button>
      )}
    </div>
  );
}

/** First office-line call from someone with no calling number: ask for the phone the office call should ring. */
function CallerNumberModal({ call, onSave, onClose }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await onSave(phone); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Your phone for office calls" onClose={onClose}>
      <form onSubmit={go}>
        <p style={{ marginTop: 0 }}>Calls go through the office line: your phone rings first, then <b>{call.lead.name}</b>. The lead sees the company number and the call is recorded. This works from a laptop too.</p>
        <Field label="Your mobile number" hint="Asked once. You can change it later the same way.">
          <input type="tel" inputMode="numeric" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98xxxxxxxx" autoFocus required />
        </Field>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row modal-actions">
          {call.usePhone && <button type="button" className="btn" disabled={busy} onClick={call.usePhone}>Use this device&apos;s dialer</button>}
          <button type="submit" className="btn primary" disabled={busy || phone.replace(/\D/g, '').length < 10}>{busy ? 'Saving…' : 'Save and call'}</button>
        </div>
      </form>
    </Modal>
  );
}

function OutcomeModal({ call, me, onClose, onSaved, onRedial }) {
  const [f, setF] = useState({ outcome: '', note: '', followUpAt: '', status: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const [office, setOffice] = useState(null); // latest office-line activity
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const officeStatus = office?.bridge?.status;
  // The server already saved the outcome (lead didn't pick up, or the caller didn't): just close after a moment.
  useEffect(() => {
    if (!['NO_ANSWER', 'BUSY', 'AGENT_NO_ANSWER'].includes(officeStatus)) return undefined;
    const t = setTimeout(onSaved, 3500);
    return () => clearTimeout(t);
  }, [officeStatus, onSaved]);
  const away = call.office ? office?.bridge?.talkSec ?? null : call.hiddenAt && call.backAt ? Math.round((call.backAt - call.hiddenAt) / 1000) : null;
  const elapsed = Math.round((now - call.startedAt) / 1000);
  const pick = (o) => setF((x) => ({ ...x, outcome: o, followUpAt: x.followUpAt || (RETRY.includes(o) ? at11(1) : '') }));
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (!call.activityId) throw new Error('The call is still being recorded, try again in a second');
      const send = () => api(`/sales/leads/${call.lead._id}/call`, { method: 'PATCH', body: {
        activityId: call.activityId, outcome: f.outcome, note: f.note, status: f.status || undefined,
        followUpAt: f.followUpAt ? new Date(f.followUpAt).toISOString() : undefined, durationSec: away ?? undefined,
      } });
      // Coming back from the phone app the connection can still be waking up: one quiet retry on a network error.
      try { await send(); } catch (e) {
        if (e.status) throw e;
        await new Promise((r) => setTimeout(r, 1500));
        await send();
      }
      onSaved();
    } catch (e) {
      setErr(e.status ? e.message : 'Could not reach the server (internet connection). Your answers are still here: press Save call again.');
      setBusy(false);
    }
  };
  return (
    <Modal title="How did the call go?" onClose={onClose}>
      <div className="call-head">
        <span className="call-ico"><Icon name="phone" size={20} /></span>
        <div style={{ minWidth: 0 }}>
          <b>{call.lead.name}</b>
          <div className="muted small">{call.lead.phone} · called by <b>{me.name}</b> at {fmtTime(call.startedAt)}{away != null ? ` · ${fmtDur(away)} on the phone` : ` · ${fmtDur(elapsed)} ago`}</div>
        </div>
        {!call.office && <button type="button" className="btn sm" onClick={onRedial} title="Dial again">Redial</button>}
      </div>
      {call.office && <OfficeStatus call={call} onUpdate={setOffice} onUsePhone={call.usePhone} />}
      <div className="outcomes">
        {Object.entries(OUTCOMES).map(([k, l]) => (
          <button key={k} type="button" className={`btn outcome o-${k.toLowerCase()} ${f.outcome === k ? 'on' : ''}`} onClick={() => pick(k)}>{l}</button>))}
      </div>
      <Field label={f.outcome === 'CONNECTED' || f.outcome === 'CALL_BACK' ? 'What was discussed' : 'Note (optional)'}>
        <textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Owner wants a demo, budget ₹10k/month, call after 5 PM…" autoFocus />
      </Field>
      <div className="form two" style={{ marginTop: 12 }}>
        <Field label="Next follow-up">
          <input type="datetime-local" value={f.followUpAt} onChange={(e) => setF({ ...f, followUpAt: e.target.value })} />
          <div className="chips" style={{ marginTop: 6 }}>
            {QUICK.map(([l, fn]) => <button key={l} type="button" className="btn sm" onClick={() => setF({ ...f, followUpAt: fn() })}>{l}</button>)}
            {f.followUpAt && <button type="button" className="btn sm" onClick={() => setF({ ...f, followUpAt: '' })}>None</button>}
          </div>
        </Field>
        <Field label="Lead status" hint="Automatic: first call → Contacted, follow-up → Follow-up, wrong number → Invalid">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">Automatic (now {STATUS[call.lead.status]?.[0] || 'New'})</option>
            {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
      </div>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Fill in later</button>
        <button type="button" className="btn primary" onClick={submit} disabled={busy || !f.outcome || (call.office && OFFICE_LIVE.includes(officeStatus || 'STARTING') && !call.officeError)}>{busy ? 'Saving…' : 'Save call'}</button>
      </div>
    </Modal>
  );
}

export function CallProvider({ children }) {
  const me = useMe();
  const [call, setCall] = useState(null); // { lead, activityId, startedAt, hiddenAt, backAt, open }
  const ref = useRef(null);
  ref.current = call;
  const [line, setLine] = useState(null); // office line: { enabled, reason }
  useEffect(() => { api('/sales/office-line').then(setLine).catch(() => setLine({ enabled: false })); }, []);
  const update = useCallback((patch) => setCall((c) => { const n = c ? { ...c, ...patch } : null; save(n); return n; }), []);

  useEffect(() => {
    const c = restore();
    if (c && Date.now() - c.startedAt < 12 * 3600000) setCall({ ...c, open: true }); else save(null);
  }, []);
  // Time away from the app while the dialer is open = rough call length.
  useEffect(() => {
    const on = () => {
      const c = ref.current;
      if (!c) return;
      if (document.visibilityState === 'hidden' && !c.backAt) update({ hiddenAt: c.hiddenAt || Date.now() });
      if (document.visibilityState === 'visible' && c.hiddenAt && !c.backAt) update({ backAt: Date.now(), open: true });
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [update]);

  /** `activity` given: fill in an earlier call that was not updated. Otherwise dial and record a new call. */
  const start = useCallback((lead, activity) => {
    if (activity) { const c = { lead, activityId: activity._id, startedAt: new Date(activity.createdAt).getTime(), open: true }; save(c); setCall(c); return; }
    if (!lead?.phone) return;
    const base = { lead: { _id: lead._id, name: lead.name, phone: lead.phone, status: lead.status }, activityId: null, startedAt: Date.now(), open: true };
    const viaPhone = () => {
      const c = { ...base, startedAt: Date.now() };
      save(c); setCall(c);
      // keepalive: the request finishes even if the phone app takes over the screen
      fetch(`/api/sales/leads/${lead._id}/call`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: lead.phone }) })
        .then((r) => r.json()).then((d) => { if (d.activity) { update({ activityId: d.activity._id }); changed(); } })
        .catch(() => {});
      window.location.href = telOf(lead.phone);
    };
    const viaOffice = () => {
      // Office line: the server rings this person's phone, then the lead. No dialer, and the call is recorded.
      setCall({ ...base, office: true, usePhone: viaPhone });
      api(`/sales/leads/${lead._id}/office-call`, { method: 'POST' })
        .then((d) => { setCall((x) => (x ? { ...x, activityId: d.activity._id } : x)); changed(); })
        .catch((e) => setCall((x) => (x ? { ...x, officeError: `${e.message}. You can call from your phone instead.` } : x)));
    };
    if (line?.enabled) return viaOffice();
    if (line?.needsNumber) {
      // No calling number yet (typical on a laptop): ask once, then call through the office line.
      setCall({ ...base, needsNumber: true, usePhone: viaPhone, onNumber: async (phone) => {
        const l = await api('/sales/office-line', { method: 'PUT', body: { phone } });
        setLine(l);
        if (!l.enabled) throw new Error(l.reason || 'Office line is not available');
        viaOffice();
      } });
      return;
    }
    viaPhone();
  }, [update, line]);

  const close = () => { save(null); setCall(null); changed(); };
  return (
    <Ctx.Provider value={start}>
      {children}
      {call?.open && call.needsNumber && <CallerNumberModal call={call} onSave={call.onNumber} onClose={close} />}
      {call?.open && !call.needsNumber && <OutcomeModal call={call} me={me} onClose={close} onSaved={close} onRedial={() => { window.location.href = telOf(call.lead.phone); }} />}
    </Ctx.Provider>
  );
}

/** Recording, summary and transcript of an office-line call (CALL activity `a`), for the timeline and the call log. */
export function OfficeCallMedia({ a, compact }) {
  const b = a?.bridge;
  if (!b?.callId) return null;
  return (
    <div className="call-media">
      <span className="badge">Office line</span>{b.talkSec ? <span className="muted small"> · talked {fmtDur(b.talkSec)}</span> : null}
      {b.recordingId && <div><audio controls preload="none" src={`/api/sales/calls/${a._id}/recording`}>Your browser cannot play this recording.</audio></div>}
      {!compact && b.summary && a.note !== b.summary && <div className="small" style={{ marginTop: 4 }}><b>Summary:</b> {b.summary}</div>}
      {!compact && b.transcript?.length > 0 && (
        <details><summary className="small">Transcript</summary>
          <ol className="ai-transcript">{b.transcript.map((m, i) => <li key={i} className={m.role === 'customer' ? 'them' : 'agent'}><span className="muted small">{m.role === 'customer' ? 'Lead' : (a.by?.name || 'Team')}</span>{m.content}</li>)}</ol>
        </details>
      )}
    </div>
  );
}

/** The phone number as a button: tap = record + dial + ask for the outcome. */
export function CallButton({ lead, big }) {
  const start = useCall();
  if (!lead.phone) return <span className="muted small">No number</span>;
  return (
    <button type="button" className={`callbtn ${big ? 'big' : ''}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); start(lead); }} title={`Call ${lead.phone}`}>
      <Icon name="phone" size={big ? 18 : 14} /><span>{lead.phone}</span>
    </button>
  );
}

/** WhatsApp / Instagram / website / map as small icon buttons (labels too when `labels`). */
export function ContactLinks({ lead, labels }) {
  const link = (href, icon, label) => (
    <a className={`iconlink ${labels ? 'labelled' : ''}`} href={href} target="_blank" rel="noreferrer" title={label} aria-label={label}><Icon name={icon} size={15} />{labels && <span>{label}</span>}</a>);
  return (
    <span className="lead-links">
      {lead.phone && link(`https://wa.me/${waNumber(lead.phone)}`, 'whatsapp', 'WhatsApp')}
      {lead.instagram && link(lead.instagram, 'instagram', 'Instagram')}
      {lead.website && link(/^https?:/i.test(lead.website) ? lead.website : `https://${lead.website}`, 'globe', 'Website')}
      {lead.mapsUrl && link(lead.mapsUrl, 'pin', 'Map')}
    </span>
  );
}

/** "You called X at 3:10 and haven't said how it went" — one row per call waiting for an update. */
export function PendingCalls({ pending }) {
  const start = useCall();
  if (!pending?.length) return null;
  return (
    <div className="alert warn pending-calls">
      <b>{pending.length === 1 ? '1 call needs an update' : `${pending.length} calls need an update`}</b>
      {pending.map((a) => a.lead && (
        <div key={a._id} className="row between">
          <span>{a.lead.name} <span className="muted small">· {fmtDateTime(a.createdAt)}</span></span>
          <button className="btn sm primary" onClick={() => start(a.lead, a)}>What happened?</button>
        </div>))}
    </div>
  );
}
