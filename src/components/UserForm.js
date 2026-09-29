'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { Field } from '@/components/ui';

const contact = { name: '', relationship: '', mobile: '' };
export const emptyForm = {
  employeeId: '', password: '', name: '', email: '', mobile: '', fatherName: '', motherName: '', dob: '', address: '', city: '', state: '', pincode: '',
  emergencyContact1: { ...contact }, emergencyContact2: { ...contact },
  department: '', designation: '', joiningDate: '', manager: '', hr: '', location: '', employeeType: '',
};

/** Reference lists for dropdowns. Empty lists are fine: everything is optional. */
export function useRefs() {
  const [r, setR] = useState({ departments: [], locations: [], managers: [], hrs: [] });
  useEffect(() => {
    Promise.all([api('/departments'), api('/locations'), api('/directory?role=MANAGER'), api('/directory?role=HR'), api('/directory?role=COO')])
      .then(([d, l, m, h, c]) => setR({ departments: d.items.filter((x) => x.status === 'ACTIVE'), locations: l.items.filter((x) => x.status === 'ACTIVE'),
        managers: [...c.items.map((x) => ({ ...x, name: `${x.name} (COO)` })), ...m.items], hrs: h.items }))
      .catch(() => {});
  }, []);
  return r;
}

export function Contact({ label, value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <Field label={`${label} name`}><input value={value.name || ''} onChange={set('name')} /></Field>
      <Field label="Relationship"><input value={value.relationship || ''} onChange={set('relationship')} /></Field>
      <Field label="Mobile"><input value={value.mobile || ''} onChange={set('mobile')} inputMode="tel" /></Field>
    </>
  );
}

export function Select({ value, onChange, items, none = 'Not assigned', label = (i) => i.name }) {
  return (
    <select value={value || ''} onChange={onChange}>
      <option value="">{none}</option>
      {items.map((i) => <option key={i._id} value={i._id}>{label(i)}</option>)}
    </select>
  );
}
