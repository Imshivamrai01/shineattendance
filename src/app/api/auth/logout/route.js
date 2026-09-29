import { NextResponse } from 'next/server';
import { handler } from '@/lib/http';
import { destroySession, COOKIE } from '@/lib/auth';

export const POST = handler(async ({ req }) => {
  await destroySession(req);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}, { roles: false });
