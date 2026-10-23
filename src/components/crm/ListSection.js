'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime } from '@/lib/client';
import Icon from '@/components/Icon';
import { Field, Modal, Skeleton } from '@/components/ui';
import { IvrButton } from '@/components/StaffCall';
import { ScriptSelect, useAgentSetup } from '@/components/AiPortal';
import WaComposer from './WaComposer';
import History from './History';
import { Blank, ChannelTabs, ContactBadge, CONTACT_STATUS, isMobile, parseList } from './shared';

/*
 * Interview and Customers sections: work on one list at a time ("Sales Executive" candidates, "Website clients" to ask
 * for feedback). A list holds a role / topic, its date, time and venue, and any number of names + numbers.
 */

const COPY = {
  INTERVIEW: {
    noun: 'role', nouns: 'roles', person: 'candidate', people: 'candidates', newLabel: 'New role', titleLabel: 'Role', titlePh: 'Sales Executive',
    empty: 'Add a role, then the candidates for it (name and number). Call them yourself, let the AI agent invite them, or send the invite on WhatsApp.',
    purposes: ['INTERVIEW'], section: 'INTERVIEW', statuses: ['NEW', 'CALLED', 'NO_ANSWER', 'CONFIRMED', 'RESCHEDULE', 'DECLINED'],
    note: 'What they said (coming / not coming / another time)', notePh: 'Will come at 11 am; asked about salary range',
    aiHint: 'The agent tells each candidate the role, date, time and venue, asks if they can come, and offers another time if not. Each answer updates the list.',
  },
  FEEDBACK: {
    noun: 'customer group', nouns: 'groups', person: 'customer', people: 'customers', newLabel: 'New group', titleLabel: 'Feedback about', titlePh: 'Website projects delivered in October',
    empty: 'Add a group of customers (name and number) and what the feedback is about. Call them, let the AI agent ask for a rating, or send the feedback request on WhatsApp.',
    purposes: ['FEEDBACK'], section: 'FEEDBACK', statuses: ['NEW', 'CALLED', 'NO_ANSWER', 'DONE', 'COMPLAINT'],
    note: 'Their feedback', notePh: 'Happy with the website, wants a monthly SEO plan',
    aiHint: 'The agent thanks them, asks how it went and for a rating from 1 to 5, and notes any complaint. Low ratings and complaints are marked "Needs follow-up".',
  },
};

/** New list (or edit one): role / topic, date, time, venue and people, typed or pasted. */
function ListForm({ kind, list, onClose, onSaved }) {
  const c = COPY[kind];
  const [f, setF] = useState({ title: list?.title || '', date: list?.date || '', time: list?.time || '', venue: list?.venue || '', details: list?.details || '' });
  const [rows, setRows] = useState(list ? [] : [{ name: '', phone: '' }, { name: '', phone: '' }, { name: '', phone: '' }]);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const people = [...rows, ...parseList(paste)].filter((r) => r.phone.trim());
  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = list ? await api(`/crm/lists/${list._id}`, { method: 'PATCH', body: { ...f, add: people } })
        : await api('/crm/lists', { method: 'POST', body: { kind, ...f, contacts: people } });
      onSaved(r.list);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title={list ? `Edit ${c.noun}` : c.newLabel} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form two">
          <Field label={c.titleLabel} span><input value={f.title} onChange={set('title')} placeholder={c.titlePh} maxLength={120} required autoFocus /></Field>
          {kind === 'INTERVIEW' ? <>
            <Field label="Interview date"><input value={f.date} onChange={set('date')} placeholder="Mon, 28 Oct" maxLength={60} /></Field>
            <Field label="Time"><input value={f.time} onChange={set('time')} placeholder="11:00 AM" maxLength={40} /></Field>
            <Field label="Venue or meeting link" span><input value={f.venue} onChange={set('venue')} placeholder="Shine Infosolutions, Gorakhpur" maxLength={200} /></Field>
          </> : null}
          <Field label={kind === 'INTERVIEW' ? 'Anything else to tell candidates (optional)' : 'Details for the agent (optional)'} span>
            <input value={f.details} onChange={set('details')} maxLength={500} placeholder={kind === 'INTERVIEW' ? 'Bring your resume and an ID proof' : 'Ask about the support team too'} />
          </Field>
        </div>
        <h3 style={{ margin: '18px 0 6px' }}>{list ? `Add ${c.people}` : c.people[0].toUpperCase() + c.people.slice(1)}</h3>
        {rows.map((r, i) => (
          <div key={i} className="crm-person-row">
            <input aria-label={`Name ${i + 1}`} placeholder="Name" value={r.name} onChange={(e) => setRow(i, 'name', e.target.value)} maxLength={120} />
            <input aria-label={`Mobile number ${i + 1}`} placeholder="Mobile number" inputMode="tel" value={r.phone} onChange={(e) => setRow(i, 'phone', e.target.value)} maxLength={30} />
            <button type="button" className="btn sm" aria-label="Remove row" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
          </div>))}
        <button type="button" className="btn sm" onClick={() => setRows([...rows, { name: '', phone: '' }])}><Icon name="plus" size={14} /> Add another</button>
        <details style={{ marginTop: 12 }}>
          <summary className="small">Paste many at once</summary>
          <Field label="One per line: Name, mobile number" hint="From Excel or WhatsApp: copy the two columns and paste.">
            <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Rahul Kumar, 9876543210\nPriya Verma, 9123456780'} spellCheck={false} />
          </Field>
        </details>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row modal-actions">
          <span className="muted small" style={{ marginRight: 'auto' }}>{people.length} {people.length === 1 ? c.person : c.people} with a number</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : list ? 'Save' : `Create ${c.noun}`}</button>
        </div>
      </form>
    </Modal>
  );
}

