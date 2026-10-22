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

/* ---------- Templates: list, create (with media headers and buttons), send ---------- */

const varCount = (text) => new Set(String(text || '').match(/\{\{\d+\}\}/g) || []).size;
const MEDIA = ['IMAGE', 'VIDEO', 'DOCUMENT'];
// Media WhatsApp accepts in a template header (and the most this app sends; Meta's own limits are 5 / 16 / 100 MB).
export const MEDIA_RULES = {
  IMAGE: { types: ['image/jpeg', 'image/png'], max: 5 * 1024 * 1024, label: 'Image (JPG / PNG, up to 5 MB)' },
  VIDEO: { types: ['video/mp4', 'video/3gpp'], max: 16 * 1024 * 1024, label: 'Video (MP4, up to 16 MB)' },
  DOCUMENT: { types: ['application/pdf'], max: 30 * 1024 * 1024, label: 'PDF document (up to 30 MB)' },
};
export const mediaKind = (mime) => Object.keys(MEDIA_RULES).find((k) => MEDIA_RULES[k].types.includes(mime)) || null;

/** One template as the CRM page uses it: header / body / footer / buttons, how many values each needs, and whether it can be sent here. */
function shapeTemplate(t) {
  const c = (type) => (t.components || []).find((x) => x.type === type);
  const h = c('HEADER'), b = c('BODY'), f = c('FOOTER'), btns = c('BUTTONS')?.buttons || [];
  const header = h ? { format: h.format, text: h.text || '', vars: h.format === 'TEXT' ? varCount(h.text) : 0 } : null;
  const buttons = btns.map((x) => ({ type: x.type, text: x.text, url: x.url, phone: x.phone_number, vars: x.type === 'URL' ? varCount(x.url) : 0 }));
  const supported = (!header || header.format === 'TEXT' || MEDIA.includes(header.format))
    && buttons.every((x) => ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(x.type))
    && !(t.components || []).some((x) => x.type === 'CAROUSEL');
  return {
    id: t.id, name: t.name, language: t.language, status: t.status, category: t.category, reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '',
    header, body: b?.text || '', vars: varCount(b?.text), footer: f?.text || '', buttons,
    media: header && MEDIA.includes(header.format) ? header.format : null,
    usable: t.status === 'APPROVED' && supported, supported,
  };
}

export async function listTemplates(settings) {
  const out = await graph(settings, `${settings.waBusinessId}/message_templates?fields=id,name,status,language,category,components,rejected_reason&limit=200`);
  return (out.data || []).map(shapeTemplate).sort((a, b) => a.name.localeCompare(b.name));
}

/** The Meta app id (needed for uploading a template's sample media), from the token when not saved yet. */
export async function appIdFor(settings) {
  if (settings.waAppId) return settings.waAppId;
  const g = await tokenGrants(settings);
  if (!g?.appId) throw new Error('Could not find the Meta app for this token. Save WhatsApp settings again with the token.');
  return String(g.appId);
}

async function rawPost(url, headers, body) {
  let res, out;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
    out = await res.json();
  } catch (e) { throw new HttpError(502, `Could not reach WhatsApp: ${e.message}`); }
  if (!res.ok || out.error) { const e = new Error(friendly(out.error)); e.wa = out.error; throw e; }
  return out;
}

/**
 * Uploads a sample file for a template's media header (Meta's resumable upload) and returns the handle
 * that goes into the template's example. Meta reviews the template with this sample.
 */
export async function uploadSample(settings, { appId, bytes, mime, name }) {
  const q = new URLSearchParams({ file_name: name || 'sample', file_length: String(bytes.byteLength), file_type: mime });
  const session = await rawPost(`${GRAPH}/${appId}/uploads?${q}`, { authorization: `Bearer ${settings.waToken}` });
  const done = await rawPost(`${GRAPH}/${session.id}`, { authorization: `OAuth ${settings.waToken}`, file_offset: '0', 'content-type': mime }, bytes);
  if (!done.h) throw new Error('WhatsApp did not accept the sample file');
  return done.h;
}

/** Uploads a file for sending (WhatsApp keeps it for 30 days). Returns the WhatsApp media id. */
export async function uploadMedia(settings, { bytes, mime, name }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([bytes], { type: mime }), name || 'file');
  const out = await rawPost(`${GRAPH}/${settings.waPhoneId}/media`, { authorization: `Bearer ${settings.waToken}` }, form);
  return out.id;
}

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const LANGS = ['en', 'en_US', 'en_GB', 'hi'];

/**
 * Checks a template the CRM page built and turns it into Meta's format. `def`:
 * { name, category: MARKETING | UTILITY, language, header: { format: NONE | TEXT | IMAGE | VIDEO | DOCUMENT, text, example },
 *   body, examples: [...], footer, buttons: [{ type: QUICK_REPLY | URL | PHONE_NUMBER, text, url, example, phone }] }
 * `handle` is the uploaded sample for a media header.
 */
