import { M, getSettings } from '@/lib/db';
import { handler, readJson, bad } from '@/lib/http';
import { audit } from '@/lib/audit';

export const GET = handler(async () => {
  const items = await M.Location.find().sort({ name: 1 }).lean();
  return { items };
});

export const POST = handler(async (ctx) => {
  const b = await readJson(ctx.req);
  const lat = Number(b.latitude), lng = Number(b.longitude);
  if (!b.name?.trim()) throw bad('Location name is required');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('Valid latitude and longitude are required');
  const settings = await getSettings();
  const l = await M.Location.create({ name: b.name.trim(), address: b.address?.trim() || undefined, latitude: lat, longitude: lng,
    radiusMeters: Number(b.radiusMeters) || settings.defaultRadiusMeters, checkoutRadiusMeters: Number(b.checkoutRadiusMeters) || 20 });
  await audit(ctx, { action: 'CREATED_LOCATION', entityType: 'Location', entityId: l._id, location: l._id,
    newData: { name: l.name, latitude: lat, longitude: lng, radiusMeters: l.radiusMeters, checkoutRadiusMeters: l.checkoutRadiusMeters } });
  return { item: l };
}, { roles: ['ADMIN'] });
