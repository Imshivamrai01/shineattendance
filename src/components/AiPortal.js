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
  const [label, tone] = AI_OUTCOME[k] || [{ QUEUED: 'Dialling…', IN_PROGRESS: 'On the call', SCHEDULED: 'On the call list', CANCELLED: 'Removed from list' }[k] || k || '—', k === 'IN_PROGRESS' || k === 'QUEUED' ? 'warn' : ''];
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

const VIEWS = [['call', 'Call leads'], ['interested', 'Interested'], ['callbacks', 'Callbacks to do'], ['all', 'All AI calls']];
const STATUS_OPTIONS = [['', 'Open leads'], ['NEW', 'New'], ['CONTACTED', 'Contacted'], ['FOLLOW_UP', 'Follow-up'], ['INTERESTED', 'Interested']];

/** Who the agent is calling now and who is next, with a Stop button. */
function QueuePanel({ queue, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!queue || (!queue.scheduled && !queue.active)) return null;
  const stop = async () => {
    if (!window.confirm(`Take the ${queue.scheduled} waiting call(s) off the list? A call already ringing will finish.`)) return;
    setBusy(true);
    try { await api('/sales/ai-calls/queue', { method: 'DELETE' }); onChanged(); } catch (e) { window.alert(e.message); }
    setBusy(false);
  };
  return (
    <div className={`alert ${queue.callingHours ? 'ok' : 'warn'}`} role="status">
      <div className="row between">
        <div>
          {queue.active ? <b>Calling {queue.active.name || queue.active.phone} now…</b> : <b>{queue.callingHours ? 'Starting the next call…' : 'Waiting for calling hours (9:00 am – 8:30 pm)'}</b>}
          <div className="small">{queue.scheduled} waiting{queue.next.length ? `: ${queue.next.map((n) => n.name || n.phone).join(', ')}${queue.scheduled > queue.next.length ? '…' : ''}` : ''}. One call at a time.</div>
        </div>
        {queue.scheduled > 0 && <button className="btn sm" disabled={busy} onClick={stop}>Stop the list</button>}
      </div>
    </div>
  );
}