/** One person's status and note, editable inline. */
function ContactStatus({ list, c, statuses, onChanged }) {
  const save = (body) => api(`/crm/lists/${list._id}`, { method: 'PATCH', body: { contact: c._id, ...body } }).then((r) => onChanged(r.list)).catch((e) => window.alert(e.message));
  return (
    <select aria-label={`Status of ${c.name}`} value={c.status} onChange={(e) => save({ status: e.target.value })} className="crm-status-select">
      {statuses.concat(statuses.includes(c.status) ? [] : [c.status]).map((s) => <option key={s} value={s}>{CONTACT_STATUS[s]?.[0] || s}</option>)}
    </select>
  );
}

function Ivr({ list, kind, onChanged }) {
  const c = COPY[kind];
  return (
    <div className="card">
      <p className="muted small" style={{ marginTop: 0 }}>Press Call: your phone rings first from the company number, then the {c.person}&apos;s. The call is recorded and summarised, and the list is updated.</p>
      <div className="table-wrap"><table className="leads">
        <thead><tr><th>{c.person[0].toUpperCase() + c.person.slice(1)}</th><th>Status</th><th>Last said</th><th></th></tr></thead>
        <tbody>{list.contacts.map((p) => (
          <tr key={p._id}>
            <td className="c-lead"><b>{p.name || '—'}</b><div className="muted small">{p.phone}</div></td>
            <td><ContactStatus list={list} c={p} statuses={c.statuses} onChanged={onChanged} /></td>
            <td className="small" style={{ minWidth: 200 }}>{p.note || <span className="muted">—</span>}{p.lastCallAt && <div className="muted small">Called {fmtDateTime(p.lastCallAt)}</div>}</td>
            <td className="nowrap"><IvrButton small person={{ _id: p._id, name: p.name || p.phone }} disabled={!isMobile(p.phone)} noteLabel={c.note} notePlaceholder={c.notePh}
              start={() => api(`/crm/lists/${list._id}/call`, { method: 'POST', body: { contact: p._id } }).finally(() => setTimeout(() => api(`/crm/lists/${list._id}`).then((r) => onChanged(r.list)), 1500))} /></td>
          </tr>))}
        </tbody>
      </table></div>
    </div>
  );
}

