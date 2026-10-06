'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Field, Skeleton } from '@/components/ui';

export default function Settings() {
  const me = useMe();
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState(null);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me.role === 'ADMIN') api('/settings').then((d) => { setS(d.settings); setSaved(d.settings.sheetScriptUrl || ''); }).catch((e) => setMsg({ text: e.message }));
  }, [me.role]);
  if (me.role !== 'ADMIN') return <div className="alert">Admin only.</div>;
  if (!s) return <Skeleton />;
  const set = (k, v) => setS({ ...s, [k]: v });
  const connected = !!saved && s.hasSheetSecret;

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null);
    try { const t = await fn(); setMsg({ ok: true, text: typeof okText === 'function' ? okText(t) : okText }); } catch (e) { setMsg({ text: e.message }); }
    setBusy(false);
  };
  const refresh = async () => { const n = await api('/settings'); setS(n.settings); setSaved(n.settings.sheetScriptUrl || ''); };

  const save = async (e) => {
    e.preventDefault();
    await run(async () => {
      const d = await api('/settings', { method: 'PATCH', body: { ...s, reason } });
      setS(d.settings); setSaved(d.settings.sheetScriptUrl || ''); setReason('');
    }, 'Settings saved and audited.');
  };
  const testMail = () => run(() => api('/notify/test', { method: 'POST', body: { to: s.notificationEmail || '' } }), (d) => `Test email sent to ${d.to.join(', ')}. Check the inbox (and spam).`);
  const showScript = () => run(async () => { const d = await api('/sheets/script'); setScript(d.script); await refresh(); }, 'Copy the script below into your sheet.');
  const rotate = () => confirm('Create a new secret? The old script stops working until you paste the new one.') &&
    run(async () => { const d = await api('/sheets/script', { method: 'POST' }); setScript(d.script); }, 'New secret created. Paste the new script and deploy it again.');
  const test = () => run(() => api('/sheets/test', { method: 'POST' }), (d) => `Connected to "${d.title}", tab "${d.tab}". Attendance now updates there automatically.`);
  // Saves the URL/tab (no separate reason needed) and immediately tests it.
  const connect = () => run(async () => {
    const d = await api('/settings', { method: 'PATCH', body: { sheetScriptUrl: s.sheetScriptUrl || '', sheetTab: s.sheetTab || 'Attendance', reason: 'Connected Google Sheets' } });
    setS(d.settings); setSaved(d.settings.sheetScriptUrl || '');
    return api('/sheets/test', { method: 'POST' });
  }, (d) => `Connected to "${d.title}", tab "${d.tab}". Attendance now updates there automatically.`);
  const sync = () => run(async () => { const d = await api('/sheets/sync', { method: 'POST' }); await refresh(); return d; }, (d) => `Sent ${d.rows} attendance rows and ${d.employees} employee profiles to the sheet.`);

  return (
    <>
      <h1>Settings</h1>
      {msg && <div className={`alert toast ${msg.ok ? 'ok' : ''}`} role="status">{msg.text}</div>}
      <form onSubmit={save}>
        <div className="card">
          <h2>Attendance</h2>
          <div className="form">
            <Field label="Default check-in radius (m)" hint="Used for new locations"><input type="number" min="1" max="5000" value={s.defaultRadiusMeters} onChange={(e) => set('defaultRadiusMeters', e.target.value)} /></Field>
            <Field label="Geofence enforcement"><select value={String(s.enforceGeofence)} onChange={(e) => set('enforceGeofence', e.target.value === 'true')}>
              <option value="true">Block check-in outside the radius</option><option value="false">Record but do not block</option></select></Field>
            <Field label="Office starts (check-in time)" hint="Checking in after this is marked Late"><input type="time" value={s.workStart || '10:00'} onChange={(e) => set('workStart', e.target.value)} /></Field>
            <Field label="Office ends (check-out time)" hint="Checking out before this is marked Left early"><input type="time" value={s.workEnd || '18:00'} onChange={(e) => set('workEnd', e.target.value)} /></Field>
            <Field label="Grace period (minutes)" hint="Late only after start time + grace"><input type="number" min="0" max="180" value={s.graceMinutes ?? 0} onChange={(e) => set('graceMinutes', e.target.value)} /></Field>
            <Field label="Lunch starts" hint="Leaving the office during lunch is never counted"><input type="time" value={s.lunchStart || '13:30'} onChange={(e) => set('lunchStart', e.target.value)} /></Field>
            <Field label="Lunch ends"><input type="time" value={s.lunchEnd || '14:30'} onChange={(e) => set('lunchEnd', e.target.value)} /></Field>
          </div>
        </div>

        <div className="card">
          <div className="row between"><h2 style={{ margin: 0 }}>Google Sheets</h2>{connected && <span className="badge ok">Connected</span>}</div>
          <p className="muted small">Every check-in, check-out, auto check-out, correction and void updates one row per person per day (Attendance tab), and every employee profile is kept in the Employees tab (role, designation, department, contact details and more). MongoDB stays the source of truth; editing or deleting sheet rows never changes records.</p>
          <ol className="steps">
            <li>Open your Google Sheet, then <b>Extensions, Apps Script</b>. Delete the sample code.</li>
            <li><button type="button" className="btn sm" onClick={showScript} disabled={busy}>Show script</button> and paste it in, then <b>Save</b>.</li>
            <li>Click <b>Deploy, New deployment</b>, type <b>Web app</b>. Set <i>Execute as: Me</i> and <i>Who has access: Anyone</i>. Approve the permissions, then copy the <b>Web app URL</b>.</li>
            <li>Paste that URL below, save settings, then press <b>Test connection</b>.</li>
          </ol>
          {script && (
            <div style={{ margin: '10px 0' }}>
              <div className="row between"><b className="small">Apps Script</b>
                <span className="row"><button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(script)}>Copy</button>
                  <button type="button" className="btn sm" onClick={rotate} disabled={busy}>New secret</button></span></div>
              <pre className="diff card" style={{ maxHeight: 260, overflow: 'auto', marginTop: 8 }}>{script}</pre>
              <p className="muted small">This script contains a secret that authorises writes to your sheet. Don't share it.</p>
            </div>
          )}
          {s.lastSheetError && <div className="alert">Last sync problem ({fmtDateTime(s.lastSheetErrorAt)}): {s.lastSheetError}</div>}
          <div className="form">
            <Field label="Web app URL" span hint="Starts with https://script.google.com/macros/s/ and ends with /exec"><input value={s.sheetScriptUrl || ''} onChange={(e) => set('sheetScriptUrl', e.target.value)} inputMode="url" /></Field>
            <Field label="Tab name"><input value={s.sheetTab || ''} onChange={(e) => set('sheetTab', e.target.value)} /></Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={busy || !(s.sheetScriptUrl || '').trim()} onClick={connect}>{busy ? 'Working…' : 'Save & test connection'}</button>
            <button type="button" className="btn" disabled={busy || !connected || saved !== (s.sheetScriptUrl || '')} onClick={sync}>Send all attendance + employees</button>
            <span className="muted small">Last sync: {fmtDateTime(s.lastSheetSync)}</span>
          </div>
          {!s.hasSheetSecret && <p className="muted small" style={{ marginBottom: 0 }}>First press <b>Show script</b> above and use that exact script in Apps Script. It contains the secret this app needs.</p>}
          {s.hasSheetSecret && !connected && <p className="muted small" style={{ marginBottom: 0 }}>Paste the Web app URL, then press Save &amp; test connection.</p>}
        </div>

        <div className="card">
          <h2>Notifications</h2>
          <p className="muted small">Every person gets their own emails (login details, check-in, check-out, absent alert, request updates, attendance or profile changes). Admin and COO also get attendance exceptions, changes, approvals and a daily summary at 6:30 pm IST (and an absent check at 10:30 am). Admin alerts go to the address below, or to every Admin's email if this is empty.</p>
          {s.mailConfigured ? <div className="alert ok">Email sending is set up on the server.</div> : <div className="alert warn">Email is not set up on the server yet (Cloudflare Email Sending binding, or SMTP_USER and SMTP_PASS locally).</div>}
          {s.lastMailError && <div className="alert">Last email problem ({fmtDateTime(s.lastMailErrorAt)}): {s.lastMailError}</div>}
          <div className="form"><Field label="Email Admin and COO on every check-in and check-out" hint="Off = only exceptions (the 8 PM daily report always goes to the report address). On = one email per check-in/out for each person (can be many)."><select value={String(!!s.mailEveryCheckin)} onChange={(e) => set('mailEveryCheckin', e.target.value === 'true')}><option value="false">Off (recommended)</option><option value="true">On</option></select></Field></div>
          <div className="form" style={{ marginTop: 14 }}><Field label="Notification email" hint="The test goes to this address. Press Save settings (below) to keep it."><input type="email" value={s.notificationEmail || ''} onChange={(e) => set('notificationEmail', e.target.value)} /></Field></div>
          <div style={{ marginTop: 12 }}><button type="button" className="btn" disabled={busy || !s.mailConfigured || !(s.notificationEmail || '').trim()} onClick={testMail}>{busy ? 'Sending…' : 'Send test email'}</button></div>
        </div>
        <div className="card">
          <Field label="Reason for change (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy || reason.trim().length < 5}>Save settings</button></div>
        </div>
      </form>
      <div className="card"><h2>Account</h2><Link className="btn" href="/change-password">Change my password</Link></div>
    </>
  );
}
