import nodemailer from 'nodemailer';
import { getCloudflareContext } from '@opennextjs/cloudflare';

let tx;

// On Cloudflare, mail goes through the Email Sending binding (wrangler.jsonc `send_email`); SMTP is the fallback elsewhere.
function cfEmail() {
  try { return getCloudflareContext().env.EMAIL || null; } catch { return null; }
}
const smtpConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
export const mailConfigured = () => !!cfEmail() || smtpConfigured();

// "Name <addr>" -> { name, email }
function parseFrom(s) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s || '');
  return m ? { name: m[1].trim(), email: m[2].trim() } : { email: String(s).trim() };
}

function transport() {
  const port = Number(process.env.SMTP_PORT) || 465;
  tx ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, // fail fast instead of hanging
    ...(process.env.SMTP_INSECURE === '1' ? { ignoreTLS: true } : {}), // local test server only
  });
  return tx;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const TONES = {
  info: { bar: '#4257e6', soft: '#eceffe', ink: '#3143c4', icon: 'i' },
  ok: { bar: '#12805a', soft: '#e4f6ee', ink: '#0d6a49', icon: '✓' },
  warn: { bar: '#d98a00', soft: '#fff2d9', ink: '#8a5600', icon: '!' },
  bad: { bar: '#c0362c', soft: '#fdeae8', ink: '#9c2a22', icon: '×' },
};

/**
 * Branded HTML email (table based, inline styles: works in Gmail/Outlook/phones).
 * `rows` = [[label, value]] details card. `highlight` = a big line (e.g. a time or a password box).
 * All values are escaped.
 */
export function layout({ title, greeting, intro, rows = [], highlight, notes = [], link, linkText = 'Open Shine Attendance', tone = 'info', preheader, extraHtml = '', extraText = '', wide = false }) {
  const t = TONES[tone] || TONES.info;
  const url = appUrl();
  const logo = url.startsWith('https://') ? `<img src="${esc(url)}/logo.png" width="34" height="34" alt="" style="vertical-align:middle;border-radius:8px;margin-right:10px;background:#fff">` : '';
  const detail = rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border:1px solid #e6e9f1;border-radius:12px;border-collapse:separate;background:#fafbfe">${rows.map(([k, v], i) => `
    <tr><td style="padding:10px 14px;color:#6b7489;font-size:13px;width:38%;vertical-align:top;${i ? 'border-top:1px solid #e6e9f1;' : ''}">${esc(k)}</td>
    <td style="padding:10px 14px;font-size:14px;font-weight:600;vertical-align:top;${i ? 'border-top:1px solid #e6e9f1;' : ''}">${esc(v)}</td></tr>`).join('')}</table>` : '';
  const big = highlight ? `<div style="margin:18px 0;padding:16px;border-radius:12px;background:${t.soft};color:${t.ink};font-size:22px;font-weight:700;text-align:center;letter-spacing:.3px">${esc(highlight)}</div>` : '';
  const noteHtml = notes.length ? `<ul style="margin:12px 0;padding-left:20px;color:#3b4258;font-size:14px">${notes.map((n) => `<li style="margin:4px 0">${esc(n)}</li>`).join('')}</ul>` : '';
  const button = link ? `<p style="margin:22px 0 4px"><a href="${esc(link)}" style="display:inline-block;background:${t.bar};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">${esc(linkText)}</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6fb">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || intro || title)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${wide ? 820 : 560}px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e9f1;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#141a2a">
<tr><td style="background:${t.bar};padding:16px 24px;color:#fff;font-size:16px;font-weight:700">${logo}<span style="vertical-align:middle">Shine Attendance</span></td></tr>
<tr><td style="padding:26px 24px">
<div style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border-radius:50%;background:${t.soft};color:${t.ink};font-weight:700;font-size:18px">${t.icon}</div>
<h1 style="margin:12px 0 6px;font-size:21px;line-height:1.3">${esc(title)}</h1>
${greeting ? `<p style="margin:0 0 6px;font-size:15px">${esc(greeting)}</p>` : ''}
<p style="margin:0;font-size:15px;line-height:1.55;color:#3b4258">${esc(intro)}</p>
${big}${detail}${extraHtml}${noteHtml}${button}
</td></tr>
<tr><td style="padding:16px 24px;background:#fafbfe;border-top:1px solid #e6e9f1;color:#98a1b3;font-size:12px">Shine Infosolutions · This is an automated message from Shine Attendance. Please do not reply.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, '', greeting, intro, highlight, ...rows.map(([k, v]) => `${k}: ${v}`), extraText, ...notes.map((n) => `- ${n}`), link ? `${linkText}: ${link}` : '']
    .filter((x) => x !== undefined && x !== null && x !== '').join('\n');
  return { html, text };
}

/** Sends one email per recipient (so staff don't see each other's addresses). Throws on send failure. */
export async function sendMail({ to, subject, html, text }) {
  if (!mailConfigured()) return { skipped: true };
  const list = [...new Set([].concat(to || []).map((x) => String(x || '').trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
  if (!list.length) return { skipped: true };
  const cf = cfEmail();
  if (cf) {
    const from = parseFrom(process.env.MAIL_FROM || 'Shine Attendance <noreply-attendance@shineinfosolutions.in>');
    for (const addr of list) await cf.send({ from, to: addr, subject, html, text });
    return { sent: list.length };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  for (const addr of list) await transport().sendMail({ from, to: addr, subject, html, text });
  return { sent: list.length };
}
