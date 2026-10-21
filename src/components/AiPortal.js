'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import { Badge, Field, Modal, Skeleton, Empty } from '@/components/ui';
import { StatusBadge, when } from '@/components/SalesBits';
import { CallButton, fmtDur } from '@/components/SalesCall';

// What the AI voice agent did: callbacks waiting for the team, every AI call with its summary, transcript and recording.

export const AI_OUTCOME = {
  CALLBACK: ['Wants a callback', 'warn'], INTERESTED: ['Interested', 'ok'], INFO_GIVEN: ['Got information', ''], NOT_INTERESTED: ['Not interested', 'bad'],
  OPT_OUT: ['Do not call', 'bad'], NO_CONVERSATION: ['No conversation', ''], FAILED: ['Did not connect', 'bad'],
};
export const AiOutcomeBadge = ({ c }) => {
  const k = c.outcome || (c.status === 'COMPLETED' ? '' : c.status);
  const [label, tone] = AI_OUTCOME[k] || [{ QUEUED: 'Dialling…', IN_PROGRESS: 'On the call' }[k] || k || '—', k === 'IN_PROGRESS' || k === 'QUEUED' ? 'warn' : ''];
  return <Badge tone={tone}>{label}</Badge>;
};
const INTEREST = { HOT: 'grade-hot', WARM: 'grade-warm', COLD: 'grade-cold', NOT_INTERESTED: 'grade-cold' };
const InterestBadge = ({ i }) => (i ? <span className={`badge ${INTEREST[i]}`}>{i === 'NOT_INTERESTED' ? 'Not interested' : i[0] + i.slice(1).toLowerCase()}</span> : null);
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const who = (c) => c.callerName || c.company || c.lead?.name || c.phone || 'Unknown caller';

