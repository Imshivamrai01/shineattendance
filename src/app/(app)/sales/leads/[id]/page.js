'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, fmtDateTime, toLocalInput } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import { useMe } from '@/components/Shell';
import { Field, Skeleton } from '@/components/ui';
import { STATUS, OUTCOMES, StatusBadge, GradeBadge, RepeatBadge, OutcomeBadge, when, LeadForm } from '@/components/SalesBits';
import { CallButton, ContactLinks, PendingCalls, useCall, fmtDur } from '@/components/SalesCall';
import { AiCallButton, AiCallDetail } from '@/components/AiPortal';

const at11 = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(11, 0, 0, 0); return toLocalInput(d); };
const QUICK = [['In 2 hours', () => toLocalInput(new Date(Date.now() + 2 * 3600000))], ['Tomorrow', () => at11(1)], ['In 3 days', () => at11(3)], ['Next week', () => at11(7)]];

// For calls made from another phone, notes, and follow-ups without a call. Calls from this app use the Call button.
function LogForm({ lead, onSaved }) {
  const [f, setF] = useState({ outcome: '', note: '', followUpAt: '', status: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (type) => {
    setBusy(true); setErr('');
    try {
      await api(`/sales/leads/${lead._id}/activity`, { method: 'POST', body: {
        type, outcome: f.outcome, note: f.note, status: f.status || undefined, followUpAt: f.followUpAt ? new Date(f.followUpAt).toISOString() : undefined,
      } });
      setF({ outcome: '', note: '', followUpAt: '', status: '' });
      onSaved();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <details className="card">
      <summary><b>Add a note, follow-up or a call made from another phone</b></summary>
      <div style={{ marginTop: 12 }}>
        <label>Call result (only if you called from another phone)</label>
        <div className="chips">
          {Object.entries(OUTCOMES).map(([k, l]) => (
            <button key={k} type="button" className={`btn sm ${f.outcome === k ? 'primary' : ''}`} onClick={() => setF({ ...f, outcome: f.outcome === k ? '' : k })}>{l}</button>))}
        </div>
        <div className="form two" style={{ marginTop: 12 }}>
          <Field label="Note" span><textarea rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Owner wants a demo next week, budget around…" /></Field>
          <Field label="Next follow-up">
            <input type="datetime-local" value={f.followUpAt} onChange={(e) => setF({ ...f, followUpAt: e.target.value })} />
            <div className="chips" style={{ marginTop: 6 }}>{QUICK.map(([l, fn]) => <button key={l} type="button" className="btn sm" onClick={() => setF({ ...f, followUpAt: fn() })}>{l}</button>)}</div>
          </Field>
          <Field label="Status">
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">Automatic (now {STATUS[lead.status]?.[0]})</option>
              {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        </div>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {f.outcome ? <button className="btn primary" disabled={busy} onClick={() => save('CALL')}>{busy ? 'Saving…' : 'Save call'}</button> : <>
            <button className="btn" disabled={busy || !f.followUpAt} onClick={() => save('FOLLOW_UP')}>Set follow-up</button>
            <button className="btn primary" disabled={busy || !f.note.trim()} onClick={() => save('NOTE')}>Save note</button>
          </>}
        </div>
      </div>
    </details>
  );
}

function Timeline({ lead, activity, names, me }) {
  const start = useCall();
  const [aiCall, setAiCall] = useState(null);
  const who = (id) => (id ? names[id] || 'someone' : 'nobody');
  const line = (a) => {
    const by = <b>{a.by?.name || 'System'}</b>;
    switch (a.type) {
      case 'AI_CALL': return <><b>AI agent</b> {a.durationSec ? 'talked' : 'called'} <OutcomeBadge o={a.outcome} />{a.durationSec ? <span className="muted small"> · {fmtDur(Math.round(a.durationSec))}</span> : null}{a.aiCall && <> · <button className="linkish" onClick={() => setAiCall(a.aiCall)}>transcript &amp; recording</button></>}</>;
      case 'CALL': return <>{by} called <OutcomeBadge o={a.outcome} />{a.durationSec ? <span className="muted small"> · {fmtDur(a.durationSec)}</span> : null}{!a.viaApp && <span className="muted small"> · other phone</span>}</>;
      case 'FOLLOW_UP': return a.followUpAt ? <>{by} set a follow-up for <b>{when(a.followUpAt)}</b></> : <>{by} cleared the follow-up</>;
      case 'STATUS': return <>{by} changed status <StatusBadge s={a.from} /> → <StatusBadge s={a.to} /></>;
      case 'ASSIGN': return <>{by} handed it from <b>{who(a.from)}</b> to <b>{who(a.to)}</b></>;
      case 'NOTE': return <>{by} added a note</>;
      case 'CREATED': return <>{by} added the lead{a.to ? <> for <b>{who(a.to)}</b></> : null}</>;
      case 'FOUND_AGAIN': return <>Found again <span className="badge repeat">Repeat</span></>;
      case 'EDIT': return <>{by} edited the details</>;
      default: return a.type;
    }
  };
  return (
    <div className="card">
      <h2>History</h2>
      {!activity.length && <p className="muted">Nothing yet.</p>}
      <ol className="timeline">
        {activity.map((a) => (
          <li key={a._id} className={`tl-${a.type.toLowerCase()}`}>
            <div className="tl-head"><span>{line(a)}</span><span className="muted small nowrap">{when(a.createdAt)}</span></div>
            {(a.type === 'CALL' || a.type === 'AI_CALL') && (a.to || a.followUpAt) && (
              <div className="muted small">{a.to && <>Status → {STATUS[a.to]?.[0]}</>}{a.to && a.followUpAt && ' · '}{a.followUpAt && <>Next follow-up {when(a.followUpAt)}</>}</div>)}
            {a.note && a.type !== 'EDIT' && <div className="tl-note">{a.note}</div>}
            {a.type === 'EDIT' && <div className="muted small">{a.note}</div>}
            {a.outcome === 'PENDING' && String(a.by?._id) === String(me._id) && (
              <button className="btn sm primary" style={{ marginTop: 6 }} onClick={() => start(lead, a)}>Fill in what happened</button>)}
          </li>))}
      </ol>
      {aiCall && <AiCallDetail id={aiCall} onClose={() => setAiCall(null)} />}
    </div>
  );
}

export default function LeadPage() {
  const { id } = useParams();
  const me = useMe();
  const [d, setD] = useState(null);
  const [overview, setOverview] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => Promise.all([api(`/sales/leads/${id}`), api('/sales')]).then(([a, b]) => { setD(a); setOverview(b); setErr(''); }).catch((e) => setErr(e.message)), [id]);
  useLive(load, 30000);
  if (err && !d) return <><Link href="/sales?tab=leads">← Leads</Link><div className="alert" style={{ marginTop: 12 }}>{err}</div></>;
  if (!d || !overview) return <Skeleton />;
  const l = d.lead;
  const manager = overview.role === 'MANAGER';
  const pending = d.activity.filter((a) => a.type === 'CALL' && a.outcome === 'PENDING' && String(a.by?._id) === String(me._id)).map((a) => ({ ...a, lead: l }));
  const patch = async (body, ok) => {
    setMsg('');
    try { await api(`/sales/leads/${l._id}`, { method: 'PATCH', body }); setMsg(ok); load(); } catch (e) { setMsg(e.message); }
  };

  return (
    <>
      <Link href="/sales?tab=leads" className="small">← Leads</Link>
      <div className="lead-top">
        <div style={{ minWidth: 0 }}>
          <h1>{l.name}</h1>
          <div className="lead-tags"><GradeBadge g={l.grade} score={l.score} /><StatusBadge s={l.status} /><RepeatBadge n={l.timesFound} />
            <span className="muted small">{[l.category, l.area, l.city].filter(Boolean).join(' · ')}</span></div>
        </div>
        <button className="btn" onClick={() => setEditing(true)}>Edit</button>
      </div>
      <PendingCalls pending={pending} />
      {msg && <div className="alert ok">{msg}</div>}

      <div className="card call-card">
        <CallButton lead={l} big />
        <AiCallButton lead={l} onStarted={() => { setMsg('The AI agent is calling now. The result shows up here when the call ends.'); load(); }} />
        <ContactLinks lead={l} labels />
        <div className="call-card-info">
          {l.callCount ? <>Last call: <b>{l.lastCallBy?.name}</b> · <OutcomeBadge o={l.lastOutcome} /> · {when(l.lastCallAt)} · {l.callCount} call{l.callCount > 1 ? 's' : ''} ({l.connectedCount || 0} talked)</> : 'Not called yet'}
          {l.nextFollowUpAt && <> · Next follow-up <b className={new Date(l.nextFollowUpAt) < new Date() ? 'overdue' : ''}>{when(l.nextFollowUpAt)}</b></>}
        </div>
      </div>

      <div className="lead-grid">
        <div>
          <div className="card">
            <h2>Details</h2>
            <table className="kv"><tbody>
              <tr><td className="muted">Address</td><td>{l.address || '—'}</td></tr>
              <tr><td className="muted">Instagram</td><td>{l.instagram ? <a href={l.instagram} target="_blank" rel="noreferrer">{l.instagram.replace(/^https:\/\/instagram\.com\//, '@')}</a> : '—'}</td></tr>
              {l.website && <tr><td className="muted">Website</td><td><a href={/^https?:/i.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer">{l.website}</a></td></tr>}
              {l.email && <tr><td className="muted">Email</td><td><a href={`mailto:${l.email}`}>{l.email}</a></td></tr>}
              {l.rating ? <tr><td className="muted">Rating</td><td>★ {l.rating} · {l.reviews || 0} reviews</td></tr> : null}
              {l.altPhones?.length > 0 && <tr><td className="muted">Other numbers</td><td>{l.altPhones.join(', ')}</td></tr>}
              <tr><td className="muted">Found</td><td>{l.timesFound}× · first {fmtDateTime(l.firstFoundAt || l.createdAt)}
                <div className="muted small">{l.source === 'GOOGLE' ? 'Google Maps' : l.source === 'OSM' ? 'OpenStreetMap' : 'Added by hand'}{l.createdBy?.name ? ` · by ${l.createdBy.name}` : ''}</div></td></tr>
              {l.notes && <tr><td className="muted">Notes</td><td style={{ whiteSpace: 'pre-wrap' }}>{l.notes}</td></tr>}
            </tbody></table>
          </div>

          <div className="card">
            <h2>Handling</h2>
            <div className="form two">
              <Field label="Status">
                <select value={l.status} onChange={(e) => patch({ status: e.target.value }, 'Status changed.')}>
                  {Object.entries(STATUS).map(([k, [lab]]) => <option key={k} value={k}>{lab}</option>)}
                </select>
              </Field>
              <Field label="Handled by">
                {manager ? (
                  <select value={l.assignedTo?._id || ''} onChange={(e) => patch({ assignedTo: e.target.value || null }, 'Lead handed over.')}>
                    <option value="">Nobody</option>{overview.team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
                  </select>
                ) : <div className="field-text">{l.assignedTo?.name || 'Nobody'}</div>}
              </Field>
            </div>
            {l.nextFollowUpAt && <div className="row" style={{ marginTop: 12 }}><span className="muted small">Follow-up {when(l.nextFollowUpAt)}</span><button className="btn sm" onClick={() => patch({ nextFollowUpAt: null }, 'Follow-up cleared.')}>Clear follow-up</button></div>}
          </div>

          <details className="card">
            <summary><b>Lead quality</b> <GradeBadge g={l.grade} score={l.score} /> <span className="muted small">· why this score</span></summary>
            <ul className="small" style={{ margin: '10px 0 0', paddingLeft: 18 }}>{(l.scoreNotes || []).map((n) => <li key={n}>{n}</li>)}</ul>
          </details>
        </div>

        <div>
          <LogForm lead={l} onSaved={() => { setMsg('Saved.'); load(); }} />
          <Timeline lead={l} activity={d.activity} names={d.names} me={me} />
        </div>
      </div>

      {editing && <LeadForm lead={l} team={overview.team} manager={manager} onClose={() => setEditing(false)} onDone={() => { setEditing(false); setMsg('Details saved.'); load(); }} />}
    </>
  );
}
