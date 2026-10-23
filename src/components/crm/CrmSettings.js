'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import Logo from '@/components/Logo';
import { Badge, Field, Skeleton } from '@/components/ui';
import { AgentSetup } from '@/components/AiPortal';
import { MediaLibrary, TemplatesTab } from '@/components/WaTemplates';

function Connect({ d, onSaved }) {
  const [f, setF] = useState({ phoneId: d.phoneId, businessId: d.businessId, token: '', appSecret: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/crm/config', { method: 'POST', body: f });
      onSaved(`WhatsApp connected: ${r.account.number}.${r.corrected ? ` WhatsApp Business Account ID ${r.businessId} was found from the token and saved.` : ''}`);
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={save}>
      <h2>Connection</h2>
      <p className="muted small" style={{ marginTop: 0 }}>From Meta for Developers → your app → WhatsApp → API Setup. Use a permanent (System User) token: the temporary one stops working after 24 hours.</p>
      <div className="form two">
        <Field label="Phone number ID"><input value={f.phoneId} onChange={set('phoneId')} inputMode="numeric" required /></Field>
        <Field label="WhatsApp Business Account ID (optional)" hint="Leave empty: it is found from the token."><input value={f.businessId} onChange={set('businessId')} inputMode="numeric" placeholder="Found automatically" /></Field>
        <Field label="Access token" span hint={d.hasToken ? 'A token is saved. Leave blank to keep it.' : undefined}>
          <textarea rows={2} value={f.token} onChange={set('token')} placeholder={d.hasToken ? '•••••••• (saved)' : 'Paste the token'} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="App secret (optional)" span hint={d.webhook?.hasAppSecret ? 'Saved. Leave blank to keep it.' : 'App settings → Basic → App secret. Lets the app check that webhook calls really come from Meta.'}>
          <input value={f.appSecret} onChange={set('appSecret')} placeholder={d.webhook?.hasAppSecret ? '•••••••• (saved)' : ''} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      {d.webhook && <Webhook w={d.webhook} />}
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy}>{busy ? 'Checking…' : 'Save and check'}</button></div>
    </form>
  );
}

// What to type into Meta → WhatsApp → Configuration → Webhook.
function Webhook({ w }) {
  const [copied, setCopied] = useState('');
  const copy = (k, v) => navigator.clipboard?.writeText(v).then(() => { setCopied(k); setTimeout(() => setCopied(''), 1500); });
  const row = (k, label, v) => (
    <Field label={label} span>
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <input readOnly value={v} onFocus={(e) => e.target.select()} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
        <button type="button" className="btn sm" onClick={() => copy(k, v)}>{copied === k ? 'Copied' : 'Copy'}</button>
      </div>
    </Field>
  );
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <h3 style={{ margin: '0 0 4px' }}>Webhook (delivery ticks and replies)</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Meta for Developers → your app → WhatsApp → Configuration → Webhook → Edit. Paste these two, press Verify and save, then subscribe to <b>messages</b>.</p>
      <div className="form">{row('url', 'Callback URL', w.callbackUrl)}{row('token', 'Verify token', w.verifyToken)}</div>
    </div>
  );
}

/** The connected number, shown as the company. */
export function SenderCard({ d }) {
  if (!d.account) return null;
  return (
    <div className="crm-sender">
      <Logo size={40} />
      <div style={{ minWidth: 0 }}>
        <b>Shine Infosolutions</b> <span className="muted">· {d.account.number}</span>
        <div className="muted small">WhatsApp sender{d.account.tier ? ` · up to ${d.account.tier.replace('TIER_', '')} new chats a day` : ''}
          {d.account.name && d.account.name !== 'Shine Infosolutions' ? ` · shows as "${d.account.name}" (change in Meta WhatsApp Manager)` : ''}</div>
      </div>
      <Badge tone={d.account.test ? 'warn' : 'ok'}>{d.account.test ? 'Test number' : 'Live'}</Badge>
    </div>
  );
}

const TPL_HINT = { brochure: 'Sales → WhatsApp → Templates: "Sales brochure (PDF)"', task: 'Employees → WhatsApp → Templates: "Task assigned (automatic)"', absent: 'Employees → WhatsApp → Templates: "No attendance yet (automatic)"' };

