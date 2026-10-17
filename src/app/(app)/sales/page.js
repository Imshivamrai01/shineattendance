'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import { Badge, Field, Skeleton, Empty } from '@/components/ui';
import { STATUS, GRADE, CATEGORY_HINTS, StatusBadge, GradeBadge, RepeatBadge, OutcomeBadge, outcomeLabel, when, LeadForm } from '@/components/SalesBits';
import { CallButton, ContactLinks, PendingCalls, useCall, fmtDur } from '@/components/SalesCall';
import { useMe } from '@/components/Shell';

const TABS = [['overview', 'Overview'], ['leads', 'Leads'], ['followups', 'Follow-ups'], ['calls', 'Call log'], ['finder', 'Lead finder'], ['team', 'Team']];
const todayIst = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const dueTone = (d) => { if (!d) return ''; const t = new Date(d); const now = new Date(); return t < now ? (t.toDateString() === now.toDateString() ? 'warn' : 'bad') : ''; };

function activityText(a) {
  const lead = a.lead?.name ? <Link href={`/sales/leads/${a.lead._id}`}>{a.lead.name}</Link> : 'a lead';
  switch (a.type) {
    case 'CALL': return <>called {lead} · <b>{outcomeLabel(a.outcome)}</b>{a.followUpAt ? ` · follow-up ${fmtDateTime(a.followUpAt)}` : ''}</>;
    case 'FOLLOW_UP': return a.followUpAt ? <>set a follow-up for {lead} on {fmtDateTime(a.followUpAt)}</> : <>cleared the follow-up of {lead}</>;
    case 'STATUS': return <>moved {lead} to <b>{STATUS[a.to]?.[0] || a.to}</b></>;
    case 'ASSIGN': return <>re-assigned {lead}</>;
    case 'NOTE': return <>added a note on {lead}</>;
    case 'CREATED': return <>added {lead}</>;
    case 'FOUND_AGAIN': return <>found {lead} again (repeat)</>;
    default: return <>updated {lead}</>;
  }
}

