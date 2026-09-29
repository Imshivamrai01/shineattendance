'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, Empty, Field, Modal, statusTone, Skeleton } from '@/components/ui';

function DeptModal({ dept, all, onClose, onDone }) {
  const [parent, setParent] = useState('');
  const [name, setName] = useState(dept?.name || '');
  const [description, setDesc] = useState(dept?.description || '');
  const [status, setStatus] = useState(dept?.status || 'ACTIVE');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (dept) await api(`/departments/${dept._id}`, { method: 'PATCH', body: { name, description, status, reason } });
      else await api('/departments', { method: 'POST', body: { name, description, parent } });
      onDone();
    } catch (e2) { setErr(e2.message); }
  };
  return (
    <Modal title={dept ? 'Edit department' : 'Add department'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        {err && <div className="alert">{err}</div>}
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Description"><input value={description} onChange={(e) => setDesc(e.target.value)} /></Field>
        {!dept && <Field label="Sub-department of" hint="Optional, e.g. INTERN"><select value={parent} onChange={(e) => setParent(e.target.value)}><option value="">None (top level)</option>{all.filter((d) => !d.parent).map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select></Field>}
        {dept && <Field label="Status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option>ACTIVE</option><option>INACTIVE</option></select></Field>}
        {dept && <Field label="Reason for change (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

export default function Departments() {
  const me = useMe();
  const [items, setItems] = useState(null);
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api('/departments').then((d) => setItems(d.items)), []);
  useEffect(() => { load(); }, [load]);
  const admin = me.role === 'ADMIN';
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <h1>Departments</h1>
        {admin && <button className="btn primary" onClick={() => setModal({})}>+ Add department</button>}
      </div>
      <div className="card scroll">
        {!items ? <Skeleton /> : items.length === 0 ? (
          <Empty message="No departments added yet." onAction={admin ? () => setModal({}) : undefined} actionLabel="+ Add department" />
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Description</th><th>Active employees</th><th>Status</th><th /></tr></thead>
            <tbody>{items.map((d) => (
              <tr key={d._id}><td>{d.parentName ? <span className="muted">{d.parentName} › </span> : null}{d.name}</td><td>{d.description || '—'}</td><td>{d.employees}</td>
                <td><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                <td>{admin && <button className="btn sm" onClick={() => setModal({ dept: d })}>Edit</button>}</td></tr>))}</tbody>
          </table>
        )}
      </div>
      {modal && <DeptModal dept={modal.dept} all={items || []} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </>
  );
}