/** Full view of one AI call: summary, callback, recording player and transcript. */
export function AiCallDetail({ id, onClose, onChanged }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api(`/sales/ai-calls/${id}`).then((r) => setC(r.call)).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const handled = async () => {
    setBusy(true);
    try { await api(`/sales/ai-calls/${id}`, { method: 'PATCH', body: { handled: true } }); await load(); onChanged?.(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title={c ? `AI call · ${who(c)}` : 'AI call'} onClose={onClose}>
      {err && <div className="alert">{err}</div>}
      {!c ? <Skeleton title={false} rows={4} /> : (
        <div className="ai-detail">
          <div className="row" style={{ marginBottom: 10 }}>
            <AiOutcomeBadge c={c} /> <InterestBadge i={c.interest} />
            <span className="muted small">{c.direction === 'inbound' ? 'Incoming' : 'Outgoing'} · {fmtDateTime(c.startedAt || c.createdAt)}{c.durationSec ? ` · ${fmtDur(c.durationSec)}` : ''}</span>
          </div>
          {c.summary && <p style={{ marginTop: 0 }}>{c.summary}</p>}
          <dl className="ai-facts">
            <dt>Phone</dt><dd>{c.phone || '—'}</dd>
            {c.callerName && <><dt>Name</dt><dd>{c.callerName}</dd></>}
            {c.company && <><dt>Company</dt><dd>{c.company}</dd></>}
            {c.requirement && <><dt>Needs</dt><dd>{c.requirement}</dd></>}
            {c.lead && <><dt>Lead</dt><dd><Link href={`/sales/leads/${c.lead._id}`}>{c.lead.name}</Link> <StatusBadge s={c.lead.status} /></dd></>}
            {c.requestedBy && <><dt>Started by</dt><dd>{c.requestedBy.name}</dd></>}
            {c.hangupCause && c.status === 'FAILED' && <><dt>Reason</dt><dd>{c.hangupCause}</dd></>}
          </dl>
          {c.callbackRequested && (
            <div className={`alert ${c.handledAt ? 'ok' : 'warn'}`}>
              <b>Callback {c.callbackAt ? `at ${fmtDateTime(c.callbackAt)}` : 'requested (no time given)'}</b>
              {c.callbackNote && <div className="small">{c.callbackNote}</div>}
              {c.handledAt
                ? <div className="small">Taken by {c.handledBy?.name || 'the team'} · {fmtDateTime(c.handledAt)}</div>
                : <div className="row" style={{ marginTop: 8 }}>
                    {c.lead && <CallButton lead={{ ...c.lead, phone: c.lead.phone || c.phone }} />}
                    <button className="btn sm primary" disabled={busy} onClick={handled}>Mark callback done</button>
                  </div>}
            </div>
          )}
          <h3 className="small muted" style={{ margin: '14px 0 6px' }}>Recording</h3>
          {c.hasRecording
            ? <audio controls preload="none" src={`/api/sales/ai-calls/${c._id}/recording`} style={{ width: '100%' }}>Your browser cannot play this recording.</audio>
            : <p className="muted small">{c.status === 'COMPLETED' ? 'Not ready yet. It usually arrives a minute after the call.' : 'No recording for this call.'}</p>}
          <h3 className="small muted" style={{ margin: '14px 0 6px' }}>Transcript</h3>
          {!c.transcript?.length ? <p className="muted small">No conversation was recorded.</p> : (
            <ol className="ai-transcript">
              {c.transcript.map((m, i) => <li key={i} className={m.role === 'user' ? 'them' : 'agent'}><span className="muted small">{m.role === 'user' ? 'Caller' : 'AI agent'}</span>{m.content}</li>)}
            </ol>
          )}
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** Sales tab "AI Portal". */
export function AiPortal() {
  const [view, setView] = useState('callbacks');
  const [day, setDay] = useState('');
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api(`/sales/ai-calls?${qs({ view: view === 'callbacks' ? 'callbacks' : '', day: view === 'all' ? day : '', q })}`)
    .then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [view, day, q]);
  useLive(load, 20000);
  // Deep link from the sheet / notification: /sales?tab=ai&call=<id>
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('call'); if (id) setOpen(id); }, []);

  const t = res?.today;
  return (
    <>
      {res && !res.connected && <div className="alert warn">The AI calling agent is not connected on this server yet (VOICE_API_URL / AI_WEBHOOK_SECRET). Calls will not be placed or recorded.</div>}
      {t && (
        <div className="sales-stats">
          <button className="stat stat-btn" onClick={() => setView('callbacks')}><span className="muted small">Callbacks to do</span><b>{res.openCallbacks}</b><span className="muted small">asked for on AI calls</span></button>
          <button className="stat stat-btn" onClick={() => { setView('all'); setDay(todayIst()); }}><span className="muted small">AI calls today</span><b>{t.total}</b><span className="muted small">{t.completed} completed · {t.talked} conversations</span></button>
          <div className="stat"><span className="muted small">Today</span><b>{t.callbacks}</b><span className="muted small">callback requests · {t.optOuts} do-not-call</span></div>
        </div>
      )}
      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <div className="tabs" style={{ margin: 0 }}>
            <button className={`btn sm ${view === 'callbacks' ? 'primary' : ''}`} onClick={() => setView('callbacks')}>Callbacks to do{res?.openCallbacks ? ` (${res.openCallbacks})` : ''}</button>
            <button className={`btn sm ${view === 'all' ? 'primary' : ''}`} onClick={() => setView('all')}>All AI calls</button>
          </div>
          <div className="row">
            {view === 'all' && <input type="date" aria-label="Day" value={day} max={todayIst()} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />}
            <input type="search" aria-label="Search AI calls" placeholder="Name, number, need…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          </div>
        </div>
        {err && <div className="alert">{err}</div>}
        {!res ? <Skeleton title={false} /> : !res.calls.length ? (
          <Empty message={view === 'callbacks' ? 'No callbacks waiting. When someone asks the AI agent to call them back, it shows up here.' : 'No AI calls yet.'} />
        ) : (
          <div className="table-wrap"><table className="leads">
            <thead><tr><th>{view === 'callbacks' ? 'Call back at' : 'When'}</th><th>Who</th><th>Needs</th><th>Result</th><th>Lead</th><th></th></tr></thead>
            <tbody>{res.calls.map((c) => (
              <tr key={c._id}>
                <td className="nowrap">
                  {view === 'callbacks' ? (c.callbackAt ? when(c.callbackAt) : <span className="muted">No time given</span>) : fmtDateTime(c.startedAt || c.createdAt)}
                  {c.durationSec ? <div className="muted small">{fmtDur(c.durationSec)} · {c.direction === 'inbound' ? 'incoming' : 'outgoing'}</div> : null}
                </td>
                <td className="c-lead"><b>{who(c)}</b><div className="muted small">{c.phone}</div></td>
                <td className="small" style={{ minWidth: 180 }}>{c.requirement || c.summary || <span className="muted">—</span>}</td>
                <td><AiOutcomeBadge c={c} /> <InterestBadge i={c.interest} />{c.callbackRequested && c.handledAt && <div className="muted small">Done by {c.handledBy?.name}</div>}</td>
                <td>{c.lead ? <Link href={`/sales/leads/${c.lead._id}`} className="lead-name">{c.lead.name}</Link> : <span className="muted">—</span>}</td>
                <td><button className="btn sm" onClick={() => setOpen(c._id)}>Open</button></td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </div>
      {open && <AiCallDetail id={open} onClose={() => { setOpen(null); window.history.replaceState(null, '', '/sales?tab=ai'); }} onChanged={load} />}
    </>
  );
}

/** "AI call" on a lead: the agent rings the lead now, after a confirmation that shows the number. */
export function AiCallButton({ lead, onStarted }) {
  const [asking, setAsking] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!lead.phone) return null;
  const go = async () => {
    setBusy(true); setErr('');
    try { await api(`/sales/leads/${lead._id}/ai-call`, { method: 'POST', body: { purpose } }); setAsking(false); onStarted?.(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => setAsking(true)}>AI call</button>
      {asking && (
        <Modal title="Let the AI agent call?" onClose={() => !busy && setAsking(false)}>
          <p style={{ marginTop: 0 }}>The AI agent will call <b>{lead.name}</b> on <b>{lead.phone}</b> now. The call is recorded, and the summary, transcript and any callback request appear here and in the AI Portal.</p>
          <Field label="Reason for the call (optional, the agent uses it)"><input value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. follow up on the website enquiry" /></Field>
          {err && <div className="alert">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Dialling…' : 'Call now'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