/** Pick leads and hand them to the AI agent. */
function CallLeads({ d, onQueued }) {
  const [f, setF] = useState({ q: '', status: '', grade: '', category: '', called: '' });
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({});
  const [purpose, setPurpose] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const query = qs({ ...f, open: f.status ? '' : '1', sort: 'score' });
  const load = useCallback(() => api(`/sales/leads?${query}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [query]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const callable = (l) => /^(\+?91|0)?[6-9]\d{9}$/.test(String(l.phone || '').replace(/[\s()-]/g, ''));
  const rows = res?.leads || [];
  const pageCallable = rows.filter(callable);
  const allOn = pageCallable.length > 0 && pageCallable.every((l) => sel[l._id]);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/sales/ai-calls/queue', { method: 'POST', body: { leadIds: ids, purpose } });
      setDone(r); setSel({}); setAsking(false); onQueued();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>Choose leads and the AI agent calls them one after another (9:00 am – 8:30 pm). Each call is recorded. Anyone interested or asking for a callback shows up under Interested / Callbacks to do, on the lead, and in the sheet.</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" aria-label="Search leads" placeholder="Search name, number, area…" value={f.q} onChange={set('q')} style={{ width: 220 }} />
        <select aria-label="Status" value={f.status} onChange={set('status')} style={{ width: 'auto' }}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select aria-label="Quality" value={f.grade} onChange={set('grade')} style={{ width: 'auto' }}><option value="">Any quality</option><option value="HOT">Hot</option><option value="WARM">Warm</option><option value="COLD">Cold</option></select>
        {d?.categories?.length > 0 && <select aria-label="Category" value={f.category} onChange={set('category')} style={{ width: 'auto' }}><option value="">All categories</option>{d.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
        <select aria-label="Called before" value={f.called} onChange={set('called')} style={{ width: 'auto' }}><option value="">Called or not</option><option value="0">Never called</option><option value="1">Called before</option></select>
      </div>
      {done && (
        <div className="alert ok">
          {done.queued} lead{done.queued === 1 ? '' : 's'} added to the call list.
          {done.skipped?.length > 0 && <div className="small">Skipped: {done.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}</div>}
        </div>
      )}
      {err && <div className="alert">{err}</div>}
      {!res ? <Skeleton title={false} /> : !rows.length ? <Empty message="No leads match these filters." /> : (
        <div className="table-wrap"><table className="leads">
          <thead><tr>
            <th><input type="checkbox" aria-label="Select all callable leads on this page" checked={allOn} onChange={() => setSel({ ...sel, ...Object.fromEntries(pageCallable.map((l) => [l._id, !allOn])) })} /></th>
            <th>Lead</th><th>Phone</th><th>Status</th><th>Last call</th>
          </tr></thead>
          <tbody>{rows.map((l) => {
            const ok = callable(l);
            return (
              <tr key={l._id} className={ok ? '' : 'muted'}>
                <td><input type="checkbox" aria-label={`Select ${l.name}`} disabled={!ok} checked={!!sel[l._id]} onChange={(e) => setSel({ ...sel, [l._id]: e.target.checked })} /></td>
                <td className="c-lead"><Link href={`/sales/leads/${l._id}`} className="lead-name">{l.name}</Link><div className="muted small">{[l.category, l.area || l.city].filter(Boolean).join(' · ')}</div></td>
                <td className="nowrap">{l.phone || '—'}{!ok && <div className="small">Not a mobile number</div>}</td>
                <td><StatusBadge s={l.status} /></td>
                <td className="small nowrap">{l.lastCallAt ? when(l.lastCallAt) : <span className="muted">Never</span>}</td>
              </tr>);
          })}</tbody>
        </table></div>
      )}
      {res && res.total > rows.length && <p className="muted small">Showing the top {rows.length} of {res.total} by lead quality. Narrow the filters to see others.</p>}
      <div className="row" style={{ marginTop: 12, position: 'sticky', bottom: 8 }}>
        <input aria-label="Reason for the call" placeholder="Reason for the call (optional, the agent uses it)" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn primary" disabled={!ids.length} onClick={() => setAsking(true)}>Call {ids.length || ''} with AI</button>
      </div>
      {asking && (
        <Modal title={`Let the AI agent call ${ids.length} lead${ids.length === 1 ? '' : 's'}?`} onClose={() => !busy && setAsking(false)}>
          <p style={{ marginTop: 0 }}>The agent calls them <b>one after another</b>, only between 9:00 am and 8:30 pm, and records every call. You can stop the list at any time.</p>
          <p className="muted small">Each call usually takes 1–3 minutes, so {ids.length} lead{ids.length === 1 ? '' : 's'} take roughly {Math.max(1, Math.round(ids.length * 2))} minutes. Phone charges apply per minute. Leads that asked not to be called, or are closed, are skipped.</p>
          {purpose && <p className="small">Reason given to the agent: <b>{purpose}</b></p>}
          {err && <div className="alert">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Adding…' : 'Start calling'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Sales tab "AI Portal". `d` is the Sales overview (categories for the lead filters). */
export function AiPortal({ d }) {
  const [view, setView] = useState('call');
  const [day, setDay] = useState('');
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  const listView = view === 'call' ? '' : view;
  const load = useCallback(() => api(`/sales/ai-calls?${qs({ view: ['callbacks', 'interested'].includes(listView) ? listView : '', day: view === 'all' ? day : '', q: view === 'call' ? '' : q })}`)
    .then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [view, listView, day, q]);
  useLive(load, 15000);
  // Deep link from the sheet / notification: /sales?tab=ai&call=<id>
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('call'); if (id) { setView('all'); setOpen(id); } }, []);

  const t = res?.today;
  const empty = { interested: 'Nobody interested yet. Leads the agent finds interested, or who ask for a callback, show up here.',
    callbacks: 'No callbacks waiting. When someone asks the AI agent to call them back, it shows up here.', all: 'No AI calls yet.' }[view];
  return (
    <>
      {res && !res.connected && <div className="alert warn">The AI calling agent is not connected on this server yet (VOICE_API_URL / AI_WEBHOOK_SECRET). Calls will not be placed or recorded.</div>}
      {t && (
        <div className="sales-stats">
          <button className="stat stat-btn" onClick={() => setView('interested')}><span className="muted small">Interested today</span><b>{t.interested}</b><span className="muted small">from AI calls</span></button>
          <button className="stat stat-btn" onClick={() => setView('callbacks')}><span className="muted small">Callbacks to do</span><b>{res.openCallbacks}</b><span className="muted small">asked for on AI calls</span></button>
          <button className="stat stat-btn" onClick={() => { setView('all'); setDay(todayIst()); }}><span className="muted small">AI calls today</span><b>{t.total}</b><span className="muted small">{t.talked} conversations · {t.optOuts} do-not-call</span></button>
        </div>
      )}
      <QueuePanel queue={res?.queue} onChanged={load} />
      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <div className="tabs" style={{ margin: 0 }}>
            {VIEWS.map(([k, label]) => (
              <button key={k} className={`btn sm ${view === k ? 'primary' : ''}`} onClick={() => setView(k)}>
                {label}{k === 'callbacks' && res?.openCallbacks ? ` (${res.openCallbacks})` : ''}
              </button>))}
          </div>
          {view !== 'call' && (
            <div className="row">
              {view === 'all' && <input type="date" aria-label="Day" value={day} max={todayIst()} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />}
              <input type="search" aria-label="Search AI calls" placeholder="Name, number, need…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
            </div>
          )}
        </div>
        {view === 'call' ? <CallLeads d={d} onQueued={load} /> : (
          <>
            {err && <div className="alert">{err}</div>}
            {!res ? <Skeleton title={false} /> : !res.calls.length ? <Empty message={empty} /> : (
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
                    <td>{c.lead ? <><Link href={`/sales/leads/${c.lead._id}`} className="lead-name">{c.lead.name}</Link><div><StatusBadge s={c.lead.status} /></div></> : <span className="muted">—</span>}</td>
                    <td><button className="btn sm" onClick={() => setOpen(c._id)}>Open</button></td>
                  </tr>))}
                </tbody>
              </table></div>
            )}
          </>
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
