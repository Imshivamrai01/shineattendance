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
const who = (c) => c.callerName || c.contactName || c.company || c.lead?.name || c.phone || 'Unknown caller';

// Sarvam Bulbul v4-flash voices (female first). "enhi" voices are made for English-Hindi mix.
const SARVAM_VOICES = [['simran_enhi_customer', 'Simran: Hinglish, friendly'], ['ishita_enhi_customer', 'Ishita: Hinglish, friendly'],
  ['ritu_hi_customer', 'Ritu: Hindi'], ['simran_hi_assistant', 'Simran: Hindi, assistant'], ['neha_en_customer', 'Neha: Indian English'],
  ['simran_en_customer', 'Simran: Indian English'], ['shubh_enhi_ads', 'Shubh (male): Hinglish']];

const KINDS = [['SALES', 'Sales (creates / updates sales leads)'], ['INTERVIEW', 'Interview invite'], ['FEEDBACK', 'Feedback'], ['OTHER', 'Other']];

/** Call types (Sales, Interview invite, Feedback...) and company info for the agent. */
export function useAgentSetup() {
  const [setup, setSetup] = useState(null);
  const load = useCallback(() => api('/ai/setup').then(setSetup).catch(() => setSetup({ companyInfo: '', scripts: [] })), []);
  useEffect(() => { load(); }, [load]);
  return [setup, load];
}

/** Call type dropdown. `kinds` limits the choices (e.g. no Sales on the CRM page). */
export function ScriptSelect({ scripts, value, onChange, kinds, hint = true }) {
  const list = (scripts || []).filter((x) => x.active !== false && (!kinds || kinds.includes(x.kind)));
  useEffect(() => { if (!value && list[0]) onChange(list[0]._id); }, [value, list, onChange]);
  return (
    <Field label="Call type" hint={hint ? 'What the agent says on this call. Edit it under Agent setup.' : undefined}>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {!list.length && <option value="">Loading…</option>}
        {list.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}
      </select>
    </Field>
  );
}

