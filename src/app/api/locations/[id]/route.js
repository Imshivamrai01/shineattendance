import { M } from '@/lib/db';
import { handler, readJson, oid, notFound, bad, requireReason } from '@/lib/http';
import { audit } from '@/lib/audit';

export const PATCH = handler(async (ctx) => {
  const l = await M.Location.findById(oid(ctx.params.id));
  if (!l) throw notFound('Location not found');
  const b = await readJson(ctx.req);
  requireReason(b.reason);
  const old = { name: l.name, address: l.address, latitude: l.latitude, longitude: l.longitude, radiusMeters: l.radiusMeters, checkoutRadiusMeters: l.checkoutRadiusMeters, status: l.status };
  if (b.name !== undefined) { if (!b.name.trim()) throw bad('Name cannot be empty'); l.name = b.name.trim(); }
  if (b.address !== undefined) l.address = b.address.trim() || undefined;
  for (const k of ['latitude', 'longitude', 'radiusMeters', 'checkoutRadiusMeters']) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n)) throw bad(`${k} must be a number`);
    l[k] = n;
  }
  if (b.status !== undefined) { if (!['ACTIVE', 'INACTIVE'].includes(b.status)) throw bad('Invalid status'); l.status = b.status; }
  await l.save();
  const nw = { name: l.name, address: l.address, latitude: l.latitude, longitude: l.longitude, radiusMeters: l.radiusMeters, checkoutRadiusMeters: l.checkoutRadiusMeters, status: l.status };
  const geofence = ['latitude', 'longitude', 'radiusMeters', 'checkoutRadiusMeters'].some((k) => old[k] !== nw[k]);
  await audit(ctx, { action: geofence ? 'CHANGED_GEOFENCE' : 'UPDATED_LOCATION', entityType: 'Location', entityId: l._id,
    location: l._id, oldData: old, newData: nw, reason: b.reason });
  return { item: l };
}, { roles: ['ADMIN'] });
