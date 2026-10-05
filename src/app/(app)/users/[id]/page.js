'use client';
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime, show, takeFlash } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { ConfirmModal, TempPassword, Skeleton } from '@/components/ui';
import AttendanceHistory from '@/components/AttendanceHistory';
import ProfileCard from '@/components/ProfileCard';
import TaskHistory from '@/components/TaskHistory';

const ALL = ['name', 'email', 'mobile', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode', 'emergencyContact1', 'emergencyContact2',
  'designation', 'joiningDate', 'employeeType', 'department', 'manager', 'hr', 'location', 'employeeId'];
const LABELS = { role: 'Role', name: 'Name', email: 'Email', mobile: 'Mobile', fatherName: "Father's name", motherName: "Mother's name", dob: 'Date of birth', address: 'Address',
  city: 'City', state: 'State', pincode: 'PIN code', emergencyContact1: 'Emergency contact 1', emergencyContact2: 'Emergency contact 2', designation: 'Designation',
  joiningDate: 'Joining date', employeeType: 'Employee type', department: 'Department', manager: 'Manager', hr: 'HR', location: 'Location', employeeId: 'Employee ID' };

const disp = (k, u) => {
  const v = u[k];
  if (k.startsWith('emergencyContact')) return v?.name ? `${v.name}${v.relationship ? ` (${v.relationship})` : ''} · ${v.mobile || 'no mobile'}` : 'Not Provided';
  if (v && typeof v === 'object') return v.name;
  return show(v);
};
const vdisp = (v) => (v == null ? 'Not Provided' : typeof v === 'object' ? [v.name, v.relationship, v.mobile].filter(Boolean).join(' · ') : String(v));

export default function UserDetail({ params }) {
  const { id } = use(params);
  const me = useMe();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [modal, setModal] = useState(null);
  const [temp, setTemp] = useState(null);
  const load = useCallback(() => api(`/users/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const m = takeFlash(); if (m) setNote(m); }, []);

  if (err) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const u = d.user;
  const done = (msg) => { setModal(null); if (msg) setNote(msg); load(); };
  const isAdmin = me.role === 'ADMIN';
  const canManagerEdit = (me.role === 'MANAGER' || me.role === 'COO') && d.canEdit && u._id !== me._id;
  const canHrRequest = ['HR', 'MANAGER', 'COO'].includes(me.role) && d.canEdit && u._id !== me._id;
  const byField = {};
  for (const v of d.versions) (byField[v.field] ||= []).push(v);

  const setStatus = (status) => setModal({ kind: 'status', status });
  return (
    <>
      {note && <div className="alert ok">{note}</div>}
      {u.statusReason && u.status !== 'ACTIVE' && <div className="alert warn">Reason recorded: {u.statusReason}</div>}
      <ProfileCard user={u} canChangePhoto={isAdmin && d.photosEnabled} onChanged={load}>
        {isAdmin && <Link className="btn primary" href={`/users/${id}/edit`}>Edit</Link>}
        {canManagerEdit && <Link className="btn primary" href={`/users/${id}/edit?mode=direct`}>Edit assignment</Link>}
        {canHrRequest && <Link className="btn" href={`/users/${id}/edit?mode=request`}>{me.role === 'MANAGER' ? 'Request profile change (to COO)' : me.role === 'COO' ? 'Request profile change (to Admin)' : 'Request profile change'}</Link>}
        {isAdmin && u.role !== 'ADMIN' && (u.status === 'ACTIVE'
          ? <button className="btn" onClick={() => setStatus('INACTIVE')}>Deactivate</button>
          : <button className="btn" onClick={() => setStatus('ACTIVE')}>Reactivate</button>)}
        {isAdmin && u.role !== 'ADMIN' && <button className="btn" onClick={() => setModal({ kind: 'reset' })}>Reset password</button>}
        {isAdmin && u.role !== 'ADMIN' && u.status !== 'ARCHIVED' && <button className="btn danger" onClick={() => setModal({ kind: 'delete' })}>Delete</button>}
      </ProfileCard>

      {u.completion.percent < 100 && (
        <div className="card">
          <div className="row between"><h2>Profile completion</h2><b>{u.completion.percent}%</b></div>
          <div className="bar"><i style={{ width: `${u.completion.percent}%` }} /></div>
          <p className="muted small">Missing: {u.completion.missing.join(', ')}</p>
        </div>
      )}

      <div className="card scroll">
        <h2>Details</h2>
        <table className="kv"><tbody>
          {ALL.map((k) => (
            <tr key={k}><td className="muted">{LABELS[k]}</td>
              <td>{disp(k, u) === 'Not Provided' ? <span className="muted">Not Provided</span> : disp(k, u)}</td></tr>
          ))}
        </tbody></table>
      </div>

      {u.role !== 'ADMIN' && <TaskHistory userId={id} />}
      {u.role !== 'ADMIN' && <AttendanceHistory userId={id} />}

      <div className="card scroll">
        <h2>Change history</h2>
        {Object.keys(byField).length === 0 ? <p className="muted">No history recorded.</p> : (
          <table>
            <thead><tr><th>Field</th><th>Version</th><th>Value</th><th>Changed by</th><th>When</th><th>Why</th></tr></thead>
            <tbody>{Object.entries(byField).flatMap(([f, vs]) => vs.map((v) => (
              <tr key={f + v.version}><td>{LABELS[f] || f}</td><td>v{v.version}</td><td>{vdisp(v.value)}</td>
                <td>{v.changedBy?.name ? `${v.changedBy.name} (${v.changedByRole})` : '—'}</td><td>{fmtDateTime(v.at)}</td><td>{v.reason || '—'}</td></tr>
            )))}</tbody>
          </table>
        )}
      </div>

      {modal?.kind === 'status' && (
        <ConfirmModal title={modal.status === 'ACTIVE' ? 'Reactivate account' : 'Deactivate account'} confirmLabel={modal.status === 'ACTIVE' ? 'Reactivate' : 'Deactivate'}
          details={[['Name', u.name], ['Employee ID', u.employeeId || '—'], ['Record type', u.role]]}
          consequence={modal.status === 'ACTIVE' ? undefined : 'They will be signed out and unable to log in. All attendance history is kept.'}
          onConfirm={(reason) => api(`/users/${id}`, { method: 'PATCH', body: { changes: { status: modal.status }, reason } })}
          onClose={(ok) => done(ok ? 'Status updated.' : '')} />
      )}
      {modal?.kind === 'delete' && (
        <ConfirmModal title="Delete account" danger confirmLabel="Delete"
          details={[['Name', u.name], ['Employee ID', u.employeeId || '—'], ['Record type', u.role]]}
          consequence="The account is archived, not destroyed: login is disabled and it is hidden from lists, but attendance and audit history stay available."
          onConfirm={(reason) => api(`/users/${id}`, { method: 'DELETE', body: { reason } })}
          onClose={(ok) => done(ok ? 'Account archived.' : '')} />
      )}
      {modal?.kind === 'reset' && (
        <ConfirmModal title="Reset password" confirmLabel="Reset"
          details={[['Name', u.name], ['Employee ID', u.employeeId || '—']]}
          consequence="All their sessions end and they must choose a new password at next login."
          onConfirm={async (reason) => { const r = await api(`/users/${id}/reset-password`, { method: 'POST', body: { reason } }); setTemp(r.tempPassword); }}
          onClose={() => setModal(null)} />
      )}
      {temp && <TempPassword value={temp} who={u.name} onClose={() => setTemp(null)} />}
    </>
  );
}
