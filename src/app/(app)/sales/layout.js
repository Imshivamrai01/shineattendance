'use client';
import { CallProvider } from '@/components/SalesCall';

export default function SalesLayout({ children }) {
  return <CallProvider>{children}</CallProvider>;
}
