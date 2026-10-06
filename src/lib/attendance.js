import { M, getSettings } from './db.js';
import { audit } from './audit.js';
import { bad, notFound, HttpError } from './http.js';
import { dateKey } from './dates.js';
import { afterHours, closingTime, dayFlags, hoursCfg, inLunch, label12, lunchEndTime, minutesText, workedHours } from './hours.js';
import { distanceMeters } from './geo.js';
import { photosEnabled, uploadAttendancePhoto } from './cloudinary.js';
import { queueSheetSync } from './sheetSync.js';
import { notifyReentry, notifyAttendanceChange, notifyCheckin, notifyCheckout } from './notify.js';

const MAX_CHECKIN_ACCURACY_M = 30;  // GPS fixes worse than this get the "weak GPS" hint
const MAX_GPS_MARGIN_M = 40;        // most uncertainty we will forgive, however poor the fix
const IGNORE_PING_ACCURACY_M = 50;  // ...and are ignored when deciding to auto check-out
const OUT_PINGS_TO_CHECKOUT = 3;    // consecutive out-of-range pings (avoids one-off GPS jumps)
// ...and they must span this long, so one bad reading (or two reports arriving together) can't check someone out.
const OUT_SECONDS_TO_CHECKOUT = process.env.OUT_SECONDS_TO_CHECKOUT != null ? Number(process.env.OUT_SECONDS_TO_CHECKOUT) : 120;
// A checked-in phone that sends no location for this long is checked out, at the time of its last report.
const SILENT_MINUTES_TO_CHECKOUT = process.env.SILENT_MINUTES_TO_CHECKOUT != null ? Number(process.env.SILENT_MINUTES_TO_CHECKOUT) : 20;
// Only a precise GPS fix can show that someone left. Indoors, phones fall back to Wi-Fi / cell-tower positions that
// claim 30-50 m accuracy and can sit 80-600 m away for minutes (seen in production), so those never count as "outside".
const PRECISE_FIX_M = 20;

// Phones report accuracy as a ~68% radius, and indoors a fix is easily 20-40 m off. Allow twice the reported
// accuracy (capped) so someone inside the office isn't refused, or checked out, because of GPS error.
const gpsMargin = (accuracy) => (accuracy == null ? 0 : Math.min(Math.round(accuracy * 2), MAX_GPS_MARGIN_M));

function readCoords(coords) {
  const lat = Number(coords?.lat), lng = Number(coords?.lng);
  const ok = coords?.lat != null && coords?.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const accuracy = Number(coords?.accuracy);
  return { ok, lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : null };
}

// The user's assigned location, otherwise every active office location.
async function candidateLocations(user) {
  if (user.location) {
    const loc = await M.Location.findById(user.location).lean();
    if (loc && loc.status === 'ACTIVE') return [loc];
  }
  return M.Location.find({ status: 'ACTIVE' }).lean();
}

async function checkInGeo(user, coords) {
  const settings = await getSettings();
  const c = readCoords(coords);
  const locs = await candidateLocations(user);
  // No office configured yet: don't block attendance.
  if (!locs.length) return { geo: c.ok ? { lat: c.lat, lng: c.lng, verified: null } : undefined, location: undefined };
  if (!c.ok) {
    if (settings.enforceGeofence) throw bad('Location access is required to mark attendance. Allow location in your browser and try again.');
    return { geo: { verified: false }, location: locs[0]._id };
  }
  let best = null;
  for (const l of locs) {
    const distance = distanceMeters(c.lat, c.lng, l.latitude, l.longitude);
    if (!best || distance < best.distance) best = { loc: l, distance };
  }
  const distance = Math.round(best.distance);
  const verified = distance <= best.loc.radiusMeters + gpsMargin(c.accuracy);
  if (!verified && settings.enforceGeofence) {
    const weak = c.accuracy != null && c.accuracy > MAX_CHECKIN_ACCURACY_M;
    throw new HttpError(403, `You are not in the office (about ${distance} m from ${best.loc.name}; check-in needs ${best.loc.radiusMeters} m` +
      (c.accuracy != null ? `, your GPS is accurate to ±${Math.round(c.accuracy)} m).` : ').') +
      (weak ? ' Turn on GPS / precise location, step near a window and try again.' : ''));
  }
  return { geo: { lat: c.lat, lng: c.lng, distance, accuracy: c.accuracy ?? undefined, verified }, location: best.loc._id };
}

