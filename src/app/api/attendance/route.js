import { handler } from '@/lib/http';
import { hoursWorked } from '@/lib/attendance';
import { photoUrl } from '@/lib/cloudinary';
import { getSettings } from '@/lib/db';
import { dayFlags } from '@/lib/hours';
import { queryAttendance } from '@/lib/attendanceQuery';

export const GET = handler(async ({ req, user }) => {
  const items = await queryAttendance(user, new URL(req.url).searchParams);
  const cfg = await getSettings();
  const sessions = (r) => r.sessions.map(({ inPhoto, outPhoto, breaks, ...s }) => ({ ...s, inPhotoUrl: photoUrl(inPhoto), outPhotoUrl: photoUrl(outPhoto), breaks: (breaks || []).map(({ photo, ...b }) => b) }));
  // The person's current profile picture goes with every record (the list shows it next to the name).
  const person = (u) => { if (!u) return u; const { photo, ...rest } = u; return { ...rest, photoUrl: photoUrl(photo) }; };
  return { items: items.map((r) => ({ ...r, user: person(r.user), sessions: sessions(r), hours: hoursWorked(r), flags: r.status === 'ACTIVE' ? dayFlags(r, cfg) : undefined })) };
});
