'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, Empty, Skeleton } from '@/components/ui';

const v = (x) => (x == null ? '—' : typeof x === 'object' ? JSON.stringify(x, null, 1).replace(/[{}"]/g, '').trim() : String(x));
const ENTITIES = ['User', 'Attendance', 'ChangeRequest', 'Department', 'Location', 'Setting', 'Session', 'Report'];

export default function AuditLogs() {
  const me = useMe();
  const [f, setF] = useState({ q: '', actorRole: '', action: '', entityType: '', department: '', location: '', from: '', to: '', override: '' });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [depts, setDepts] = useState([]);
  const [locs, setLocs] = useState([]);
  const [err, setErr] = useState('');
  const set = (k) => (e) => { setPage(1); setF({ ...f, [k]: e.target.value }); };

  useEffect(() => { api('/departments').then((d) => setDepts(d.items)); api('/locations').then((d) => setLocs(d.items)); }, []);
  const load = useCallback(() => {
    const p = new URLSearchParams({ page });
    Object.entries(f).forEach(([k, val]) => val && p.set(k, val));
    api(`/audit-logs?${p}`).then(setData).catch((e) => setErr(e.message));
  }, [f, page]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  if (me.role !== 'ADMIN') return <div className="alert">Admin only.</div>;

  return (
    <>
      <h1>Audit logs</h1>
      <p className="muted">Append-only. Entries cannot be edited or deleted.</p>
      <div className="card form filters">
        <input placeholder="Search employee, admin, reason…" value={f.q} onChange={set('q')} />
        <select value={f.actorRole} onChange={set('actorRole')}><option value="">Any actor role</option><option>ADMIN</option><option>COO</option><option>MANAGER</option><option>HR</option><option>EMPLOYEE</option></select>
        <input placeholder="Action (e.g. CORRECTED)" value={f.action} onChange={set('action')} />
        <select value={f.entityType} onChange={set('entityType')}><option value="">Any entity</option>{ENTITIES.map((e) => <option key={e}>{e}</option>)}</select>
        <select value={f.department} onChange={set('department')}><option value="">Any department</option>{depts.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select>
        <select value={f.location} onChange={set('location')}><option value="">Any location</option>{locs.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select>
        <input type="date" value={f.from} onChange={set('from')} title="From" />
        <input type="date" value={f.to} onChange={set('to')} title="To" />
        <select value={f.override} onChange={set('override')}><option value="">All entries</option><option value="1">Admin overrides only</option></select>
      </div>
      {err && <div className="alert">{err}</div>}
      <div className="card scroll">
        {!data ? <Skeleton /> : data.items.length === 0 ? <Empty message="No audit entries match." /> : (
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Employee</th><th>Old</th><th>New</th><th>Reason</th></tr></thead>
            <tbody>{data.items.map((a) => (
              <tr key={a._id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
                <td>{a.actorEmail || '—'}<div className="muted small">{a.actorRole}{a.ip ? ` · ${a.ip}` : ''}</div></td>
                <td>{a.action.replace(/_/g, ' ')} {a.override && <Badge tone="warn">OVERRIDE</Badge>}<div className="muted small">{a.entityType}</div></td>
                <td>{a.subject ? `${a.subject.name}${a.subject.employeeId ? ` (${a.subject.employeeId})` : ''}` : '—'}</td>
                <td><pre className="diff">{v(a.oldData)}</pre></td><td><pre className="diff">{v(a.newData)}</pre></td>
                <td>{a.reason || '—'}</td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {data && data.total > data.limit && (
        <div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted small">Page {page} of {Math.ceil(data.total / data.limit)}</span>
          <button className="btn sm" disabled={page * data.limit >= data.total} onClick={() => setPage(page + 1)}>Next</button></div>)}
    </>
  );
}