export async function checkIn(ctx, coords) {
  const user = ctx.user;
  const cfg = await getSettings();
  if (afterHours(cfg)) throw new HttpError(403, `Office hours are over. Check-in closes at ${label12(hoursCfg(cfg).workEnd)}.`);
  const { geo, location } = await checkInGeo(user, coords);
  const date = dateKey();
  if (await M.Attendance.exists({ user: user._id, status: 'ACTIVE', 'sessions.checkOut': null })) throw new HttpError(409, 'You are already checked in');
  // After leaving the premises (auto check-out) the user must give a reason to check in again.
  const todays = await M.Attendance.findOne({ user: user._id, date }).lean();
  const prev = todays?.status === 'ACTIVE' ? todays.sessions.at(-1) : null;
  const resume = !!(prev?.autoCheckout && prev.checkOut);
  let reentryReason, lateReason;
  if (resume) {
    reentryReason = String(coords?.reason || '').trim().slice(0, 300);
    if (reentryReason.length < 3) throw new HttpError(400, 'You left the office. Enter a reason to check in again.', { code: 'REASON_REQUIRED' });
  }
  const now = new Date();
  // First check-in of the day after office start (+ grace): the person must say why they are late.
  const late = !todays?.sessions?.length ? dayFlags({ sessions: [{ checkIn: now }] }, cfg) : null;
  if (late?.late) {
    lateReason = String(coords?.lateReason || '').trim().slice(0, 300);
    if (lateReason.length < 3) throw new HttpError(400, `You are ${minutesText(late.lateMinutes)} late. Enter the reason for being late.`, { code: 'LATE_REASON_REQUIRED' });
  }
  // Live camera photo (only present when captured in the app; the server can't tell camera from file, so the UI offers camera only).
  const inPhoto = photosEnabled() ? await uploadAttendancePhoto(coords?.photo, { userId: user._id, kind: 'in' }) : undefined;
  await M.Attendance.updateOne({ user: user._id, date }, { $setOnInsert: { user: user._id, date, sessions: [] } }, { upsert: true });
  const allClosed = { user: user._id, date, status: 'ACTIVE', sessions: { $not: { $elemMatch: { checkOut: null } } } };
  const r = resume
    // Back after an automatic check-out: the earlier session carries on from its original check-in time.
    // The time away is recorded (with the reason and the return photo) and deducted from the hours, except during lunch.
    ? await M.Attendance.updateOne(allClosed,
      { $set: { 'sessions.$[s].autoCheckout': false, 'sessions.$[s].silent': false, 'sessions.$[s].lastPingAt': now }, $unset: { 'sessions.$[s].checkOut': '', 'sessions.$[s].outGeo': '' },
        $push: { 'sessions.$[s].breaks': { outAt: prev.checkOut, backAt: now, distance: prev.outGeo?.distance, reason: prev.silent ? `(location stopped) ${reentryReason}` : reentryReason, photo: inPhoto } } },
      { arrayFilters: [{ 's._id': prev._id }] })
    : await M.Attendance.updateOne(allClosed,
      { $push: { sessions: { checkIn: now, inGeo: geo, inPhoto, lateReason, lastPingAt: now } }, ...(location ? { $set: { location } } : {}) });
  if (!r.modifiedCount) {
    const doc = await M.Attendance.findOne({ user: user._id, date }).lean();
    throw new HttpError(409, doc?.status === 'VOIDED'
      ? 'Today\'s attendance record was voided. Contact HR or Admin.' : 'You are already checked in');
  }
  const rec = await M.Attendance.findOne({ user: user._id, date }).lean();
  if (reentryReason) await audit(ctx, { action: 'REENTRY_CHECKIN', entityType: 'Attendance', entityId: rec._id, subjectId: user._id, department: user.department, oldData: { checkOut: prev.checkOut, distance: prev.outGeo?.distance }, newData: { back: now, sessionContinuesFrom: prev.checkIn }, reason: reentryReason });
  if (lateReason) await audit(ctx, { action: 'LATE_CHECKIN', entityType: 'Attendance', entityId: rec._id, subjectId: user._id, department: user.department, newData: { checkIn: now, lateMinutes: late.lateMinutes }, reason: lateReason });
  queueSheetSync(rec._id);
  if (reentryReason) notifyReentry({ userId: user._id, reason: reentryReason, at: now });
  notifyCheckin({ userId: user._id, recId: rec._id, at: now, distance: geo?.distance });
  return rec;
}

