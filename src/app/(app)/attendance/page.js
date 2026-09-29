'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtTime, toLocalInput } from '@/lib/client';
import { minutesText } from '@/lib/hours';
import { useMe } from '@/components/Shell';
import { Badge, ConfirmModal, Empty, Field, Modal, statusTone, Skeleton } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function CorrectionModal({ rec, session, onClose, onDone, mode }) {
  const [ci, setCi] = useState(toLocalInput(session?.checkIn));
  const [co, setCo] = useState(toLocalInput(session?.checkOut));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    const times = { checkIn: ci ? new Date(ci).toISOString() : undefined, checkOut: co ? new Date(co).toISOString() : undefined };
    try {
      if (mode === 'direct') await api(`/attendance/${rec._id}`, { method: 'PATCH', body: { sessionId: session?._id, ...times, reason } });
      else await api('/requests', { method: 'POST', body: { type: 'ATTENDANCE_CORRECTION', subjectId: rec.user._id, payload: { attendanceId: rec._id, sessionId: session?._id, ...times }, reason } });
      onDone(mode === 'direct' ? 'Correction saved and audited.' : 'Correction request submitted.');
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <Modal title={`${session ? 'Correct session' : 'Add session'} · ${rec.user?.name} · ${rec.date}`} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="alert">{err}</div>}
        <div className="form">
          <Field label="Check-in"><input type="datetime-local" value={ci} onChange={(e) => setCi(e.target.value)} /></Field>
          <Field label="Check-out"><input type="datetime-local" value={co} onChange={(e) => setCo(e.target.value)} /></Field>
          <Field label="Reason (required)" span><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || reason.trim().length < 5}>{mode === 'direct' ? 'Save correction' : 'Submit request'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Attendance() {
  const me = useMe();
  const [from, setFrom] = useState(ago(29));
  const [to, setTo] = useState(today());
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [modal, setModal] = useState(null);
  const [role, setRole] = useState('');
  const [person, setPerson] = useState('');
  const [people, setPeople] = useState([]);
  useEffect(() => { if (me.role !== 'EMPLOYEE') api('/users?limit=500').then((d) => setPeople(d.items)).catch(() => {}); }, [me.role]);
  const qs = `from=${from}&to=${to}${role ? `&role=${role}` : ''}${person ? `&userId=${person}` : ''}`;
  const load = useCallback(() => api(`/attendance?${qs}`).then((d) => setItems(d.items)).catch((e) => setErr(e.message)), [qs]);
  useEffect(() => { load(); }, [load]);
  const done = (m) => { setModal(null); if (m) setNote(m); load(); };
  const direct = ['ADMIN', 'COO', 'MANAGER'].includes(me.role);
  const canReq = me.role === 'EMPLOYEE' || me.role === 'HR';
  const exportCsv = async () => {
    const res = await api(`/reports/attendance?${qs}`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'attendance.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <h1>Attendance</h1>
        {me.role !== 'EMPLOYEE' && <button className="btn" onClick={exportCsv}>Export CSV</button>}
      </div>
      <div className="card row">
        <div><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        {me.role !== 'EMPLOYEE' && <>
          <div><label>Role</label><select value={role} onChange={(e) => { setRole(e.target.value); setPerson(''); }}>
            <option value="">All roles</option>{['COO', 'MANAGER', 'HR', 'EMPLOYEE'].map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
          <div><label>Person</label><select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Everyone</option>{people.filter((p) => !role || p.role === role).map((p) => <option key={p._id} value={p._id}>{p.name} ({p.employeeId})</option>)}</select></div>
        </>}
        <div className="row" style={{ alignSelf: 'end' }}>
          <button className="btn sm" onClick={() => { setFrom(today()); setTo(today()); }}>Today</button>
          <button className="btn sm" onClick={() => { setFrom(today().slice(0, 8) + '01'); setTo(today()); }}>This month</button>
          <button className="btn sm" onClick={() => { const d = new Date(); d.setDate(0); const e = d.toISOString().slice(0, 10); setFrom(e.slice(0, 8) + '01'); setTo(e); }}>Last month</button>
        </div>
      </div>
      {err && <div className="alert">{err}</div>}
      {note && <div className="alert ok">{note}</div>}
      <div className="card scroll">
        {!items ? <Skeleton /> : items.length === 0 ? <Empty message="No attendance records in this period." /> : (
          <table>
            <thead><tr><th>Date</th><th>Employee</th><th>Sessions</th><th>Hours</th><th>Status</th><th /></tr></thead>
            <tbody>{items.map((r) => (
              <tr key={r._id} style={r.status === 'VOIDED' ? { opacity: 0.65 } : undefined}>
                <td>{r.date}</td>
                <td>{me.role !== 'EMPLOYEE' ? <Link href={`/users/${r.user?._id}`}>{r.user?.name}</Link> : r.user?.name}<div className="muted small">{r.user?.employeeId}</div></td>
                <td>{r.sessions.map((s) => (
                  <div key={s._id} className="row" style={{ gap: 6 }}>
                    {s.inPhotoUrl && <a href={s.inPhotoUrl} target="_blank" rel="noreferrer" title="Check-in photo"><img className="thumb" src={s.inPhotoUrl} alt="Check-in" /></a>}
                    <span>{fmtTime(s.checkIn)} – {fmtTime(s.checkOut)}</span>
                    {s.outPhotoUrl && <a href={s.outPhotoUrl} target="_blank" rel="noreferrer" title="Check-out photo"><img className="thumb" src={s.outPhotoUrl} alt="Check-out" /></a>}
                    {s.corrected && <Badge tone="warn">corrected</Badge>}
                    {s.autoCheckout && <Badge tone="warn">auto check-out</Badge>}
                    {s.inGeo?.verified === false && <Badge tone="bad">outside</Badge>}
                    {r.status === 'ACTIVE' && (direct || canReq) && (
                      <button className="btn sm" onClick={() => setModal({ kind: 'fix', rec: r, session: s })}>{direct ? 'Correct' : 'Request fix'}</button>)}
                  </div>))}</td>
                <td>{r.hours}</td>
                <td><Badge tone={statusTone(r.status)}>{r.status}</Badge>{r.flags?.late && <> <Badge tone="warn">Late {minutesText(r.flags.lateMinutes)}</Badge></>}{r.flags?.early && <> <Badge tone="warn">Left early</Badge></>}{r.voidReason && <div className="muted small">{r.voidReason}</div>}</td>
                <td>
                  {r.status === 'ACTIVE' && direct && <button className="btn sm" onClick={() => setModal({ kind: 'add', rec: r })}>+ Session</button>}{' '}
                  {r.status === 'ACTIVE' && me.role === 'ADMIN' && <button className="btn sm danger" onClick={() => setModal({ kind: 'void', rec: r })}>Void</button>}
                </td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {(modal?.kind === 'fix' || modal?.kind === 'add') && (
        <CorrectionModal rec={modal.rec} session={modal.session} mode={direct ? 'direct' : 'request'} onClose={() => setModal(null)} onDone={done} />)}
      {modal?.kind === 'void' && (
        <ConfirmModal title="Void attendance record" danger confirmLabel="Void record"
          details={[['Employee', modal.rec.user?.name], ['Employee ID', modal.rec.user?.employeeId || '—'], ['Record type', `Attendance ${modal.rec.date}`]]}
          consequence="The record is marked VOIDED and excluded from totals. The original data and your reason stay visible; nothing is destroyed."
          onConfirm={(reason) => api(`/attendance/${modal.rec._id}`, { method: 'DELETE', body: { reason } })}
          onClose={(ok) => done(ok ? 'Record voided.' : '')} />)}
    </>
  );
}
