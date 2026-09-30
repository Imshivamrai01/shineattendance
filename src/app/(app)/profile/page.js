'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, show, takeFlash } from '@/lib/client';
import AttendanceHistory from '@/components/AttendanceHistory';
import { Badge, Skeleton } from '@/components/ui';

const ROWS = [['Name', 'name'], ['Email', 'email'], ['Mobile', 'mobile'], ["Father's name", 'fatherName'], ["Mother's name", 'motherName'], ['Date of birth', 'dob'],
  ['Address', 'address'], ['City', 'city'], ['State', 'state'], ['PIN code', 'pincode'], ['Emergency contact 1', 'emergencyContact1'], ['Emergency contact 2', 'emergencyContact2'],
  ['Department', 'department'], ['Designation', 'designation'], ['Manager', 'manager'], ['HR', 'hr'], ['Location', 'location']];
const disp = (v) => (v && typeof v === 'object' ? (v.name ? [v.name, v.relationship, v.mobile].filter(Boolean).join(' · ') : 'Not Provided') : show(v));

export default function Profile() {
  const [u, setU] = useState(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => api('/auth/me').then((d) => setU(d.user)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const m = takeFlash(); if (m) setNote(m); }, []);
  if (!u) return <Skeleton />;
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div><h1>My profile</h1><div className="muted">{u.role} · {u.employeeId || '—'} <Badge tone="ok">{u.status}</Badge></div></div>
        <div className="row">
          <Link className="btn primary" href={`/users/${u._id}/edit`}>{u.role === 'ADMIN' ? 'Edit my details' : 'Edit my details (needs approval)'}</Link>
          <Link className="btn" href="/change-password">Change password</Link>
        </div>
      </div>
      {note && <div className="alert ok">{note}</div>}
      {u.completion.percent < 100 && (
        <div className="card">
          <div className="row between"><h2>Profile completion</h2><b>{u.completion.percent}%</b></div>
          <div className="bar"><i style={{ width: `${u.completion.percent}%` }} /></div>
          <p className="muted small">Missing: {u.completion.missing.join(', ')}</p>
        </div>)}
            <div className="card"><table><tbody>
        {ROWS.map(([label, k]) => { const val = disp(u[k]); return <tr key={k}><td className="muted" style={{ width: 200 }}>{label}</td><td className={val === 'Not Provided' ? 'muted' : ''}>{val}</td></tr>; })}
      </tbody></table></div>
      {u.role !== 'ADMIN' && <AttendanceHistory userId={u._id} />}
    </>
  );
}
