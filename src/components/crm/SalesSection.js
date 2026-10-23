'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, fmtDateTime } from '@/lib/client';
import { Skeleton } from '@/components/ui';
import { CallButton } from '@/components/SalesCall';
import { AiPortal } from '@/components/AiPortal';
import { StatusBadge, OutcomeBadge, STATUS } from '@/components/SalesBits';
import WaComposer from './WaComposer';
import History from './History';
import { Blank, ChannelTabs } from './shared';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

/** Leads with search and a status filter (open leads by default). */
function useLeads() {
  const [f, setF] = useState({ q: '', status: '' });
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const query = qs({ ...f, open: f.status ? '' : '1', sort: 'score' });
  const load = useCallback(() => api(`/sales/leads?${query}`).then((r) => { setRes(r); setErr(''); }).catch((e) => setErr(e.message)), [query]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { window.addEventListener('sales:changed', load); return () => window.removeEventListener('sales:changed', load); }, [load]);
  const bar = (
    <div className="row crm-filters">
      <input type="search" aria-label="Search leads" placeholder="Search name, number, area…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ maxWidth: 260 }} />
      <select aria-label="Lead status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={{ width: 'auto' }}>
        <option value="">Open leads</option>
        {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </div>
  );
  return { res, err, bar };
}

/** Sales section: IVR calls to leads, the AI portal, WhatsApp offers / brochure, and the history. */
export default function SalesSection({ d, loadCrm, channel, setChannel }) {
  const leads = useLeads();
  const [sales, setSales] = useState(null);
  const [salesErr, setSalesErr] = useState('');
  useEffect(() => { if (channel === 'ai' && !sales) api('/sales').then(setSales).catch((e) => setSalesErr(e.message)); }, [channel, sales]);
  const rows = leads.res?.leads || [];
  const people = useMemo(() => rows.map((l) => ({ key: l._id, name: l.name, phone: l.phone || '', sub: STATUS[l.status]?.[0], leadId: l._id })), [rows]);

  return (
    <>
      <ChannelTabs value={channel} onChange={setChannel} />
      {channel === 'ivr' && (
        <div className="card">
          {leads.bar}
          {leads.err && <div className="alert">{leads.err}</div>}
          {!leads.res ? <Skeleton title={false} /> : !rows.length ? <Blank icon="target" title="No leads match">Change the filters, or add leads on the Sales page.</Blank> : (
            <div className="table-wrap"><table className="leads">
              <thead><tr><th>Lead</th><th>Status</th><th>Last call</th><th>Call</th></tr></thead>
              <tbody>{rows.map((l) => (
                <tr key={l._id}>
                  <td className="c-lead"><Link href={`/sales/leads/${l._id}`} className="lead-name">{l.name}</Link><div className="muted small">{[l.category, l.area || l.city, l.assignedTo?.name].filter(Boolean).join(' · ')}</div></td>
                  <td><StatusBadge s={l.status} /></td>
                  <td className="small nowrap">{l.lastCallAt ? <>{fmtDateTime(l.lastCallAt)}<div><OutcomeBadge o={l.lastOutcome} /></div></> : <span className="muted">Never</span>}</td>
                  <td className="nowrap"><CallButton lead={l} /></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
          {leads.res && leads.res.total > rows.length && <p className="muted small">Top {rows.length} of {leads.res.total} by lead quality. Search to find others.</p>}
          <p className="muted small" style={{ marginBottom: 0 }}>Your phone rings first, then the lead. After the call you note how it went; an <b>Interested</b> lead gets the brochure on WhatsApp automatically when that is switched on in Settings.</p>
        </div>
      )}
      {channel === 'ai' && (salesErr ? <div className="alert">{salesErr}</div> : !sales ? <Skeleton /> : <AiPortal d={sales} />)}
      {channel === 'whatsapp' && <WaComposer d={d} load={loadCrm} purposes={['OFFER', 'SALES', 'BROCHURE']} people={people} peopleLabel="leads" toolbar={leads.bar} />}
      {channel === 'history' && <History section="SALES" />}
    </>
  );
}
