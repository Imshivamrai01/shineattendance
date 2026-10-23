'use client';
import Icon from '@/components/Icon';
import { Badge } from '@/components/ui';

// "Name, 98xxxxxxxx" per line (comma, tab or several spaces between them; a bare number is fine too).
export function parseList(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)[,\t;]\s*(\+?[\d\s()-]{8,})$/.exec(line) || /^(.*?)\s+(\+?[\d\s()-]{8,})$/.exec(line);
    if (m) return { name: m[1].trim(), phone: m[2].trim() };
    return /^\+?[\d\s()-]{8,}$/.test(line) ? { name: '', phone: line } : { name: line, phone: '' };
  });
}

export const isMobile = (p) => /^(\+?91|0)?[6-9]\d{9}$/.test(String(p || '').replace(/[\s()-]/g, ''));
export const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
export const waTone = (s) => ({ APPROVED: 'ok', SENT: 'ok', DELIVERED: 'ok', READ: 'ok', RECEIVED: 'warn', PENDING: 'warn', IN_APPEAL: 'warn', REJECTED: 'bad', FAILED: 'bad', PAUSED: 'bad', DISABLED: 'bad' }[s] || '');

export const CHANNELS = [
  ['ivr', 'IVR Call', 'phone', 'Your phone rings first, then theirs'],
  ['ai', 'AI Call', 'spark', 'The AI agent calls for you'],
  ['whatsapp', 'WhatsApp', 'whatsapp', 'Approved template messages'],
  ['history', 'History', 'clock', 'Every call and message'],
];

/** IVR Call · AI Call · WhatsApp · History. */
export function ChannelTabs({ value, onChange, counts = {} }) {
  return (
    <div className="crm-channels" role="tablist" aria-label="Channel">
      {CHANNELS.map(([k, label, icon, hint]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={`crm-channel ${value === k ? 'on' : ''}`} onClick={() => onChange(k)} title={hint}>
          <Icon name={icon} size={16} /><span>{label}</span>{counts[k] ? <span className="crm-count">{counts[k]}</span> : null}
        </button>))}
    </div>
  );
}

/** Small empty state used inside cards. */
export function Blank({ icon = 'inbox', title, children }) {
  return (
    <div className="crm-blank">
      <span className="crm-blank-ico"><Icon name={icon} size={22} /></span>
      <b>{title}</b>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}

export const CONTACT_STATUS = {
  NEW: ['Not contacted', ''], CALLED: ['Called', 'ok'], NO_ANSWER: ['No answer', 'warn'], CONFIRMED: ['Confirmed', 'ok'], DECLINED: ['Declined', 'bad'],
  RESCHEDULE: ['Wants another time', 'warn'], DONE: ['Feedback given', 'ok'], COMPLAINT: ['Needs follow-up', 'bad'],
};
export const ContactBadge = ({ s }) => <Badge tone={CONTACT_STATUS[s]?.[1]}>{CONTACT_STATUS[s]?.[0] || s}</Badge>;
