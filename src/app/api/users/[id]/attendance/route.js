import { handler, oid, bad } from '@/lib/http';
import { loadVisibleUser } from '@/lib/users';
import { M, getSettings } from '@/lib/db';
import { awayMs, dayFlags, lunchCfg } from '@/lib/hours';
import { dateKey } from '@/lib/dates';
import { hoursWorked } from '@/lib/attendance';
import { photoUrl } from '@/lib/cloudinary';

// Month view of one person's attendance. Access follows the same visibility rules as the profile itself.
export const GET = handler(async ({ req, user, params }) => {
  const id = oid(params.id);
  const u = await loadVisibleUser(user, id);
  const today = dateKey();
  const month = new URL(req.url).searchParams.get('month') || today.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('month must be YYYY-MM');

  // Attendance only exists from the day the person was added to this app; earlier days are "no data", never "absent".
  const start = dateKey(u.createdAt);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const recs = await M.Attendance.find({ user: id, date: { $gte: `${month}-01`, $lte: `${month}-${String(last).padStart(2, '0')}` } }).lean();
  const byDate = Object.fromEntries(recs.map((r) => [r.date, r]));
  const cfg = await getSettings();

  const days = [];
  for (let d = 1; d <= last; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday (weekly off)
    const r = byDate[date];
    let status;
    if (r) status = r.status === 'VOIDED' ? 'VOIDED' : 'PRESENT';
    else if (date > today) status = 'FUTURE';
    else if (date < start) status = 'BEFORE_START';
    else if (weekday === 0) status = 'WEEK_OFF';
    else status = 'ABSENT';
    days.push({
      date, weekday, status, hours: r && r.status === 'ACTIVE' ? hoursWorked(r, cfg) : 0, voidReason: r?.voidReason, flags: r && r.status === 'ACTIVE' ? dayFlags(r, cfg) : undefined,
      sessions: (r?.sessions || []).map(({ inPhoto, outPhoto, breaks, ...s }) => ({ ...s, inPhotoUrl: photoUrl(inPhoto), outPhotoUrl: photoUrl(outPhoto), breaks: (breaks || []).map(({ photo, ...b }) => ({ ...b, deductedMinutes: Math.round(awayMs(b, date, cfg) / 60000) })) })),
    });
  }

  const present = days.filter((x) => x.status === 'PRESENT');
  const totalHours = Math.round(present.reduce((a, x) => a + x.hours, 0) * 100) / 100;
  const months = [];
  for (let [yy, mm] = start.slice(0, 7).split('-').map(Number); `${yy}-${String(mm).padStart(2, '0')}` <= today.slice(0, 7) && months.length < 120; mm === 12 ? (yy++, mm = 1) : mm++) {
    months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }

  return {
    person: { _id: u._id, name: u.name, employeeId: u.employeeId, role: u.role }, month, office: { start: cfg.workStart || '10:00', end: cfg.workEnd || '18:00', grace: cfg.graceMinutes || 0, ...lunchCfg(cfg) }, months: months.reverse(), start, today, days,
    summary: {
      present: present.length, absent: days.filter((x) => x.status === 'ABSENT').length, voided: days.filter((x) => x.status === 'VOIDED').length,
      lateDays: present.filter((x) => x.flags?.late).length, earlyDays: present.filter((x) => x.flags?.early).length,
      totalHours, avgHours: present.length ? Math.round((totalHours / present.length) * 100) / 100 : 0,
      outsideCheckins: present.filter((x) => x.sessions.some((s) => s.inGeo?.verified === false)).length,
    },
  };
});
