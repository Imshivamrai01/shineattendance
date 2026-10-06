'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLive } from '@/lib/useLive';
import { api, fmtTime, toLocalInput } from '@/lib/client';
import { minutesText } from '@/lib/hours';
import { useMe } from '@/components/Shell';
import { Badge, ConfirmModal, Empty, Field, Modal, Skeleton } from '@/components/ui';
import Avatar from '@/components/Avatar';

const today = () => new Date().toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
const hoursText = (h) => (h ? `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m` : '—');

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
  const load = useCallback(() => api(`/attendance?${qs}`).then((d) => { setItems(d.items); setErr(''); }).catch((e) => setErr(e.message)), [qs]);
  useLive(load, 20000);
  const done = (m) => { setModal(null); if (m) setNote(m); load(); };
  const staff = me.role !== 'EMPLOYEE';
  // Tapping a name shows that person's attendance for this month.
  const showPerson = (id) => { setRole(''); setPerson(id); setFrom(today().slice(0, 8) + '01'); setTo(today()); window.scrollTo({ top: 0 }); };
  const selected = person ? (items?.find((r) => r.user?._id === person)?.user || people.find((p) => p._id === person)) : null;
  const active = (items || []).filter((r) => r.status === 'ACTIVE');
  const totals = { days: active.length, hours: Math.round(active.reduce((a, r) => a + r.hours, 0) * 100) / 100, late: active.filter((r) => r.flags?.late).length };
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
      {selected && (
        <div className="card att-person">
          <Avatar user={selected} size={52} />
          <div className="att-person-info">
            <b>{selected.name}</b>
            <div className="muted small">{[selected.employeeId, selected.designation || selected.role].filter(Boolean).join(' · ')}</div>
            <div className="muted small">{totals.days} day{totals.days === 1 ? '' : 's'} · {hoursText(totals.hours)}{totals.late ? ` · ${totals.late} late` : ''}</div>
          </div>
          <div className="att-person-actions">
            <Link className="btn sm" href={`/users/${selected._id}`}>Profile</Link>
            <button className="btn sm" onClick={() => setPerson('')}>Everyone</button>
          </div>
        </div>
      )}
      {!items ? <div className="card"><Skeleton /></div> : items.length === 0 ? <div className="card"><Empty message="No attendance records in this period." /></div> : (
        <div className="att-list">
          {items.map((r) => (
            <div key={r._id} className={`att-card ${r.status === 'VOIDED' ? 'voided' : ''}`}>
              <div className="att-head">
                <Avatar user={r.user} size={42} />
                <div className="att-who">
                  {staff && !person
                    ? <button type="button" className="att-name" onClick={() => showPerson(r.user?._id)}>{r.user?.name}</button>
                    : <span className="att-name">{r.user?.name}</span>}
                  <div className="muted small">{dayLabel(r.date)}{r.user?.employeeId ? ` · ${r.user.employeeId}` : ''}</div>
                </div>
                <div className="att-hours"><b>{hoursText(r.hours)}</b><span className="muted small">{r.sessions.some((x) => !x.checkOut) ? 'so far' : 'worked'}</span></div>
              </div>
              <div className="row att-tags">
                {r.status === 'VOIDED' ? <Badge tone="bad">Voided</Badge> : <Badge tone="ok">Present</Badge>}
                {r.flags?.late && <Badge tone="warn">Late {minutesText(r.flags.lateMinutes)}</Badge>}
                {r.flags?.early && <Badge tone="warn">Left early</Badge>}
                {r.location?.name && <span className="muted small">{r.location.name}</span>}
              </div>
              {r.voidReason && <div className="muted small" style={{ marginTop: 6 }}>Reason: {r.voidReason}</div>}
              <div className="att-sessions">
                {r.sessions.map((s) => (
                  <div key={s._id} className="att-session">
                    {s.inPhotoUrl ? <a href={s.inPhotoUrl} target="_blank" rel="noreferrer" title="Check-in photo"><img className="thumb" src={s.inPhotoUrl} alt="Check-in" /></a> : null}
                    <div className="att-times">
                      <div><b>{fmtTime(s.checkIn)}</b> <span className="muted">→</span> <b>{s.checkOut ? fmtTime(s.checkOut) : 'in office'}</b></div>
                      <div className="row att-flags">
                        {s.corrected && <Badge tone="warn">corrected</Badge>}
                        {s.autoCheckout && <Badge tone="warn">left office</Badge>}
                        {s.endOfDay && <Badge>office closed</Badge>}
                        {s.inGeo?.verified === false && <Badge tone="bad">outside</Badge>}
                        {s.reentryReason && <span className="muted small">Back: {s.reentryReason}</span>}
                        {s.lateReason && <span className="muted small">Late: {s.lateReason}</span>}
                        {(s.breaks || []).map((b, i) => <span key={i} className="muted small">Away {fmtTime(b.outAt)} to {fmtTime(b.backAt)}: {b.reason}</span>)}
                      </div>
                    </div>
                    {s.outPhotoUrl && <a href={s.outPhotoUrl} target="_blank" rel="noreferrer" title="Check-out photo"><img className="thumb" src={s.outPhotoUrl} alt="Check-out" /></a>}
                    {r.status === 'ACTIVE' && (direct || canReq) && (
                      <button className="btn sm" onClick={() => setModal({ kind: 'fix', rec: r, session: s })}>{direct ? 'Correct' : 'Request fix'}</button>)}
                  </div>))}
              </div>
              {r.status === 'ACTIVE' && (direct || me.role === 'ADMIN') && (
                <div className="row att-actions-row">
                  {direct && <button className="btn sm" onClick={() => setModal({ kind: 'add', rec: r })}>+ Add session</button>}
                  {me.role === 'ADMIN' && <button className="btn sm danger" onClick={() => setModal({ kind: 'void', rec: r })}>Void</button>}
                </div>)}
            </div>))}
        </div>
      )}
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
