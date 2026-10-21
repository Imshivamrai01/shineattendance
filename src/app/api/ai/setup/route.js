import { M, getSettings } from '@/lib/db';
import { readJson, bad } from '@/lib/http';
import { salesHandler } from '@/lib/sales';
import { aiScripts } from '@/lib/aiCalls';
import { audit } from '@/lib/audit';
import { AI_KINDS } from '@/models/AiScript';

const maskMobile = (m) => (m ? `••••••${String(m).replace(/\D/g, '').slice(-4)}` : '');
const transferOf = (s) => ({ enabled: s.aiTransferEnabled !== false, mode: s.aiTransferMode || 'SEQUENTIAL', ringSec: s.aiTransferRingSec || 20, needCheckIn: s.aiTransferNeedCheckIn !== false });

async function view(ctx) {
  const s = await getSettings();
  const out = { companyInfo: s.aiCompanyInfo || '', scripts: await aiScripts({ all: true }), transfer: transferOf(s) };
  if (ctx.sales === 'MANAGER') {
    // Who the AI may put callers through to (mobile numbers stay masked).
    out.people = (await M.User.find({ status: 'ACTIVE' }).select('name role designation mobile aiTransfer').sort({ name: 1 }).lean())
      .map((u) => ({ _id: u._id, name: u.name, role: u.designation || u.role, mobile: maskMobile(u.mobile), hasMobile: !!u.mobile, aiTransfer: !!u.aiTransfer }));
  }
  return out;
}

// Agent setup: what the AI agent knows about the company, the call types (Sales, Interview invite, Feedback...), and live transfer.
export const GET = salesHandler(view);

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// { companyInfo, scripts: [{ _id?, name, kind, opening, instructions, collect, active }], transfer: { enabled, mode, ringSec, needCheckIn },
//   people: { userId: true|false } } — managers only.
export const PUT = salesHandler(async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.companyInfo !== undefined) {
    await M.Setting.updateOne({ key: 'system' }, { $set: { aiCompanyInfo: clip(b.companyInfo, 4000) } }, { upsert: true });
  }
  for (const x of Array.isArray(b.scripts) ? b.scripts.slice(0, 30) : []) {
    const doc = { name: clip(x.name, 60), kind: AI_KINDS.includes(x.kind) ? x.kind : 'OTHER', opening: clip(x.opening, 300),
      instructions: clip(x.instructions, 3000), collect: clip(x.collect, 600), active: x.active !== false, updatedBy: ctx.user._id };
    if (doc.name.length < 2) throw bad('Every call type needs a name');
    if (x._id) await M.AiScript.updateOne({ _id: x._id }, { $set: doc });
    else await M.AiScript.create(doc);
  }
  if (b.transfer && typeof b.transfer === 'object') {
    const t = b.transfer;
    await M.Setting.updateOne({ key: 'system' }, { $set: {
      aiTransferEnabled: t.enabled !== false, aiTransferMode: t.mode === 'ALL' ? 'ALL' : 'SEQUENTIAL',
      aiTransferRingSec: Math.min(45, Math.max(10, Number(t.ringSec) || 20)), aiTransferNeedCheckIn: t.needCheckIn !== false,
    } }, { upsert: true });
  }
  if (b.people && typeof b.people === 'object') {
    const on = Object.keys(b.people).filter((id) => b.people[id] === true && /^[a-f\d]{24}$/i.test(id));
    const off = Object.keys(b.people).filter((id) => b.people[id] === false && /^[a-f\d]{24}$/i.test(id));
    if (on.length) await M.User.updateMany({ _id: { $in: on } }, { $set: { aiTransfer: true } });
    if (off.length) await M.User.updateMany({ _id: { $in: off } }, { $set: { aiTransfer: false } });
  }
  await audit(ctx, { action: 'CHANGED_AI_AGENT_SETUP', entityType: 'Setting', entityId: 'ai-agent' });
  return view(ctx);
}, { manager: true });
