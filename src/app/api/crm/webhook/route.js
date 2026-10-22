import { connect, getSettings, withDb, M } from '@/lib/db';
import { ingestWebhook, signatureOk } from '@/lib/whatsapp';

// Meta (WhatsApp Cloud API) webhook. Callback URL: https://<site>/api/crm/webhook, verify token from CRM → WhatsApp settings.
// GET is Meta's one-time check; POST brings delivery ticks (delivered / read / failed) and replies to the business number.
// Meta gives up after ~5 s, and a cold start plus a database connection from Meta's US servers can take longer,
// so the token is also kept as the WA_VERIFY_TOKEN secret and checked without the database.
export const GET = (req) => {
  const q = new URL(req.url).searchParams;
  const env = process.env.WA_VERIFY_TOKEN;
  if (env && q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === env) {
    return new Response(q.get('hub.challenge') || '', { headers: { 'content-type': 'text/plain' } });
  }
  return verifyFromDb(q);
};

const verifyFromDb = (q) => withDb(async () => {
  await connect();
  const s = await getSettings();
  if (q.get('hub.mode') === 'subscribe' && s.waVerifyToken && q.get('hub.verify_token') === s.waVerifyToken) {
    return new Response(q.get('hub.challenge') || '', { headers: { 'content-type': 'text/plain' } });
  }
  return new Response('Verify token does not match', { status: 403 });
});

export const POST = (req) => withDb(async () => {
  const raw = await req.text();
  await connect();
  const s = await getSettings();
  if (!signatureOk(s.waAppSecret, raw, req.headers.get('x-hub-signature-256'))) return new Response('Bad signature', { status: 401 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  try { await ingestWebhook(M, body); } catch (e) { console.error('whatsapp webhook', e.message); } // always 200, or Meta keeps retrying
  return new Response('OK');
});
