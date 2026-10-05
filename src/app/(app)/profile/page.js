'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, show, takeFlash } from '@/lib/client';
import AttendanceHistory from '@/components/AttendanceHistory';
import ProfileCard from '@/components/ProfileCard';
import TaskHistory from '@/components/TaskHistory';
import { Skeleton } from '@/components/ui';

const ROWS = [["Father's name", 'fatherName'], ["Mother's name", 'motherName'], ['Date of birth', 'dob'],
  ['Address', 'address'], ['City', 'city'], ['State', 'state'], ['PIN code', 'pincode'], ['Emergency contact 1', 'emergencyContact1'], ['Emergency contact 2', 'emergencyContact2'],
  ['Employee type', 'employeeType']];
const disp = (v) => (v && typeof v === 'object' ? (v.name ? [v.name, v.relationship, v.mobile].filter(Boolean).join(' · ') : 'Not Provided') : show(v));

export default function Profile() {
  const [d, setD] = useState(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => api('/auth/me').then(setD), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const m = takeFlash(); if (m) setNote(m); }, []);
  if (!d) return <Skeleton />;
  const u = d.user;
  return (
    <>
      {note && <div className="alert ok">{note}</div>}
      <ProfileCard user={u} canChangePhoto={d.photosEnabled} onChanged={load}>
        <Link className="btn primary" href={`/users/${u._id}/edit`}>{u.role === 'ADMIN' ? 'Edit my details' : 'Edit my details (needs approval)'}</Link>
        <Link className="btn" href="/change-password">Change password</Link>
      </ProfileCard>
      {u.completion.percent < 100 && (
        <div className="card">
          <div className="row between"><h2>Profile completion</h2><b>{u.completion.percent}%</b></div>
          <div className="bar"><i style={{ width: `${u.completion.percent}%` }} /></div>
          <p className="muted small">Missing: {u.completion.missing.join(', ')}</p>
        </div>)}
      <div className="card">
        <h2>Personal details</h2>
        <table className="kv"><tbody>
          {ROWS.map(([label, k]) => { const val = disp(u[k]); return <tr key={k}><td className="muted">{label}</td><td className={val === 'Not Provided' ? 'muted' : ''}>{val}</td></tr>; })}
        </tbody></table>
      </div>
      {u.role !== 'ADMIN' && <TaskHistory userId={u._id} mine />}
      {u.role !== 'ADMIN' && <AttendanceHistory userId={u._id} />}
    </>
  );
}