/** Agent setup: company info + call types, in plain words. Managers can edit; others read. */
export function AgentSetup({ canEdit = true, onSaved }) {
  const [setup, reload] = useAgentSetup();
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const fromSetup = (x) => ({ companyInfo: x.companyInfo, scripts: x.scripts.map((y) => ({ ...y })), transfer: { ...x.transfer }, voice: { ...x.voice }, officeLine: x.officeLine,
    people: Object.fromEntries((x.people || []).map((u) => [u._id, u.aiTransfer])) });
  useEffect(() => { if (setup && !f) setF(fromSetup(setup)); }, [setup, f]);
  if (!f) return <Skeleton title={false} rows={4} />;
  const setScript = (i, k, v) => setF({ ...f, scripts: f.scripts.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api('/ai/setup', { method: 'PUT', body: f });
      setF(fromSetup(r)); reload(); setMsg('Saved. The agent uses this from the next call.'); onSaved?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="ai-setup">
      <Field label="About the company" hint="Services, prices you are happy to share, timings, address, website, answers to common questions. The agent only says what is written here.">
        <textarea rows={7} maxLength={4000} disabled={!canEdit} value={f.companyInfo} onChange={(e) => setF({ ...f, companyInfo: e.target.value })}
          placeholder={'Shine Infosolutions, Noida. We build websites, mobile apps and CRM software for schools, hotels and small businesses.\nWebsites start at ₹15,000. Office hours 10 am to 6 pm, Monday to Saturday.\nAddress: ...'} />
      </Field>
      <h3 style={{ margin: '18px 0 8px' }}>Call types</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Choose one of these when you start AI calls. Write like you would brief a new team member.</p>
      {f.scripts.map((x, i) => (
        <details key={x._id || `new-${i}`} className="card ai-script" open={!x._id}>
          <summary><b>{x.name || 'New call type'}</b> <span className="muted small">· {KINDS.find(([k]) => k === x.kind)?.[1] || x.kind}{x.active === false ? ' · switched off' : ''}</span></summary>
          <div className="form two" style={{ marginTop: 12 }}>
            <Field label="Name"><input value={x.name} maxLength={60} disabled={!canEdit} onChange={(e) => setScript(i, 'name', e.target.value)} /></Field>
            <Field label="Kind"><select value={x.kind} disabled={!canEdit} onChange={(e) => setScript(i, 'kind', e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <Field label="First sentence" hint="{name} = their first name, {company} = company name">
            <input value={x.opening || ''} maxLength={300} disabled={!canEdit} onChange={(e) => setScript(i, 'opening', e.target.value)} />
          </Field>
          <Field label="What to say / how to pitch">
            <textarea rows={4} maxLength={3000} disabled={!canEdit} value={x.instructions || ''} onChange={(e) => setScript(i, 'instructions', e.target.value)} />
          </Field>
          <Field label="What to find out">
            <textarea rows={2} maxLength={600} disabled={!canEdit} value={x.collect || ''} onChange={(e) => setScript(i, 'collect', e.target.value)} />
          </Field>
          <label className="check"><input type="checkbox" disabled={!canEdit} checked={x.active !== false} onChange={(e) => setScript(i, 'active', e.target.checked)} /> Available to choose</label>
        </details>
      ))}
      <h3 style={{ margin: '18px 0 8px' }}>Voice</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Which service speaks for the agent. With Auto it uses Rumik, and if Rumik stops working during a call (no balance, bad key) it switches to Sarvam for the rest of that call, and Admins get a notification. A chosen service also falls back to the other one instead of going silent.</p>
      {f.voice && (
        <div className="form two">
          <Field label="Voice service">
            <select disabled={!canEdit} value={f.voice.provider} onChange={(e) => setF({ ...f, voice: { ...f.voice, provider: e.target.value } })}>
              <option value="auto">Auto: Rumik, Sarvam as backup</option>
              <option value="rumik">Rumik (₹0.50 per 1,000 characters)</option>
              <option value="sarvam">Sarvam Bulbul (₹2 per 1,000 characters)</option>
            </select>
          </Field>
          <Field label="Sarvam voice" hint="Used whenever Sarvam speaks">
            <select disabled={!canEdit} value={f.voice.sarvamSpeaker} onChange={(e) => setF({ ...f, voice: { ...f.voice, sarvamSpeaker: e.target.value } })}>
              {SARVAM_VOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </div>
      )}
      <h3 style={{ margin: '18px 0 8px' }}>Office line for sales calls</h3>
      <label className="check"><input type="checkbox" disabled={!canEdit} checked={f.officeLine !== false} onChange={(e) => setF({ ...f, officeLine: e.target.checked })} /> When someone presses Call on a lead, ring their own phone first and then the lead, from the company number. The call is recorded, transcribed and summarised on the lead.</label>
      <p className="muted small">The first time someone calls, they are asked which mobile to ring (once). Off: the Call button opens the phone&apos;s dialer as before.</p>
      <h3 style={{ margin: '18px 0 8px' }}>Live transfer to a person</h3>
      <p className="muted small" style={{ marginTop: 0 }}>When a caller asks to talk to someone, the agent rings a person below. They get a notification with a one-line summary, then talk to the caller. That conversation is recorded, transcribed and summarised on the call. If nobody picks up, the caller hears that the team will call back, and it becomes a callback.</p>
      {f.transfer && (
        <div className="form two">
          <label className="check"><input type="checkbox" disabled={!canEdit} checked={f.transfer.enabled} onChange={(e) => setF({ ...f, transfer: { ...f.transfer, enabled: e.target.checked } })} /> Allow live transfer</label>
          <label className="check"><input type="checkbox" disabled={!canEdit} checked={f.transfer.needCheckIn} onChange={(e) => setF({ ...f, transfer: { ...f.transfer, needCheckIn: e.target.checked } })} /> Only people checked in right now</label>
          <Field label="How to ring">
            <select disabled={!canEdit} value={f.transfer.mode} onChange={(e) => setF({ ...f, transfer: { ...f.transfer, mode: e.target.value } })}>
              <option value="SEQUENTIAL">One by one (the lead&apos;s owner first)</option>
              <option value="ALL">Everyone at once, first to pick up</option>
            </select>
          </Field>
          <Field label="Ring each for (seconds)"><input type="number" min={10} max={45} disabled={!canEdit} value={f.transfer.ringSec} onChange={(e) => setF({ ...f, transfer: { ...f.transfer, ringSec: e.target.value } })} /></Field>
        </div>
      )}
      {setup?.people && (
        <div className="table-wrap" style={{ marginTop: 8 }}><table>
          <thead><tr><th>Receives transfers</th><th>Person</th><th>Mobile</th></tr></thead>
          <tbody>{setup.people.map((u) => (
            <tr key={u._id} className={u.hasMobile ? '' : 'muted'}>
              <td className="sel"><input type="checkbox" aria-label={`${u.name} receives AI transfers`} disabled={!canEdit || !u.hasMobile} checked={!!f.people?.[u._id]}
                onChange={(e) => setF({ ...f, people: { ...f.people, [u._id]: e.target.checked } })} /></td>
              <td>{u.name} <span className="muted small">{u.role}</span></td>
              <td className="small">{u.hasMobile ? u.mobile : 'No mobile number in profile'}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      {err && <div className="alert">{err}</div>}
      {msg && <div className="alert ok">{msg}</div>}
      {canEdit && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <button className="btn" onClick={() => setF({ ...f, scripts: [...f.scripts, { name: '', kind: 'OTHER', opening: 'Namaste {name} ji! Main {company} se bol rahi hoon.', instructions: '', collect: '', active: true }] })}>Add call type</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
      {!canEdit && <p className="muted small">Only sales managers can change this.</p>}
    </div>
  );
}

const TypeTag = ({ c }) => (c.scriptName ? <div className="muted small">{c.scriptName}</div> : null);

const TX_LABEL = { REQUESTED: ['Finding someone…', 'warn'], RINGING: ['Ringing the team…', 'warn'], CONNECTED: ['Talking to the team', 'ok'],
  ENDED: ['Put through to the team', 'ok'], NO_ANSWER: ['Nobody picked up', 'bad'], FAILED: ['Could not put through', 'bad'] };
export const TransferBadge = ({ t }) => {
  if (!t?.status) return null;
  const [label, tone] = TX_LABEL[t.status] || [t.status, ''];
  return <Badge tone={tone}>{t.toName && ['CONNECTED', 'ENDED'].includes(t.status) ? `Put through to ${t.toName}` : label}</Badge>;
};

/** The part of the call after the caller was put through to a person. */
function TransferPart({ c }) {
  const t = c.transfer;
  return (
    <div className="card ai-transfer" style={{ margin: '12px 0' }}>
      <div className="row between"><h3 style={{ margin: 0 }}>Live transfer</h3><TransferBadge t={t} /></div>
      <dl className="ai-facts" style={{ marginTop: 10 }}>
        {(t.to?.name || t.toName) && <><dt>Picked up by</dt><dd>{t.to?.name || t.toName}</dd></>}
        {t.tried?.length > 0 && <><dt>Rang</dt><dd>{t.tried.join(', ')}</dd></>}
        {t.answeredAt && <><dt>Connected</dt><dd>{fmtDateTime(t.answeredAt)}{t.durationSec ? ` · talked ${fmtDur(Math.round(t.durationSec))}` : ''}</dd></>}
        {t.reason && <><dt>Why</dt><dd>{t.reason}</dd></>}
      </dl>
      {t.summary && <p style={{ marginTop: 0 }}>{t.summary}</p>}
      <h4 className="small muted" style={{ margin: '10px 0 6px' }}>Recording (with the team)</h4>
      {c.hasTransferRecording
        ? <audio controls preload="none" src={`/api/sales/ai-calls/${c._id}/recording?part=transfer`} style={{ width: '100%' }}>Your browser cannot play this recording.</audio>
        : <p className="muted small">{['CONNECTED', 'RINGING', 'REQUESTED'].includes(t.status) ? 'Arrives a minute after the call ends.' : t.status === 'ENDED' ? 'Not ready yet.' : 'No conversation with the team.'}</p>}
      {t.transcript?.length > 0 && (
        <>
          <h4 className="small muted" style={{ margin: '10px 0 6px' }}>Transcript (with the team)</h4>
          <ol className="ai-transcript">
            {t.transcript.map((m, i) => <li key={i} className={m.role === 'customer' ? 'them' : 'agent'}><span className="muted small">{m.role === 'customer' ? 'Customer' : (t.to?.name || t.toName || 'Team')}</span>{m.content}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}

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
            {c.scriptName && <><dt>Call type</dt><dd>{c.scriptName}</dd></>}
            <dt>Phone</dt><dd>{c.phone || '—'}</dd>
            {c.contactName && <><dt>Called</dt><dd>{c.contactName}</dd></>}
            {c.accepted != null && <><dt>Accepted</dt><dd><Badge tone={c.accepted ? 'ok' : 'bad'}>{c.accepted ? 'Yes' : 'No'}</Badge>{c.appointmentAt ? ` · ${fmtDateTime(c.appointmentAt)}` : ''}</dd></>}
            {c.accepted == null && c.appointmentAt && <><dt>Time agreed</dt><dd>{fmtDateTime(c.appointmentAt)}</dd></>}
            {c.rating != null && <><dt>Rating</dt><dd>{c.rating} / 5</dd></>}
            {c.feedback && <><dt>Feedback</dt><dd>{c.feedback}</dd></>}
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
          {c.transfer?.status && <TransferPart c={c} />}
          <h3 className="small muted" style={{ margin: '14px 0 6px' }}>{c.transfer?.status ? 'Recording (AI part)' : 'Recording'}</h3>
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

const VIEWS = [['call', 'Call leads'], ['interested', 'Interested'], ['callbacks', 'Callbacks to do'], ['all', 'All AI calls'], ['setup', 'Agent setup']];
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
  const [setup] = useAgentSetup();
  const [scriptId, setScriptId] = useState('');
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
      const r = await api('/sales/ai-calls/queue', { method: 'POST', body: { leadIds: ids, purpose, scriptId } });
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
      {rows.length > 0 && (
        <div className="row between" style={{ marginBottom: 8 }}>
          <button type="button" className="btn sm" disabled={!pageCallable.length} onClick={() => setSel({ ...sel, ...Object.fromEntries(pageCallable.map((l) => [l._id, !allOn])) })}>
            {allOn ? 'Clear selection' : `Select all ${pageCallable.length}`}
          </button>
          <span className="muted small">{ids.length} selected</span>
        </div>
      )}
      {!res ? <Skeleton title={false} /> : !rows.length ? <Empty message="No leads match these filters." /> : (
        <div className="table-wrap"><table className="leads">
          <thead><tr>
            <th className="sel"><input type="checkbox" aria-label="Select all callable leads on this page" checked={allOn} onChange={() => setSel({ ...sel, ...Object.fromEntries(pageCallable.map((l) => [l._id, !allOn])) })} /></th>
            <th>Lead</th><th>Phone</th><th>Status</th><th>Last call</th>
          </tr></thead>
          <tbody>{rows.map((l) => {
            const ok = callable(l);
            return (
              <tr key={l._id} className={ok ? '' : 'muted'}>
                <td className="sel"><input type="checkbox" aria-label={`Select ${l.name}`} disabled={!ok} checked={!!sel[l._id]} onChange={(e) => setSel({ ...sel, [l._id]: e.target.checked })} /></td>
                <td className="c-lead"><Link href={`/sales/leads/${l._id}`} className="lead-name">{l.name}</Link><div className="muted small">{[l.category, l.area || l.city].filter(Boolean).join(' · ')}</div></td>
                <td className="nowrap">{l.phone || '—'}{!ok && <div className="small">Not a mobile number</div>}</td>
                <td><StatusBadge s={l.status} /></td>
                <td className="small nowrap">{l.lastCallAt ? when(l.lastCallAt) : <span className="muted">Never</span>}</td>
              </tr>);
          })}</tbody>
        </table></div>
      )}
      {res && res.total > rows.length && <p className="muted small">Showing the top {rows.length} of {res.total} by lead quality. Narrow the filters to see others.</p>}
      <div className="ai-callbar">
        <div className="ai-callbar-type"><ScriptSelect scripts={setup?.scripts} value={scriptId} onChange={setScriptId} hint={false} /></div>
        <div className="ai-callbar-reason"><Field label="Reason for the call (optional)">
          <input aria-label="Reason for the call" placeholder="Reason for the call (optional), e.g. follow up on the website enquiry" value={purpose} maxLength={300} onChange={(e) => setPurpose(e.target.value)} />
        </Field></div>
        <button className="btn primary" disabled={!ids.length} onClick={() => setAsking(true)}>{ids.length ? `Call ${ids.length} with AI` : 'Choose leads to call'}</button>
      </div>
      {asking && (
        <Modal title={`Let the AI agent call ${ids.length} lead${ids.length === 1 ? '' : 's'}?`} onClose={() => !busy && setAsking(false)}>
          <p style={{ marginTop: 0 }}>The agent calls them <b>one after another</b>, only between 9:00 am and 8:30 pm, and records every call. You can stop the list at any time.</p>
          <p className="muted small">Each call usually takes 1–3 minutes, so {ids.length} lead{ids.length === 1 ? '' : 's'} take roughly {Math.max(1, Math.round(ids.length * 2))} minutes. Phone charges apply per minute. Leads that asked not to be called, or are closed, are skipped.</p>
          <p className="small">Call type: <b>{setup?.scripts.find((x) => x._id === scriptId)?.name || 'Sales'}</b>{purpose ? <> · Reason given to the agent: <b>{purpose}</b></> : null}</p>
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
          {!['call', 'setup'].includes(view) && (
            <div className="row">
              {view === 'all' && <input type="date" aria-label="Day" value={day} max={todayIst()} onChange={(e) => setDay(e.target.value)} style={{ width: 'auto' }} />}
              <input type="search" aria-label="Search AI calls" placeholder="Name, number, need…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
            </div>
          )}
        </div>
        {view === 'setup' ? <AgentSetup canEdit={d?.role === 'MANAGER'} /> : view === 'call' ? <CallLeads d={d} onQueued={load} /> : (
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
                    <td><AiOutcomeBadge c={c} /> <InterestBadge i={c.interest} /> <TransferBadge t={c.transfer} /><TypeTag c={c} />{c.callbackRequested && c.handledAt && <div className="muted small">Done by {c.handledBy?.name}</div>}</td>
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
  const [setup] = useAgentSetup();
  const [scriptId, setScriptId] = useState('');
  const [asking, setAsking] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!lead.phone) return null;
  const go = async () => {
    setBusy(true); setErr('');
    try { await api(`/sales/leads/${lead._id}/ai-call`, { method: 'POST', body: { purpose, scriptId } }); setAsking(false); onStarted?.(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => setAsking(true)}>AI call</button>
      {asking && (
        <Modal title="Let the AI agent call?" onClose={() => !busy && setAsking(false)}>
          <p style={{ marginTop: 0 }}>The AI agent will call <b>{lead.name}</b> on <b>{lead.phone}</b> now. The call is recorded, and the summary, transcript and any callback request appear here and in the AI Portal.</p>
          <ScriptSelect scripts={setup?.scripts} value={scriptId} onChange={setScriptId} />
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

/** "Name, 98xxxxxxxx" per line; a bare number is fine too. */
function parseContacts(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)[,\t;]\s*(\+?[\d\s()-]{8,})$/.exec(line) || /^(.*?)\s+(\+?[\d\s()-]{8,})$/.exec(line);
    if (m) return { name: m[1].trim(), phone: m[2].trim() };
    return /^\+?[\d\s()-]{8,}$/.test(line) ? { name: '', phone: line } : { name: line, phone: '' };
  });
}
const isMobile = (p) => /^(\+?91|0)?[6-9]\d{9}$/.test(String(p || '').replace(/[\s()-]/g, ''));

/** CRM page, "AI calls": interview invites, feedback and other calls to a pasted list (no sales leads are created). */
export function CrmAiCalls() {
  const [setup, reloadSetup] = useAgentSetup();
  const [scriptId, setScriptId] = useState('');
  const [details, setDetails] = useState('');
  const [pasted, setPasted] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api('/crm/ai-calls').then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useLive(load, 15000);
  const people = parseContacts(pasted);
  const ok = people.filter((x) => isMobile(x.phone));
  const script = setup?.scripts.find((x) => x._id === scriptId);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/crm/ai-calls', { method: 'POST', body: { contacts: ok, scriptId, details } });
      setDone(r); setAsking(false); setPasted(''); load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <>
      {res && !res.connected && <div className="alert warn">The AI calling agent is not connected on this server yet.</div>}
      <QueuePanel queue={res?.queue} onChanged={load} />
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>AI calls</h2><button className="btn sm" onClick={() => setEditing(true)}>Agent setup</button></div>
        <p className="muted small">The AI agent calls each person, one after another between 9:00 am and 8:30 pm, records the call, and writes down the answer (for an interview: coming or not, and when). Nobody is added to Sales.</p>
        <div className="form two">
          <ScriptSelect scripts={setup?.scripts} kinds={['INTERVIEW', 'FEEDBACK', 'OTHER']} value={scriptId} onChange={setScriptId} />
          <Field label="Details for this call" hint={script?.kind === 'INTERVIEW' ? 'Role, date, time and place / link of the interview' : 'Anything the agent should mention on these calls'}>
            <input value={details} maxLength={300} onChange={(e) => setDetails(e.target.value)}
              placeholder={script?.kind === 'INTERVIEW' ? 'Sales executive interview, 25 Oct, 11 am, Sector 62 Noida office' : 'e.g. their order last week'} />
          </Field>
        </div>
        <Field label="People to call" hint="One per line: Name, mobile number">
          <textarea rows={6} value={pasted} onChange={(e) => { setPasted(e.target.value); setDone(null); }} placeholder={'Rahul Sharma, 98xxxxxxxx\nPriya, +91 97xxxxxxxx'} />
        </Field>
        {people.length > 0 && <p className="muted small">{ok.length} ready{people.length > ok.length ? ` · ${people.length - ok.length} without a valid mobile number will be skipped` : ''}</p>}
        {done && (
          <div className="alert ok">{done.queued} added to the call list.{done.skipped?.length > 0 && <div className="small">Skipped: {done.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}</div>}</div>
        )}
        {err && <div className="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={!ok.length || !scriptId} onClick={() => setAsking(true)}>Call {ok.length || ''} with AI</button>
        </div>
      </div>

      <div className="card">
        <h2>Recent AI calls</h2>
        {!res ? <Skeleton title={false} /> : !res.calls.length ? <Empty message="No AI calls from here yet." /> : (
          <div className="table-wrap"><table className="leads">
            <thead><tr><th>When</th><th>Who</th><th>Call type</th><th>Result</th><th></th></tr></thead>
            <tbody>{res.calls.map((c) => (
              <tr key={c._id}>
                <td className="nowrap">{fmtDateTime(c.startedAt || c.createdAt)}{c.durationSec ? <div className="muted small">{fmtDur(c.durationSec)}</div> : null}</td>
                <td className="c-lead"><b>{who(c)}</b><div className="muted small">{c.phone}</div></td>
                <td className="small">{c.scriptName || '—'}</td>
                <td className="small" style={{ minWidth: 180 }}>
                  {c.accepted != null ? <Badge tone={c.accepted ? 'ok' : 'bad'}>{c.accepted ? 'Coming' : 'Not coming'}</Badge> : c.rating ? <Badge>{c.rating}/5</Badge> : <AiOutcomeBadge c={c} />}
                  {c.appointmentAt && <div>{fmtDateTime(c.appointmentAt)}</div>}
                  {c.summary && <div className="muted">{c.summary}</div>}
                </td>
                <td><button className="btn sm" onClick={() => setOpen(c._id)}>Open</button></td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </div>

      {asking && (
        <Modal title={`Let the AI agent call ${ok.length} ${ok.length === 1 ? 'person' : 'people'}?`} onClose={() => !busy && setAsking(false)}>
          <p style={{ marginTop: 0 }}>Call type: <b>{script?.name}</b>{details ? <> · {details}</> : null}</p>
          <p className="muted small">One call at a time, only between 9:00 am and 8:30 pm, every call recorded. Roughly {Math.max(1, ok.length * 2)} minutes in all; phone charges apply per minute. You can stop the list at any time.</p>
          {err && <div className="alert">{err}</div>}
          <div className="row modal-actions">
            <button className="btn" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Adding…' : 'Start calling'}</button>
          </div>
        </Modal>
      )}
      {editing && <Modal title="Agent setup" onClose={() => setEditing(false)}><AgentSetup onSaved={reloadSetup} /></Modal>}
      {open && <AiCallDetail id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}