// Manual check-out is allowed from anywhere; the position is recorded when available.
export async function checkOut(ctx, coords) {
  const user = ctx.user;
  const c = readCoords(coords);
  const open = await M.Attendance.findOne({ user: user._id, status: 'ACTIVE', 'sessions.checkOut': null }).sort({ date: -1 });
  if (!open) throw new HttpError(409, 'You are not checked in');
  const waiting = await M.Task.countDocuments({ user: user._id, date: open.date, status: 'PENDING' });
  if (waiting) throw new HttpError(400, `Add your update on today's ${waiting === 1 ? 'task' : `${waiting} tasks`} before checking out (open Tasks).`, { code: 'TASK_UPDATE_REQUIRED' });
  let geo;
  if (c.ok) {
    const loc = open.location ? await M.Location.findById(open.location).lean() : null;
    geo = { lat: c.lat, lng: c.lng, ...(loc ? { distance: Math.round(distanceMeters(c.lat, c.lng, loc.latitude, loc.longitude)) } : {}) };
  }
  const outPhoto = photosEnabled() ? await uploadAttendancePhoto(coords?.photo, { userId: user._id, kind: 'out' }) : undefined;
  const r = await M.Attendance.updateOne(
    { _id: open._id, status: 'ACTIVE' },
    { $set: { 'sessions.$[s].checkOut': new Date(), 'sessions.$[s].outGeo': geo, ...(outPhoto ? { 'sessions.$[s].outPhoto': outPhoto } : {}) } },
    { arrayFilters: [{ 's.checkOut': null }] });
  if (!r.modifiedCount) throw new HttpError(409, 'You are not checked in');
  queueSheetSync(open._id);
  notifyCheckout({ userId: user._id, recId: open._id, at: new Date(), distance: geo?.distance });
  return M.Attendance.findById(open._id).lean();
}

/**
 * Called periodically by the app while the user is checked in. Beyond the location's
 * checkout radius for consecutive pings => automatic check-out (time = first out-of-range ping).
 */
export async function ping(ctx, coords) {
  const user = ctx.user;
  const c = readCoords(coords);
  const rec = await M.Attendance.findOne({ user: user._id, status: 'ACTIVE', 'sessions.checkOut': null }).sort({ date: -1 });
  if (!rec) return { open: false };
  const cfg = await getSettings();
  if (rec.date < dateKey() || afterHours(cfg)) {
    await closeAtEndOfDay(ctx, rec, cfg);
    return { open: false, autoCheckedOut: true, endOfDay: true };
  }
  const loc = rec.location ? await M.Location.findById(rec.location).lean() : null;
  const current = rec.sessions.find((s) => !s.checkOut);
  if (c.ok && (!current.lastPingAt || Date.now() - new Date(current.lastPingAt).getTime() >= 60000)) {
    await M.Attendance.updateOne({ _id: rec._id }, { $set: { 'sessions.$[s].lastPingAt': new Date(),
      ...(loc ? { 'sessions.$[s].lastPingDistance': Math.round(distanceMeters(c.lat, c.lng, loc.latitude, loc.longitude)) } : {}) } }, { arrayFilters: [{ 's.checkOut': null }] });
  }
  if (inLunch(cfg)) return { open: true, lunch: true };
  if (!loc || !c.ok || (c.accuracy != null && c.accuracy > IGNORE_PING_ACCURACY_M)) return { open: true, ignored: true };
  const session = rec.sessions.find((s) => !s.checkOut);
  const distance = Math.round(distanceMeters(c.lat, c.lng, loc.latitude, loc.longitude));
  const limit = loc.checkoutRadiusMeters ?? 20;
  if (distance <= limit + gpsMargin(c.accuracy)) {
    if (session.outCount) { session.outCount = 0; session.firstOutAt = undefined; await rec.save(); }
    return { open: true, distance, limit };
  }
  // Looks outside, but the fix is too rough to prove it: neither counts against the person nor clears earlier precise reports.
  if (c.accuracy == null || c.accuracy > PRECISE_FIX_M) return { open: true, distance, limit, uncertain: true };
  session.outCount = (session.outCount || 0) + 1;
  session.firstOutAt ||= new Date();
  const pings = session.outCount;
  const sustained = pings >= OUT_PINGS_TO_CHECKOUT && Date.now() - new Date(session.firstOutAt).getTime() >= OUT_SECONDS_TO_CHECKOUT * 1000;
  if (!sustained) { await rec.save(); return { open: true, distance, limit, warning: true }; }
  session.checkOut = session.firstOutAt > session.checkIn ? session.firstOutAt : new Date();
  session.autoCheckout = true;
  session.outGeo = { lat: c.lat, lng: c.lng, distance, accuracy: c.accuracy ?? undefined, verified: false };
  session.outCount = 0; session.firstOutAt = undefined;
  await rec.save();
  await audit(ctx, { action: 'AUTO_CHECKOUT', entityType: 'Attendance', entityId: rec._id, subjectId: user._id, department: user.department,
    location: loc._id, newData: { distance, limit, accuracy: c.accuracy, pings, checkOut: session.checkOut }, reason: `Moved ${distance} m from ${loc.name} (limit ${limit} m)` });
  queueSheetSync(rec._id);
  notifyCheckout({ userId: user._id, recId: rec._id, at: session.checkOut, auto: true, distance });
  return { open: false, autoCheckedOut: true, distance, limit };
}

