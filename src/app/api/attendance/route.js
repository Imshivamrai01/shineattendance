import { handler } from '@/lib/http';
import { hoursWorked } from '@/lib/attendance';
import { photoUrl } from '@/lib/cloudinary';
import { getSettings } from '@/lib/db';
import { awayMs, dayFlags } from '@/lib/hours';
import { queryAttendance } from '@/lib/attendanceQuery';
import { canManage } from '@/lib/users';

export const GET = handler(async ({ req, user }) => {
  const items = await queryAttendance(user, new URL(req.url).searchParams);
  const cfg = await getSettings();
  const sessions = (r) => r.sessions.map(({ inPhoto, outPhoto, breaks, ...s }) => ({ ...s, inPhotoUrl: photoUrl(inPhoto), outPhotoUrl: photoUrl(outPhoto),
    breaks: (breaks || []).map(({ photo, ...b }) => ({ ...b, deductedMinutes: Math.round(awayMs(b, r.date, cfg) / 60000) })) }));
  // The person's current profile picture goes with every record (the list shows it next to the name).
  const person = (u) => { if (!u) return u; const { photo, ...rest } = u; return { ...rest, photoUrl: photoUrl(photo) }; };
  // Reviewing a presence check: the person's HR / Manager, a COO or Admin; never your own record.
  const canReview = (r) => !!r.user && user.role !== 'EMPLOYEE' && String(r.user._id) !== String(user._id) && canManage(user, r.user);
  return { items: items.map((r) => ({ ...r, canReview: canReview(r), user: person(r.user), sessions: sessions(r), hours: hoursWorked(r, cfg), flags: r.status === 'ACTIVE' ? dayFlags(r, cfg) : undefined })) };
});
