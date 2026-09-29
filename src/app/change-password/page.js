'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client';
import { Field } from '@/components/ui';
import Logo from '@/components/Logo';

export default function ChangePassword() {
  const [forced, setForced] = useState(false);
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/auth/me').then((d) => setForced(d.user.mustChangePassword)).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault(); setErr('');
    if (f.newPassword !== f.confirm) return setErr('New passwords do not match');
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.currentPassword, newPassword: f.newPassword } });
      window.location.href = '/';
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div style={{ textAlign: "center", marginBottom: 6 }}><Logo size={64} /></div>
        <h1>Change password</h1>
        {forced && <div className="alert warn">For your security you must set a new password before continuing.</div>}
        <p className="muted small">At least 10 characters with upper case, lower case and a number.</p>
        {err && <div className="alert">{err}</div>}
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="Current password"><input type="password" value={f.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" required /></Field>
          <Field label="New password"><input type="password" value={f.newPassword} onChange={set('newPassword')} autoComplete="new-password" required /></Field>
          <Field label="Confirm new password"><input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required /></Field>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
          {!forced && <Link href="/">Cancel</Link>}
        </div>
      </form>
    </div>
  );
}
