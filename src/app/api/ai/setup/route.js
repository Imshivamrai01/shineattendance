import { M, getSettings } from '@/lib/db';
import { readJson, bad } from '@/lib/http';
import { salesHandler } from '@/lib/sales';
import { aiScripts } from '@/lib/aiCalls';
import { audit } from '@/lib/audit';
import { AI_KINDS } from '@/models/AiScript';

// Agent setup: what the AI agent knows about the company, and the call types (Sales, Interview invite, Feedback...).
export const GET = salesHandler(async () => {
  const s = await getSettings();
  return { companyInfo: s.aiCompanyInfo || '', scripts: await aiScripts({ all: true }) };
});

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// { companyInfo, scripts: [{ _id?, name, kind, opening, instructions, collect, active }] } — managers only.
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
  await audit(ctx, { action: 'CHANGED_AI_AGENT_SETUP', entityType: 'Setting', entityId: 'ai-agent' });
  const s = await getSettings();
  return { companyInfo: s.aiCompanyInfo || '', scripts: await aiScripts({ all: true }) };
}, { manager: true });