/** Brochure after an interested call, task on WhatsApp, "no attendance yet" message. */
function Automations({ d, load }) {
  const [a, setA] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api('/crm/auto').then((r) => setA(r.auto)).catch((e) => setErr(e.message)); }, []);
  if (err && !a) return <div className="alert">{err}</div>;
  if (!a) return <Skeleton />;
  const save = async (k, patch) => {
    setBusy(k); setErr(''); setMsg('');
    try { const r = await api('/crm/auto', { method: 'PUT', body: { [k]: { ...a[k], ...patch } } }); setA(r.auto); setMsg('Saved.'); } catch (e) { setErr(e.message); }
    setBusy('');
  };
  const usable = (d.templates || []).filter((t) => t.usable);
  const approved = (k) => usable.some((t) => t.name === a[k].template && t.language === a[k].language);
  const TplSelect = ({ k, filter = () => true }) => (
    <Field label="Template">
      <select value={`${a[k].template}|${a[k].language}`} onChange={(e) => { const [template, language] = e.target.value.split('|'); save(k, { template, language }); }}>
        {!approved(k) && <option value={`${a[k].template}|${a[k].language}`}>{a[k].template} (not approved yet)</option>}
        {usable.filter(filter).map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language})</option>)}
      </select>
    </Field>
  );
  const Toggle = ({ k, title, children }) => (
    <div className={`card crm-auto ${a[k].on ? 'on' : ''}`}>
      <div className="row between">
        <div><h3 style={{ margin: 0 }}>{title}</h3><div className="muted small">{children}</div></div>
        <label className="switch"><input type="checkbox" checked={a[k].on} disabled={busy === k} onChange={(e) => save(k, { on: e.target.checked })} /><span aria-hidden="true" /><span className="sr-only">{title}</span></label>
      </div>
      {!approved(k) && <div className="alert warn small" style={{ margin: '10px 0 0' }}>The template is not approved yet. Submit it under {TPL_HINT[k]}.</div>}
    </div>
  );
  return (
    <>
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert">{err}</div>}
      <Toggle k="brochure" title="Brochure after an interested call">When a sales call (IVR or AI) ends with the lead marked <b>Interested</b>, the brochure PDF goes to them on WhatsApp. Once per lead.</Toggle>
      <div className="card crm-auto-body">
        <div className="form two">
          <TplSelect k="brochure" filter={(t) => t.media === 'DOCUMENT'} />
          <Field label="Services named in the message"><input defaultValue={a.brochure.services} maxLength={200} onBlur={(e) => e.target.value !== a.brochure.services && save('brochure', { services: e.target.value })} /></Field>
        </div>
        <label style={{ marginTop: 10, display: 'block' }}>Brochure PDF</label>
        <MediaLibrary items={d.media || []} kind="DOCUMENT" picked={a.brochure.mediaId} onPick={(f) => save('brochure', { mediaId: f._id })} onChange={(f) => { load(); if (f) save('brochure', { mediaId: f._id }); }} />
        <p className="muted small" style={{ marginBottom: 0 }}>WhatsApp keeps an uploaded file for 30 days. Upload the PDF again after that; until then a failed send shows in Sales → History.</p>
      </div>

      <Toggle k="task" title="Tasks on WhatsApp">When a task is assigned, the employee also gets it on WhatsApp: the task, the day it is due and who assigned it.</Toggle>
      <div className="card crm-auto-body"><div className="form two"><TplSelect k="task" filter={(t) => !t.media} /></div></div>

      <Toggle k="absent" title="No attendance yet">Every working day (not Sunday), employees who have not checked in some time after office start get a polite WhatsApp asking them to check in or inform their manager.</Toggle>
      <div className="card crm-auto-body">
        <div className="form two">
          <TplSelect k="absent" filter={(t) => !t.media} />
          <Field label="Send after office start (minutes)"><input type="number" min={0} max={600} defaultValue={a.absent.afterMin} onBlur={(e) => Number(e.target.value) !== a.absent.afterMin && save('absent', { afterMin: Number(e.target.value) })} /></Field>
        </div>
      </div>
    </>
  );
}

const TABS = [['whatsapp', 'WhatsApp connection'], ['auto', 'Automatic messages'], ['agent', 'AI agent'], ['templates', 'All templates']];

/** CRM settings in one place: WhatsApp connection, automatic messages, what the AI agent says, every template. */
export default function CrmSettings({ d, load, onBack }) {
  const [tab, setTab] = useState(d.configured ? 'auto' : 'whatsapp');
  const [note, setNote] = useState('');
  return (
    <>
      <div className="crm-subtabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setNote(''); }}>{l}</button>)}
      </div>
      {note && <div className="alert ok">{note}</div>}
      {tab === 'whatsapp' && (
        <>
          {d.account && <div className="card"><SenderCard d={d} /></div>}
          {d.error && <div className="alert">{d.error}</div>}
          <Connect d={d} onSaved={(m) => { setNote(m); load(); }} />
        </>
      )}
      {tab === 'auto' && (d.configured ? <Automations d={d} load={load} /> : <div className="alert warn">Connect WhatsApp first.</div>)}
      {tab === 'agent' && <div className="card"><AgentSetup canEdit /></div>}
      {tab === 'templates' && (d.configured ? <TemplatesTab d={d} load={load} setNote={setNote} /> : <div className="alert warn">Connect WhatsApp first.</div>)}
      <button type="button" className="btn" style={{ marginTop: 12 }} onClick={onBack}>Back to CRM</button>
    </>
  );
}
