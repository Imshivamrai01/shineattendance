'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, ConfirmModal, Empty, statusTone, Skeleton } from '@/components/ui';

const STAGE = { PENDING_HR: 'Pending HR', PENDING_MANAGER: 'Pending Manager', PENDING_COO: 'Pending COO', PENDING_ADMIN: 'Pending Admin', APPROVED: 'Approved', REJECTED: 'Rejected' };
const OWN_STAGE = { ADMIN: 'PENDING_ADMIN', COO: 'PENDING_COO', MANAGER: 'PENDING_MANAGER', HR: 'PENDING_HR' };
const STAGE_ROLE = { PENDING_HR: 'HR', PENDING_MANAGER: 'the Manager', PENDING_COO: 'the COO' };
const fv = (v) => (v == null || v === '' ? 'Not Provided' : typeof v === 'object' ? [v.name, v.relationship, v.mobile].filter(Boolean).join(' · ') : String(v));

export default function Requests() {
  const me = useMe();
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [modal, setModal] = useState(null);
  // Deciding a stage that belongs to a lower role is allowed (Admin > COO > Manager > HR) but is an override.
  const ownStage = (r) => r.status === OWN_STAGE[me.role] || (r.status === 'PENDING_MANAGER' && String(r.subject?.manager) === String(me._id));
  const load = useCallback(() => api(`/requests${filter === 'pending' ? '?pending=1' : ''}`).then((d) => setItems(d.items)).catch((e) => setErr(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <h1>Requests</h1>
      <div className="tabs">
        <button className={`btn sm ${filter === 'pending' ? 'primary' : ''}`} onClick={() => setFilter('pending')}>Pending</button>
        <button className={`btn sm ${filter === 'all' ? 'primary' : ''}`} onClick={() => setFilter('all')}>All</button>
      </div>
      {err && <div className="alert">{err}</div>}
      {note && <div className="alert ok">{note}</div>}
      {!items ? <Skeleton /> : items.length === 0 ? <div className="card"><Empty message={filter === 'pending' ? 'No pending requests.' : 'No requests yet.'} /></div> :
        items.map((r) => (
          <div className="card" key={r._id}>
            <div className="row between">
              <div><b>{r.type === 'PROFILE_CHANGE' ? 'Profile change' : 'Attendance correction'}</b> · {r.subject?.name}
                <div className="muted small">By {r.requester?.name} ({r.requester?.role}) · {fmtDateTime(r.createdAt)}</div></div>
              <Badge tone={statusTone(r.status)}>{STAGE[r.status]}</Badge>
            </div>
            <p style={{ margin: '10px 0 6px' }}>“{r.reason}”</p>
            {r.type === 'PROFILE_CHANGE'
              ? <ul className="small">{Object.entries(r.changes || {}).map(([k, v]) => <li key={k}><b>{k}</b> → {fv(v)}</li>)}</ul>
              : <div className="small muted">New times: {r.payload?.checkIn ? fmtDateTime(r.payload.checkIn) : '—'} to {r.payload?.checkOut ? fmtDateTime(r.payload.checkOut) : '—'}</div>}
            {r.history.length > 1 && <div className="small muted">{r.history.slice(1).map((h, i) => (
              <div key={i}>{h.action} by {h.byRole}{h.override ? ' (override)' : ''} · {fmtDateTime(h.at)}{h.note ? ` · ${h.note}` : ''}</div>))}</div>}
            {r.canAct && (
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary sm" onClick={() => setModal({ r, decision: 'approve' })}>{!ownStage(r) ? 'Approve now' : 'Approve'}</button>
                <button className="btn sm" onClick={() => setModal({ r, decision: 'reject' })}>Reject</button>
              </div>)}
          </div>))}
      {modal && (
        <ConfirmModal title={`${modal.decision === 'approve' ? 'Approve' : 'Reject'} request`} danger={modal.decision === 'reject'}
          confirmLabel={modal.decision === 'approve' ? 'Approve' : 'Reject'} reasonLabel="Note" minReason={modal.decision === 'reject' ? 3 : (me.role === 'ADMIN' && modal.r.status !== 'PENDING_ADMIN' ? 5 : 0)}
          question={!ownStage(modal.r) ? `This is waiting for ${STAGE_ROLE[modal.r.status] || 'someone else'}. Your decision is final and is logged as an override.` : 'Are you sure?'}
          details={[['Employee', modal.r.subject?.name], ['Employee ID', modal.r.subject?.employeeId || '—'], ['Record type', modal.r.type === 'PROFILE_CHANGE' ? 'Profile change' : 'Attendance correction']]}
          onConfirm={(note2) => api(`/requests/${modal.r._id}`, { method: 'POST', body: { decision: modal.decision, note: note2 } })}
          onClose={(ok) => { setModal(null); if (ok) { setNote('Decision recorded.'); load(); } }} />)}
    </>
  );
}
