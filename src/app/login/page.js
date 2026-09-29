'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { Field } from '@/components/ui';
import Logo from '@/components/Logo';

export default function Login() {
  const [identifier, setId] = useState('');
  const [password, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const d = await api('/auth/login', { method: 'POST', body: { identifier, password } });
      window.location.href = d.mustChangePassword ? '/change-password' : '/';
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div style={{ textAlign: "center", marginBottom: 6 }}><Logo size={84} /></div>
        <h1 style={{ textAlign: "center" }}>Shine Attendance</h1>
        <p className="muted">Sign in with your User ID (email, mobile or employee ID) and password.</p>
        {err && <div className="alert">{err}</div>}
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="User ID"><input value={identifier} onChange={(e) => setId(e.target.value)} autoComplete="username" required autoFocus /></Field>
          <Field label="Password"><input type="password" value={password} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></Field>
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}
