'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import Icon from '@/components/Icon';
import { Badge, Skeleton } from '@/components/ui';
import { fmtDur } from '@/components/SalesCall';
import { outcomeLabel, outcomeTone } from '@/components/SalesBits';
import { Blank, waTone } from './shared';

const CH = { IVR: ['IVR call', 'phone'], AI: ['AI call', 'spark'], WA: ['WhatsApp', 'whatsapp'] };
const AI_RESULT = { CALLBACK: ['Callback', 'warn'], INTERESTED: ['Interested', 'ok'], INFO_GIVEN: ['Talked', 'ok'], NOT_INTERESTED: ['Not interested', 'bad'],
  OPT_OUT: ['Do not call', 'bad'], NO_CONVERSATION: ['No answer', 'warn'], COMPLETED: ['Done', 'ok'], FAILED: ['Failed', 'bad'], SCHEDULED: ['Waiting', 'warn'],
  QUEUED: ['Dialling', 'warn'], IN_PROGRESS: ['On the call', 'warn'], CANCELLED: ['Cancelled', ''] };
const STAFF = { IN_PROGRESS: ['In progress', 'warn'], COMPLETED: ['Talked', 'ok'], NO_ANSWER: ['No answer', 'bad'], FAILED: ['Failed', 'bad'] };
const WA = { SENT: 'Sent', DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed', RECEIVED: 'Reply' };

function status(it, staff) {
  if (it.channel === 'WA') return [WA[it.status] || it.status, waTone(it.status)];
  if (it.channel === 'AI') {
    if (it.accepted === true) return ['Confirmed', 'ok'];
    if (it.accepted === false) return ['Declined', 'bad'];
    if (it.rating) return [`Rated ${it.rating}/5`, it.rating >= 4 ? 'ok' : it.rating <= 2 ? 'bad' : 'warn'];
    return AI_RESULT[it.status] || [it.statusText || it.status, ''];
  }
  return staff ? STAFF[it.status] || [it.status, ''] : [outcomeLabel(it.status), outcomeTone(it.status)];
}

/** Every IVR call, AI call and WhatsApp message of one CRM section, newest first. */
export default function History({ section }) {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [only, setOnly] = useState('');
  const [q, setQ] = useState('');
  const load = useCallback(() => api(`/crm/history?section=${section}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [section]);
  useLive(load, 20000);
  const staff = section !== 'SALES';
  const needle = q.trim().toLowerCase();
  const items = (res?.items || []).filter((it) => (!only || it.channel === only) && (!needle || `${it.name} ${it.phone} ${it.summary || ''}`.toLowerCase().includes(needle)));
  const n = (c) => (res?.items || []).filter((it) => it.channel === c).length;
  return (
    <div className="card">
      <div className="card-head">
        <div className="crm-subtabs sm" style={{ margin: 0 }}>
          <button type="button" className={!only ? 'on' : ''} onClick={() => setOnly('')}>All</button>
          {Object.entries(CH).map(([k, [l]]) => <button key={k} type="button" className={only === k ? 'on' : ''} onClick={() => setOnly(k)}>{l} <span className="muted">{n(k)}</span></button>)}
        </div>
        <input type="search" aria-label="Search history" placeholder="Search name, number, what was said…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>
      {err && <div className="alert">{err}</div>}
      {!res ? <Skeleton title={false} /> : !items.length ? <Blank icon="clock" title="Nothing here yet">Calls and messages from this section show up here.</Blank> : (
        <ol className="crm-timeline">
          {items.map((it) => {
            const [label, tone] = status(it, staff);
            return (
              <li key={`${it.channel}-${it.id}`}>
                <span className={`crm-tl-ico ch-${it.channel.toLowerCase()}`}><Icon name={CH[it.channel][1]} size={15} /></span>
                <div className="crm-tl-body">
                  <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <b>{it.link ? <Link href={it.link}>{it.name || it.phone}</Link> : it.name || it.phone}</b>
                      <span className="muted small"> · {CH[it.channel][0]}{it.reply ? ' reply' : ''} · {fmtDateTime(it.at)}{it.by ? ` · ${it.by}` : ''}{it.durationSec ? ` · ${fmtDur(it.durationSec)}` : ''}</span>
                    </div>
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                  {it.summary && <div className="small crm-tl-text">{it.summary}</div>}
                  {it.error && <div className="small" style={{ color: 'var(--bad)' }}>{it.error}</div>}
                  {it.recording && <audio controls preload="none" src={it.recording} className="crm-audio">Your browser cannot play this recording.</audio>}
                </div>
              </li>);
          })}
        </ol>
      )}
    </div>
  );
}
