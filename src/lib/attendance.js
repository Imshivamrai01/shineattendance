import { M, getSettings } from './db.js';
import { audit } from './audit.js';
import { bad, notFound, HttpError } from './http.js';
import { dateKey } from './dates.js';
import { afterHours, closingTime, dayFlags, hoursCfg, inLunch, label12, lunchEndTime, minutesText, workedHours } from './hours.js';
import { distanceMeters } from './geo.js';
import { photosEnabled, uploadAttendancePhoto } from './cloudinary.js';
import { queueSheetSync } from './sheetSync.js';
import { notifyReentry, notifyAttendanceChange, notifyCheckin, notifyCheckout, notifyPresenceAsked, notifyReviewRequired, notifyPresenceReviewed } from './notify.js';
import { activeCheck } from './presence.js';
import { canManage } from './users.js';

const MAX_CHECKIN_ACCURACY_M = 30;  // GPS fixes worse than this get the "weak GPS" hint
const MAX_GPS_MARGIN_M = 40;        // most uncertainty we will forgive, however poor the fix
const IGNORE_PING_ACCURACY_M = 50;  // ...and are ignored when deciding to auto check-out
const env = (name, fallback) => (process.env[name] != null ? Number(process.env[name]) : fallback); // overridden by the test suite
const OUT_PINGS = 3;                                    // precise out-of-range fixes in a row...
const OUT_SECONDS = env('PRESENCE_OUT_SECONDS', 120);   // ...spanning this long => the signal is OUTSIDE
const SILENT_MINUTES = env('PRESENCE_SILENT_MINUTES', 20); // no location report for this long => the signal is UNKNOWN
const REPLY_MINUTES = env('PRESENCE_REPLY_MINUTES', 15);   // time to answer "Still in office?" before a review is required
const COOLDOWN_MINUTES = env('PRESENCE_COOLDOWN_MINUTES', 30); // don't ask the same person again sooner than this
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
    { $set: { 'sessions.$[s].checkOut': new Date(), 'sessions.$[s].closeReason': 'MANUAL', 'sessions.$[s].outGeo': geo, ...(outPhoto ? { 'sessions.$[s].outPhoto': outPhoto } : {}) } },
    { arrayFilters: [{ 's.checkOut': null }] });
  if (!r.modifiedCount) throw new HttpError(409, 'You are not checked in');
  // An unanswered "Still in office?" is settled by the person checking out themselves.
  const closed = await M.Attendance.findById(open._id);
  const unanswered = closed.sessions.flatMap((x) => x.checks || []).filter((k) => k.status === 'ASKED');
  for (const k of unanswered) { k.status = 'RESOLVED'; k.outcome = 'MANUAL_CHECKOUT'; k.resolvedAt = new Date(); }
  if (unanswered.length) await closed.save();
  queueSheetSync(open._id);
  notifyCheckout({ userId: user._id, recId: open._id, at: new Date(), distance: geo?.distance });
  return M.Attendance.findById(open._id).lean();
}

const publicCheck = (c) => (c ? { id: String(c._id), reason: c.reason, status: c.status, since: c.since, distance: c.distance, askedAt: c.askedAt, answer: c.answer } : null);
const recently = (session, now) => (session.checks || []).some((c) => now - new Date(c.askedAt).getTime() < COOLDOWN_MINUTES * 60000);

/** Raise a "Still in office?" check on the open session (never more than one at a time, and not too often). */
async function ask(ctx, rec, session, { reason, since, distance, accuracy }) {
  const now = Date.now();
  if (activeCheck(session) || recently(session, now)) return null;
  session.checks.push({ reason, since, distance, accuracy, askedAt: new Date(now), status: 'ASKED' });
  session.signal = reason === 'GEOFENCE_EXIT' ? 'OUTSIDE' : 'UNKNOWN'; session.signalAt = since;
  session.outCount = 0; session.firstOutAt = undefined;
  await rec.save();
  await audit(ctx, { raw: true, action: 'PRESENCE_ASKED', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user,
    newData: { reason, since, distance, accuracy }, reason: reason === 'GEOFENCE_EXIT' ? `Location shows ${distance} m from the office` : 'No location from the phone' });
  queueSheetSync(rec._id);
  notifyPresenceAsked({ userId: rec.user, reason, since, distance });
  return session.checks.at(-1);
}

