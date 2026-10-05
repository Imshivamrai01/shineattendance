'use client';
import { useRef, useState } from 'react';
import { api, show } from '@/lib/client';
import Avatar from '@/components/Avatar';
import Icon from '@/components/Icon';
import { Badge, statusTone } from '@/components/ui';

const ROLE = { ADMIN: 'Admin', COO: 'COO', MANAGER: 'Manager', HR: 'HR', EMPLOYEE: 'Employee' };

// Square-crop and shrink a picked image to a small JPEG (keeps uploads fast and under the server limit).
async function toSquareJpeg(file, side = 400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = side;
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}

/** The person as a card: photo, name, role and the key details. `canChangePhoto` shows the camera button. */
export default function ProfileCard({ user, canChangePhoto, onChanged, children }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setErr('');
    try {
      await api(`/users/${user._id}/photo`, { method: 'POST', body: { photo: await toSquareJpeg(file) } });
      onChanged?.();
    } catch (x) { setErr(x.message || 'Could not upload the photo'); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true); setErr('');
    try { await api(`/users/${user._id}/photo`, { method: 'DELETE' }); onChanged?.(); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const name = (v) => (v && typeof v === 'object' ? v.name : v);
  const facts = [
    ['Department', name(user.department)], ['Location', name(user.location)],
    ...(user.role !== 'ADMIN' ? [['Reports to', name(user.manager)], ['HR', name(user.hr)]] : []),
    ['Joined', user.joiningDate],
  ].filter(([, v]) => v);

  return (
    <div className="card pcard">
      <div className="pcard-banner" />
      <div className="pcard-body">
        <div className="pcard-photo">
          <Avatar user={user} size={96} />
          {canChangePhoto && (
            <button type="button" className="pcard-cam" onClick={() => input.current?.click()} disabled={busy} aria-label="Change photo" title="Change photo">
              <Icon name="camera" size={16} />
            </button>
          )}
          <input ref={input} type="file" accept="image/*" hidden onChange={pick} />
        </div>
        <h1 className="pcard-name">{user.name}</h1>
        <div className="muted">{user.designation || ROLE[user.role]}</div>
        <div className="row pcard-tags">
          <Badge tone="info">{ROLE[user.role]}</Badge>
          {user.employeeId && <Badge>{user.employeeId}</Badge>}
          <Badge tone={statusTone(user.status)}>{user.status}</Badge>
        </div>
        <div className="pcard-contact">
          {user.email && <a href={`mailto:${user.email}`}><Icon name="mail" size={16} /> <span>{user.email}</span></a>}
          {user.mobile && <a href={`tel:${user.mobile}`}><Icon name="phone" size={16} /> <span>{user.mobile}</span></a>}
        </div>
        {facts.length > 0 && (
          <div className="pcard-facts">
            {facts.map(([k, v]) => <div key={k}><div className="muted small">{k}</div><b>{show(v)}</b></div>)}
          </div>
        )}
        {busy && <div className="muted small" style={{ marginTop: 10 }}>Saving photo…</div>}
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        {canChangePhoto && user.photoUrl && !busy && <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={remove}>Remove photo</button>}
        {children && <div className="row pcard-actions">{children}</div>}
      </div>
    </div>
  );
}
