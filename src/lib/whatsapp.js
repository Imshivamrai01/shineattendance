// WhatsApp Cloud API (Meta) for the CRM page: bulk template messages to candidates and employees.
// WhatsApp only lets a business start a conversation with a pre-approved template, so everything here sends templates.
import crypto from 'node:crypto';
import { bad, HttpError } from './errors.js';

const GRAPH = process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com/v21.0'; // the override is for the test suite's mock server
export const waConfigured = (s) => !!(s?.waPhoneId && s?.waBusinessId && s?.waToken);

async function graph(settings, path, { method = 'GET', body } = {}) {
  let res, out;
  try {
    res = await fetch(`${GRAPH}/${path}`, {
      method, signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${settings.waToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    out = await res.json();
  } catch (e) {
    throw new HttpError(502, `Could not reach WhatsApp: ${e.message}`);
  }
  if (!res.ok || out.error) {
    const e = new Error(friendly(out.error));
    e.wa = out.error;
    throw e;
  }
  return out;
}

// The errors people actually hit, in plain words.
function friendly(err) {
  if (!err) return 'WhatsApp request failed';
  const c = err.code, sub = err.error_subcode;
  if (c === 190) return 'The WhatsApp access token has expired or is invalid. Save a new (permanent) token in WhatsApp settings.';
  if (c === 131030) return 'This number is not on the test number\'s allowed list. Add it in the Meta dashboard, or connect your real business number.';
  if (c === 131026) return 'Message could not be delivered (the number may not be on WhatsApp).';
  if (c === 132001) return 'Template not found or not approved in this language.';
  if (c === 132000) return 'The number of values does not match the template\'s variables.';
  if (c === 131047) return 'More than 24 hours since this person last replied: only a template can be sent.';
  if (c === 130429 || c === 131048 || c === 131056) return 'WhatsApp is rate-limiting this number. Wait a few minutes and try again.';
  if (c === 100 && sub === 33) return 'The Phone number ID or Business account ID is wrong for this token.';
  return err.error_user_msg || err.error_data?.details || err.message || 'WhatsApp request failed';
}

/** 10-digit Indian numbers get 91 in front; anything else must already include the country code. Returns digits or null. */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

const bodyOf = (t) => t.components?.find((c) => c.type === 'BODY')?.text || '';
const varCount = (text) => new Set(text.match(/\{\{\d+\}\}/g) || []).size;
// Templates with a media / variable header or URL-variable buttons need extra inputs this page doesn't collect.
const simple = (t) => !(t.components || []).some((c) => (c.type === 'HEADER' && (c.format !== 'TEXT' || /\{\{/.test(c.text || '')))
  || (c.type === 'BUTTONS' && (c.buttons || []).some((b) => /\{\{/.test(b.url || ''))) || c.type === 'CAROUSEL');

export async function accountInfo(settings) {
  const p = await graph(settings, `${settings.waPhoneId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`);
  return { number: p.display_phone_number, name: p.verified_name, quality: p.quality_rating, tier: p.messaging_limit_tier,
    test: /^\+?1\s*555/.test(p.display_phone_number || '') || p.verified_name === 'Test Number' };
}

/**
 * What the token itself can reach, from Meta's debug_token: its permissions and, per permission, the ids it was granted
 * (for whatsapp_business_* these are WhatsApp Business Account ids). Best effort: null if Meta does not answer.
 */
async function tokenGrants(settings) {
  try {
    const d = (await graph(settings, `debug_token?input_token=${encodeURIComponent(settings.waToken)}`)).data || {};
    const ids = new Set();
    for (const g of d.granular_scopes || []) if (/^whatsapp_business_/.test(g.scope)) (g.target_ids || []).forEach((x) => ids.add(String(x)));
    return { scopes: d.scopes || [], wabas: [...ids], userId: d.user_id, appId: d.app_id, valid: d.is_valid,
      expires: d.expires_at ? new Date(d.expires_at * 1000).toISOString().slice(0, 10) : 'never',
      granular: (d.granular_scopes || []).map((g) => `${g.scope}${g.target_ids?.length ? ` → ${g.target_ids.join(', ')}` : ' → (no ids)'}`) };
  } catch { return null; }
}

// What Meta says about the token, for the error message (never the token itself).
const describe = (g) => (g ? ` [Token details from Meta: system user ID ${g.userId || '?'}, app ID ${g.appId || '?'}, valid: ${g.valid}, expires: ${g.expires}; `
  + `permissions: ${g.granular.length ? g.granular.join('; ') : g.scopes.join(', ') || 'none'}]` : ' [Meta did not return the token details]');

const numbersOf = async (settings, waba) => (await graph(settings, `${waba}/phone_numbers?fields=id,display_phone_number&limit=100`)).data || [];

/**
 * Checks the token, the Phone number ID and the WhatsApp Business Account ID. The account id may be left empty or be
 * wrong (Meta's screens show several similar ids): the accounts this token was granted are then searched for the one
 * that holds this phone number. Returns { account, businessId } with the id that works.
 */
export async function checkAccount(settings) {
  let account;
  try { account = await accountInfo(settings); } catch (e) {
    if (e.wa?.code === 100) throw new Error(`Phone number ID ${settings.waPhoneId} is not a phone number this token can use. Copy the Phone number ID shown under the number in WhatsApp → API Setup, and check that the token's system user has that WhatsApp account assigned.`);
    throw e;
  }
  const has = (list) => list.some((n) => String(n.id) === String(settings.waPhoneId));
  let given = null, givenErr = '';
  if (settings.waBusinessId) {
    try { given = await numbersOf(settings, settings.waBusinessId); } catch (e) { if (e.wa?.code !== 100) throw e; givenErr = ` Meta said about account ${settings.waBusinessId}: "${e.wa?.message || e.message}".`; }
    if (given && has(given)) return { account, businessId: settings.waBusinessId };
  }
  const grants = await tokenGrants(settings);
  for (const id of grants?.wabas || []) {
    if (id === settings.waBusinessId) continue;
    try { if (has(await numbersOf(settings, id))) return { account, businessId: id }; } catch { /* not this one */ }
  }
  // Nothing fits: say why, as precisely as possible.
  const info = givenErr + describe(grants);
  if (grants && !grants.scopes.includes('whatsapp_business_management')) {
    throw new Error(`The token is missing the whatsapp_business_management permission. Generate a new token for the system user with both whatsapp_business_messaging and whatsapp_business_management ticked, and paste it here.${info}`);
  }
  if (grants && !grants.wabas.length) {
    throw new Error(`The token has no WhatsApp account in it. The system user that made it needs the WhatsApp account assigned (Business Settings → Accounts → WhatsApp accounts → the account → Assign people → Full control) before the token is generated.${info}`);
  }
  if (given) {
    throw new Error(`${account.number} is not in WhatsApp Business Account ${settings.waBusinessId}. Numbers in that account: ${given.map((n) => `${n.display_phone_number} (ID ${n.id})`).join(', ') || 'none'}. Leave the account ID empty to find it automatically.${info}`);
  }
  throw new Error(`None of the WhatsApp accounts this token can use holds phone number ID ${settings.waPhoneId}. Check that the system user has the WhatsApp account with ${account.number} assigned, then generate a new token.${info}`);
}

export async function listTemplates(settings) {
  const out = await graph(settings, `${settings.waBusinessId}/message_templates?fields=name,status,language,category,components&limit=100`);
  return (out.data || []).map((t) => ({ name: t.name, language: t.language, status: t.status, category: t.category, body: bodyOf(t), vars: varCount(bodyOf(t)), usable: t.status === 'APPROVED' && simple(t) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Send one template message. `params` fill {{1}}, {{2}}… in the body. Returns the WhatsApp message id. */
export async function sendTemplate(settings, { to, template, language, params = [] }) {
  // WhatsApp rejects new lines, tabs and long runs of spaces inside a variable.
  const clean = params.map((p) => String(p ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-');
  const out = await graph(settings, `${settings.waPhoneId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'template',
      template: { name: template, language: { code: language }, ...(clean.length ? { components: [{ type: 'body', parameters: clean.map((text) => ({ type: 'text', text })) }] } : {}) } },
  });
  return out.messages?.[0]?.id;
}

// Ready-made templates for this app. They are submitted to Meta for approval from the CRM page.
export const PRESETS = {
  interview_invite: {
    label: 'Interview invite', category: 'UTILITY', purpose: 'INTERVIEW',
    text: 'Hello {{1}},\n\nThank you for applying at Shine Infosolutions. You are invited for an interview for the {{2}} position.\n\nDate: {{3}}\nTime: {{4}}\nVenue: {{5}}\n\nPlease reply to this message to confirm your availability.',
    example: ['Rahul', 'Sales Executive', '10 October 2026', '11:00 AM', 'Shine Infosolutions Office, Gorakhpur'],
    fields: ['Candidate name', 'Position', 'Date', 'Time', 'Venue'],
  },
  employee_welcome: {
    label: 'Employee welcome', category: 'UTILITY', purpose: 'WELCOME',
    text: 'Welcome to Shine Infosolutions, {{1}}!\n\nWe are glad to have you on the team. Your attendance, daily tasks and profile are in the Shine Attendance app: https://attendance.shineinfosolutions.in\n\nPlease check in from the office every day.',
    example: ['Rahul'], fields: ['Employee name'],
  },
  team_update: {
    label: 'Team update', category: 'UTILITY', purpose: 'BULK',
    text: 'Hello {{1}},\n\nAn update from Shine Infosolutions:\n{{2}}\n\nPlease contact HR if you have any questions.',
    example: ['Rahul', 'The office will remain closed on Monday for Diwali.'], fields: ['Name', 'Message'],
  },
};

export async function createPreset(settings, name) {
  const p = PRESETS[name];
  if (!p) throw bad('Unknown template');
  return graph(settings, `${settings.waBusinessId}/message_templates`, {
    method: 'POST',
    body: { name, language: 'en', category: p.category, components: [{ type: 'BODY', text: p.text, example: { body_text: [p.example] } }] },
  });
}

/* ---------- Meta webhook (delivery ticks and replies) ---------- */

/** Callback URL and verify token for Meta's webhook form. The token is made once and kept in settings. */
export async function webhookInfo(settings, M, origin) {
  let token = process.env.WA_VERIFY_TOKEN || settings.waVerifyToken; // the secret wins: that is what the webhook checks first
  if (!token) {
    token = `shine-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await M.Setting.updateOne({ key: 'system', waVerifyToken: { $in: [null, ''] } }, { $set: { waVerifyToken: token } });
    token = (await M.Setting.findOne({ key: 'system' }).select('waVerifyToken').lean()).waVerifyToken;
  }
  return { callbackUrl: `${origin}/api/crm/webhook`, verifyToken: token, hasAppSecret: !!settings.waAppSecret };
}

/** X-Hub-Signature-256 check (only when the app secret is saved). */
export function signatureOk(secret, raw, header) {
  if (!secret) return true;
  const mac = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(header || '').replace(/^sha256=/, ''));
  return got.length === mac.length && crypto.timingSafeEqual(got, mac);
}

const STATUS = { delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
const RANK = { SENT: 0, DELIVERED: 1, READ: 2, FAILED: 3 };

/** Apply one webhook delivery: message status updates and incoming replies. */
export async function ingestWebhook(M, body) {
  let updated = 0, received = 0;
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'messages') continue;
      const v = ch.value || {};
      for (const st of v.statuses || []) {
        const next = STATUS[st.status];
        if (!next || !st.id) continue;
        const msg = await M.WaMessage.findOne({ waId: st.id });
        if (!msg) continue;
        const at = new Date(Number(st.timestamp) * 1000 || Date.now());
        if (next === 'DELIVERED') msg.deliveredAt ||= at;
        if (next === 'READ') { msg.readAt ||= at; msg.deliveredAt ||= at; }
        if (next === 'FAILED') msg.error = friendly(st.errors?.[0]).slice(0, 300);
        if ((RANK[next] ?? 0) > (RANK[msg.status] ?? 0)) msg.status = next;
        await msg.save(); updated++;
      }
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        if (!m.id || await M.WaMessage.exists({ waId: m.id })) continue; // Meta retries deliveries
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || `[${m.type}]`;
        await M.WaMessage.create({ direction: 'IN', status: 'RECEIVED', to: m.from, name: names[m.from] || '', waId: m.id, text: String(text).slice(0, 4000), purpose: 'REPLY' });
        received++;
      }
    }
  }
  return { updated, received };
}
