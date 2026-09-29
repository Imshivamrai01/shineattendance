'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';

const TEMPLATE = 'Employee ID,Name,Email,Mobile,Department,Designation,Manager,HR,Location\n';

export default function Import() {
  const me = useMe();
  const [csv, setCsv] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (me.role !== 'ADMIN') return <div className="alert">Admin only.</div>;

  const pick = async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); };
  const run = async () => {
    setBusy(true); setErr(''); setRes(null);
    try { setRes(await api('/users/import', { method: 'POST', body: { csv } })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const download = (name, text) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click();
  };
  const creds = () => download('temporary-passwords.csv', 'Row,Name,Employee ID,Login,Temporary password\n' + res.created.map((c) => [c.row, c.name, c.employeeId, c.login, c.tempPassword].join(',')).join('\n'));

  return (
    <>
      <h1>Import people</h1>
      <p className="muted">Upload a CSV. Valid rows are imported; invalid rows are listed so you can fix and re-upload just those. Missing columns are fine except Name; each row needs an email or mobile. Manager/HR are matched by email, mobile or employee ID. Unknown departments are created; unknown locations are skipped.</p>
      <div className="card">
        <div className="row">
          <input type="file" accept=".csv,text/csv" onChange={pick} style={{ maxWidth: 320 }} />
          <button className="btn" onClick={() => download('people-template.csv', TEMPLATE)}>Download template</button>
        </div>
        <textarea rows={6} style={{ marginTop: 12 }} placeholder="…or paste CSV here" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <div style={{ marginTop: 12 }}><button className="btn primary" disabled={busy || !csv.trim()} onClick={run}>{busy ? 'Importing…' : 'Import'}</button></div>
      </div>
      {err && <div className="alert">{err}</div>}
      {res && (
        <div className="card">
          <div className={`alert ${res.failed ? 'warn' : 'ok'}`}>Imported {res.imported} · Failed {res.failed}</div>
          {res.imported > 0 && <div className="alert warn">Temporary passwords are shown only now. <button className="btn sm" onClick={creds}>Download credentials CSV</button></div>}
          {res.errors.length > 0 && <><h3>Rows with errors</h3><table><thead><tr><th>Row</th><th>Problem</th></tr></thead><tbody>{res.errors.map((e) => <tr key={e.row}><td>{e.row}</td><td>{e.error}</td></tr>)}</tbody></table></>}
          {res.warnings.length > 0 && <><h3 style={{ marginTop: 14 }}>Warnings</h3><table><tbody>{res.warnings.map((w, i) => <tr key={i}><td>{w.row}</td><td>{w.warning}</td></tr>)}</tbody></table></>}
        </div>
      )}
    </>
  );
}
