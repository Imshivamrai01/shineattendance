'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtTime, toLocalInput } from '@/lib/client';
import { useMe } from '@/components/Shell';
import Icon from '@/components/Icon';
import { Field, Modal } from '@/components/ui';
import { STATUS, OUTCOMES, waNumber } from '@/components/SalesBits';

/*
 * Click-to-call. Pressing a number:
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

function OutcomeModal({ call, me, onClose, onSaved, onRedial }) {
  const [f, setF] = useState({ outcome: '', note: '', followUpAt: '', status: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const away = call.hiddenAt && call.backAt ? Math.round((call.backAt - call.hiddenAt) / 1000) : null;
  const elapsed = Math.round((now - call.startedAt) / 1000);
  const pick = (o) => setF((x) => ({ ...x, outcome: o, followUpAt: x.followUpAt || (RETRY.includes(o) ? at11(1) : '') }));
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (!call.activityId) throw new Error('The call is still being recorded, try again in a second');
      await api(`/sales/leads/${call.lead._id}/call`, { method: 'PATCH', body: {
        activityId: call.activityId, outcome: f.outcome, note: f.note, status: f.status || undefined,
        followUpAt: f.followUpAt ? new Date(f.followUpAt).toISOString() : undefined, durationSec: away ?? undefined,
      } });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title="How did the call go?" onClose={onClose}>
      <div className="call-head">
        <span className="call-ico"><Icon name="phone" size={20} /></span>
        <div style={{ minWidth: 0 }}>
          <b>{call.lead.name}</b>
          <div className="muted small">{call.lead.phone} · called by <b>{me.name}</b> at {fmtTime(call.startedAt)}{away != null ? ` · ${fmtDur(away)} on the phone` : ` · ${fmtDur(elapsed)} ago`}</div>
        </div>
        <button type="button" className="btn sm" onClick={onRedial} title="Dial again">Redial</button>
      </div>
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
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Fill in later</button>
        <button type="button" className="btn primary" onClick={submit} disabled={busy || !f.outcome}>{busy ? 'Saving…' : 'Save call'}</button>
      </div>
    </Modal>
  );
}

export function CallProvider({ children }) {
  const me = useMe();
  const [call, setCall] = useState(null); // { lead, activityId, startedAt, hiddenAt, backAt, open }
  const ref = useRef(null);
  ref.current = call;
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
    const c = { lead: { _id: lead._id, name: lead.name, phone: lead.phone, status: lead.status }, activityId: null, startedAt: Date.now(), open: true };
    save(c); setCall(c);
    // keepalive: the request finishes even if the phone app takes over the screen
    fetch(`/api/sales/leads/${lead._id}/call`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: lead.phone }) })
      .then((r) => r.json()).then((d) => { if (d.activity) { update({ activityId: d.activity._id }); changed(); } })
      .catch(() => {});
    window.location.href = telOf(lead.phone);
  }, [update]);

  const close = () => { save(null); setCall(null); changed(); };
  return (
    <Ctx.Provider value={start}>
      {children}
      {call?.open && <OutcomeModal call={call} me={me} onClose={close} onSaved={close} onRedial={() => { window.location.href = telOf(call.lead.phone); }} />}
    </Ctx.Provider>
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
