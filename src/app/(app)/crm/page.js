'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import { Badge, Field, Skeleton } from '@/components/ui';

const CHUNK = 20;
const fill = (text, params) => text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[n - 1] || `{{${n}}}`);
const tone = (s) => ({ APPROVED: 'ok', SENT: 'ok', PENDING: 'warn', IN_APPEAL: 'warn', REJECTED: 'bad', FAILED: 'bad', PAUSED: 'bad', DISABLED: 'bad' }[s] || '');

// "Name, 98xxxxxxxx" per line (comma, tab or several spaces between them; a bare number is fine too).
function parseList(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)[,\t;]\s*(\+?[\d\s()-]{8,})$/.exec(line) || /^(.*?)\s+(\+?[\d\s()-]{8,})$/.exec(line);
    if (m) return { name: m[1].trim(), phone: m[2].trim() };
    return /^\+?[\d\s()-]{8,}$/.test(line) ? { name: '', phone: line } : { name: line, phone: '' };
  });
}

function Connect({ d, onSaved }) {
  const [f, setF] = useState({ phoneId: d.phoneId, businessId: d.businessId, token: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/crm/config', { method: 'POST', body: f }); onSaved('WhatsApp connected.'); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={save}>
      <h2>WhatsApp connection</h2>
      <p className="muted small" style={{ marginTop: 0 }}>From Meta for Developers → your app → WhatsApp → API Setup. Use a permanent (System User) token: the temporary one stops working after 24 hours.</p>
      <div className="form two">
        <Field label="Phone number ID"><input value={f.phoneId} onChange={set('phoneId')} inputMode="numeric" required /></Field>
        <Field label="WhatsApp Business Account ID"><input value={f.businessId} onChange={set('businessId')} inputMode="numeric" required /></Field>
        <Field label="Access token" span hint={d.hasToken ? 'A token is saved. Leave blank to keep it.' : undefined}>
          <textarea rows={2} value={f.token} onChange={set('token')} placeholder={d.hasToken ? '•••••••• (saved)' : 'Paste the token'} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Save and check'}</button></div>
    </form>
  );
}

export default function Crm() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('send');
  const [showConnect, setShowConnect] = useState(false);
  // composer
  const [tplKey, setTplKey] = useState('');
  const [source, setSource] = useState('employees');
  const [picked, setPicked] = useState({});
  const [pasted, setPasted] = useState('');
  const [values, setValues] = useState({}); // {{n}} -> typed value; {{1}} defaults to the recipient's name
  const [nameVar, setNameVar] = useState(true);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);

  const load = useCallback(() => api('/crm').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const usable = useMemo(() => (d?.templates || []).filter((t) => t.usable), [d]);
  const tpl = usable.find((t) => `${t.name}|${t.language}` === tplKey);
  const preset = d?.presets.find((p) => p.name === tpl?.name);
  const recipients = useMemo(() => {
    if (!d) return [];
    if (source === 'employees') return d.employees.filter((e) => picked[e._id]).map((e) => ({ name: e.name, phone: e.mobile || '', userId: e._id }));
    return parseList(pasted);
  }, [d, source, picked, pasted]);
  const ready = recipients.filter((r) => r.phone);
  const paramsFor = (r) => Array.from({ length: tpl?.vars || 0 }, (_, i) => (i === 0 && nameVar ? (r.name || 'there').split(/\s+/)[0] : values[i + 1] || ''));
  const missing = tpl ? Array.from({ length: tpl.vars }, (_, i) => i + 1).filter((n) => !(n === 1 && nameVar) && !(values[n] || '').trim()) : [];

  if (err) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;

  const choose = (name, src) => {
    const t = usable.find((x) => x.name === name);
    setTab('send'); setResults(null); setValues({}); setNameVar(true);
    if (t) setTplKey(`${t.name}|${t.language}`);
    if (src) setSource(src);
    if (src === 'employees' && name === 'employee_welcome') setPicked(Object.fromEntries(d.employees.filter((e) => e.mobile).map((e) => [e._id, true])));
    if (!t) setNote(`The "${name}" template is not approved yet. Submit it under Templates, then come back.`);
  };
  const submitPreset = async (name) => {
    setNote('');
    try { const r = await api('/crm/templates', { method: 'POST', body: { preset: name } }); setNote(`Template submitted to Meta (${r.status}). It can be used once approved.`); load(); } catch (e) { setNote(e.message); }
  };
  const send = async () => {
    if (!window.confirm(`Send "${tpl.name}" on WhatsApp to ${ready.length} ${ready.length === 1 ? 'person' : 'people'}?`)) return;
    const batch = `b-${Date.now()}`; const all = [];
    setResults(null); setProgress({ done: 0, total: ready.length });
    for (let i = 0; i < ready.length; i += CHUNK) {
      const part = ready.slice(i, i + CHUNK).map((r) => ({ ...r, params: paramsFor(r) }));
      try {
        const r = await api('/crm/send', { method: 'POST', body: { template: tpl.name, language: tpl.language, purpose: preset?.purpose || 'BULK', batch, recipients: part } });
        all.push(...r.results);
      } catch (e) { all.push(...part.map((r) => ({ to: r.phone, name: r.name, status: 'FAILED', error: e.message }))); }
      setProgress({ done: Math.min(i + CHUNK, ready.length), total: ready.length });
    }
    setProgress(null); setResults(all); load();
  };
  const withMobile = d.employees.filter((e) => e.mobile);
  const allPicked = withMobile.length > 0 && withMobile.every((e) => picked[e._id]);

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div><h1>CRM · WhatsApp</h1><div className="muted">Interview invites, employee messages and bulk updates</div></div>
        {d.configured && <button className="btn" onClick={() => setShowConnect(!showConnect)}>{showConnect ? 'Hide settings' : 'WhatsApp settings'}</button>}
      </div>
      {note && <div className="alert ok">{note}</div>}
      {(!d.configured || showConnect) && <Connect d={d} onSaved={(m) => { setNote(m); setShowConnect(false); load(); }} />}
      {d.error && <div className="alert">{d.error}</div>}
      {d.account && (
        <div className="card">
          <div className="row between">
            <div><b>{d.account.name}</b> · {d.account.number}<div className="muted small">Connected sender{d.account.tier ? ` · limit ${d.account.tier.replace('TIER_', '')} new chats / day` : ''}</div></div>
            <Badge tone={d.account.test ? 'warn' : 'ok'}>{d.account.test ? 'Test number' : 'Live'}</Badge>
          </div>
          {d.account.test && <div className="alert warn" style={{ marginTop: 10, marginBottom: 0 }}>This is Meta&apos;s test number: it can only message the (up to 5) numbers you added as test recipients in the Meta dashboard. Connect your real business number to message everyone.</div>}
        </div>
      )}

      {d.configured && (
        <>
          <div className="tabs">
            {[['send', 'Send'], ['templates', 'Templates'], ['history', 'History']].map(([k, label]) => (
              <button key={k} className={`btn sm ${tab === k ? 'primary' : ''}`} onClick={() => setTab(k)}>{label}</button>))}
          </div>

          {tab === 'send' && (
            <>
              <div className="card">
                <h2>Quick start</h2>
                <div className="row">
                  <button className="btn" onClick={() => choose('interview_invite', 'paste')}>Interview invites</button>
                  <button className="btn" onClick={() => choose('employee_welcome', 'employees')}>Welcome all employees</button>
                  <button className="btn" onClick={() => choose('team_update', 'employees')}>Message employees</button>
                </div>
              </div>

              <div className="card">
                <h2>1 · Message</h2>
                {!usable.length ? <p className="muted">No approved templates yet. Submit the ready-made ones under Templates.</p> : (
                  <Field label="Template">
                    <select value={tplKey} onChange={(e) => { setTplKey(e.target.value); setValues({}); setResults(null); }}>
                      <option value="">Choose…</option>
                      {usable.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{d.presets.find((p) => p.name === t.name)?.label || t.name} ({t.language})</option>)}
                    </select>
                  </Field>
                )}
                {tpl && tpl.vars > 0 && (
                  <div className="form two" style={{ marginTop: 12 }}>
                    {Array.from({ length: tpl.vars }, (_, i) => i + 1).map((n) => (
                      <Field key={n} label={preset?.fields?.[n - 1] || `Value {{${n}}}`} hint={n === 1 ? undefined : 'Same for everyone'}>
                        {n === 1 && (
                          <label className="check"><input type="checkbox" checked={nameVar} onChange={(e) => setNameVar(e.target.checked)} /> Use each person&apos;s first name</label>
                        )}
                        {!(n === 1 && nameVar) && <input value={values[n] || ''} onChange={(e) => setValues({ ...values, [n]: e.target.value })} maxLength={500} />}
                      </Field>))}
                  </div>
                )}
                {tpl && <pre className="wa-preview">{fill(tpl.body, paramsFor(ready[0] || { name: 'Rahul' }))}</pre>}
              </div>

              <div className="card">
                <h2>2 · Recipients</h2>
                <div className="tabs">
                  <button className={`btn sm ${source === 'employees' ? 'primary' : ''}`} onClick={() => setSource('employees')}>Employees</button>
                  <button className={`btn sm ${source === 'paste' ? 'primary' : ''}`} onClick={() => setSource('paste')}>Paste a list</button>
                </div>
                {source === 'employees' ? (
                  <>
                    <label className="check"><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? Object.fromEntries(withMobile.map((x) => [x._id, true])) : {})} /> <b>Everyone with a mobile number ({withMobile.length})</b></label>
                    <div className="pick-list">
                      {d.employees.map((e) => (
                        <label key={e._id} className={`check ${e.mobile ? '' : 'off'}`}>
                          <input type="checkbox" disabled={!e.mobile} checked={!!picked[e._id]} onChange={(ev) => setPicked({ ...picked, [e._id]: ev.target.checked })} />
                          <span>{e.name} <span className="muted small">{e.employeeId} · {e.mobile || 'no mobile number'}</span></span>
                        </label>))}
                    </div>
                  </>
                ) : (
                  <Field label="One person per line: Name, mobile number" hint="10-digit Indian numbers get +91 automatically. Other countries: include the country code.">
                    <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Rahul Kumar, 9876543210\nPriya Verma, 9123456780'} spellCheck={false} />
                  </Field>
                )}
                <div className="muted small" style={{ marginTop: 8 }}>{ready.length} ready to send{recipients.length > ready.length ? ` · ${recipients.length - ready.length} without a number (skipped)` : ''}</div>
              </div>

              <div className="savebar">
                <span className="muted small" style={{ marginRight: 'auto' }}>
                  {progress ? `Sending… ${progress.done} of ${progress.total}` : !tpl ? 'Choose a template' : missing.length ? 'Fill in every value' : `${ready.length} recipient${ready.length === 1 ? '' : 's'}`}
                </span>
                <button className="btn primary" disabled={!!progress || !tpl || missing.length > 0 || !ready.length} onClick={send}>{progress ? 'Sending…' : 'Send on WhatsApp'}</button>
              </div>

              {results && (
                <div className="card" style={{ marginTop: 12 }}>
                  <h2>Result: {results.filter((r) => r.status === 'SENT').length} sent, {results.filter((r) => r.status !== 'SENT').length} failed</h2>
                  {results.map((r, i) => (
                    <div key={i} className="row between wa-row"><span>{r.name || r.to} <span className="muted small">{r.to}</span>{r.error && <div className="muted small">{r.error}</div>}</span><Badge tone={tone(r.status)}>{r.status === 'SENT' ? 'Sent' : 'Failed'}</Badge></div>))}
                </div>
              )}
            </>
          )}

          {tab === 'templates' && (
            <>
              <div className="card">
                <h2>Ready-made templates</h2>
                <p className="muted small" style={{ marginTop: 0 }}>WhatsApp only allows approved templates for the first message to someone. Submit these once; Meta usually approves within minutes to a day.</p>
                {d.presets.map((p) => (
                  <div key={p.name} className="wa-tpl">
                    <div className="row between"><b>{p.label}</b>{p.status ? <Badge tone={tone(p.status)}>{p.status}</Badge> : <button className="btn sm primary" onClick={() => submitPreset(p.name)}>Submit for approval</button>}</div>
                    <pre className="wa-preview">{p.text}</pre>
                  </div>))}
              </div>
              <div className="card">
                <h2>All templates on this account</h2>
                {d.templates.map((t) => (
                  <div key={`${t.name}|${t.language}`} className="row between wa-row"><span>{t.name} <span className="muted small">{t.language} · {t.category}{t.status === 'APPROVED' && !t.usable ? ' · needs media/buttons (not supported here)' : ''}</span></span><Badge tone={tone(t.status)}>{t.status}</Badge></div>))}
              </div>
            </>
          )}

          {tab === 'history' && (
            <div className="card">
              <h2>Last 100 messages</h2>
              {!d.history.length && <p className="muted">Nothing sent yet.</p>}
              {d.history.map((m) => (
                <div key={m._id} className="row between wa-row">
                  <span>{m.name || m.to} <span className="muted small">{m.to} · {m.template} · {fmtDateTime(m.createdAt)}</span>{m.error && <div className="muted small">{m.error}</div>}</span>
                  <Badge tone={tone(m.status)}>{m.status === 'SENT' ? 'Sent' : 'Failed'}</Badge>
                </div>))}
            </div>
          )}
        </>
      )}
    </>
  );
}