/**
 * Scheduled every few minutes during office hours: someone whose phone has sent no location for
 * SILENT_MINUTES_TO_CHECKOUT is checked out, and the check-out time is their last location report
 * (the moment we stopped knowing where they were). Lunch never counts as silence.
 */
export async function silentCheckout(ctx) {
  const cfg = await getSettings();
  if (afterHours(cfg)) return { skipped: 'office is closed' };
  if (inLunch(cfg)) return { skipped: 'lunch break' };
  const today = dateKey(), now = Date.now(), lunchEnd = lunchEndTime(today, cfg).getTime();
  const open = await M.Attendance.find({ date: today, status: 'ACTIVE', 'sessions.checkOut': null });
  let closed = 0;
  for (const rec of open) {
    const s = rec.sessions.find((x) => !x.checkOut);
    if (!s?.lastPingAt) continue; // session from before this rule existed
    const last = new Date(s.lastPingAt).getTime();
    // Silence that started before lunch ended only counts from the end of lunch.
    const since = last < lunchEnd && now >= lunchEnd ? lunchEnd : last;
    if (now - since < SILENT_MINUTES_TO_CHECKOUT * 60000) continue;
    s.checkOut = new Date(Math.max(last, new Date(s.checkIn).getTime()));
    s.autoCheckout = true; s.silent = true; s.outCount = 0; s.firstOutAt = undefined;
    s.outGeo = { distance: s.lastPingDistance, verified: false };
    await rec.save();
    await audit(ctx, { raw: true, action: 'AUTO_CHECKOUT', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user,
      newData: { checkOut: s.checkOut, silentMinutes: Math.round((now - last) / 60000) }, reason: `No location from the phone since ${label12(new Date(last + 330 * 60000).toISOString().slice(11, 16))}` });
    queueSheetSync(rec._id);
    notifyCheckout({ userId: rec.user, recId: rec._id, at: s.checkOut, auto: true, silent: true });
    closed++;
  }
  return { closed };
}

/** Close every open session of a record at office closing time (or now, if that is earlier). */
async function closeAtEndOfDay(ctx, rec, cfg) {
  const close = closingTime(rec.date, cfg);
  const at = close < new Date() ? close : new Date();
  let n = 0;
  for (const s of rec.sessions) {
    if (s.checkOut) continue;
    s.checkOut = at > s.checkIn ? at : new Date(s.checkIn);
    s.endOfDay = true; s.outCount = 0; s.firstOutAt = undefined;
    n++;
  }
  if (!n) return false;
  await rec.save();
  await audit(ctx, { raw: true, action: 'END_OF_DAY_CHECKOUT', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user,
    newData: { checkOut: at }, reason: `Office closes at ${label12(hoursCfg(cfg).workEnd)}` });
  queueSheetSync(rec._id);
  notifyCheckout({ userId: rec.user, recId: rec._id, at, endOfDay: true });
  return true;
}

