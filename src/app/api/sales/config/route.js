import { M, getSettings } from '@/lib/db';
import { readJson, bad, forbidden, oid } from '@/lib/http';
import { audit } from '@/lib/audit';
import { salesHandler } from '@/lib/sales';
import { checkGoogleKey } from '@/lib/leadFinder';

const canConfigure = (ctx) => ['ADMIN', 'COO'].includes(ctx.user.role);

// Sales settings: who has sales access, and the Google Places key status (the key itself never leaves the server).
export const GET = salesHandler(async (ctx) => {
  const s = await getSettings();
  const people = await M.User.find({ status: 'ACTIVE', role: { $nin: ['ADMIN', 'COO'] } }).select('name employeeId role designation salesAccess').sort({ name: 1 }).lean();
  return { googleReady: !!s.placesKey, canConfigure: canConfigure(ctx), people };
}, { manager: true });

// { placesKey } saves (or with '' removes) the Google key after testing it; { userId, salesAccess } gives / removes sales access.
export const POST = salesHandler(async (ctx) => {
  if (!canConfigure(ctx)) throw forbidden();
  const b = await readJson(ctx.req);
  if (b.placesKey !== undefined) {
    const key = String(b.placesKey || '').trim();
    if (key) {
      if (!/^[\w-]{20,100}$/.test(key)) throw bad('That does not look like a Google API key');
      try { await checkGoogleKey(key); } catch (e) { throw bad(`Google rejected the key: ${e.message}`); }
    }
    await M.Setting.updateOne({ key: 'system' }, { $set: { placesKey: key || null } }, { upsert: true });
    await audit(ctx, { action: key ? 'SET_PLACES_KEY' : 'REMOVED_PLACES_KEY', entityType: 'Setting', entityId: 'sales' });
    return { ok: true, googleReady: !!key };
  }
  if (b.userId !== undefined) {
    if (!['NONE', 'AGENT', 'MANAGER'].includes(b.salesAccess)) throw bad('Unknown access level');
    const u = await M.User.findById(oid(b.userId, 'user'));
    if (!u || ['ADMIN', 'COO'].includes(u.role)) throw bad('Admin and COO always have full sales access');
    const old = u.salesAccess || 'NONE';
    if (old === b.salesAccess) return { ok: true };
    u.salesAccess = b.salesAccess;
    await u.save();
    await audit(ctx, { action: 'CHANGED_SALES_ACCESS', entityType: 'User', entityId: u._id, subjectId: u._id, oldData: { salesAccess: old }, newData: { salesAccess: b.salesAccess } });
    return { ok: true };
  }
  throw bad('Nothing to change');
}, { manager: true });
