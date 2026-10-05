'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, Empty, statusTone, Skeleton } from '@/components/ui';
import Avatar from '@/components/Avatar';

const LABEL = { COO: 'COO', MANAGER: 'Manager', HR: 'HR', EMPLOYEE: 'Employee' };
const EMPTY = { COO: 'No COO added yet.', MANAGER: 'No Managers added yet.', HR: 'No HR users added yet.', EMPLOYEE: 'No employees added yet.' };

function List() {
  const me = useMe();
  const sp = useSearchParams();
  const [role, setRole] = useState(sp.get('role') || '');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (role) p.set('role', role); if (status) p.set('status', status); if (q) p.set('q', q);
      api(`/users?${p}`).then(setData).catch((e) => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [role, status, q]);

  const canAdd = me.role === 'ADMIN' || me.role === 'HR';
  const filtering = role || status || q;
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div><h1>People</h1><div className="muted">{data ? `${data.total} shown` : ''}</div></div>
        {canAdd && <Link className="btn primary" href={`/users/new${role ? `?role=${role}` : ''}`}>+ Add {role ? LABEL[role] : 'person'}</Link>}
      </div>
      <div className="card row">
        <input style={{ maxWidth: 260 }} placeholder="Search name, email, mobile, ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ maxWidth: 160 }} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option><option value="COO">COO</option><option value="MANAGER">Managers</option><option value="HR">HR</option><option value="EMPLOYEE">Employees</option>
        </select>
        <select style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Active + inactive</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="ARCHIVED">Archived</option>
        </select>
      </div>
      {err && <div className="alert">{err}</div>}
      <div className="card">
        {!data ? <Skeleton /> : data.items.length === 0 ? (
          filtering && !(role && !q && !status)
            ? <Empty message="No people match these filters." />
            : <Empty message={role ? EMPTY[role] : 'No people added yet.'} actionHref={canAdd ? `/users/new${role ? `?role=${role}` : ''}` : undefined}
                actionLabel={`+ Add ${role ? LABEL[role] : 'Employee'}`} />
        ) : (
          <div className="people-grid">
            {data.items.map((u) => (
              <Link key={u._id} href={`/users/${u._id}`} className="person-card">
                <Avatar user={u} size={56} />
                <div className="person-info">
                  <b className="person-name">{u.name}</b>
                  <div className="muted small">{u.designation || LABEL[u.role] || u.role}{u.employeeId ? ` · ${u.employeeId}` : ''}</div>
                  <div className="muted small">{u.department?.name || 'No department'}{u.manager?.name ? ` · reports to ${u.manager.name}` : ''}</div>
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <Badge tone={statusTone(u.status)}>{u.status}</Badge>
                    <Badge>{LABEL[u.role] || u.role}</Badge>
                    {u.completion.percent < 100 && <Badge tone="warn">Profile {u.completion.percent}%</Badge>}
                  </div>
                </div>
              </Link>))}
          </div>
        )}
      </div>
    </>
  );
}
export default function Page() { return <Suspense fallback={<Skeleton />}><List /></Suspense>; }