function Ai({ list, kind, onChanged }) {
  const c = COPY[kind];
  const [setup] = useAgentSetup();
  const [scriptId, setScriptId] = useState('');
  const [sel, setSel] = useState({});
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const callable = list.contacts.filter((p) => isMobile(p.phone));
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const allOn = callable.length > 0 && callable.every((p) => sel[p._id]);
  const pickWaiting = () => setSel(Object.fromEntries(callable.filter((p) => ['NEW', 'NO_ANSWER'].includes(p.status)).map((p) => [p._id, true])));
  const go = async () => {
    if (!window.confirm(`Let the AI agent call ${ids.length} ${ids.length === 1 ? c.person : c.people}? One call at a time, 9 am to 8:30 pm, all recorded.`)) return;
    setBusy(true); setErr('');
    try { setRes(await api(`/crm/lists/${list._id}/ai`, { method: 'POST', body: { contacts: ids, purpose: extra, scriptId } })); setSel({}); onChanged(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const about = kind === 'INTERVIEW' ? [`${list.title} interview`, list.date, list.time, list.venue].filter(Boolean).join(' · ') : `Feedback about ${list.title}`;
  return (
    <div className="crm-compose">
      <div className="card crm-compose-main">
        <p className="muted small" style={{ marginTop: 0 }}>{c.aiHint}</p>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn sm" onClick={() => setSel(allOn ? {} : Object.fromEntries(callable.map((p) => [p._id, true])))}>{allOn ? 'Clear' : `Select all ${callable.length}`}</button>
            <button type="button" className="btn sm" onClick={pickWaiting}>Only not contacted / no answer</button>
          </div>
          <span className="muted small">{ids.length} selected</span>
        </div>
        <div className="pick-list" style={{ maxHeight: 420 }}>
          {list.contacts.map((p) => (
            <label key={p._id} className={`check ${isMobile(p.phone) ? '' : 'off'}`}>
              <input type="checkbox" disabled={!isMobile(p.phone)} checked={!!sel[p._id]} onChange={(e) => setSel({ ...sel, [p._id]: e.target.checked })} />
              <span style={{ flex: 1 }}>{p.name || p.phone} <span className="muted small">{p.phone}{isMobile(p.phone) ? '' : ' · not a mobile number'}</span>
                {p.note && <div className="muted small">{p.note}</div>}</span>
              <ContactBadge s={p.status} />
            </label>))}
        </div>
      </div>
      <aside className="crm-compose-side">
        <div className="card">
          <h3>What the agent will talk about</h3>
          <div className="crm-about"><Icon name="spark" size={16} /><span>{about}{list.details ? `. ${list.details}` : ''}</span></div>
          <ScriptSelect scripts={setup?.scripts} kinds={[kind]} value={scriptId} onChange={setScriptId} />
          <Field label="Anything else to say (optional)" hint="The agent sticks to this call's topic and nothing else.">
            <textarea rows={2} value={extra} maxLength={200} onChange={(e) => setExtra(e.target.value)} placeholder={kind === 'INTERVIEW' ? 'Second round with the director' : 'Mention the free maintenance month'} />
          </Field>
          {err && <div className="alert">{err}</div>}
          {res && <div className="alert ok">{res.queued} added to the AI call list.{res.skipped?.length ? <div className="small">Skipped: {res.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}</div> : null}</div>}
          <button type="button" className="btn primary" style={{ width: '100%' }} disabled={busy || !ids.length} onClick={go}>{busy ? 'Adding…' : ids.length ? `Call ${ids.length} with AI` : `Choose ${c.people}`}</button>
        </div>
      </aside>
    </div>
  );
}

/** Interview / Customers section. `kind` = INTERVIEW | FEEDBACK; `d` = /api/crm for WhatsApp. */
export default function ListSection({ kind, d, loadCrm, channel, setChannel, listId, setListId }) {
  const c = COPY[kind];
  const [lists, setLists] = useState(null);
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null); // 'new' | 'edit'
  const [err, setErr] = useState('');
  const loadLists = useCallback(() => api(`/crm/lists?kind=${kind}`).then((r) => setLists(r.lists)).catch((e) => setErr(e.message)), [kind]);
  const loadList = useCallback(() => (listId ? api(`/crm/lists/${listId}`).then((r) => setList(r.list)).catch((e) => setErr(e.message)) : Promise.resolve()), [listId]);
  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => { setList(null); loadList(); }, [loadList]);
  useEffect(() => { if (lists?.length && !listId) setListId(lists[0]._id); }, [lists, listId, setListId]);
  const changed = (l) => { if (l) setList(l); else loadList(); loadLists(); };
  const counts = useMemo(() => (list ? list.contacts.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }), {}) : {}), [list]);
  const people = useMemo(() => (list?.contacts || []).map((p) => ({ key: p._id, name: p.name, phone: p.phone, sub: CONTACT_STATUS[p.status]?.[0], listId: list._id, contactId: p._id })), [list]);
  const prefill = kind === 'INTERVIEW' && list ? { 2: list.title, 3: list.date, 4: list.time, 5: list.venue } : list ? { 2: list.title } : {};

  if (err) return <div className="alert">{err}</div>;
  if (!lists) return <Skeleton />;
  return (
    <>
      <div className="crm-listbar card">
        {lists.length ? (
          <div className="crm-listpick">
            <label htmlFor={`pick-${kind}`} className="muted small">{c.titleLabel}</label>
            <select id={`pick-${kind}`} value={listId || ''} onChange={(e) => setListId(e.target.value)}>
              {lists.map((l) => <option key={l._id} value={l._id}>{l.title}{l.date ? ` · ${l.date}` : ''} ({l.count})</option>)}
            </select>
          </div>
        ) : <div className="muted">No {c.nouns} yet.</div>}
        <div className="row" style={{ gap: 8 }}>
          {list && <button type="button" className="btn sm" onClick={() => setForm('edit')}>Edit / add {c.people}</button>}
          <button type="button" className="btn primary sm" onClick={() => setForm('new')}><Icon name="plus" size={14} /> {c.newLabel}</button>
        </div>
        {list && (
          <div className="crm-listmeta">
            {kind === 'INTERVIEW' && [list.date, list.time, list.venue].some(Boolean) && <span><Icon name="clock" size={14} /> {[list.date, list.time].filter(Boolean).join(', ') || 'Date not set'}{list.venue ? ` · ${list.venue}` : ''}</span>}
            <span className="crm-chips">
              <span className="crm-chip">{list.contacts.length} {c.people}</span>
              {c.statuses.filter((s) => s !== 'NEW' && counts[s]).map((s) => <span key={s} className={`crm-chip t-${CONTACT_STATUS[s][1] || 'n'}`}>{counts[s]} {CONTACT_STATUS[s][0].toLowerCase()}</span>)}
            </span>
          </div>
        )}
      </div>

      {!lists.length ? (
        <div className="card"><Blank icon={kind === 'INTERVIEW' ? 'briefcase' : 'star'} title={`Start with a ${c.noun}`}>{c.empty}
          <div style={{ marginTop: 12 }}><button type="button" className="btn primary" onClick={() => setForm('new')}><Icon name="plus" size={14} /> {c.newLabel}</button></div></Blank></div>
      ) : (
        <>
          <ChannelTabs value={channel} onChange={setChannel} />
          {channel === 'history' ? <History section={c.section} /> : !list ? <Skeleton /> : !list.contacts.length && channel !== 'whatsapp' ? (
            <div className="card"><Blank icon="users" title={`No ${c.people} on this ${c.noun} yet`}><button type="button" className="btn primary" style={{ marginTop: 10 }} onClick={() => setForm('edit')}>Add {c.people}</button></Blank></div>
          ) : channel === 'ivr' ? <Ivr list={list} kind={kind} onChanged={changed} />
            : channel === 'ai' ? <Ai list={list} kind={kind} onChanged={() => changed()} />
              : <WaComposer key={list._id} d={d} load={loadCrm} purposes={c.purposes} people={people} peopleLabel={c.people} prefill={prefill} />}
        </>
      )}
      {form && <ListForm kind={kind} list={form === 'edit' ? list : null} onClose={() => setForm(null)} onSaved={(l) => { setForm(null); setListId(l._id); setList(l); loadLists(); }} />}
    </>
  );
}
