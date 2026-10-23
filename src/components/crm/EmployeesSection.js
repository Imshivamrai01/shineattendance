'use client';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, fmtTime, fmtDateTime } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import Icon from '@/components/Icon';
import { Badge, Field, Skeleton } from '@/components/ui';
import { IvrButton } from '@/components/StaffCall';
import WaComposer from './WaComposer';
import History from './History';
import { ChannelTabs, isMobile } from './shared';

const CALL = { IN_PROGRESS: ['Calling…', 'warn'], COMPLETED: ['Talked', 'ok'], NO_ANSWER: ['No answer', 'bad'], FAILED: ['Failed', 'bad'] };

/** Filter chips + search over employees: Not checked in today / Checked in / Everyone. */
function useEmployees() {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('/crm/employees').then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useLive(load, 30000);
  return [res, err, load];
}

function Filters({ res, show, setShow, q, setQ }) {
  const absent = res.employees.filter((e) => !e.checkIn).length;
  return (
    <div className="row between crm-filters">
      <div className="crm-subtabs sm" style={{ margin: 0 }}>
        <button type="button" className={show === 'absent' ? 'on' : ''} onClick={() => setShow('absent')}>Not checked in today <span className="muted">{absent}</span></button>
        <button type="button" className={show === 'in' ? 'on' : ''} onClick={() => setShow('in')}>Checked in <span className="muted">{res.employees.length - absent}</span></button>
        <button type="button" className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>Everyone <span className="muted">{res.employees.length}</span></button>
      </div>
      <input type="search" aria-label="Search employees" placeholder="Search name, ID, department…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
    </div>
  );
}

const LastCall = ({ c }) => (c ? (
  <div className="small"><Badge tone={CALL[c.status]?.[1]}>{c.mode === 'AI' ? 'AI · ' : 'IVR · '}{CALL[c.status]?.[0] || c.status}</Badge> <span className="muted">{fmtDateTime(c.at)}</span>
    {c.reason && <div style={{ marginTop: 3 }}>{c.reason}</div>}</div>
) : <span className="muted small">Not called</span>);

