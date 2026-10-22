// A stand-in for the WhatsApp Cloud API, for tests and local UI work (set WHATSAPP_GRAPH_URL to its address).
import http from 'node:http';

const TEMPLATES = [
  { name: 'interview_invite', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}},\n\nYou are invited for an interview for the {{2}} position.\n\nDate: {{3}}\nTime: {{4}}\nVenue: {{5}}' }] },
  { name: 'employee_welcome', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Welcome to Shine Infosolutions, {{1}}!' }] },
  { name: 'team_update', language: 'en', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}},\n\n{{2}}' }] },
  { name: 'promo_image', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Offer!' }] },
];

/** `sent` collects every message body the app posts. A number ending in 0000 is rejected like an un-allowed test recipient. */
export function startWaMock(port) {
  const sent = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c)).on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // 't' x60: full token. 'n' x60: a token made without whatsapp_business_management (can see the number, not the account).
      const full = req.headers.authorization === `Bearer ${'t'.repeat(60)}`, limited = req.headers.authorization === `Bearer ${'n'.repeat(60)}`;
      if (!full && !limited) return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/debug_token') {
        return send(200, { data: full
          ? { scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['999999999', '222222222'] }, { scope: 'whatsapp_business_messaging', target_ids: ['222222222'] }] }
          : { user_id: '61500000000001', app_id: '3263884590488956', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: ['222222222'] }] } });
      }
      if (limited && path !== '/111111111') return send(400, { error: { code: 100, error_subcode: 33, message: 'Unsupported get request' } });
      if (req.method === 'GET' && path === '/111111111') return send(200, { display_phone_number: '+91 90000 11111', verified_name: 'Shine Infosolutions', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250' });
      if (req.method === 'GET' && path === '/222222222/message_templates') return send(200, { data: TEMPLATES });
      if (req.method === 'GET' && path === '/222222222/phone_numbers') return send(200, { data: [{ id: '111111111', display_phone_number: '+91 90000 11111' }] });
      if (req.method === 'POST' && path === '/222222222/message_templates') return send(200, { id: '1', status: 'PENDING', category: 'UTILITY' });
      if (req.method === 'POST' && path === '/111111111/messages') {
        const body = JSON.parse(raw);
        if (body.to.endsWith('0000')) return send(400, { error: { code: 131030, message: 'Recipient phone number not in allowed list' } });
        sent.push(body);
        return send(200, { messages: [{ id: `wamid.${sent.length}` }] });
      }
      send(400, { error: { code: 100, error_subcode: 33, message: 'Unsupported request' } });
    });
  }).listen(port);
  return { sent, close: () => server.close(), token: 't'.repeat(60), phoneId: '111111111', businessId: '222222222' };
}

// Run directly for local UI work: node scripts/wa-mock.mjs
if (process.argv[1]?.endsWith('wa-mock.mjs')) { startWaMock(3999); console.log('WhatsApp mock on http://127.0.0.1:3999'); }
