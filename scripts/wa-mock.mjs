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
      if (req.headers.authorization !== `Bearer ${'t'.repeat(60)}`) return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/111111111') return send(200, { display_phone_number: '+91 90000 11111', verified_name: 'Shine Infosolutions', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250' });
      if (req.method === 'GET' && path === '/222222222/message_templates') return send(200, { data: TEMPLATES });
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
