import { getSettings } from '@/lib/db';
import { handler, bad, HttpError, readJson } from '@/lib/http';
import { sendMail, layout, appUrl, mailConfigured } from '@/lib/mailer';
import { adminRecipients } from '@/lib/notify';

// "Send test email": goes to the Notification email (or the Admin's own email if none is set).
export const POST = handler(async ({ req, user }) => {
  const body = await readJson(req).catch(() => ({}));
  if (!mailConfigured()) throw bad('Email is not set up on the server yet (SMTP_USER / SMTP_PASS in .env.local).');
  // The address typed in the form is used directly, so it can be tested before saving.
  const typed = String(body.to || '').trim().toLowerCase();
  if (typed && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(typed)) throw bad('That email address is not valid');
  const to = typed ? [typed] : (await adminRecipients()).filter(Boolean);
  if (!to.length) throw bad('Enter a Notification email first');
  const m = layout({ title: 'Test email', intro: `Email from Shine Attendance is working. Sent by ${user.name}.`, link: appUrl(), linkText: 'Open Shine Attendance' });
  try { await sendMail({ to, subject: 'Shine Attendance: test email', ...m }); } catch (e) { throw new HttpError(502, `Could not send: ${e.message}`); }
  return { ok: true, to };
}, { roles: ['ADMIN'] });