/**
 * Called periodically by the app (and its background service) while the person is checked in.
 * It only updates the location signal. Nothing here closes a session: when the signal says the person
 * is outside, they are asked "Still in office?" and, without an answer, the record goes to review.
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
  const session = rec.sessions.find((s) => !s.checkOut);
  const out = (extra) => ({ open: true, check: publicCheck(activeCheck(session)), ...extra });
  const loc = rec.location ? await M.Location.findById(rec.location).lean() : null;
  if (!c.ok) return out({ ignored: true });
  const distance = loc ? Math.round(distanceMeters(c.lat, c.lng, loc.latitude, loc.longitude)) : undefined;
  const now = new Date();
  if (!session.lastPingAt || now - new Date(session.lastPingAt) >= 60000) { session.lastPingAt = now; session.lastPingDistance = distance; session.markModified('lastPingAt'); }
  const save = async () => { if (rec.isModified()) await rec.save(); };
  if (inLunch(cfg)) { await save(); return out({ lunch: true }); }
  if (!loc || (c.accuracy != null && c.accuracy > IGNORE_PING_ACCURACY_M)) { await save(); return out({ ignored: true }); }

  const limit = loc.checkoutRadiusMeters ?? 100;
  if (distance <= limit + gpsMargin(c.accuracy)) {
    session.outCount = 0; session.firstOutAt = undefined;
    if (session.signal !== 'INSIDE') { session.signal = 'INSIDE'; session.signalAt = now; }
    // The location came back inside by itself before the person answered: nothing left to ask.
    const pending = (session.checks || []).find((k) => k.status === 'ASKED');
    if (pending) { pending.status = 'RESOLVED'; pending.outcome = 'SIGNAL_RESTORED'; pending.resolvedAt = now; }
    await save();
    if (pending) queueSheetSync(rec._id);
    return out({ distance, limit });
  }
  // Looks outside, but the fix is too rough to prove it: it neither counts nor clears earlier precise reports.
  if (c.accuracy == null || c.accuracy > PRECISE_FIX_M) { await save(); return out({ distance, limit, uncertain: true }); }
  session.outCount = (session.outCount || 0) + 1;
  session.firstOutAt ||= now;
  const sustained = session.outCount >= OUT_PINGS && now - new Date(session.firstOutAt) >= OUT_SECONDS * 1000;
  if (!sustained) { await rec.save(); return out({ distance, limit, warning: true }); }
  await ask(ctx, rec, session, { reason: 'GEOFENCE_EXIT', since: session.firstOutAt, distance, accuracy: c.accuracy });
  await save();
  return out({ distance, limit, warning: true });
}

/**
 * Scheduled every few minutes during office hours.
 *  1. "Still in office?" checks nobody answered in REPLY_MINUTES become REVIEW_REQUIRED (the session stays open).
 *  2. Open sessions whose phone has sent no location for SILENT_MINUTES get a new check (signal UNKNOWN).
 * Lunch never counts: nothing is asked or escalated during it, and silence is measured from the end of lunch.
 */
export async function presenceSweep(ctx) {
  const cfg = await getSettings();
  if (afterHours(cfg)) return { skipped: 'office is closed' };
  if (inLunch(cfg)) return { skipped: 'lunch break' };
  const today = dateKey(), now = Date.now(), lunchEnd = lunchEndTime(today, cfg).getTime();
  const open = await M.Attendance.find({ date: today, status: 'ACTIVE', 'sessions.checkOut': null });
  let asked = 0, escalated = 0;
  for (const rec of open) {
    const s = rec.sessions.find((x) => !x.checkOut);
    const waiting = (s.checks || []).find((k) => k.status === 'ASKED');
    if (waiting) {
      const from = Math.max(new Date(waiting.askedAt).getTime(), now >= lunchEnd && new Date(waiting.askedAt).getTime() < lunchEnd ? lunchEnd : 0);
      if (now - from >= REPLY_MINUTES * 60000 && from < now) {
        waiting.status = 'REVIEW_REQUIRED';
        await rec.save();
        await audit(ctx, { raw: true, action: 'REVIEW_REQUIRED', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user, newData: { reason: waiting.reason, since: waiting.since }, reason: 'No reply to "Still in office?"' });
        queueSheetSync(rec._id);
        notifyReviewRequired({ userId: rec.user, recId: rec._id, reason: waiting.reason, since: waiting.since });
        escalated++;
      }
      continue;
    }
    if (!s.lastPingAt) continue; // session from before location reports were recorded
    const last = new Date(s.lastPingAt).getTime();
    const since = last < lunchEnd && now >= lunchEnd ? lunchEnd : last; // silence that began before lunch ended counts from its end
    if (now - since < SILENT_MINUTES * 60000) continue;
    if (await ask(ctx, rec, s, { reason: 'SIGNAL_LOST', since: new Date(last), distance: s.lastPingDistance })) asked++;
  }
  return { asked, escalated };
}

