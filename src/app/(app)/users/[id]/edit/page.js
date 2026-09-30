'use client';
import { Suspense, use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Skeleton } from '@/components/ui';
import ProfileEditForm from '@/components/ProfileEditor';
import { planEdit } from '@/lib/editPlan';

function Edit({ id }) {
  const me = useMe();
  const wantMode = useSearchParams().get('mode');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/users/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);

  if (err) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const self = String(me._id) === String(d.user._id);
  const plan = planEdit(me, d.user, wantMode);
  const back = self ? '/profile' : `/users/${id}`;
  if (!plan || (!self && !d.canEdit && me.role !== 'ADMIN')) {
    return <div className="alert">You cannot edit this person. <Link href={back}>Go back</Link></div>;
  }
  return <ProfileEditForm key={`${id}-${plan.mode}`} user={d.user} fields={plan.fields} mode={plan.mode} note={plan.note} back={back} />;
}

export default function Page({ params }) {
  const { id } = use(params);
  return <Suspense fallback={<Skeleton />}><Edit id={id} /></Suspense>;
}