export function buildTemplate(def, handle) {
  const name = clip(def.name, 512).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z0-9_]+$/.test(name)) throw bad('Template name: lowercase letters, numbers and _ only (for example summer_offer)');
  const category = ['MARKETING', 'UTILITY'].includes(def.category) ? def.category : null;
  if (!category) throw bad('Choose a category: Marketing or Utility');
  const language = LANGS.includes(def.language) ? def.language : 'en';
  const body = String(def.body || '').trim();
  if (!body) throw bad('Write the message text');
  if (body.length > 1024) throw bad('The message text can be at most 1024 characters');
  const nums = [...new Set((body.match(/\{\{(\d+)\}\}/g) || []).map((m) => Number(m.slice(2, -2))))].sort((a, b) => a - b);
  if (nums.some((n, i) => n !== i + 1)) throw bad('Number the values in order: {{1}}, {{2}}, {{3}}…');
  if (/^\s*\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}[\s.!?]*$/.test(body)) throw bad('WhatsApp does not allow a value {{n}} at the very start or end of the message. Add some words before / after it.');
  const examples = nums.map((n) => clip(def.examples?.[n - 1], 200));
  if (examples.some((x) => !x)) throw bad('Give an example for every value ({{1}}, {{2}}…): Meta checks the template with them');
  const components = [];

  const h = def.header || {};
  const format = String(h.format || 'NONE').toUpperCase();
  if (format === 'TEXT') {
    const text = clip(h.text, 60);
    if (!text) throw bad('Write the header text (up to 60 characters)');
    const hv = varCount(text);
    if (hv > 1 || (hv === 1 && !/\{\{1\}\}/.test(text))) throw bad('The header can have only one value, {{1}}');
    components.push({ type: 'HEADER', format: 'TEXT', text, ...(hv ? { example: { header_text: [clip(h.example, 60) || 'Example'] } } : {}) });
  } else if (MEDIA.includes(format)) {
    if (!handle) throw bad('Attach a sample file for the header: Meta reviews the template with it');
    components.push({ type: 'HEADER', format, example: { header_handle: [handle] } });
  } else if (format !== 'NONE') throw bad('Unknown header type');

  components.push({ type: 'BODY', text: body, ...(nums.length ? { example: { body_text: [examples] } } : {}) });
  const footer = clip(def.footer, 60);
  if (footer) components.push({ type: 'FOOTER', text: footer });

  const btns = (Array.isArray(def.buttons) ? def.buttons : []).filter((x) => clip(x?.text, 25)).slice(0, 10);
  if (btns.length) {
    const out = btns.map((x) => {
      const text = clip(x.text, 25);
      if (x.type === 'QUICK_REPLY') return { type: 'QUICK_REPLY', text };
      if (x.type === 'PHONE_NUMBER') {
        const phone = String(x.phone || '').replace(/[^\d+]/g, '');
        if (!/^\+\d{8,15}$/.test(phone)) throw bad(`Button "${text}": phone number with country code, like +919876543210`);
        return { type: 'PHONE_NUMBER', text, phone_number: phone };
      }
      if (x.type === 'URL') {
        const url = clip(x.url, 2000);
        if (!/^https:\/\/[^\s]+$/.test(url)) throw bad(`Button "${text}": link must start with https://`);
        if (/\{\{\d+\}\}/.test(url) && !/\{\{1\}\}$/.test(url)) throw bad(`Button "${text}": a link value can only be {{1}} at the end`);
        return { type: 'URL', text, url, ...(/\{\{1\}\}$/.test(url) ? { example: [clip(x.example, 500) || url.replace('{{1}}', 'example')] } : {}) };
      }
      throw bad('Unknown button type');
    });
    if (out.filter((x) => x.type === 'PHONE_NUMBER').length > 1) throw bad('Only one call button is allowed');
    if (out.filter((x) => x.type === 'URL').length > 2) throw bad('At most two link buttons are allowed');
    components.push({ type: 'BUTTONS', buttons: out });
  }
  return { name, language, category, components };
}

export async function createTemplate(settings, tpl) {
  return graph(settings, `${settings.waBusinessId}/message_templates`, { method: 'POST', body: tpl });
}

/**
 * Send one template message. `params` fill {{1}}, {{2}}… in the body; `header` is { type: image | video | document, id, filename }
 * or { type: text, text }; `buttonParams` fill a {{1}} at the end of link buttons, in button order. Returns the WhatsApp message id.
 */