/** The person's own answer to "Still in office?". Their current position is checked against what they say. */
export async function answerPresence(ctx, { answer, ...coords }) {
  if (!['IN_OFFICE', 'LEFT'].includes(answer)) throw bad('Answer must be IN_OFFICE or LEFT');
  const user = ctx.user;
  const rec = await M.Attendance.findOne({ user: user._id, status: 'ACTIVE', 'sessions.checks.status': 'ASKED' }).sort({ date: -1 });
  const session = rec?.sessions.find((s) => (s.checks || []).some((k) => k.status === 'ASKED'));
  const check = session?.checks.find((k) => k.status === 'ASKED');
  if (!check) throw new HttpError(409, 'There is nothing to answer right now');
  const c = readCoords(coords);
  const loc = rec.location ? await M.Location.findById(rec.location).lean() : null;
  const now = new Date();
  check.answer = answer; check.answeredAt = now;
  let outside = false;
  if (c.ok && loc) {
    check.answerDistance = Math.round(distanceMeters(c.lat, c.lng, loc.latitude, loc.longitude));
    outside = check.answerDistance > (loc.checkoutRadiusMeters ?? 100) + gpsMargin(c.accuracy) && c.accuracy != null && c.accuracy <= PRECISE_FIX_M;
    if (!session.checkOut) { session.lastPingAt = now; session.lastPingDistance = check.answerDistance; }
  }
  if (answer === 'IN_OFFICE' && !outside) {
    check.status = 'RESOLVED'; check.outcome = 'EMPLOYEE_CONFIRMED'; check.resolvedAt = now;
    if (!session.checkOut) { session.signal = 'INSIDE'; session.signalAt = now; session.outCount = 0; session.firstOutAt = undefined; }
  } else {
    // "I have left", or "in office" while a precise fix says otherwise: an authorised person decides.
    check.status = 'REVIEW_REQUIRED';
  }
  await rec.save();
  await audit(ctx, { action: 'PRESENCE_ANSWERED', entityType: 'Attendance', entityId: rec._id, subjectId: user._id, department: user.department,
    newData: { answer, distance: check.answerDistance, status: check.status }, reason: answer === 'IN_OFFICE' ? 'Says they are in the office' : 'Says they have left' });
  queueSheetSync(rec._id);
  if (check.status === 'REVIEW_REQUIRED') notifyReviewRequired({ userId: user._id, recId: rec._id, reason: check.reason, since: check.since, answer });
  return { status: check.status, check: publicCheck(activeCheck(session)) };
}

/**
 * An authorised reviewer (the person's HR / Manager, a COO or Admin) settles a REVIEW_REQUIRED check:
 * STAYED = they were in the office, nothing changes; LEFT = the session is checked out at `at`
 * (default: when the signal changed). Works on sessions already closed at office closing too.
 */
export async function reviewPresence(ctx, { attendanceId, checkId, decision, at, note }) {
  const actor = ctx.user;
  if (!['STAYED', 'LEFT'].includes(decision)) throw bad('Decision must be STAYED or LEFT');
  const rec = await M.Attendance.findById(attendanceId);
  if (!rec || rec.status !== 'ACTIVE') throw notFound('Attendance record not found');
  const subject = await M.User.findById(rec.user).lean();
  if (!subject || String(subject._id) === String(actor._id) || !canManage(actor, subject)) throw new HttpError(403, 'You cannot review this person\'s attendance');
  const session = rec.sessions.find((s) => (s.checks || []).some((k) => String(k._id) === String(checkId)));
  const check = session?.checks.id(checkId);
  if (!check || check.status !== 'REVIEW_REQUIRED') throw new HttpError(409, 'This has already been reviewed');
  const text = String(note || '').trim().slice(0, 300);
  if (text.length < 3) throw bad('Add a short note for the record (at least 3 characters)');
  const now = new Date();
  const old = { checkOut: fmt(session.checkOut), status: check.status };
  check.status = 'RESOLVED'; check.resolvedAt = now; check.note = text; check.reviewedBy = actor._id; check.reviewedByName = actor.name;
  if (decision === 'LEFT') {
    const left = at ? new Date(at) : new Date(check.since);
    if (isNaN(left)) throw bad('Invalid time');
    if (left <= session.checkIn) throw bad('The check-out time must be after the check-in');
    if (left > now) throw bad('The check-out time cannot be in the future');
    if (session.checkOut && left > session.checkOut) throw bad('The check-out time cannot be after the recorded check-out');
    check.outcome = 'REVIEW_LEFT'; check.leftAt = left;
    session.checkOut = left; session.closeReason = 'REVIEW'; session.endOfDay = false; session.signal = 'OUTSIDE'; session.signalAt = left;
    session.outCount = 0; session.firstOutAt = undefined;
  } else {
    check.outcome = 'REVIEW_STAYED';
  }
  await rec.save();
  await audit(ctx, { action: 'REVIEWED_PRESENCE', entityType: 'Attendance', entityId: rec._id, subjectId: rec.user, department: subject.department, location: subject.location,
    oldData: old, newData: { decision, checkOut: fmt(session.checkOut), reason: check.reason }, reason: text });
  queueSheetSync(rec._id);
  notifyPresenceReviewed({ userId: rec.user, decision, at: check.leftAt, by: actor, note: text });
  return rec;
}

/** Close every open session of a record at office closing time (or now, if that is earlier). */
async function closeAtEndOfDay(ctx, rec, cfg) {
  const close = closingTime(rec.date, cfg);
  const at = close < new Date() ? close : new Date();
  let n = 0;
  for (const s of rec.sessions) {
    if (s.checkOut) continue;
    s.checkOut = at > s.checkIn ? at : new Date(s.checkIn);
    s.endOfDay = true; s.closeReason = 'OFFICE_CLOSED'; s.outCount = 0; s.firstOutAt = undefined;
    for (const k of s.checks || []) if (k.status === 'ASKED') k.status = 'REVIEW_REQUIRED';
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
    s.corrected = true; if (co) s.closeReason = 'ADMIN_CORRECTION';
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
