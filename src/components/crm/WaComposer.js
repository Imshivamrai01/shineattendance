'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client';
import { Badge, Field } from '@/components/ui';
import { TemplatesTab, WaPreview, MediaLibrary, MEDIA_KIND } from '@/components/WaTemplates';
import { parseList, firstName, waTone, Blank } from './shared';

const CHUNK = 20;
const fill = (text, params) => text.replace(/\{\{(\d+)\}\}/g, (_, n) => params[n - 1] || `{{${n}}}`);

/**
 * WhatsApp for one CRM section: pick an approved template (only the ones made for this section, unless "all"),
 * pick people, fill the values, preview, send. "Templates" makes new ones and submits them to Meta for approval.
 *  d         /api/crm (templates, presets, media library)
 *  purposes  template purposes that belong here, e.g. ['INTERVIEW']
 *  people    [{ key, name, phone, sub, userId?, leadId?, listId?, contactId? }] to pick from
 *  prefill   { 2: 'Sales Executive', 3: '28 Oct' } values filled in when a template is chosen
 *  toolbar   filters shown above the people list (search box…)
 */
export default function WaComposer({ d, load, purposes, people = [], peopleLabel = 'people', prefill = {}, toolbar, allowPaste = true }) {
  const [view, setView] = useState('send');
  const [all, setAll] = useState(false);
  const [tplKey, setTplKey] = useState('');
  const [values, setValues] = useState({});
  const [nameVar, setNameVar] = useState(true);
  const [headerMedia, setHeaderMedia] = useState(null);
  const [headerText, setHeaderText] = useState('');
  const [urlVals, setUrlVals] = useState({});
  const [picked, setPicked] = useState({});
  const [source, setSource] = useState(people.length || !allowPaste ? 'people' : 'paste');
  const [pasted, setPasted] = useState('');
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [note, setNote] = useState('');

  const usable = useMemo(() => (d.templates || []).filter((t) => t.usable && (all || purposes.includes(t.purpose))), [d, all, purposes]);
  const tpl = usable.find((t) => `${t.name}|${t.language}` === tplKey);
  useEffect(() => { if (!tpl && usable.length === 1) setTplKey(`${usable[0].name}|${usable[0].language}`); }, [tpl, usable]);
  useEffect(() => { setValues(Object.fromEntries(Object.entries(prefill).filter(([, v]) => v))); setResults(null); setHeaderMedia(null); setHeaderText(''); setUrlVals({}); }, [tplKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const urlButtons = (tpl?.buttons || []).map((b, i) => ({ ...b, index: i })).filter((b) => b.type === 'URL' && b.vars);
  const recipients = source === 'people' ? people.filter((p) => picked[p.key]) : parseList(pasted).map((r, i) => ({ ...r, key: `p${i}` }));
  const ready = recipients.filter((r) => r.phone);
  const paramsFor = (r) => Array.from({ length: tpl?.vars || 0 }, (_, i) => (i === 0 && nameVar ? firstName(r.name) : values[i + 1] || ''));
  const missing = tpl ? [
    ...Array.from({ length: tpl.vars }, (_, i) => i + 1).filter((n) => !(n === 1 && nameVar) && !String(values[n] || '').trim()).map((n) => tpl.fields?.[n - 1] || `value {{${n}}}`),
    ...(tpl.media && !headerMedia ? ['header file'] : []), ...(tpl.header?.vars && !headerText.trim() ? ['header text'] : []),
    ...urlButtons.filter((b) => !(urlVals[b.index] || '').trim()).map((b) => b.text),
  ] : [];
  const withPhone = people.filter((p) => p.phone);
  const allPicked = withPhone.length > 0 && withPhone.every((p) => picked[p.key]);

  const send = async () => {
    if (!window.confirm(`Send "${tpl.name}" on WhatsApp to ${ready.length} ${ready.length === 1 ? 'person' : 'people'}?`)) return;
    const batch = `b-${Date.now()}`; const out = [];
    setResults(null); setProgress({ done: 0, total: ready.length });
    for (let i = 0; i < ready.length; i += CHUNK) {
      const part = ready.slice(i, i + CHUNK).map((r) => ({ name: r.name, phone: r.phone, userId: r.userId, leadId: r.leadId, listId: r.listId, contactId: r.contactId, params: paramsFor(r) }));
      try {
        const r = await api('/crm/send', { method: 'POST', body: { template: tpl.name, language: tpl.language, purpose: tpl.purpose || purposes[0], batch, recipients: part,
          header: headerMedia ? { mediaId: headerMedia._id } : headerText ? { text: headerText } : undefined, buttons: urlButtons.map((b) => ({ index: b.index, text: urlVals[b.index] || '' })) } });
        out.push(...r.results);
      } catch (e) { out.push(...part.map((r) => ({ to: r.phone, name: r.name, status: 'FAILED', error: e.message }))); }
      setProgress({ done: Math.min(i + CHUNK, ready.length), total: ready.length });
    }
    setProgress(null); setResults(out); load();
  };

  if (!d.configured) return <Blank icon="whatsapp" title="WhatsApp is not connected">Open Settings (top right) and connect the business number first.</Blank>;
  const scoped = { ...d, presets: d.presets.filter((p) => purposes.includes(p.purpose)), templates: d.templates.filter((t) => purposes.includes(t.purpose)) };
  return (
    <>
      <div className="crm-subtabs">
        <button type="button" className={view === 'send' ? 'on' : ''} onClick={() => setView('send')}>Send message</button>
        <button type="button" className={view === 'templates' ? 'on' : ''} onClick={() => setView('templates')}>Templates &amp; approval</button>
      </div>
      {note && <div className="alert ok">{note}</div>}
      {view === 'templates' ? <TemplatesTab d={scoped} load={load} setNote={setNote} /> : (
        <div className="crm-compose">
          <div className="card crm-compose-main">
            <div className="crm-step"><span>1</span><h2>Message</h2></div>
            {!usable.length ? (
              <Blank icon="file" title="No approved template here yet">
                Open <button type="button" className="linkish" onClick={() => setView('templates')}>Templates &amp; approval</button>, start from a ready-made one and submit it to Meta. Approval usually takes a few minutes to a day.
                {!all && <div style={{ marginTop: 6 }}><button type="button" className="linkish" onClick={() => setAll(true)}>Use a template from another section</button></div>}
              </Blank>
            ) : (
              <>
                <Field label="Template" hint={all ? undefined : 'Only templates made for this section.'}>
                  <select value={tplKey} onChange={(e) => setTplKey(e.target.value)}>
                    <option value="">Choose…</option>
                    {usable.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{d.presets.find((p) => p.name === t.name)?.label || t.name} ({t.language}){t.media ? ` · ${MEDIA_KIND[t.media]}` : ''}</option>)}
                  </select>
                </Field>
                {!all && <button type="button" className="linkish small" onClick={() => setAll(true)}>Show templates from all sections</button>}
              </>
            )}
            {tpl && tpl.vars > 0 && (
              <div className="form two" style={{ marginTop: 14 }}>
                {Array.from({ length: tpl.vars }, (_, i) => i + 1).map((n) => (
                  <Field key={n} label={tpl.fields?.[n - 1] || `Value {{${n}}}`} hint={n === 1 && nameVar ? undefined : 'Same for everyone'}>
                    {n === 1 && <label className="check"><input type="checkbox" checked={nameVar} onChange={(e) => setNameVar(e.target.checked)} /> Each person&apos;s first name</label>}
                    {!(n === 1 && nameVar) && <input value={values[n] || ''} onChange={(e) => setValues({ ...values, [n]: e.target.value })} maxLength={500} />}
                  </Field>))}
              </div>
            )}
            {tpl?.media && (
              <div style={{ marginTop: 14 }}>
                <label>Header {MEDIA_KIND[tpl.media].toLowerCase()} (same for everyone)</label>
                <MediaLibrary items={d.media || []} kind={tpl.media} picked={headerMedia?._id} onPick={setHeaderMedia} onChange={(item) => { if (item) setHeaderMedia(item); load(); }} />
              </div>
            )}
            {tpl?.header?.vars > 0 && <Field label="Header value" hint={`Header: ${tpl.header.text}`}><input value={headerText} onChange={(e) => setHeaderText(e.target.value)} maxLength={60} /></Field>}
            {urlButtons.map((b) => (
              <Field key={b.index} label={`Link for the "${b.text}" button`} hint={`${b.url.replace('{{1}}', '…')}: the end of the link, same for everyone`}>
                <input value={urlVals[b.index] || ''} onChange={(e) => setUrlVals({ ...urlVals, [b.index]: e.target.value })} maxLength={500} />
              </Field>))}

            <div className="crm-step" style={{ marginTop: 22 }}><span>2</span><h2>Recipients</h2></div>
            {allowPaste && people.length > 0 && (
              <div className="crm-subtabs sm">
                <button type="button" className={source === 'people' ? 'on' : ''} onClick={() => setSource('people')}>Choose {peopleLabel}</button>
                <button type="button" className={source === 'paste' ? 'on' : ''} onClick={() => setSource('paste')}>Paste a list</button>
              </div>
            )}
            {source === 'people' ? (
              <>
                {toolbar}
                {!people.length ? <p className="muted small">No {peopleLabel} to show.</p> : (
                  <>
                    <label className="check"><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? Object.fromEntries(withPhone.map((p) => [p.key, true])) : {})} /> <b>All with a number ({withPhone.length})</b></label>
                    <div className="pick-list">
                      {people.map((p) => (
                        <label key={p.key} className={`check ${p.phone ? '' : 'off'}`}>
                          <input type="checkbox" disabled={!p.phone} checked={!!picked[p.key]} onChange={(e) => setPicked({ ...picked, [p.key]: e.target.checked })} />
                          <span>{p.name || p.phone} <span className="muted small">{[p.sub, p.phone || 'no number'].filter(Boolean).join(' · ')}</span></span>
                        </label>))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <Field label="One person per line: Name, mobile number" hint="10-digit Indian numbers get +91 automatically.">
                <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'Rahul Kumar, 9876543210\nPriya Verma, 9123456780'} spellCheck={false} />
              </Field>
            )}
          </div>

          <aside className="crm-compose-side">
            <div className="card">
              <h3>Preview</h3>
              {tpl ? (
                <WaPreview header={tpl.header ? { ...tpl.header, text: fill(tpl.header.text, [headerText]) } : null} mediaName={headerMedia?.name}
                  body={fill(tpl.body, paramsFor(ready[0] || { name: 'Rahul' }))} footer={tpl.footer} buttons={tpl.buttons} />
              ) : <p className="muted small">Choose a template to see the message.</p>}
              <div className="crm-sendbox">
                <div className="small">{progress ? `Sending… ${progress.done} of ${progress.total}` : !tpl ? 'Choose a template' : missing.length ? `Still needed: ${missing.slice(0, 3).join(', ')}` : <><b>{ready.length}</b> recipient{ready.length === 1 ? '' : 's'} ready</>}</div>
                <button type="button" className="btn primary" disabled={!!progress || !tpl || missing.length > 0 || !ready.length} onClick={send}>{progress ? 'Sending…' : 'Send on WhatsApp'}</button>
              </div>
            </div>
            {results && (
              <div className="card">
                <h3>{results.filter((r) => r.status === 'SENT').length} sent · {results.filter((r) => r.status !== 'SENT').length} failed</h3>
                {results.map((r, i) => (
                  <div key={i} className="row between wa-row"><span>{r.name || r.to}{r.error && <div className="muted small">{r.error}</div>}</span><Badge tone={waTone(r.status)}>{r.status === 'SENT' ? 'Sent' : 'Failed'}</Badge></div>))}
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
