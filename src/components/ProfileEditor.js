'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, setFlash } from '@/lib/client';
import { Field } from '@/components/ui';
import { Contact, Select, useRefs } from '@/components/UserForm';

const idOf = (v) => (v && typeof v === 'object' ? v._id : v) || '';
const blank = (v) => (v == null ? '' : v);
const cnorm = (c) => JSON.stringify({ name: c?.name || '', relationship: c?.relationship || '', mobile: c?.mobile || '' });
const LABEL = { name: 'Full name', email: 'Email', mobile: 'Mobile', employeeId: 'Employee ID (login User ID)', fatherName: "Father's name", motherName: "Mother's name", dob: 'Date of birth',
  address: 'Address', city: 'City', state: 'State', pincode: 'PIN code', designation: 'Designation', joiningDate: 'Joining date' };
const INPUT_TYPE = { dob: 'date', joiningDate: 'date', email: 'email' };
const CONTACTS = [['emergencyContact1', 'Contact 1'], ['emergencyContact2', 'Contact 2']];

// Each section shows only when at least one of its fields may be edited.
const SECTIONS = [
  { title: 'Account', fields: ['role', 'name', 'email', 'mobile', 'employeeId'] },
  { title: 'Personal details', fields: ['fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode'] },
  { title: 'Emergency contacts', fields: ['emergencyContact1', 'emergencyContact2'] },
  { title: 'Employment', fields: ['department', 'designation', 'joiningDate', 'employeeType', 'manager', 'hr', 'location'] },
];

/**
 * Full edit page form. mode 'direct' saves at once (Admin, and COO/Manager assignments); mode 'request'
 * sends the change up for approval. `fields` decides what is editable.
 */
export default function ProfileEditForm({ user, fields, mode, note, back }) {
  const refs = useRefs();
  const router = useRouter();
  const init = {};
  for (const k of ['name', 'email', 'mobile', 'employeeId', 'fatherName', 'motherName', 'dob', 'address', 'city', 'state', 'pincode', 'designation', 'joiningDate', 'employeeType']) init[k] = blank(user[k]);
  for (const [k] of CONTACTS) init[k] = user[k] || {};
  for (const k of ['department', 'manager', 'hr', 'location']) init[k] = idOf(user[k]);
  init.role = user.role;
  const [f, setF] = useState(init);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const show = (k) => fields.includes(k);

  // Managers and COOs report to nobody, and HR has no HR: hide fields that don't apply. Nobody is their own manager/HR.
  const senior = user.role === 'MANAGER' || user.role === 'COO';
  const showRef = (k) => show(k) && !((k === 'manager' || k === 'hr') && senior) && !(k === 'hr' && user.role === 'HR');
  const others = (list) => list.filter((x) => x._id !== user._id);

  const changed = () => {
    const c = {};
    for (const k of fields) {
      if (CONTACTS.some(([x]) => x === k)) { if (cnorm(f[k]) !== cnorm(init[k])) c[k] = f[k]; }
      else if (String(f[k] ?? '') !== String(init[k] ?? '')) c[k] = f[k];
    }
    return c;
  };
  const count = Object.keys(changed()).length;

  const submit = async (e) => {
    e.preventDefault(); setErr('');
    const changes = changed();
    if (!Object.keys(changes).length) return setErr('Nothing was changed');
    setBusy(true);
    try {
      if (mode === 'direct') await api(`/users/${user._id}`, { method: 'PATCH', body: { changes, reason } });
      else await api('/requests', { method: 'POST', body: { type: 'PROFILE_CHANGE', subjectId: user._id, changes, reason } });
      setFlash(mode === 'direct' ? 'Changes saved and recorded in the audit log.' : `Change request submitted. It is now waiting for ${note || 'approval'}.`);
      router.push(back);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <h1>{mode === 'direct' ? `Edit ${user.name}` : 'Request a change'}</h1>
          <div className="muted">{user.role}{user.employeeId ? ` · ${user.employeeId}` : ''}{mode === 'request' && user.name ? ` · ${user.name}` : ''}</div>
        </div>
      </div>
      {mode === 'request'
        ? <div className="alert warn">Nothing changes right away. Your request goes to <b>{note || 'an approver'}</b> and is applied once approved. Steps with nobody assigned are skipped.</div>
        : <div className="alert ok">These changes are saved immediately and recorded in the audit log with your reason.</div>}
      {err && <div className="alert">{err}</div>}

      {SECTIONS.map((s) => {
        const active = s.fields.filter((k) => (['department', 'manager', 'hr', 'location'].includes(k) ? showRef(k) : show(k)));
        if (!active.length) return null;
        return (
          <div className="card" key={s.title}>
            <h2>{s.title}</h2>
            {s.title === 'Emergency contacts' ? (
              <div style={{ display: 'grid', gap: 16 }}>
                {CONTACTS.filter(([k]) => show(k)).map(([k, label]) => (
                  <div key={k} className="sub"><div className="sub-title">{label}</div>
                    <div className="form three"><Contact label="" value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} /></div></div>
                ))}
              </div>
            ) : (
              <div className="form">
                {active.map((k) => {
                  if (k === 'role') return (
                    <Field key={k} label="Role" hint="Changes what this person can see and do">
                      <select value={f.role} onChange={set('role')}><option value="EMPLOYEE">Employee</option><option value="HR">HR</option><option value="MANAGER">Manager</option><option value="COO">COO (Chief Operating Officer)</option></select></Field>);
                  if (k === 'employeeType') return (
                    <Field key={k} label="Employee type"><select value={f.employeeType} onChange={set('employeeType')}>
                      <option value="">Not set</option><option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACT">Contract</option><option value="INTERN">Intern</option></select></Field>);
                  if (k === 'department') return <Field key={k} label="Department"><Select value={f.department} onChange={set('department')} items={refs.departments} none="None" /></Field>;
                  if (k === 'location') return <Field key={k} label="Assigned location"><Select value={f.location} onChange={set('location')} items={refs.locations} none="None" /></Field>;
                  if (k === 'manager') return <Field key={k} label="Reports to (Manager or COO)"><Select value={f.manager} onChange={set('manager')} items={others(refs.managers)} none="Nobody" /></Field>;
                  if (k === 'hr') return <Field key={k} label="HR"><Select value={f.hr} onChange={set('hr')} items={others(refs.hrs)} none="Nobody" /></Field>;
                  return <Field key={k} label={LABEL[k] || k} span={k === 'address'}><input type={INPUT_TYPE[k] || 'text'} value={f[k]} onChange={set(k)} /></Field>;
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="card">
        <Field label="Reason for change (required)" hint="Recorded with the change so everyone can see why it was made">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
        </Field>
      </div>

      <div className="savebar">
        <span className="muted small" style={{ marginRight: 'auto' }}>{count ? `${count} change${count === 1 ? '' : 's'}` : 'No changes yet'}</span>
        <Link className="btn" href={back}>Cancel</Link>
        <button className="btn primary" disabled={busy || !count || reason.trim().length < 5}>{busy ? 'Saving…' : mode === 'direct' ? 'Save changes' : 'Submit for approval'}</button>
      </div>
    </form>
  );
}