/** Scheduled: once office hours are over, check out everyone who is still checked in. */
export async function endOfDayCheckout(ctx) {
  const cfg = await getSettings();
  if (!afterHours(cfg)) return { skipped: `office is open until ${label12(hoursCfg(cfg).workEnd)}` };
  const open = await M.Attendance.find({ status: 'ACTIVE', 'sessions.checkOut': null });
  let closed = 0;
  for (const rec of open) if (await closeAtEndOfDay(ctx, rec, cfg)) closed++;
  return { closed };
}

const fmt = (d) => (d ? new Date(d).toISOString() : null);

/**
 * Correct one session (or add one when sessionId is omitted). Never silent: audits old/new.
 */
export async function correctAttendance(ctx, { attendanceId, sessionId, checkIn, checkOut, reason, override = false, actor }) {
  actor = actor || ctx.user;
  const rec = await M.Attendance.findById(attendanceId);
  if (!rec) throw notFound('Attendance record not found');
  if (rec.status === 'VOIDED') throw bad('Cannot correct a voided record');
  const ci = checkIn ? new Date(checkIn) : null, co = checkOut ? new Date(checkOut) : null;
  if ((ci && isNaN(ci)) || (co && isNaN(co))) throw bad('Invalid date/time');
  let oldData, newData;
  if (sessionId) {
    const s = rec.sessions.id(sessionId);
    if (!s) throw notFound('Session not found');
    oldData = { checkIn: fmt(s.checkIn), checkOut: fmt(s.checkOut) };
    if (ci) s.checkIn = ci;
    if (co) s.checkOut = co;
    if (s.checkOut && s.checkOut <= s.checkIn) throw bad('Check-out must be after check-in');
    s.corrected = true;
    newData = { checkIn: fmt(s.checkIn), checkOut: fmt(s.checkOut) };
  } else {
    if (!ci) throw bad('Check-in time is required to add a session');
    if (co && co <= ci) throw bad('Check-out must be after check-in');
    oldData = null;
    rec.sessions.push({ checkIn: ci, checkOut: co || undefined, corrected: true });
    newData = { checkIn: fmt(ci), checkOut: fmt(co) };
  }
  await rec.save();
  const subject = await M.User.findById(rec.user).select('department location').lean();
  await audit(ctx, {
    actor, action: 'CORRECTED_ATTENDANCE', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user,
    department: subject?.department, location: subject?.location, oldData, newData, reason, override,
  });
  queueSheetSync(rec._id);
  notifyAttendanceChange({ kind: 'corrected', recId: rec._id, actor, reason, oldData, newData });
  return rec;
}

export async function voidAttendance(ctx, { attendanceId, reason }) {
  const rec = await M.Attendance.findById(attendanceId);
  if (!rec) throw notFound('Attendance record not found');
  if (rec.status === 'VOIDED') throw bad('Record is already voided');
  const old = { status: rec.status, sessions: rec.sessions.map((s) => ({ checkIn: fmt(s.checkIn), checkOut: fmt(s.checkOut) })) };
  rec.status = 'VOIDED'; rec.voidReason = reason; rec.voidedBy = ctx.user._id; rec.voidedAt = new Date();
  await rec.save();
  const subject = await M.User.findById(rec.user).select('department location').lean();
  await audit(ctx, {
    action: 'VOIDED_ATTENDANCE', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user,
    department: subject?.department, location: subject?.location, oldData: old, newData: { status: 'VOIDED' }, reason,
  });
  queueSheetSync(rec._id);
  notifyAttendanceChange({ kind: 'voided', recId: rec._id, actor: ctx.user, reason, oldData: old, newData: { status: 'VOIDED' } });
  return rec;
}

/** Pass the settings so a custom lunch time is respected (defaults to 1:30 - 2:30 PM). */
export const hoursWorked = (rec, cfg) => workedHours(rec, cfg);
