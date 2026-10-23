import { M, getSettings, defer } from './db.js';
import { dateKey } from './dates.js';
import { hoursCfg } from './hours.js';
import { normalizePhone, sendTemplate, waConfigured } from './whatsapp.js';

/*
 * WhatsApp messages the app sends on its own, each switched on under CRM → Settings → Automatic messages:
 *  - brochure: a sales lead becomes Interested after a call (IVR or AI) -> the brochure PDF, once per lead
 *  - task:     a task is assigned -> the employee gets the task on WhatsApp
 *  - absent:   no check-in by office start + N minutes -> "we have not received your attendance today"
 * Every message is logged in WaMessage like the ones sent by hand, so it shows in the CRM history.
 * Best effort: a failure is logged on the message and never blocks the call, task or attendance.
 */

const DEFAULTS = {
  brochure: { on: false, template: 'shine_sales_brochure', language: 'en', mediaId: '', services: 'website, app and digital marketing' },
  task: { on: false, template: 'task_assigned', language: 'en' },
  absent: { on: false, template: 'absent_notice', language: 'en', afterMin: 60 },
};

/** The automatic-message settings with defaults filled in. */
export function autoConfig(s) {
  const a = s?.waAuto || {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { ...d, ...(a[k] || {}) }]));
}

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

/** Send one template and log it. Returns the WaMessage. */
async function send(s, { to, name, template, language, params, header, media, purpose, user }) {
  const phone = normalizePhone(to);
  const log = { batch: `auto-${purpose.toLowerCase()}`, purpose, to: phone || String(to || ''), name, user, template, language, params, media };
  if (!phone) return M.WaMessage.create({ ...log, status: 'FAILED', error: 'Not a valid mobile number' });
  try {
    return await M.WaMessage.create({ ...log, status: 'SENT', waId: await sendTemplate(s, { to: phone, template, language, params, header }) });
  } catch (e) {
    return M.WaMessage.create({ ...log, status: 'FAILED', error: String(e.message).slice(0, 300) });
  }
}

/** Brochure to a lead that just became Interested. Runs after the response; once per lead. */
export function sendBrochure(leadId) {
  defer(async () => {
    try {
      const s = await getSettings();
      const cfg = autoConfig(s).brochure;
      if (!cfg.on || !waConfigured(s)) return;
      // Claim the lead first, so two calls finishing together send one brochure.
      const lead = await M.Lead.findOneAndUpdate({ _id: leadId, brochureSentAt: null, phone: { $nin: [null, ''] } }, { $set: { brochureSentAt: new Date() } }, { new: true });
      if (!lead) return;
      const file = cfg.mediaId ? await M.WaMedia.findById(cfg.mediaId).lean().catch(() => null) : null;
      if (!file || file.expiresAt < new Date()) {
        await M.WaMessage.create({ batch: 'auto-brochure', purpose: 'BROCHURE', to: String(lead.phone), name: lead.name, template: cfg.template, language: cfg.language, status: 'FAILED',
          error: 'The brochure PDF is missing or expired at WhatsApp (files are kept 30 days). Upload it again under CRM → Settings → Automatic messages.' });
        await M.Lead.updateOne({ _id: lead._id }, { $unset: { brochureSentAt: '' } }); // try again after the next interested call
        return;
      }
      const msg = await send(s, { to: lead.phone, name: lead.name, template: cfg.template, language: cfg.language, params: [first(lead.name), cfg.services],
        header: { type: 'document', id: file.waMediaId, filename: file.name }, media: file.name, purpose: 'BROCHURE' });
      if (msg.status === 'FAILED') await M.Lead.updateOne({ _id: lead._id }, { $unset: { brochureSentAt: '' } });
      else await M.LeadActivity.create({ lead: lead._id, type: 'NOTE', note: `Brochure (${file.name}) sent on WhatsApp automatically after the call.` });
    } catch (e) { console.error('Auto brochure failed:', e.message); }
  });
}

const dayText = (d) => new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

/** A task was assigned: the employee gets it on WhatsApp too. */
export function sendTaskWhatsApp(taskId) {
  defer(async () => {
    try {
      const s = await getSettings();
      const cfg = autoConfig(s).task;
      if (!cfg.on || !waConfigured(s)) return;
      const t = await M.Task.findById(taskId).populate('user', 'name mobile').populate('assignedBy', 'name').lean();
      if (!t?.user?.mobile) return;
      await send(s, { to: t.user.mobile, name: t.user.name, user: t.user._id, template: cfg.template, language: cfg.language, purpose: 'TASK',
        params: [first(t.user.name), String(t.title).slice(0, 200), dayText(t.date), t.assignedBy?.name || 'HR'] });
    } catch (e) { console.error('Task WhatsApp failed:', e.message); }
  });
}

/**
 * Cron (every 5 minutes): once office start + `afterMin` has passed, message every active employee who has not
 * checked in today. Once a day (claimed atomically); never on Sunday.
 */
export async function sendAbsentWhatsApp(now = new Date()) {
  const s = await getSettings();
  const cfg = autoConfig(s).absent;
  if (!cfg.on || !waConfigured(s)) return { sent: 0, reason: 'off' };
  const today = dateKey(now);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() === 0) return { sent: 0, reason: 'Sunday' };
  const [h, m] = (hoursCfg(s).workStart || '10:00').split(':').map(Number);
  const due = new Date(`${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`).getTime() + (Number(cfg.afterMin) || 60) * 60000;
  if (now.getTime() < due) return { sent: 0, reason: 'not yet' };
  const claim = await M.Setting.updateOne({ key: 'system', waAbsentSentDate: { $ne: today } }, { $set: { waAbsentSentDate: today } });
  if (!claim.modifiedCount) return { sent: 0, reason: 'already sent today' };
  const people = await M.User.find({ status: 'ACTIVE', role: { $ne: 'ADMIN' }, mobile: { $nin: [null, ''] } }).select('name mobile').lean();
  const here = new Set((await M.Attendance.find({ date: today, user: { $in: people.map((p) => p._id) } }).distinct('user')).map(String));
  let sent = 0;
  for (const p of people.filter((x) => !here.has(String(x._id))).slice(0, 300)) {
    const msg = await send(s, { to: p.mobile, name: p.name, user: p._id, template: cfg.template, language: cfg.language, purpose: 'ABSENT', params: [first(p.name), dayText(today)] });
    if (msg.status === 'SENT') sent++;
  }
  return { sent };
}
