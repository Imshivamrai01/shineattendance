'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import Icon from '@/components/Icon';
import { Skeleton } from '@/components/ui';
import { useMe } from '@/components/Shell';
import { CallProvider } from '@/components/SalesCall';
import SalesHub from '@/components/crm/SalesHub';
import ListSection from '@/components/crm/ListSection';
import EmployeesSection from '@/components/crm/EmployeesSection';
import CrmSettings, { SenderCard } from '@/components/crm/CrmSettings';

/*
 * CRM: one place to reach people. Sales (the sales dashboard, leads, follow-ups, call log, AI calls, WhatsApp,
 * lead finder, team) and, for Admin / COO, Customers, Interview and Employees, each with IVR Call, AI Call,
 * WhatsApp and History. Settings (top right) holds WhatsApp, automatic messages, the AI agent and templates.
 * Sales people without Admin / COO see Sales only. The URL keeps the place: /crm?section=interview&channel=ai&list=…
 */

const SECTIONS = [
  ['sales', 'Sales', 'target', 'Dashboard, leads, calls and follow-ups'],
  ['customers', 'Customers', 'star', 'Feedback calls and messages'],
  ['interview', 'Interview', 'briefcase', 'Invite candidates role by role'],
  ['employees', 'Employees', 'users', 'Absent calls, tasks and updates'],
];
const CHANNELS = ['ivr', 'ai', 'whatsapp', 'history'];

export default function Crm() {
  const me = useMe();
  const full = ['ADMIN', 'COO'].includes(me.role); // everything; others: Sales only
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [place, setPlace] = useState(null);
  const load = useCallback(() => (full ? api('/crm').then(setD).catch((e) => setErr(e.message)) : Promise.resolve()), [full]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const section = full && SECTIONS.some(([k]) => k === q.get('section')) ? q.get('section') : 'sales';
    setPlace({ section, channel: CHANNELS.includes(q.get('channel')) ? q.get('channel') : 'ivr', list: q.get('list') || '', settings: full && q.get('settings') === '1' });
  }, [full]);
  const go = useCallback((patch) => setPlace((p) => {
    const n = { ...p, ...patch };
    const q = n.settings ? { settings: '1' } : n.section === 'sales' ? { section: 'sales' } : { section: n.section, channel: n.channel, ...(n.list ? { list: n.list } : {}) };
    window.history.replaceState(null, '', `/crm?${new URLSearchParams(q)}`);
    return n;
  }), []);
  const setChannel = useCallback((channel) => go({ channel }), [go]);
  const setListId = useCallback((list) => go({ list }), [go]);

  if (err) return <div className="alert">{err}</div>;
  if (!place || (full && !d)) return <Skeleton />;
  return (
    <CallProvider>
      <div className="sales crm">
        <header className="crm-head">
          <div>
            <h1>{place.settings ? 'CRM settings' : 'CRM'}</h1>
            <div className="muted">{place.settings ? 'WhatsApp, automatic messages, the AI agent and templates'
              : full ? 'Sales, customers, interviews and employees: every call and message in one place' : 'Your leads, calls and follow-ups'}</div>
          </div>
          {full && (
            <div className="row" style={{ gap: 10 }}>
              {!place.settings && d.account && <div className="crm-head-sender"><SenderCard d={d} /></div>}
              <button type="button" className={`btn ${place.settings ? 'primary' : ''}`} onClick={() => go({ settings: !place.settings })} aria-pressed={place.settings}>
                <Icon name={place.settings ? 'back' : 'cog'} size={16} /> {place.settings ? 'Back' : 'Settings'}
              </button>
            </div>
          )}
        </header>

        {place.settings ? <CrmSettings d={d} load={load} onBack={() => go({ settings: false })} /> : (
          <>
            {full && (
              <nav className="crm-sections" role="tablist" aria-label="Section">
                {SECTIONS.map(([k, label, icon, hint]) => (
                  <button key={k} type="button" role="tab" aria-selected={place.section === k} className={`crm-section ${place.section === k ? 'on' : ''}`}
                    onClick={() => go({ section: k, list: '' })}>
                    <span className="crm-section-ico"><Icon name={icon} size={20} /></span>
                    <span className="crm-section-text"><b>{label}</b><span className="muted small">{hint}</span></span>
                  </button>))}
              </nav>
            )}
            {full && !d.configured && place.section !== 'sales' && <div className="alert warn">WhatsApp is not connected yet. <button type="button" className="linkish" onClick={() => go({ settings: true })}>Open Settings</button> to connect the business number. Calls work without it.</div>}
            {place.section === 'sales' && <SalesHub crm={full ? d : null} loadCrm={load} />}
            {place.section === 'customers' && <ListSection key="FEEDBACK" kind="FEEDBACK" d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} listId={place.list} setListId={setListId} />}
            {place.section === 'interview' && <ListSection key="INTERVIEW" kind="INTERVIEW" d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} listId={place.list} setListId={setListId} />}
            {place.section === 'employees' && <EmployeesSection d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} />}
          </>
        )}
      </div>
    </CallProvider>
  );
}
