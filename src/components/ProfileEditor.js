'use client';
import { useState } from 'react';
import { api } from '@/lib/client';
import { Field, Modal } from '@/components/ui';
import { Contact, Select, useRefs } from '@/components/UserForm';

const TEXT = [
  ['name', 'Full name'], ['email', 'Email'], ['mobile', 'Mobile'], ['fatherName', "Father's name"], ['motherName', "Mother's name"],
  ['dob', 'Date of birth', 'date'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['pincode', 'PIN code'],
  ['designation', 'Designation'], ['joiningDate', 'Joining date', 'date'], ['employeeId', 'Employee ID'],
];
const CONTACTS = [['emergencyContact1', 'Contact 1'], ['emergencyContact2', 'Contact 2']];
const REFS = [['department', 'Department', 'departments'], ['manager', 'Manager', 'managers'], ['hr', 'HR', 'hrs'], ['location', 'Assigned location', 'locations']];

const idOf = (v) => (v && typeof v === 'object' ? v._id : v) || '';
const blank = (v) => (v == null ? '' : v);
const cnorm = (c) => JSON.stringify({ name: c?.name || '', relationship: c?.relationship || '', mobile: c?.mobile || '' });

/**
 * mode 'direct': PATCH the user (Admin/Manager). mode 'request': POST a change request (Employee/HR).
 * `fields` restricts which inputs are shown.
 */
export default function ProfileEditor({ user, fields, mode, onClose, onDone }) {
  const refs = useRefs();
  const init = {};
  for (const [k] of TEXT) init[k] = blank(user[k]);
  for (const [k] of CONTACTS) init[k] = user[k] || {};
  for (const [k] of REFS) init[k] = idOf(user[k]);
  init.employeeType = blank(user.employeeType);
  init.status = user.status;
  init.role = user.role;
  const [f, setF] = useState(init);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const show = (k) => fields.includes(k);

  const submit = async (e) => {
    e.preventDefault(); setErr('');
    const changes = {};
    for (const k of fields) {
      if (CONTACTS.some(([c]) => c === k)) { if (cnorm(f[k]) !== cnorm(init[k])) changes[k] = f[k]; }
      else if (String(f[k] ?? '') !== String(init[k] ?? '')) changes[k] = f[k];
    }
    if (!Object.keys(changes).length) return setErr('Nothing was changed');
    setBusy(true);
    try {
      if (mode === 'direct') await api(`/users/${user._id}`, { method: 'PATCH', body: { changes, reason } });
      else await api('/requests', { method: 'POST', body: { type: 'PROFILE_CHANGE', subjectId: user._id, changes, reason } });
      onDone(mode === 'direct' ? 'Changes saved and recorded in the audit log.' : 'Change request submitted for approval.');
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  return (
    <Modal title={mode === 'direct' ? `Edit ${user.name}` : 'Request a profile change'} onClose={onClose}>
      <form onSubmit={submit}>
        {mode === 'request' && <div className="alert warn">Changes are applied only after approval. Employee requests go to HR, then the Manager.</div>}
        {err && <div className="alert">{err}</div>}
        <div className="form two">
          {TEXT.filter(([k]) => show(k)).map(([k, label, type]) => (
            <Field key={k} label={label}><input type={type || 'text'} value={f[k]} onChange={set(k)} /></Field>
          ))}
          {REFS.filter(([k]) => show(k)).map(([k, label, list]) => (
            <Field key={k} label={label}><Select value={f[k]} onChange={set(k)} items={refs[list]} none="None" /></Field>
          ))}
          {show('role') && (
            <Field label="Role" hint="Changing the role changes what this person can see and do"><select value={f.role} onChange={set('role')}>
              <option value="EMPLOYEE">Employee</option><option value="HR">HR</option><option value="MANAGER">Manager</option><option value="COO">COO (Chief Operating Officer)</option></select></Field>
          )}
          {show('employeeType') && (
            <Field label="Employee type"><select value={f.employeeType} onChange={set('employeeType')}>
              <option value="">Not set</option><option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACT">Contract</option><option value="INTERN">Intern</option></select></Field>
          )}
          {CONTACTS.filter(([k]) => show(k)).map(([k, label]) => (
            <div key={k} className="span"><div className="form three">
              <Contact label={label} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} /></div></div>
          ))}
          <Field label="Reason for change (required)" span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || reason.trim().length < 5}>{busy ? 'Saving…' : mode === 'direct' ? 'Save changes' : 'Submit request'}</button>
        </div>
      </form>
    </Modal>
  );
}
