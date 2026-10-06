// Office hours (default 10:00 - 18:00 IST): who came late / left early.
export const DEFAULT_HOURS = { workStart: '10:00', workEnd: '18:00', graceMinutes: 0 };
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const istMin = (d) => { const x = new Date(new Date(d).getTime() + 330 * 60000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
export const hoursCfg = (s) => ({ workStart: s?.workStart || DEFAULT_HOURS.workStart, workEnd: s?.workEnd || DEFAULT_HOURS.workEnd, graceMinutes: Number(s?.graceMinutes) || 0 });

/** "10:00" -> "10:00 AM", "18:00" -> "6:00 PM" */
export function label12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
export const minutesText = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`);

/** Flags for one attendance record. Late = first check-in after start + grace. Early = closed for the day before the end time. */
export function dayFlags(rec, cfg) {
  const c = hoursCfg(cfg);
  const s = rec?.sessions || [];
  if (!s.length) return { late: false, lateMinutes: 0, early: false, earlyMinutes: 0 };
  const start = toMin(c.workStart), end = toMin(c.workEnd);
  const inMin = istMin(s[0].checkIn);
  const late = inMin > start + c.graceMinutes;
  const closed = s.every((x) => x.checkOut);
  const lastOut = closed ? s.map((x) => x.checkOut).sort((a, b) => new Date(a) - new Date(b)).at(-1) : null;
  const outMin = lastOut ? istMin(lastOut) : null;
  const early = closed && outMin < end;
  return { late, lateMinutes: late ? inMin - start : 0, early, earlyMinutes: early ? end - outMin : 0 };
}

/** True once office hours are over for the day (IST), e.g. from 18:00. */
export const afterHours = (cfg, d = new Date()) => istMin(d) >= toMin(hoursCfg(cfg).workEnd);
/** The office closing instant of an IST date key ("2026-09-30" -> 18:00 IST that day). */
export const closingTime = (dateKey, cfg) => new Date(`${dateKey}T${hoursCfg(cfg).workEnd}:00+05:30`);

// Lunch break (default 1:30 - 2:30 PM IST): leaving the office then is fine and is never counted against anyone.
export const lunchCfg = (s) => ({ lunchStart: s?.lunchStart || '13:30', lunchEnd: s?.lunchEnd || '14:30' });
export const inLunch = (cfg, d = new Date()) => { const l = lunchCfg(cfg), m = istMin(d); return m >= toMin(l.lunchStart) && m < toMin(l.lunchEnd); };
const istAt = (dateKey, hhmm) => new Date(`${dateKey}T${hhmm}:00+05:30`).getTime();

/** Milliseconds of one time away (auto check-out -> return) that are deducted: everything outside the lunch break. */
export function awayMs(b, dateKey, cfg) {
  if (!b?.outAt || !b?.backAt) return 0;
  const out = new Date(b.outAt).getTime(), back = new Date(b.backAt).getTime();
  const l = lunchCfg(cfg);
  const lunch = Math.max(0, Math.min(back, istAt(dateKey, l.lunchEnd)) - Math.max(out, istAt(dateKey, l.lunchStart)));
  return Math.max(0, back - out - lunch);
}

/** Hours worked on a day: closed sessions, minus time spent away from the office (lunch excepted). */
export function workedHours(rec, cfg) {
  let ms = 0;
  for (const s of rec?.sessions || []) {
    if (!s.checkIn || !s.checkOut) continue;
    ms += new Date(s.checkOut) - new Date(s.checkIn);
    for (const b of s.breaks || []) ms -= awayMs(b, rec.date, cfg);
  }
  return Math.round((Math.max(0, ms) / 3600000) * 100) / 100;
}