/** Employees section: IVR / AI calls ("why didn't you come in today") and WhatsApp to the team. */
export default function EmployeesSection({ d, loadCrm, channel, setChannel }) {
  const [res, err, load] = useEmployees();
  const [show, setShow] = useState('absent');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [aiErr, setAiErr] = useState('');
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => (res?.employees || []).filter((e) => (show === 'all' || (show === 'absent' ? !e.checkIn : !!e.checkIn))
    && (!needle || `${e.name} ${e.employeeId || ''} ${e.department || ''} ${e.designation || ''}`.toLowerCase().includes(needle))), [res, show, needle]);
  const people = useMemo(() => rows.map((e) => ({ key: e._id, name: e.name, phone: e.mobile || '', sub: [e.employeeId, e.department].filter(Boolean).join(' · '), userId: e._id })), [rows]);
  const callable = rows.filter((e) => isMobile(e.mobile));
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const allOn = callable.length > 0 && callable.every((e) => sel[e._id]);

  const startAi = async () => {
    if (!window.confirm(`Let the AI agent call ${ids.length} ${ids.length === 1 ? 'employee' : 'employees'}? It asks why they did not come in, whether they told anyone, and when they will be back.`)) return;
    setBusy(true); setAiErr('');
    try { setDone(await api('/crm/employees/ai', { method: 'POST', body: { users: ids, purpose: extra } })); setSel({}); load(); } catch (e) { setAiErr(e.message); }
    setBusy(false);
  };

  if (err) return <div className="alert">{err}</div>;
  if (!res) return <Skeleton />;
  const filters = <Filters res={res} show={show} setShow={setShow} q={q} setQ={setQ} />;
  return (
    <>
      <ChannelTabs value={channel} onChange={setChannel} />
      {channel === 'history' && <History section="EMPLOYEE" />}

      {channel === 'ivr' && (
        <div className="card">
          {filters}
          <div className="table-wrap"><table className="leads">
            <thead><tr><th>Employee</th><th>Today</th><th>Last call</th><th></th></tr></thead>
            <tbody>{rows.map((e) => (
              <tr key={e._id}>
                <td className="c-lead"><Link href={`/users/${e._id}`} className="lead-name">{e.name}</Link><div className="muted small">{[e.employeeId, e.designation || e.department, e.mobile].filter(Boolean).join(' · ')}</div></td>
                <td>{e.checkIn ? <Badge tone="ok">In at {fmtTime(e.checkIn)}</Badge> : <Badge tone="bad">Not checked in</Badge>}</td>
                <td style={{ minWidth: 220 }}><LastCall c={e.lastCall} /></td>
                <td className="nowrap"><IvrButton small person={{ _id: e._id, name: e.name }} disabled={!isMobile(e.mobile)} start={() => api(`/users/${e._id}/calls`, { method: 'POST', body: { mode: 'OFFICE' } }).finally(() => setTimeout(load, 1500))} /></td>
              </tr>))}
            </tbody>
          </table></div>
          {!rows.length && <p className="muted" style={{ textAlign: 'center' }}>{show === 'absent' ? 'Everyone has checked in today.' : 'Nobody here.'}</p>}
        </div>
      )}

      {channel === 'ai' && (
        <div className="crm-compose">
          <div className="card crm-compose-main">
            {filters}
            <div className="row between" style={{ marginBottom: 8 }}>
              <button type="button" className="btn sm" disabled={!callable.length} onClick={() => setSel(allOn ? {} : Object.fromEntries(callable.map((e) => [e._id, true])))}>{allOn ? 'Clear' : `Select all ${callable.length}`}</button>
              <span className="muted small">{ids.length} selected</span>
            </div>
            <div className="pick-list" style={{ maxHeight: 440 }}>
              {rows.map((e) => (
                <label key={e._id} className={`check ${isMobile(e.mobile) ? '' : 'off'}`}>
                  <input type="checkbox" disabled={!isMobile(e.mobile)} checked={!!sel[e._id]} onChange={(ev) => setSel({ ...sel, [e._id]: ev.target.checked })} />
                  <span style={{ flex: 1 }}>{e.name} <span className="muted small">{[e.employeeId, e.department, e.mobile || 'no mobile number'].filter(Boolean).join(' · ')}</span>
                    {e.lastCall?.reason && <div className="muted small">Last reason: {e.lastCall.reason}</div>}</span>
                  {e.checkIn ? <Badge tone="ok">In</Badge> : <Badge tone="bad">Absent</Badge>}
                </label>))}
              {!rows.length && <p className="muted small">Nobody here.</p>}
            </div>
          </div>
          <aside className="crm-compose-side">
            <div className="card">
              <h3>What the agent will ask</h3>
              <ul className="crm-asks">
                <li>Why they did not come to the office today</li>
                <li>Whether they told their manager or applied for leave</li>
                <li>When they will be back</li>
              </ul>
              <Field label="Anything else to ask (optional)" hint="The agent asks only about this, politely, and never promises leave.">
                <textarea rows={2} value={extra} maxLength={200} onChange={(e) => setExtra(e.target.value)} placeholder="Also absent yesterday without informing" />
              </Field>
              {aiErr && <div className="alert">{aiErr}</div>}
              {done && <div className="alert ok">{done.queued} added to the AI call list. Answers appear under Last call and in History.{done.skipped?.length ? <div className="small">Skipped: {done.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}</div> : null}</div>}
              <button type="button" className="btn primary" style={{ width: '100%' }} disabled={busy || !ids.length} onClick={startAi}><Icon name="spark" size={15} /> {busy ? 'Adding…' : ids.length ? `Call ${ids.length} with AI` : 'Choose employees'}</button>
            </div>
          </aside>
        </div>
      )}

      {channel === 'whatsapp' && <WaComposer d={d} load={loadCrm} purposes={['WELCOME', 'BULK', 'TASK', 'ABSENT']} people={people} peopleLabel="employees" toolbar={filters} />}
    </>
  );
}
