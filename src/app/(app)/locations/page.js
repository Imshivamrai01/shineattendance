'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, Empty, Field, Modal, statusTone, Skeleton } from '@/components/ui';

function LocModal({ loc, onClose, onDone }) {
  const [f, setF] = useState({ name: loc?.name || '', address: loc?.address || '', latitude: loc?.latitude ?? '', longitude: loc?.longitude ?? '',
    radiusMeters: loc?.radiusMeters ?? '', checkoutRadiusMeters: loc?.checkoutRadiusMeters ?? '', status: loc?.status || 'ACTIVE', reason: '' });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const useHere = () => navigator.geolocation?.getCurrentPosition((p) => setF((x) => ({ ...x, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })),
    () => setErr('Could not read your current position'));
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (loc) await api(`/locations/${loc._id}`, { method: 'PATCH', body: f });
      else await api('/locations', { method: 'POST', body: f });
      onDone();
    } catch (e2) { setErr(e2.message); }
  };
  return (
    <Modal title={loc ? 'Edit location / geofence' : 'Add location'} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="alert">{err}</div>}
        <div className="form two">
          <Field label="Name" span><input value={f.name} onChange={set('name')} required /></Field>
          <Field label="Address" span><input value={f.address} onChange={set('address')} /></Field>
          <Field label="Latitude"><input value={f.latitude} onChange={set('latitude')} required inputMode="decimal" /></Field>
          <Field label="Longitude"><input value={f.longitude} onChange={set('longitude')} required inputMode="decimal" /></Field>
          <Field label="Check-in radius (m)" hint="Must be this close to check in. Blank = default"><input value={f.radiusMeters} onChange={set('radiusMeters')} inputMode="numeric" /></Field>
          <Field label="Auto check-out beyond (m)" hint="Blank = 20"><input value={f.checkoutRadiusMeters} onChange={set('checkoutRadiusMeters')} inputMode="numeric" /></Field>
          <div style={{ alignSelf: 'end' }}><button type="button" className="btn" onClick={useHere}>Use my current position</button></div>
          {loc && <Field label="Status"><select value={f.status} onChange={set('status')}><option>ACTIVE</option><option>INACTIVE</option></select></Field>}
          {loc && <Field label="Reason for change (required)" span><input value={f.reason} onChange={set('reason')} /></Field>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

export default function Locations() {
  const me = useMe();
  const [items, setItems] = useState(null);
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api('/locations').then((d) => setItems(d.items)), []);
  useEffect(() => { load(); }, [load]);
  const admin = me.role === 'ADMIN';
  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <h1>Locations</h1>
        {admin && <button className="btn primary" onClick={() => setModal({})}>+ Add location</button>}
      </div>
      <div className="card scroll">
        {!items ? <Skeleton /> : items.length === 0 ? (
          <Empty message="No locations added yet." onAction={admin ? () => setModal({}) : undefined} actionLabel="+ Add location" />
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Coordinates</th><th>Check-in / auto check-out</th><th>Status</th><th /></tr></thead>
            <tbody>{items.map((l) => (
              <tr key={l._id}><td>{l.name}<div className="muted small">{l.address}</div></td><td>{l.latitude}, {l.longitude}</td><td>{l.radiusMeters} m / {l.checkoutRadiusMeters ?? 20} m</td>
                <td><Badge tone={statusTone(l.status)}>{l.status}</Badge></td>
                <td>{admin && <button className="btn sm" onClick={() => setModal({ loc: l })}>Edit</button>}</td></tr>))}</tbody>
          </table>
        )}
      </div>
      {modal && <LocModal loc={modal.loc} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); }} />}
    </>
  );
}
