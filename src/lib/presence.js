// Pure helpers for "is this person still at the office?" — shared by the server, reports and the browser.
//
// A session is open or closed. Separately, the phone's location gives a signal: INSIDE, OUTSIDE or UNKNOWN.
// The signal never closes a session. When it turns OUTSIDE or UNKNOWN the person is asked "Still in office?"
// (a presence check); with no answer the record becomes REVIEW_REQUIRED and HR / Manager / COO / Admin decide.
// A session is only ever closed by the person (manual check-out), at office closing, or by an authorised review.

export const CHECK_REASONS = { SIGNAL_LOST: 'Signal lost', GEOFENCE_EXIT: 'Geofence exit' };

/** The presence check that still needs an answer or a review, if any. */
export const activeCheck = (session) => (session?.checks || []).find((c) => c.status === 'ASKED' || c.status === 'REVIEW_REQUIRED') || null;
export const needsReview = (session) => (session?.checks || []).some((c) => c.status === 'REVIEW_REQUIRED');

const hhmm = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '');

/** One line describing a presence check and how it ended. */
export function checkText(c) {
  const what = c.reason === 'GEOFENCE_EXIT' ? `Geofence exit at ${hhmm(c.since)}${c.distance != null ? ` (${c.distance} m)` : ''}` : `Signal lost at ${hhmm(c.since)}`;
  let how = 'waiting for the employee';
  if (c.status === 'REVIEW_REQUIRED') how = c.answer === 'LEFT' ? 'employee says they left: review required' : c.answer === 'IN_OFFICE' ? 'employee says in office but the location disagrees: review required' : 'no reply: review required';
  else if (c.status === 'RESOLVED') {
    if (c.outcome === 'EMPLOYEE_CONFIRMED') how = `employee confirmed in office at ${hhmm(c.answeredAt)}`;
    else if (c.outcome === 'SIGNAL_RESTORED') how = `location back inside at ${hhmm(c.resolvedAt)}`;
    else if (c.outcome === 'MANUAL_CHECKOUT') how = 'employee checked out';
    else if (c.outcome === 'REVIEW_STAYED') how = `reviewed by ${c.reviewedByName || 'a reviewer'}: was in office`;
    else if (c.outcome === 'REVIEW_LEFT') how = `reviewed by ${c.reviewedByName || 'a reviewer'}: left at ${hhmm(c.leftAt)}`;
    else if (c.outcome === 'OFFICE_CLOSED') how = 'unanswered at office closing';
  }
  return `${what}: ${how}${c.note ? ` (${c.note})` : ''}`;
}

/**
 * Reason codes for one session, for display next to every record:
 * how it was closed, and anything that happened to it on the way.
 */
export function sessionCodes(s) {
  const codes = [];
  for (const c of s.checks || []) {
    codes.push({ code: c.reason, label: CHECK_REASONS[c.reason] || c.reason, tone: 'warn' });
    if (c.status === 'REVIEW_REQUIRED') codes.push({ code: 'REVIEW_REQUIRED', label: 'Review required', tone: 'bad' });
    if (c.outcome === 'EMPLOYEE_CONFIRMED') codes.push({ code: 'EMPLOYEE_CONFIRMED', label: 'Employee confirmed', tone: 'ok' });
    if (c.outcome === 'REVIEW_STAYED' || c.outcome === 'REVIEW_LEFT') codes.push({ code: 'REVIEWED', label: 'Reviewed', tone: '' });
  }
  if (s.checkOut) {
    if (s.closeReason === 'REVIEW') codes.push({ code: 'REVIEW_CHECKOUT', label: 'Checked out by review', tone: '' });
    else if (s.endOfDay) codes.push({ code: 'OFFICE_CLOSED', label: 'Office closed', tone: '' });
    else if (s.silent) codes.push({ code: 'SIGNAL_LOST', label: 'Signal lost (auto, old rule)', tone: 'warn' });
    else if (s.autoCheckout) codes.push({ code: 'GEOFENCE_EXIT', label: 'Geofence exit (auto, old rule)', tone: 'warn' });
    else codes.push({ code: 'MANUAL', label: 'Manual check-out', tone: '' });
  }
  if (s.corrected) codes.push({ code: 'ADMIN_CORRECTION', label: 'Admin correction', tone: 'warn' });
  // one badge per code
  return codes.filter((c, i) => codes.findIndex((x) => x.code === c.code) === i);
}
