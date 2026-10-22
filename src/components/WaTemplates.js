'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { Badge, Field } from '@/components/ui';
import Icon from '@/components/Icon';

/*
 * WhatsApp templates on the CRM page: a builder (header text / image / video / PDF, body with values, footer, buttons)
 * with a live WhatsApp-style preview, the list of templates at Meta, and the media library for headers.
 */
const KIND = { IMAGE: 'Image', VIDEO: 'Video', DOCUMENT: 'PDF' };
const ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4,video/3gpp', DOCUMENT: 'application/pdf' };
const LIMIT = { IMAGE: 5, VIDEO: 16, DOCUMENT: 30 }; // MB, same as the server
export const tplTone = (s) => ({ APPROVED: 'ok', PENDING: 'warn', IN_APPEAL: 'warn', REJECTED: 'bad', PAUSED: 'bad', DISABLED: 'bad' }[s] || '');
const STATUS_LABEL = { APPROVED: 'Approved', PENDING: 'In review', REJECTED: 'Rejected', PAUSED: 'Paused', DISABLED: 'Disabled', IN_APPEAL: 'In appeal' };
const fill = (text, values) => String(text || '').replace(/\{\{(\d+)\}\}/g, (_, n) => values?.[n - 1] || `{{${n}}}`);
const varsIn = (text) => [...new Set((String(text || '').match(/\{\{(\d+)\}\}/g) || []).map((m) => Number(m.slice(2, -2))))].sort((a, b) => a - b);
const mb = (n) => `${(n / 1024 / 1024).toFixed(n < 1048576 ? 2 : 1)} MB`;

