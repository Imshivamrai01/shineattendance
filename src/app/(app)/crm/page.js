'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import Icon from '@/components/Icon';
import { Skeleton } from '@/components/ui';
import { CallProvider } from '@/components/SalesCall';
import SalesSection from '@/components/crm/SalesSection';
import ListSection from '@/components/crm/ListSection';
import EmployeesSection from '@/components/crm/EmployeesSection';
import CrmSettings, { SenderCard } from '@/components/crm/CrmSettings';

/*
 * CRM: one place to reach people. Four sections (Sales, Customers, Interview, Employees), each with the same four
 * channels (IVR Call, AI Call, WhatsApp, History). Settings (top right) holds the WhatsApp connection, the automatic
 * messages, what the AI agent says and every template. The URL keeps the place: /crm?section=interview&channel=ai&list=…
 */

const SECTIONS = [
  ['sales', 'Sales', 'target', 'Leads: calls, offers and the brochure'],
  ['customers', 'Customers', 'star', 'Feedback calls and messages'],
  ['interview', 'Interview', 'briefcase', 'Invite candidates role by role'],
  ['employees', 'Employees', 'users', 'Absent calls, tasks and updates'],
];
const CHANNELS = ['ivr', 'ai', 'whatsapp', 'history'];

export default function Crm() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [place, setPlace] = useState({ section: 'sales', channel: 'ivr', list: '', settings: false });
  const load = useCallback(() => api('/crm').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const section = SECTIONS.some(([k]) => k === q.get('section')) ? q.get('section') : 'sales';
    setPlace({ section, channel: CHANNELS.includes(q.get('channel')) ? q.get('channel') : 'ivr', list: q.get('list') || '', settings: q.get('settings') === '1' });
  }, []);
  const go = useCallback((patch) => setPlace((p) => {
    const n = { ...p, ...patch };
    const q = n.settings ? { settings: '1' } : { section: n.section, channel: n.channel, ...(n.list ? { list: n.list } : {}) };
    window.history.replaceState(null, '', `/crm?${new URLSearchParams(q)}`);
    return n;
  }), []);
  const setChannel = useCallback((channel) => go({ channel }), [go]);
  const setListId = useCallback((list) => go({ list }), [go]);

  if (err) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const sec = SECTIONS.find(([k]) => k === place.section);
  return (
    <CallProvider>
      <div className="sales crm">
        <header className="crm-head">
          <div>
            <h1>{place.settings ? 'CRM settings' : 'CRM'}</h1>
            <div className="muted">{place.settings ? 'WhatsApp, automatic messages, the AI agent and templates' : 'Call and message leads, customers, candidates and employees from one place'}</div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {!place.settings && d.account && <div className="crm-head-sender"><SenderCard d={d} /></div>}
            <button type="button" className={`btn ${place.settings ? 'primary' : ''}`} onClick={() => go({ settings: !place.settings })} aria-pressed={place.settings}>
              <Icon name={place.settings ? 'back' : 'cog'} size={16} /> {place.settings ? 'Back' : 'Settings'}
            </button>
          </div>
        </header>

        {place.settings ? <CrmSettings d={d} load={load} onBack={() => go({ settings: false })} /> : (
          <>
            {!d.configured && <div className="alert warn">WhatsApp is not connected yet. <button type="button" className="linkish" onClick={() => go({ settings: true })}>Open Settings</button> to connect the business number. Calls work without it.</div>}
            <nav className="crm-sections" role="tablist" aria-label="Section">
              {SECTIONS.map(([k, label, icon, hint]) => (
                <button key={k} type="button" role="tab" aria-selected={place.section === k} className={`crm-section ${place.section === k ? 'on' : ''}`}
                  onClick={() => go({ section: k, list: '', channel: place.channel })}>
                  <span className="crm-section-ico"><Icon name={icon} size={20} /></span>
                  <span className="crm-section-text"><b>{label}</b><span className="muted small">{hint}</span></span>
                </button>))}
            </nav>
            <h2 className="sr-only">{sec[1]}</h2>
            {place.section === 'sales' && <SalesSection d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} />}
            {place.section === 'customers' && <ListSection key="FEEDBACK" kind="FEEDBACK" d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} listId={place.list} setListId={setListId} />}
            {place.section === 'interview' && <ListSection key="INTERVIEW" kind="INTERVIEW" d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} listId={place.list} setListId={setListId} />}
            {place.section === 'employees' && <EmployeesSection d={d} loadCrm={load} channel={place.channel} setChannel={setChannel} />}
          </>
        )}
      </div>
    </CallProvider>
  );
}
