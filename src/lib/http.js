import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { connect } from './db.js';
import { getAuthUser } from './auth.js';

import { HttpError, bad, forbidden, notFound } from './errors.js';
export { HttpError, bad, forbidden, notFound };

export function clientInfo(req) {
  return {
    ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || undefined,
    device: (req.headers.get('user-agent') || '').slice(0, 200),
  };
}

export function requireReason(reason, min = 5) {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < min) throw bad(`A reason of at least ${min} characters is required`);
  return r;
}

export function oid(v, label = 'id') {
  if (!mongoose.isValidObjectId(v)) throw bad(`Invalid ${label}`);
  return String(v);
}

/**
 * Wraps a route handler. `roles`: array of allowed roles, or false for public routes.
 * `allowPasswordChange`: let users with mustChangePassword through (auth routes only).
 */
export function handler(fn, { roles = null, allowPasswordChange = false } = {}) {
  return async (req, routeCtx) => {
    const rid = crypto.randomUUID();
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.get('origin');
        if (origin && new URL(origin).host !== req.headers.get('host')) throw new HttpError(403, 'Cross-origin request blocked');
      }
      await connect();
      const params = routeCtx?.params ? await routeCtx.params : {};
      let user = null;
      if (roles !== false) {
        user = await getAuthUser(req);
        if (!user) throw new HttpError(401, 'Not authenticated');
        if (user.mustChangePassword && !allowPasswordChange) {
          throw new HttpError(403, 'Password change required', { code: 'PASSWORD_CHANGE_REQUIRED' });
        }
        if (roles && !roles.includes(user.role)) throw forbidden();
      }
      const ctx = { req, user, params, rid, ...clientInfo(req) };
      const out = await fn(ctx);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { 'x-request-id': rid } });
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message, ...(e.extra || {}) }, { status: e.status });
      }
      if (e?.code === 11000) {
        const field = Object.keys(e.keyPattern || {})[0] || 'value';
        return NextResponse.json({ error: `That ${field} is already in use` }, { status: 409 });
      }
      if (e?.name === 'ValidationError' || e?.name === 'CastError') {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      console.error(`[${rid}]`, e);
      return NextResponse.json({ error: 'Internal server error', requestId: rid }, { status: 500 });
    }
  };
}

export async function readJson(req) {
  try { return await req.json(); } catch { throw bad('Invalid JSON body'); }
}