async function upload(path, form) {
  const res = await fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin', signal: AbortSignal.timeout(180000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

/** A WhatsApp chat bubble: header (text / image / video / PDF), body, footer and buttons. */
export function WaPreview({ header, mediaUrl, mediaName, body, footer, buttons = [] }) {
  const f = header?.format;
  return (
    <div className="wa-chat" aria-label="Message preview">
      <div className="wa-bubble">
        {f === 'TEXT' && header.text && <div className="wa-h">{header.text}</div>}
        {f === 'IMAGE' && (mediaUrl ? <img className="wa-media" src={mediaUrl} alt="Header" /> : <div className="wa-media ph"><Icon name="camera" size={28} /><span>Image</span></div>)}
        {f === 'VIDEO' && <div className="wa-media ph"><Icon name="play" size={28} /><span>{mediaName || 'Video'}</span></div>}
        {f === 'DOCUMENT' && <div className="wa-doc"><span className="wa-pdf">PDF</span><span>{mediaName || 'brochure.pdf'}</span></div>}
        <div className="wa-body">{body || <span className="muted">Your message…</span>}</div>
        {footer && <div className="wa-foot">{footer}</div>}
        <div className="wa-time">10:30</div>
      </div>
      {buttons.filter((b) => b.text).map((b, i) => (
        <div key={i} className="wa-btn">{b.type === 'URL' ? '↗ ' : b.type === 'PHONE_NUMBER' ? '✆ ' : '↩ '}{b.text}</div>))}
    </div>
  );
}

const blank = { name: '', category: 'MARKETING', language: 'en', purpose: 'BULK', header: { format: 'NONE', text: '', example: '' }, body: '', examples: [], fields: [], footer: '', buttons: [] };

function fromPreset(p) {
  return { ...blank, name: p.name, category: p.category, purpose: p.purpose, header: { format: p.header?.format || 'NONE', text: p.header?.text || '', example: '' },
    body: p.text, examples: [...(p.example || [])], fields: [...(p.fields || [])], footer: p.footer || '', buttons: (p.buttons || []).map((b) => ({ ...b })) };
}

export function TemplateBuilder({ start, onClose, onDone }) {
  const [t, setT] = useState(() => (start ? fromPreset(start) : { ...blank }));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bodyRef = useRef(null);
  const preview = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : ''), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const nums = varsIn(t.body);
  const set = (k, v) => setT((x) => ({ ...x, [k]: v }));
  const setHeader = (k, v) => setT((x) => ({ ...x, header: { ...x.header, [k]: v } }));
  const media = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header.format);
  const addVar = () => {
    const n = (nums.at(-1) || 0) + 1, el = bodyRef.current, at = el ? el.selectionStart : t.body.length;
    set('body', `${t.body.slice(0, at)}{{${n}}}${t.body.slice(at)}`);
  };
  const setBtn = (i, k, v) => set('buttons', t.buttons.map((b, j) => (j === i ? { ...b, [k]: v } : b)));
  const pickFile = (e) => {
    const f = e.target.files?.[0] || null;
    setErr('');
    if (f && f.size > LIMIT[t.header.format] * 1048576) { setErr(`File too big: up to ${LIMIT[t.header.format]} MB`); e.target.value = ''; return; }
    setFile(f);
  };
  const submit = async () => {
    setBusy(true); setErr('');
    const def = { ...t, name: t.name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'), examples: nums.map((n) => t.examples[n - 1] || ''), fields: nums.map((n) => t.fields[n - 1] || '') };
    try {
      let r;
      if (media) {
        const form = new FormData();
        form.append('def', JSON.stringify(def));
        if (file) form.append('sample', file);
        r = await upload('/crm/templates', form);
      } else r = await api('/crm/templates', { method: 'POST', body: { def } });
      onDone(r);
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="card tb">
      <div className="card-head"><h2 style={{ margin: 0 }}>{start ? `New template: ${start.label}` : 'New template'}</h2><button className="btn sm" onClick={onClose}>Close</button></div>
      <div className="tb-grid">
        <div className="tb-form">
          <div className="form two">
            <Field label="Template name" hint="Lowercase, numbers and _ (for example diwali_offer)">
              <input value={t.name} onChange={(e) => set('name', e.target.value.toLowerCase().replace(/\s+/g, '_'))} placeholder="diwali_offer" maxLength={60} />
            </Field>
            <Field label="Category" hint={t.category === 'MARKETING' ? 'Offers, promotions, brochures, feedback' : 'Updates the person expects: interviews, reminders, confirmations'}>
              <select value={t.category} onChange={(e) => set('category', e.target.value)}><option value="MARKETING">Marketing</option><option value="UTILITY">Utility</option></select>
            </Field>
            <Field label="Language">
              <select value={t.language} onChange={(e) => set('language', e.target.value)}><option value="en">English</option><option value="hi">Hindi</option><option value="en_US">English (US)</option></select>
            </Field>
            <Field label="Used for">
              <select value={t.purpose} onChange={(e) => set('purpose', e.target.value)}>
                {[['OFFER', 'Offer'], ['SALES', 'Sales'], ['FEEDBACK', 'Feedback'], ['INTERVIEW', 'Interview'], ['WELCOME', 'Welcome'], ['BULK', 'Other / updates']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
          </div>

          <h3 className="tb-sec">Header <span className="muted small">(optional)</span></h3>
          <div className="seg">
            {[['NONE', 'None'], ['TEXT', 'Text'], ['IMAGE', 'Image'], ['VIDEO', 'Video'], ['DOCUMENT', 'PDF']].map(([k, l]) => (
              <button key={k} type="button" className={t.header.format === k ? 'on' : ''} onClick={() => { setHeader('format', k); setFile(null); }}>{l}</button>))}
          </div>
          {t.header.format === 'TEXT' && (
            <Field label="Header text" hint="Up to 60 characters"><input value={t.header.text} onChange={(e) => setHeader('text', e.target.value)} maxLength={60} placeholder="Diwali offer for you" /></Field>
          )}
          {media && (
            <Field label={`Sample ${KIND[t.header.format].toLowerCase()} for Meta's review`} hint={`${t.header.format === 'DOCUMENT' ? 'PDF' : t.header.format === 'IMAGE' ? 'JPG or PNG' : 'MP4'}, up to ${LIMIT[t.header.format]} MB. When sending you can attach a different file each time.`}>
              <input type="file" accept={ACCEPT[t.header.format]} onChange={pickFile} />
              {file && <div className="muted small" style={{ marginTop: 4 }}>{file.name} · {mb(file.size)}</div>}
            </Field>
          )}

          <h3 className="tb-sec">Message</h3>
          <Field label="Text" hint="Use {{1}}, {{2}}… for things that change per person (name, offer, date)">
            <textarea ref={bodyRef} rows={7} value={t.body} onChange={(e) => set('body', e.target.value)} maxLength={1024} placeholder={'Hello {{1}},\n\nWe have a special offer for you: {{2}}'} />
            <div className="row between" style={{ marginTop: 6 }}>
              <button type="button" className="btn sm" onClick={addVar}>+ Add value {`{{${(nums.at(-1) || 0) + 1}}}`}</button>
              <span className="muted small">{t.body.length} / 1024</span>
            </div>
          </Field>
          {nums.length > 0 && (
            <div className="tb-vars">
              {nums.map((n) => (
                <div key={n} className="tb-var">
                  <span className="tb-n">{`{{${n}}}`}</span>
                  <input aria-label={`Label for {{${n}}}`} placeholder="Label (e.g. Customer name)" value={t.fields[n - 1] || ''} onChange={(e) => { const a = [...t.fields]; a[n - 1] = e.target.value; set('fields', a); }} />
                  <input aria-label={`Example for {{${n}}}`} placeholder="Example (e.g. Rahul)" value={t.examples[n - 1] || ''} onChange={(e) => { const a = [...t.examples]; a[n - 1] = e.target.value; set('examples', a); }} />
                </div>))}
              <p className="muted small" style={{ margin: 0 }}>Meta checks the template with the examples. Labels are only for this CRM.</p>
            </div>
          )}
          <Field label="Footer (optional)" hint="Small grey text, up to 60 characters"><input value={t.footer} onChange={(e) => set('footer', e.target.value)} maxLength={60} placeholder="Shine Infosolutions" /></Field>

          <h3 className="tb-sec">Buttons <span className="muted small">(optional, up to 10)</span></h3>
          {t.buttons.map((b, i) => (
            <div key={i} className="tb-btn">
              <select value={b.type} onChange={(e) => setBtn(i, 'type', e.target.value)} aria-label="Button type">
                <option value="QUICK_REPLY">Quick reply</option><option value="URL">Open link</option><option value="PHONE_NUMBER">Call</option>
              </select>
              <input value={b.text} onChange={(e) => setBtn(i, 'text', e.target.value)} maxLength={25} placeholder="Button text" aria-label="Button text" />
              {b.type === 'URL' && <input value={b.url || ''} onChange={(e) => setBtn(i, 'url', e.target.value)} placeholder="https://shineinfosolutions.in" aria-label="Link" />}
              {b.type === 'PHONE_NUMBER' && <input value={b.phone || ''} onChange={(e) => setBtn(i, 'phone', e.target.value)} placeholder="+919876543210" aria-label="Phone number" />}
              {b.type === 'QUICK_REPLY' && <span className="muted small">Tapping it sends this text back</span>}
              <button type="button" className="btn sm" onClick={() => set('buttons', t.buttons.filter((_, j) => j !== i))} aria-label="Remove button">Remove</button>
            </div>))}
          {t.buttons.length < 10 && (
            <div className="row">
              <button type="button" className="btn sm" onClick={() => set('buttons', [...t.buttons, { type: 'QUICK_REPLY', text: '' }])}>+ Quick reply</button>
              <button type="button" className="btn sm" onClick={() => set('buttons', [...t.buttons, { type: 'URL', text: 'Visit website', url: 'https://' }])}>+ Link</button>
              <button type="button" className="btn sm" onClick={() => set('buttons', [...t.buttons, { type: 'PHONE_NUMBER', text: 'Call us', phone: '+91' }])}>+ Call</button>
            </div>)}
        </div>

        <div className="tb-side">
          <div className="muted small" style={{ marginBottom: 6 }}>Preview (with your examples)</div>
          <WaPreview header={t.header} mediaUrl={preview} mediaName={file?.name} body={fill(t.body, t.examples)} footer={t.footer} buttons={t.buttons} />
        </div>
      </div>
      {err && <div className="alert" style={{ marginTop: 12 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <span className="muted small" style={{ marginRight: 'auto' }}>Meta reviews it, usually within minutes, at most a day.</span>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy || !t.name || !t.body.trim() || (media && !file)}>{busy ? 'Submitting…' : 'Submit for approval'}</button>
      </div>
    </div>
  );
}

/** Uploaded headers (brochures, images, videos). `pick(kind)` mode lets the composer choose one. */
export function MediaLibrary({ items, onChange, kind, picked, onPick }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const list = kind ? items.filter((x) => x.kind === kind) : items;
  const add = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy(true); setErr('');
    const fd = new FormData();
    fd.append('file', f);
    try { const r = await upload('/crm/media', fd); onChange(r.item); } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const remove = async (id) => {
    if (!window.confirm('Remove this file from the library?')) return;
    try { await api(`/crm/media?id=${id}`, { method: 'DELETE' }); onChange(); } catch (x) { setErr(x.message); }
  };
  const days = (d) => Math.max(0, Math.ceil((new Date(d) - Date.now()) / 86400000));
  return (
    <div className="media-lib">
      {err && <div className="alert">{err}</div>}
      {!list.length && <p className="muted small" style={{ margin: '4px 0 10px' }}>No {kind ? KIND[kind].toLowerCase() : 'files'} uploaded yet.</p>}
      <div className="media-grid">
        {list.map((m) => (
          <div key={m._id} className={`media-item ${picked === m._id ? 'on' : ''}`}>
            <span className={`media-ico k-${m.kind.toLowerCase()}`}>{m.kind === 'DOCUMENT' ? 'PDF' : m.kind === 'IMAGE' ? 'IMG' : 'VID'}</span>
            <div className="media-meta"><b title={m.name}>{m.name}</b><span className="muted small">{mb(m.size || 0)} · {days(m.expiresAt)} days left</span></div>
            {onPick
              ? <button className={`btn sm ${picked === m._id ? 'primary' : ''}`} onClick={() => onPick(m)}>{picked === m._id ? 'Selected' : 'Use'}</button>
              : <button className="btn sm" onClick={() => remove(m._id)}>Remove</button>}
          </div>))}
      </div>
      <label className={`btn sm ${busy ? 'disabled' : ''}`} style={{ marginTop: 10 }}>
        <input type="file" hidden accept={kind ? ACCEPT[kind] : 'application/pdf,image/jpeg,image/png,video/mp4'} onChange={add} disabled={busy} />
        {busy ? 'Uploading…' : `+ Upload ${kind ? KIND[kind].toLowerCase() : 'PDF, image or video'}`}
      </label>
    </div>
  );
}

/** The Templates tab: start from a ready-made one or blank, the templates at Meta, and the media library. */
export function TemplatesTab({ d, load, setNote }) {
  const [start, setStart] = useState(undefined); // undefined = closed, null = blank, preset = from preset
  const del = async (name) => {
    if (!window.confirm(`Delete the template "${name}" at WhatsApp? This cannot be undone.`)) return;
    try { await api(`/crm/templates?name=${name}`, { method: 'DELETE' }); setNote(`Template "${name}" deleted.`); load(); } catch (e) { setNote(e.message); }
  };
  return (
    <>
      {start !== undefined ? (
        <TemplateBuilder start={start} onClose={() => setStart(undefined)}
          onDone={(r) => { setStart(undefined); setNote(`"${r.name}" sent to Meta for approval (${STATUS_LABEL[r.status] || r.status}).${r.media ? ` The sample file was added to the media library.` : ''}`); load(); }} />
      ) : (
        <div className="card">
          <div className="card-head"><h2>Create a template</h2><button className="btn primary sm" onClick={() => setStart(null)}>+ Blank template</button></div>
          <p className="muted small" style={{ marginTop: 0 }}>WhatsApp needs an approved template for the first message to someone. Start from one of these, change anything, attach a sample image / video / PDF if it has one, and submit.</p>
          <div className="preset-grid">
            {d.presets.map((p) => (
              <button key={p.name} className="preset" onClick={() => setStart(p)}>
                <span className="row between" style={{ width: '100%' }}><b>{p.label}</b>{p.status && <Badge tone={tplTone(p.status)}>{STATUS_LABEL[p.status] || p.status}</Badge>}</span>
                <span className="muted small">{p.category === 'MARKETING' ? 'Marketing' : 'Utility'}{p.header?.format && p.header.format !== 'NONE' ? ` · ${KIND[p.header.format] || 'Text'} header` : ''}{p.buttons?.length ? ` · ${p.buttons.length} buttons` : ''}</span>
                <span className="preset-text">{p.text}</span>
              </button>))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Templates on this WhatsApp account</h2><button className="btn sm" onClick={load}>Refresh status</button></div>
        {!d.templates.length && <p className="muted">None yet.</p>}
        <div className="tpl-list">
          {d.templates.map((t) => (
            <div key={`${t.name}|${t.language}`} className="tpl-row">
              <div className="tpl-main">
                <div><b>{t.name}</b> <span className="muted small">{t.language} · {t.category === 'MARKETING' ? 'Marketing' : t.category === 'UTILITY' ? 'Utility' : t.category}{t.media ? ` · ${KIND[t.media]} header` : ''}{t.buttons?.length ? ` · ${t.buttons.length} buttons` : ''}</span></div>
                <div className="muted small tpl-body">{t.body}</div>
                {t.reason && <div className="small" style={{ color: 'var(--bad)' }}>Rejected: {t.reason.replace(/_/g, ' ').toLowerCase()}</div>}
                {t.status === 'APPROVED' && !t.supported && <div className="muted small">Has parts this page cannot send (carousel, location or special buttons).</div>}
              </div>
              <div className="tpl-side"><Badge tone={tplTone(t.status)}>{STATUS_LABEL[t.status] || t.status}</Badge><button className="btn sm" onClick={() => del(t.name)} aria-label={`Delete ${t.name}`}>Delete</button></div>
            </div>))}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Media library</h2><span className="muted small">Brochures, images and videos for template headers. WhatsApp keeps each file 30 days.</span></div>
        <MediaLibrary items={d.media || []} onChange={() => load()} />
      </div>
    </>
  );
}

export { fill as fillTemplate, KIND as MEDIA_KIND };
