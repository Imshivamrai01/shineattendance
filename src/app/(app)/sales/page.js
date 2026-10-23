'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui';

// Sales lives in CRM -> Sales now. Old links (/sales?tab=ai&call=…) keep working.
export default function SalesRedirect() {
  const router = useRouter();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    q.set('section', 'sales');
    router.replace(`/crm?${q}`);
  }, [router]);
  return <Skeleton />;
}