export async function sendTemplate(settings, { to, template, language, params = [], header, buttonParams = [] }) {
  // WhatsApp rejects new lines, tabs and long runs of spaces inside a variable.
  const tidy = (p) => String(p ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';
  const components = [];
  if (header?.type === 'text') components.push({ type: 'header', parameters: [{ type: 'text', text: tidy(header.text) }] });
  else if (header?.id) {
    const media = { id: header.id, ...(header.type === 'document' && header.filename ? { filename: header.filename } : {}) };
    components.push({ type: 'header', parameters: [{ type: header.type, [header.type]: media }] });
  }
  if (params.length) components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text: tidy(text) })) });
  buttonParams.forEach((b, i) => { if (b != null && b !== '') components.push({ type: 'button', sub_type: 'url', index: String(b.index ?? i), parameters: [{ type: 'text', text: tidy(b.text ?? b) }] }); });
  const out = await graph(settings, `${settings.waPhoneId}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: language }, ...(components.length ? { components } : {}) } },
  });
  return out.messages?.[0]?.id;
}

// Ready-made templates: starting points for the builder on the CRM page (edit, attach a sample if needed, submit).
export const PRESETS = {
  interview_invite: {
    label: 'Interview invite', category: 'UTILITY', purpose: 'INTERVIEW', header: { format: 'NONE' },
    text: 'Hello {{1}},\n\nThank you for applying at Shine Infosolutions. You are invited for an interview for the {{2}} position.\n\nDate: {{3}}\nTime: {{4}}\nVenue: {{5}}\n\nPlease reply to this message to confirm your availability.',
    example: ['Rahul', 'Sales Executive', '10 October 2026', '11:00 AM', 'Shine Infosolutions Office, Gorakhpur'],
    fields: ['Candidate name', 'Position', 'Date', 'Time', 'Venue'],
    buttons: [{ type: 'QUICK_REPLY', text: 'I will attend' }, { type: 'QUICK_REPLY', text: 'Need another time' }],
  },
  shine_offer: {
    label: 'Offer (with image)', category: 'MARKETING', purpose: 'OFFER', header: { format: 'IMAGE' },
    text: 'Hello {{1}},\n\nSpecial offer from Shine Infosolutions: {{2}}\n\nOffer valid till {{3}}. Reply YES and our team will call you with the details.',
    example: ['Rahul', '20% off on website + social media package', '31 October 2026'],
    fields: ['Customer name', 'Offer', 'Valid till'], footer: 'Shine Infosolutions',
    buttons: [{ type: 'QUICK_REPLY', text: 'YES, interested' }, { type: 'QUICK_REPLY', text: 'Not now' }],
  },
  shine_sales_brochure: {
    label: 'Sales brochure (PDF)', category: 'MARKETING', purpose: 'SALES', header: { format: 'DOCUMENT' },
    text: 'Hello {{1}},\n\nThank you for your interest in Shine Infosolutions. Please find our brochure attached with our {{2}} services and prices.\n\nReply to this message or call us to book a free consultation.',
    example: ['Rahul', 'website, app and digital marketing'], fields: ['Customer name', 'Services'], footer: 'Shine Infosolutions',
    buttons: [{ type: 'QUICK_REPLY', text: 'Book a consultation' }, { type: 'URL', text: 'Visit website', url: 'https://shineinfosolutions.in' }],
  },
  shine_feedback: {
    label: 'Feedback request', category: 'MARKETING', purpose: 'FEEDBACK', header: { format: 'NONE' },
    text: 'Hello {{1}},\n\nThank you for choosing Shine Infosolutions for {{2}}. How was your experience with us?\n\nPlease tap a button below, it takes 2 seconds. Your feedback helps us serve you better.',
    example: ['Rahul', 'your website project'], fields: ['Customer name', 'Service'], footer: 'Shine Infosolutions',
    buttons: [{ type: 'QUICK_REPLY', text: 'Excellent' }, { type: 'QUICK_REPLY', text: 'Good' }, { type: 'QUICK_REPLY', text: 'Needs improvement' }],
  },
  employee_welcome: {
    label: 'Employee welcome', category: 'UTILITY', purpose: 'WELCOME', header: { format: 'NONE' },
    text: 'Welcome to Shine Infosolutions, {{1}}!\n\nWe are glad to have you on the team. Your attendance, daily tasks and profile are in the Shine Attendance app: https://attendance.shineinfosolutions.in\n\nPlease check in from the office every day.',
    example: ['Rahul'], fields: ['Employee name'],
  },
  team_update: {
    label: 'Team update', category: 'UTILITY', purpose: 'BULK', header: { format: 'NONE' },
    text: 'Hello {{1}},\n\nAn update from Shine Infosolutions:\n{{2}}\n\nPlease contact HR if you have any questions.',
    example: ['Rahul', 'The office will remain closed on Monday for Diwali.'], fields: ['Name', 'Message'],
  },
};

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
