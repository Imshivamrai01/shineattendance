'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Field, TempPassword, Skeleton } from '@/components/ui';
import { Contact, Select, emptyForm, useRefs } from '@/components/UserForm';

function NewUser() {
  const me = useMe();
  const sp = useSearchParams();
  const router = useRouter();
  const refs = useRefs();
  const [role, setRole] = useState(me.role === 'HR' ? 'EMPLOYEE' : (sp.get('role') || 'EMPLOYEE'));
  const [f, setF] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const body = { ...f, role };
      if (senior) { body.manager = ''; body.hr = ''; }
      if (role === 'MANAGER') body.department = '';
      const d = await api('/users', { method: 'POST', body });
      setTemp({ pw: d.tempPassword || f.password, id: d.user._id, name: d.user.name });
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  const isEmp = role === 'EMPLOYEE';
  const senior = role === 'MANAGER' || role === 'COO'; // no reporting manager/HR; Managers also have no single department
  // The COO belongs to Operations by default.
  useEffect(() => {
    if (role !== 'COO' || f.department) return;
    const ops = refs.departments.find((d) => d.name.toUpperCase() === 'OPERATIONS');
    if (ops) setF((x) => ({ ...x, department: ops._id }));
  }, [role, refs.departments]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <h1>Add {role === 'COO' ? 'Chief Operating Officer' : role === 'MANAGER' ? 'Manager' : role === 'HR' ? 'HR user' : 'Employee'}</h1>
      <p className="muted">Name and Employee ID are required. The Employee ID is the login User ID. Everything else can be completed later.</p>
      {err && <div className="alert">{err}</div>}
      <form onSubmit={submit}>
        <div className="card">
          <h2>Account</h2>
          <div className="form">
            {me.role === 'ADMIN' && (
              <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="EMPLOYEE">Employee</option><option value="HR">HR</option><option value="MANAGER">Manager</option><option value="COO">Chief Operating Officer</option></select></Field>
            )}
            <Field label="Full name *"><input value={f.name} onChange={set('name')} required /></Field>
            <Field label="Email" hint="Optional"><input type="email" value={f.email} onChange={set('email')} /></Field>
            <Field label="Mobile number"><input value={f.mobile} onChange={set('mobile')} inputMode="tel" /></Field>
            <Field label="Employee ID * (login User ID)" hint="The employee's existing company ID"><input value={f.employeeId} onChange={set('employeeId')} required /></Field>
            <Field label="Password" hint="Set the initial password to hand over. Blank = auto-generate. Changed at first login."><input type="text" autoComplete="off" value={f.password} onChange={set('password')} /></Field>
          </div>
        </div>

        <div className="card">
          <h2>Employment</h2>
          <div className="form">
            {role !== 'MANAGER' && <Field label="Department"><Select value={f.department} onChange={set('department')} items={refs.departments} /></Field>}
            <Field label="Designation"><input value={f.designation} onChange={set('designation')} /></Field>
            <Field label="Joining date"><input type="date" value={f.joiningDate} onChange={set('joiningDate')} /></Field>
            <Field label="Employee type"><select value={f.employeeType} onChange={set('employeeType')}>
              <option value="">Not set</option><option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option><option value="CONTRACT">Contract</option><option value="INTERN">Intern</option></select></Field>
            {!senior && <Field label="Manager" hint={refs.managers.length ? '' : 'No Managers added yet'}><Select value={f.manager} onChange={set('manager')} items={refs.managers} /></Field>}
            {isEmp && me.role === 'ADMIN' && <Field label="HR" hint={refs.hrs.length ? '' : 'No HR users added yet'}><Select value={f.hr} onChange={set('hr')} items={refs.hrs} /></Field>}
            <Field label="Assigned location" hint={refs.locations.length ? '' : 'No locations configured yet'}><Select value={f.location} onChange={set('location')} items={refs.locations} /></Field>
          </div>
        </div>

        <details className="card">
          <summary><b>Personal details &amp; emergency contacts</b> <span className="muted">(optional)</span></summary>
          <div className="form" style={{ marginTop: 14 }}>
            <Field label="Father's name"><input value={f.fatherName} onChange={set('fatherName')} /></Field>
            <Field label="Mother's name"><input value={f.motherName} onChange={set('motherName')} /></Field>
            <Field label="Date of birth"><input type="date" value={f.dob} onChange={set('dob')} /></Field>
            <Field label="Address" span><input value={f.address} onChange={set('address')} /></Field>
            <Field label="City"><input value={f.city} onChange={set('city')} /></Field>
            <Field label="State"><input value={f.state} onChange={set('state')} /></Field>
            <Field label="PIN code"><input value={f.pincode} onChange={set('pincode')} inputMode="numeric" /></Field>
            <Contact label="Contact 1" value={f.emergencyContact1} onChange={(v) => setF({ ...f, emergencyContact1: v })} />
            <Contact label="Contact 2" value={f.emergencyContact2} onChange={(v) => setF({ ...f, emergencyContact2: v })} />
          </div>
        </details>

        <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button><Link className="btn" href="/users">Cancel</Link></div>
      </form>
      {temp && <TempPassword value={temp.pw} who={temp.name} onClose={() => router.push(`/users/${temp.id}`)} />}
    </>
  );
}
export default function Page() { return <Suspense fallback={<Skeleton />}><NewUser /></Suspense>; }
