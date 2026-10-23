import { M } from '@/lib/db';
import { handler, bad } from '@/lib/http';

// One timeline per CRM section: IVR calls, AI calls and WhatsApp messages, newest first.
const SECTIONS = {
  SALES: { ai: ['SALES'], wa: ['OFFER', 'SALES', 'BROCHURE'] },
  FEEDBACK: { ai: ['FEEDBACK'], wa: ['FEEDBACK'], staff: 'FEEDBACK' },
  INTERVIEW: { ai: ['INTERVIEW'], wa: ['INTERVIEW'], staff: 'INTERVIEW' },
  EMPLOYEE: { ai: ['ATTENDANCE'], wa: ['WELCOME', 'BULK', 'TASK', 'ABSENT'], staff: 'EMPLOYEE' },
};
const N = 80;
const AI_TEXT = { SCHEDULED: 'Waiting', QUEUED: 'Dialling', IN_PROGRESS: 'On the call', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };

export const GET = handler(async (ctx) => {
  const sec = SECTIONS[new URL(ctx.req.url).searchParams.get('section')];
  if (!sec) throw bad('Unknown section');
  const ivr = sec.staff
    ? M.StaffCall.find({ section: sec.staff, mode: 'OFFICE' }).sort({ createdAt: -1 }).limit(N).populate('by', 'name').populate('employee', 'name').lean()
    : M.LeadActivity.find({ type: 'CALL' }).sort({ createdAt: -1 }).limit(N).populate('by', 'name').populate('lead', 'name phone').lean();
  const [calls, ai, wa] = await Promise.all([
    ivr,
    M.AiCall.find({ kind: { $in: sec.ai }, direction: 'outbound' }).sort({ createdAt: -1 }).limit(N).populate('requestedBy', 'name').populate('lead', 'name').populate('employee', 'name').lean(),
    M.WaMessage.find({ purpose: { $in: sec.wa } }).sort({ createdAt: -1 }).limit(N).populate('sentBy', 'name').lean(),
  ]);
  const items = [
    ...calls.map((c) => ({
      id: String(c._id), channel: 'IVR', at: c.createdAt, by: c.by?.name || '',
      name: c.lead?.name || c.employee?.name || c.contactName || '', phone: c.phone || c.lead?.phone || '',
      status: sec.staff ? c.status : c.outcome, summary: sec.staff ? c.reason || c.bridge?.summary || c.note : c.note,
      durationSec: c.durationSec ?? c.bridge?.talkSec, recording: c.bridge?.recordingId ? (sec.staff ? `/api/staff-calls/${c._id}/recording` : `/api/sales/calls/${c._id}/recording`) : null,
      link: c.lead ? `/sales/leads/${c.lead._id}` : c.employee ? `/users/${c.employee._id}` : null,
    })),
    ...ai.map((c) => ({
      id: String(c._id), channel: 'AI', at: c.startedAt || c.createdAt, by: c.requestedBy?.name || '',
      name: c.lead?.name || c.employee?.name || c.contactName || c.callerName || '', phone: c.phone,
      status: c.status === 'COMPLETED' ? (c.outcome || 'COMPLETED') : c.status, statusText: AI_TEXT[c.status],
      summary: c.summary || c.hangupCause, durationSec: c.durationSec, recording: c.recordingId ? `/api/sales/ai-calls/${c._id}/recording` : null,
      accepted: c.accepted, rating: c.rating, interest: c.interest,
      link: c.lead ? `/sales/leads/${c.lead._id}` : c.employee ? `/users/${c.employee._id}` : null,
    })),
    ...wa.map((m) => ({
      id: String(m._id), channel: 'WA', at: m.createdAt, by: m.sentBy?.name || (m.batch?.startsWith('auto-') ? 'Automatic' : ''),
      name: m.name || '', phone: m.to, status: m.status, summary: m.direction === 'IN' ? m.text : `${m.template}${m.media ? ` + ${m.media}` : ''}`,
      error: m.error, reply: m.direction === 'IN',
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  return { items };
}, { roles: ['ADMIN', 'COO'] });