function Overview({ d, go }) {
  const c = d.counts;
  const pct = c.total ? Math.round((c.called / c.total) * 100) : 0;
  const stat = (label, value, sub, filter) => (
    <button className="stat stat-btn" onClick={() => go(filter)} key={label}><span className="muted small">{label}</span><b>{value}</b>{sub && <span className="muted small">{sub}</span>}</button>
  );
  return (
    <>
      <div className="sales-stats">
        {stat('Total leads', c.total, `${c.fresh} fresh · ${c.repeat} repeat`, { tab: 'leads' })}
        {stat('Called', c.called, `${pct}% of leads · ${c.calls} calls`, { tab: 'leads', called: '1' })}
        {stat('Not called yet', c.notCalled, 'open leads', { tab: 'leads', called: '0', open: '1' })}
        {stat('Follow-ups today', c.dueToday, c.overdue ? `${c.overdue} overdue` : 'none overdue', { tab: 'followups' })}
        {stat('Calls today', d.today.calls, `${d.today.connected} talked`, { tab: 'calls' })}
        {stat('Interested', c.status.INTERESTED || 0, `${c.status.CONVERTED || 0} converted`, { tab: 'leads', status: 'INTERESTED' })}
      </div>

      <div className="cols">
        <div className="card">
          <h2>Lead quality</h2>
          <div className="quality-bar">
            {['HOT', 'WARM', 'COLD'].map((g) => (c.grade[g] ? <span key={g} className={`grade-${GRADE[g][1]}`} style={{ flex: c.grade[g] }} /> : null))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {['HOT', 'WARM', 'COLD'].map((g) => <button key={g} className="btn sm" onClick={() => go({ tab: 'leads', grade: g, sort: 'score' })}><GradeBadge g={g} /> {c.grade[g] || 0}</button>)}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Hot = reachable mobile number, Instagram / website, good ratings, or interested on the call. Calls update the score.</p>
          <h2 style={{ marginTop: 18 }}>Pipeline</h2>
          <div className="row">
            {Object.keys(STATUS).map((s) => <button key={s} className="btn sm" onClick={() => go({ tab: 'leads', status: s })}><StatusBadge s={s} /> {c.status[s] || 0}</button>)}
          </div>
        </div>

        <div className="card">
          <h2>Recent activity</h2>
          {!d.recent.length && <p className="muted">Nothing yet. Find some leads and start calling.</p>}
          {d.recent.map((a) => (
            <div key={a._id} className="wa-row act-row">
              <span><b>{a.by?.name || 'System'}</b> {activityText(a)}{a.note && a.type !== 'CREATED' && a.type !== 'FOUND_AGAIN' && <div className="muted small">“{a.note}”</div>}</span>
              <span className="muted small nowrap">{fmtDateTime(a.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>

      {d.board && (
        <div className="card">
          <h2>Team today</h2>
          <table>
            <thead><tr><th>Person</th><th>Leads</th><th>Called</th><th>Calls today</th><th>Follow-ups due</th><th>Interested</th><th>Converted</th></tr></thead>
            <tbody>
              {d.board.map((u) => (
                <tr key={u._id}>
                  <td><button className="linkish" onClick={() => go({ tab: 'leads', assigned: u._id })}><b>{u.name}</b></button> <span className="muted small">{u.sales === 'MANAGER' ? 'Manager' : 'Agent'}</span></td>
                  <td>{u.leads}</td><td>{u.called}</td>
                  <td><button className="linkish" onClick={() => go({ tab: 'calls', by: u._id })}>{u.callsToday}</button> <span className="muted small">({u.connectedToday} talked)</span></td>
                  <td>{u.due ? <Badge tone="warn">{u.due}</Badge> : 0}</td><td>{u.interested}</td><td>{u.converted}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.counts.unassigned > 0 && <p className="muted small" style={{ marginBottom: 0 }}><button className="linkish" onClick={() => go({ tab: 'leads', assigned: 'none' })}>{d.counts.unassigned} leads</button> are not assigned to anyone.</p>}
        </div>
      )}
    </>
  );
}

function LeadsTable({ d, preset = {}, fixed = {}, title }) {
  const manager = d.role === 'MANAGER';
  const [f, setF] = useState({ q: '', status: '', grade: '', category: '', assigned: '', called: '', bucket: '', sort: '', open: '', scrape: '', ...preset });
  const [page, setPage] = useState(1);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({});
  const [bulk, setBulk] = useState({ assignedTo: '', status: '' });
  const [msg, setMsg] = useState('');
  const query = qs({ ...f, ...fixed, page });
  const load = useCallback(() => api(`/sales/leads?${query}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [query]);
  useLive(load, 30000);
  useEffect(() => { setF((x) => ({ ...x, ...preset })); setPage(1); }, [JSON.stringify(preset)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setPage(1); setSel({}); };
  const picked = Object.keys(sel).filter((k) => sel[k]);
  const applyBulk = async () => {
    const body = { ids: picked };
    if (bulk.assignedTo) body.assignedTo = bulk.assignedTo === 'none' ? null : bulk.assignedTo;
    if (bulk.status) body.status = bulk.status;
    try { const r = await api('/sales/leads/bulk', { method: 'POST', body }); setMsg(`${r.changed} change${r.changed === 1 ? '' : 's'} saved.`); setSel({}); setBulk({ assignedTo: '', status: '' }); load(); } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{title || 'Leads'}{res ? <span className="muted small"> · {res.total}</span> : null}</h2>
        <a className="btn sm" href={`/api/sales/export?${qs({ ...f, ...fixed })}`}>Export CSV</a>
      </div>
      {!fixed.due && (
        <div className="tabs">
          {[['', 'All'], ['fresh', 'Fresh'], ['repeat', 'Repeat (found again)']].map(([k, l]) => (
            <button key={k} className={`btn sm ${f.bucket === k ? 'primary' : ''}`} onClick={() => { setF({ ...f, bucket: k }); setPage(1); }}>{l}{d.counts && k ? ` (${k === 'fresh' ? d.counts.fresh : d.counts.repeat})` : ''}</button>))}
        </div>
      )}
      <div className="filters">
        <input type="search" placeholder="Search name, phone, area, Instagram…" value={f.q} onChange={set('q')} />
        <select value={f.status} onChange={set('status')}><option value="">Any status</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={f.grade} onChange={set('grade')}><option value="">Any quality</option>{Object.entries(GRADE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
        {d.categories.length > 0 && <select value={f.category} onChange={set('category')}><option value="">Any category</option>{d.categories.map((c) => <option key={c}>{c}</option>)}</select>}
        <select value={f.called} onChange={set('called')}><option value="">Called or not</option><option value="1">Called</option><option value="0">Not called yet</option></select>
        {manager && <select value={f.assigned} onChange={set('assigned')}><option value="">Anyone</option><option value="none">Not assigned</option>{d.team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}</select>}
        <select value={f.sort} onChange={set('sort')}><option value="">Newest first</option><option value="score">Best quality first</option><option value="followup">Next follow-up</option><option value="called">Last called</option><option value="found">Most found</option><option value="name">Name A-Z</option></select>
      </div>
      {f.scrape && <div className="alert ok">Showing leads from one lead finder run. <button className="linkish" onClick={() => setF({ ...f, scrape: '' })}>Show all</button></div>}
      {msg && <div className="alert ok">{msg}</div>}
      {manager && picked.length > 0 && (
        <div className="bulkbar">
          <b>{picked.length} selected</b>
          <select value={bulk.assignedTo} onChange={(e) => setBulk({ ...bulk, assignedTo: e.target.value })}><option value="">Assign to…</option><option value="none">Nobody</option>{d.team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}</select>
          <select value={bulk.status} onChange={(e) => setBulk({ ...bulk, status: e.target.value })}><option value="">Set status…</option>{Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn sm primary" disabled={!bulk.assignedTo && !bulk.status} onClick={applyBulk}>Apply</button>
          <button className="btn sm" onClick={() => setSel({})}>Clear</button>
        </div>
      )}
      {err && <div className="alert">{err}</div>}
      {!res ? <Skeleton title={false} /> : !res.leads.length ? <Empty message={fixed.due ? 'No follow-ups due. Nice work.' : 'No leads match. Use the Lead finder to get some.'} /> : (
        <div className="table-wrap"><table className="leads">
          <thead><tr>
            {manager && <th><input type="checkbox" aria-label="Select all" checked={res.leads.every((l) => sel[l._id])} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(res.leads.map((l) => [l._id, true])) : {})} /></th>}
            <th>Lead</th><th>Phone</th><th>Status</th><th>Last call</th><th>Follow-up</th>{manager && <th>Handled by</th>}
          </tr></thead>
          <tbody>
            {res.leads.map((l) => (
              <tr key={l._id}>
                {manager && <td className="sel"><input type="checkbox" aria-label={`Select ${l.name}`} checked={!!sel[l._id]} onChange={(e) => setSel({ ...sel, [l._id]: e.target.checked })} /></td>}
                <td className="c-lead">
                  <Link href={`/sales/leads/${l._id}`} className="lead-name">{l.name}</Link>
                  <div className="muted small">{[l.category, l.area || l.city].filter(Boolean).join(' · ')}{l.rating ? ` · ★ ${l.rating} (${l.reviews || 0})` : ''}</div>
                  <div className="lead-tags"><GradeBadge g={l.grade} score={l.score} /><RepeatBadge n={l.timesFound} /></div>
                </td>
                <td className="c-phone"><CallButton lead={l} /><ContactLinks lead={l} /></td>
                <td><StatusBadge s={l.status} /></td>
                <td className="c-call">
                  {l.callCount ? <>
                    <div><b>{l.lastCallBy?.name || '—'}</b> <OutcomeBadge o={l.lastOutcome} /></div>
                    <div className="muted small">{when(l.lastCallAt)} · {l.callCount} call{l.callCount > 1 ? 's' : ''}</div>
                  </> : <span className="muted">Not called</span>}
                </td>
                <td>{l.nextFollowUpAt ? <Badge tone={dueTone(l.nextFollowUpAt)}>{when(l.nextFollowUpAt)}</Badge> : <span className="muted">—</span>}</td>
                {manager && <td className="nowrap">{l.assignedTo?.name || <span className="muted">Nobody</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {res && res.pages > 1 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted small">Page {res.page} of {res.pages}</span>
          <button className="btn sm" disabled={page >= res.pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function CallLog({ d, preset = {} }) {
  const manager = d.role === 'MANAGER';
  const start = useCall();
  const me = useMe();
  const [day, setDay] = useState(todayIst());
  const [by, setBy] = useState(preset.by || '');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api(`/sales/calls?${qs({ day, by })}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [day, by]);
  useLive(load, 30000);
  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Call log{res ? <span className="muted small"> · {res.calls.length} calls</span> : null}</h2>
        <div className="row">
          <input type="date" value={day} max={todayIst()} onChange={(e) => setDay(e.target.value || todayIst())} style={{ width: 'auto' }} />
          {manager && <select value={by} onChange={(e) => setBy(e.target.value)} style={{ width: 'auto' }}><option value="">Everyone</option>{d.team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}</select>}
        </div>
      </div>
      {res?.people.length > 0 && (
        <div className="caller-chips">
          {res.people.map((p) => (
            <button key={p._id} className={`caller-chip ${by === p._id ? 'on' : ''}`} onClick={() => manager && setBy(by === p._id ? '' : p._id)}>
              <b>{p.name}</b><span>{p.calls} calls · {p.talked} talked{p.seconds ? ` · ${fmtDur(p.seconds)}` : ''}{p.pending ? ` · ${p.pending} not updated` : ''}</span>
            </button>))}
        </div>
      )}
      {err && <div className="alert">{err}</div>}
      {!res ? <Skeleton title={false} /> : !res.calls.length ? <Empty message="No calls on this day." /> : (
        <div className="table-wrap"><table className="leads">
          <thead><tr><th>Time</th><th>Called by</th><th>Lead</th><th>Result</th><th>What was said</th><th>Next follow-up</th></tr></thead>
          <tbody>{res.calls.map((c) => (
            <tr key={c._id}>
              <td className="nowrap">{new Date(c.createdAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}{c.durationSec ? <div className="muted small">{fmtDur(c.durationSec)}</div> : null}</td>
              <td className="nowrap"><b>{c.by?.name}</b></td>
              <td className="c-lead">{c.lead ? <Link href={`/sales/leads/${c.lead._id}`} className="lead-name">{c.lead.name}</Link> : '—'}<div className="muted small">{c.phone || c.lead?.phone}</div></td>
              <td>
                <OutcomeBadge o={c.outcome} />
                {c.outcome === 'PENDING' && String(c.by?._id) === String(me._id) && c.lead && <div><button className="btn sm primary" style={{ marginTop: 6 }} onClick={() => start(c.lead, c)}>Update</button></div>}
              </td>
              <td className="small" style={{ minWidth: 180 }}>{c.note || <span className="muted">—</span>}</td>
              <td className="nowrap">{c.followUpAt ? when(c.followUpAt) : <span className="muted">—</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function Finder({ d, onDone, go }) {
  const manager = d.role === 'MANAGER';
  const [f, setF] = useState({ category: '', location: '', source: 'AUTO', max: 40, onlyWithPhone: true, assignTo: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const run = async (e) => {
    e.preventDefault(); setBusy(true); setErr(''); setRes(null);
    try { setRes(await api('/sales/scrape', { method: 'POST', body: { ...f, max: Number(f.max) }, timeout: 180000 })); onDone(); } catch (x) { setErr(x.name === 'TimeoutError' ? 'The search took too long. Try a smaller area or fewer results.' : x.message); }
    setBusy(false);
  };
  return (
    <>
      <form className="card" onSubmit={run}>
        <h2>Find leads</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Searches businesses by category and location and saves them as leads with name, phone, address, Instagram, website and rating.
          A business that is already in the CRM is never added twice: it is shown under <b>Already in CRM</b> and counted as a repeat lead.
        </p>
        <div className="form two">
          <Field label="Category" hint="What kind of business">
            <input value={f.category} onChange={set('category')} list="finder-cats" placeholder="Restaurant, Gym, Salon…" required />
            <datalist id="finder-cats">{CATEGORY_HINTS.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Location" hint="Area and city works best"><input value={f.location} onChange={set('location')} placeholder="Golghar, Gorakhpur" required /></Field>
          <Field label="Source" hint={d.googleReady ? undefined : 'Add a Google Places key under Team to get far more phone numbers.'}>
            <select value={f.source} onChange={set('source')}>
              <option value="AUTO">{d.googleReady ? 'Google Maps (recommended)' : 'OpenStreetMap (free)'}</option>
              {d.googleReady && <option value="OSM">OpenStreetMap (free)</option>}
            </select>
          </Field>
          <Field label="How many"><select value={f.max} onChange={set('max')}>{[20, 40, 60].map((n) => <option key={n} value={n}>Up to {n}</option>)}</select></Field>
          {manager && (
            <Field label="Give the new leads to">
              <select value={f.assignTo} onChange={set('assignTo')}><option value="">Nobody yet</option>{d.team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}</select>
            </Field>
          )}
          <Field label="Filter"><label className="check"><input type="checkbox" checked={f.onlyWithPhone} onChange={set('onlyWithPhone')} /> Only businesses with a phone number</label></Field>
        </div>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          {busy && <span className="muted small">Searching and reading websites for Instagram… up to a minute.</span>}
          <button className="btn primary" disabled={busy}>{busy ? 'Searching…' : 'Find leads'}</button>
        </div>
      </form>

      {res && (
        <>
          <div className="alert ok">
            Found {res.job.found} · <b>{res.fresh.length} new leads saved</b> · {res.repeat.length} already in CRM{res.job.skipped ? ` · ${res.job.skipped} without a phone skipped` : ''}.
            {' '}<button className="linkish" onClick={() => go({ tab: 'leads', scrape: res.job._id })}>Open these leads</button>
          </div>
          <div className="card">
            <h2>New leads ({res.fresh.length})</h2>
            {!res.fresh.length && <p className="muted">Nothing new here: every result is already in the CRM.</p>}
            {res.fresh.length > 0 && (
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>Instagram</th><th>Quality</th></tr></thead>
                <tbody>{res.fresh.map((l) => (
                  <tr key={l._id}>
                    <td><Link href={`/sales/leads/${l._id}`}><b>{l.name}</b></Link>{l.rating ? <div className="muted small">★ {l.rating} ({l.reviews || 0})</div> : null}</td>
                    <td><CallButton lead={l} /></td><td className="small">{l.address || '—'}</td>
                    <td>{l.instagram ? <a href={l.instagram} target="_blank" rel="noreferrer">{l.instagram.replace(/^https:\/\/instagram\.com\//, '@')}</a> : <span className="muted">—</span>}</td>
                    <td><GradeBadge g={l.grade} score={l.score} /></td>
                  </tr>))}
                </tbody>
              </table>
            )}
          </div>
          {res.repeat.length > 0 && (
            <div className="card">
              <h2>Already in CRM · repeat leads ({res.repeat.length})</h2>
              <p className="muted small" style={{ marginTop: 0 }}>These were found before, so they were not added again. Their “found” count went up.</p>
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Found</th><th>Status</th><th>Calls</th><th>Handled by</th></tr></thead>
                <tbody>{res.repeat.map((l) => (
                  <tr key={l._id}>
                    <td><Link href={`/sales/leads/${l._id}`}><b>{l.name}</b></Link><div className="muted small">first found {fmtDateTime(l.firstFoundAt)}</div></td>
                    <td className="nowrap">{l.phone || '—'}</td><td><RepeatBadge n={l.timesFound} /></td><td><StatusBadge s={l.status} /></td>
                    <td>{l.callCount || 0}</td><td>{l.assignedName || <span className="muted">Nobody</span>}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="card">
        <h2>Past searches</h2>
        {!d.scrapes.length && <p className="muted">No searches yet.</p>}
        {d.scrapes.map((j) => (
          <div key={j._id} className="row between wa-row">
            <span><b>{j.category}</b> in {j.location} <span className="muted small">· {j.source === 'GOOGLE' ? 'Google' : 'OpenStreetMap'} · {j.by?.name} · {fmtDateTime(j.createdAt)}</span>
              {j.error && <div className="muted small">Failed: {j.error}</div>}</span>
            {!j.error && <button className="btn sm" onClick={() => go({ tab: 'leads', scrape: j._id })}>{j.created} new · {j.repeated} repeat</button>}
          </div>
        ))}
      </div>
    </>
  );
}

function Team({ onChanged }) {
  const [c, setC] = useState(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/sales/config').then(setC).catch((e) => setMsg({ text: e.message })), []);
  useEffect(() => { load(); }, [load]);
  if (!c) return <Skeleton />;
  const saveKey = async (value) => {
    setBusy(true); setMsg(null);
    try { await api('/sales/config', { method: 'POST', body: { placesKey: value } }); setKey(''); setMsg({ ok: true, text: value ? 'Google key works and is saved. The lead finder now uses Google Maps.' : 'Google key removed.' }); load(); onChanged(); } catch (e) { setMsg({ text: e.message }); }
    setBusy(false);
  };
  const setAccess = async (userId, salesAccess) => {
    setMsg(null);
    try { await api('/sales/config', { method: 'POST', body: { userId, salesAccess } }); load(); onChanged(); } catch (e) { setMsg({ text: e.message }); }
  };
  return (
    <>
      {msg && <div className={`alert ${msg.ok ? 'ok' : ''}`}>{msg.text}</div>}
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Google Maps data (optional)</h2><Badge tone={c.googleReady ? 'ok' : 'warn'}>{c.googleReady ? 'Connected' : 'Not connected'}</Badge></div>
        <p className="muted small">Without a key the lead finder uses OpenStreetMap, which is free but has phone numbers for fewer businesses. With a Google Places API key it searches Google Maps: phone, rating, reviews and website for almost every business.</p>
        <ol className="steps small">
          <li>Open <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noreferrer">Google Cloud Console → Places API (New)</a> and press <b>Enable</b> (a billing account is required; Google gives a monthly free credit).</li>
          <li>Go to <b>APIs &amp; Services → Credentials → Create credentials → API key</b>. Restrict it to <i>Places API (New)</i>.</li>
          <li>Paste the key here. It is tested and kept on the server only.</li>
        </ol>
        {c.canConfigure ? (
          <div className="row">
            <input style={{ flex: 1, minWidth: 220 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder={c.googleReady ? '•••••••• (saved) — paste a new key to replace' : 'AIza…'} autoComplete="off" spellCheck={false} />
            <button className="btn primary" disabled={busy || key.trim().length < 20} onClick={() => saveKey(key.trim())}>{busy ? 'Checking…' : 'Save key'}</button>
            {c.googleReady && <button className="btn danger" disabled={busy} onClick={() => window.confirm('Remove the Google key? The lead finder will use OpenStreetMap.') && saveKey('')}>Remove</button>}
          </div>
        ) : <p className="muted small">Only Admin or COO can change this.</p>}
      </div>

      <div className="card">
        <h2>Who works on sales</h2>
        <p className="muted small" style={{ marginTop: 0 }}><b>Agent</b>: sees and calls the leads given to them, can use the lead finder. <b>Manager</b>: sees every lead, assigns leads, sees the team board. Admin and COO are always managers.</p>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Sales access</th></tr></thead>
          <tbody>{c.people.map((u) => (
            <tr key={u._id}>
              <td>{u.name} <span className="muted small">{u.employeeId}</span></td>
              <td className="muted small">{u.designation || u.role}</td>
              <td>
                <select value={u.salesAccess || 'NONE'} disabled={!c.canConfigure} onChange={(e) => setAccess(u._id, e.target.value)}>
                  <option value="NONE">No access</option><option value="AGENT">Agent</option><option value="MANAGER">Manager</option>
                </select>
              </td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Sales() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('overview');
  const [preset, setPreset] = useState({});
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const load = useCallback(() => api('/sales').then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), []);
  useLive(load, 30000);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && TABS.some(([k]) => k === t)) setTab(t);
  }, []);
  const show = (t) => { setTab(t); window.history.replaceState(null, '', t === 'overview' ? '/sales' : `/sales?tab=${t}`); };
  const go = ({ tab: t, ...filters }) => { setPreset(filters); show(t); };

  if (err && !d) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const manager = d.role === 'MANAGER';
  const tabs = TABS.filter(([k]) => k !== 'team' || manager);

  return (
    <>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div><h1>Sales</h1><div className="muted">{manager ? 'Leads, calls and follow-ups for the whole team' : 'Your leads, calls and follow-ups'}</div></div>
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}>Add lead</button>
          <button className="btn primary" onClick={() => show('finder')}>Find leads</button>
        </div>
      </div>
      <PendingCalls pending={d.myPending} />
      {note && <div className="alert ok">{note}</div>}
      <div className="tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`btn sm ${tab === k ? 'primary' : ''}`} onClick={() => { setPreset({}); show(k); }}>
            {label}{k === 'followups' && d.counts.dueToday + d.counts.overdue > 0 ? ` (${d.counts.dueToday + d.counts.overdue})` : ''}
          </button>))}
      </div>

      {tab === 'overview' && <Overview d={d} go={go} />}
      {tab === 'calls' && <CallLog d={d} preset={preset} />}
      {tab === 'leads' && <LeadsTable d={d} preset={preset} />}
      {tab === 'followups' && <LeadsTable d={d} fixed={{ due: 'today', open: '1' }} preset={{ sort: 'followup' }} title="Follow-ups due today and overdue" />}
      {tab === 'finder' && <Finder d={d} onDone={load} go={go} />}
      {tab === 'team' && manager && <Team onChanged={load} />}

      {adding && <LeadForm team={d.team} manager={manager} onClose={() => setAdding(false)}
        onDone={(r) => { setAdding(false); setNote(r.repeat ? `“${r.lead.name}” is already in the CRM${r.lead.assignedTo ? ` (handled by ${r.lead.assignedTo.name})` : ''}: marked as a repeat lead, not added again.` : `“${r.lead.name}” added.`); load(); }} />}
    </>
  );
}
