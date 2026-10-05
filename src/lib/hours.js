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
