'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { Badge, Field, Modal } from '@/components/ui';

export const STATUS = {
  NEW: ['New', ''], CONTACTED: ['Contacted', ''], FOLLOW_UP: ['Follow-up', 'warn'], INTERESTED: ['Interested', 'ok'],
  CONVERTED: ['Converted', 'ok'], NOT_INTERESTED: ['Not interested', 'bad'], INVALID: ['Invalid', 'bad'],
};
export const OUTCOMES = {
  CONNECTED: 'Talked', CALL_BACK: 'Asked to call back', NO_ANSWER: 'No answer', CALL_CUT: 'Call cut', BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off', WRONG_NUMBER: 'Wrong number',
};
export const outcomeLabel = (o) => (o === 'PENDING' ? 'Not updated yet' : OUTCOMES[o] || o || '');
export const outcomeTone = (o) => ({ CONNECTED: 'ok', CALL_BACK: 'ok', PENDING: 'warn', WRONG_NUMBER: 'bad', SWITCHED_OFF: 'bad' }[o] || '');
export const OutcomeBadge = ({ o }) => <Badge tone={outcomeTone(o)}>{outcomeLabel(o)}</Badge>;
export const GRADE = { HOT: ['Hot', 'hot'], WARM: ['Warm', 'warm'], COLD: ['Cold', 'cold'] };
export const CATEGORY_HINTS = ['Restaurant', 'Cafe', 'Hotel', 'Gym', 'Salon', 'Spa', 'Clinic', 'Dentist', 'Hospital', 'School', 'Coaching', 'College',
  'Bakery', 'Jeweller', 'Boutique', 'Clothes', 'Electronics', 'Mobile shop', 'Furniture', 'Real estate', 'Car dealer', 'Pharmacy', 'Supermarket',
  'Sweet shop', 'Banquet', 'Photographer', 'Travel agent', 'CA', 'Lawyer', 'Optician', 'Pet shop'];

export const StatusBadge = ({ s }) => <Badge tone={STATUS[s]?.[1]}>{STATUS[s]?.[0] || s}</Badge>;
export const GradeBadge = ({ g, score }) => <span className={`badge grade-${GRADE[g]?.[1] || 'cold'}`} title="Lead quality score">{GRADE[g]?.[0] || 'Cold'}{score != null ? ` · ${score}` : ''}</span>;
export const RepeatBadge = ({ n }) => (n > 1 ? <span className="badge repeat" title={`Found ${n} times by the lead finder / added again`}>Repeat ×{n}</span> : null);

/** 10-digit Indian numbers -> 91XXXXXXXXXX for wa.me links. */
export const waNumber = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? `91${d}` : d;
};

/** Add a lead by hand (or edit one when `lead` is given). onDone(result) after saving. */
export function LeadForm({ lead, team, manager, onClose, onDone }) {
  const [f, setF] = useState({
    name: lead?.name || '', phone: lead?.phone || '', instagram: lead?.instagram || '', category: lead?.category || '',
    address: lead?.address || '', area: lead?.area || '', city: lead?.city || '', website: lead?.website || '', email: lead?.email || '',
    notes: lead?.notes || '', assignedTo: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const body = { ...f }; if (lead || !manager) delete body.assignedTo;
      const r = lead ? await api(`/sales/leads/${lead._id}`, { method: 'PATCH', body }) : await api('/sales/leads', { method: 'POST', body });
      onDone(r);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title={lead ? 'Edit lead' : 'Add a lead'} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form two">
          <Field label="Business name" span><input value={f.name} onChange={set('name')} required autoFocus /></Field>
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} inputMode="tel" placeholder="98765 43210" /></Field>
          <Field label="Instagram" hint="Profile link or @username"><input value={f.instagram} onChange={set('instagram')} placeholder="@business" /></Field>
          <Field label="Category">
            <input value={f.category} onChange={set('category')} list="lead-cats" />
            <datalist id="lead-cats">{CATEGORY_HINTS.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="City"><input value={f.city} onChange={set('city')} /></Field>
          <Field label="Address" span><input value={f.address} onChange={set('address')} /></Field>
          <Field label="Website"><input value={f.website} onChange={set('website')} /></Field>
          <Field label="Email"><input value={f.email} onChange={set('email')} type="email" /></Field>
          {!lead && manager && (
            <Field label="Handled by" span>
              <select value={f.assignedTo} onChange={set('assignedTo')}>
                <option value="">Nobody yet</option>
                {team.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Notes" span><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        </div>
        {!lead && <p className="muted small">If this business is already in the CRM (same number or Instagram), it is not added again: it is marked as a repeat lead.</p>}
        {err && <div className="alert">{err}</div>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : lead ? 'Save' : 'Add lead'}</button>
        </div>
      </form>
    </Modal>
  );
}

// "Today, 3:10 pm" / "Yesterday, 11:00 am" / "17 Oct, 1:16 pm"
export function when(d) {
  if (!d) return '';
  const t = new Date(d), now = new Date();
  const time = t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(now)) / 86400000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === -1) return `Yesterday, ${time}`;
  if (diff === 1) return `Tomorrow, ${time}`;
  return `${t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${time}`;
}
