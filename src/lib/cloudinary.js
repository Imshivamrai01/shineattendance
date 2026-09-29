import crypto from 'node:crypto';
import { HttpError, bad } from './errors.js';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest();
const cfg = () => ({
  cloud: process.env.CLOUDINARY_CLOUD_NAME, key: process.env.CLOUDINARY_API_KEY, secret: process.env.CLOUDINARY_API_SECRET,
});
export const photosEnabled = () => { const c = cfg(); return !!(c.cloud && c.key && c.secret); };

const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * Upload a camera capture (JPEG data URL) as a private "authenticated" asset.
 * Returns { publicId, version } to store; use photoUrl() to get a signed viewing URL.
 */
export async function uploadAttendancePhoto(dataUrl, { userId, kind }) {
  const { cloud, key, secret } = cfg();
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw bad('A live camera photo is required');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 200 || buf.length > MAX_BYTES) throw bad('Photo is invalid or too large');

  const folder = 'shine_attendance/attendance';
  const publicId = `${userId}_${kind}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, public_id: publicId, timestamp, type: 'authenticated' };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = sha1(toSign + secret).toString('hex');

  const form = new FormData();
  form.set('file', new Blob([buf], { type: 'image/jpeg' }), 'capture.jpg');
  for (const [k, v] of Object.entries({ ...params, api_key: key, signature })) form.set(k, String(v));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Cloudinary upload failed', res.status, out?.error?.message);
    throw new HttpError(502, 'Could not save the photo. Please try again.');
  }
  return { publicId: out.public_id, version: out.version };
}

/** Time-unlimited signed URL for a private asset (only handed to logged-in, permitted users). */
export function photoUrl(p) {
  if (!p?.publicId || !photosEnabled()) return undefined;
  const { cloud, secret } = cfg();
  const sig = sha1(`${p.publicId}.jpg${secret}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').slice(0, 8);
  return `https://res.cloudinary.com/${cloud}/image/authenticated/s--${sig}--/v${p.version}/${p.publicId}.jpg`;
}
