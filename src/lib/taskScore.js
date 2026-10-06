// Pure task helpers, shared by the server (reports, Sheets) and the browser.

/** 1 when finished on its day, otherwise 0 (late submission). */
export const taskScore = (t) => (t.status === 'DONE' && !t.late ? 1 : 0);
/** What people see: Done, Pending, Late submission (not done), Done late. */
export const taskLabel = (t) => (t.status === 'DONE' ? (t.late ? 'Done late' : 'Done') : t.status === 'NOT_DONE' ? 'Late submission' : t.status === 'SUBMITTED' ? 'Waiting for approval' : 'Pending');
export const taskTone = (t) => (t.status === 'DONE' ? (t.late ? 'warn' : 'ok') : t.status === 'NOT_DONE' ? 'bad' : t.status === 'SUBMITTED' ? 'warn' : '');
/** A description written one point per line -> the points (leading "-", "•", "1." markers removed). */
export const taskPoints = (details) => String(details || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim()).filter(Boolean);
