'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import Icon from '@/components/Icon';
import { Field, Modal } from '@/components/ui';

const SENDERS = ['ADMIN', 'COO', 'MANAGER', 'HR'];

function Compose({ onDone, onCancel }) {
  const [people, setPeople] = useState(null);
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState({});
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api('/users?limit=500&status=ACTIVE').then((d) => setPeople(d.items)).catch((e) => setErr(e.message)); }, []);
  const ids = Object.keys(picked).filter((k) => picked[k]);
  const send = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await api('/notifications', { method: 'PUT', body: { title, body, to: everyone ? 'all' : ids } });
      onDone(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <form onSubmit={send}>
      <Field label="To">
        <label className="check"><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Everyone I oversee{people ? ` (${people.length})` : ''}</label>
        {!everyone && (
          <div className="pick-list">
            {!people ? <span className="muted small">Loading…</span> : people.map((p) => (
              <label key={p._id} className="check"><input type="checkbox" checked={!!picked[p._id]} onChange={(e) => setPicked({ ...picked, [p._id]: e.target.checked })} />
                <span>{p.name} <span className="muted small">{p.employeeId} · {p.role}</span></span></label>))}
          </div>
        )}
      </Field>
      <div style={{ marginTop: 10 }}><Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required minLength={3} placeholder="e.g. Office closed on Monday" /></Field></div>
      <div style={{ marginTop: 10 }}><Field label="Message"><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={450} required minLength={3} /></Field></div>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Back</button>
        <button className="btn primary" disabled={busy || (!everyone && !ids.length)}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  );
}

const POLL_MS = 30000;
const ago = (d) => {
  const m = Math.floor((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** The bell: shows unread notifications; reading one (or all) clears it from the list. */
export default function Notifications({ role }) {
  const router = useRouter();
  const [data, setData] = useState({ items: [], count: 0 });
  const [open, setOpen] = useState(false);
  const [compose, setCompose] = useState(false);
  const [sentNote, setSentNote] = useState('');
  const canSend = SENDERS.includes(role);
  const load = useCallback(() => api('/notifications').then(setData).catch(() => {}), []);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const read = async (n) => {
    setData((d) => ({ items: d.items.filter((x) => x._id !== n._id), count: Math.max(0, d.count - 1) }));
    api('/notifications', { method: 'POST', body: { id: n._id } }).catch(() => {});
    if (n.link) { setOpen(false); router.push(n.link); }
  };
  const readAll = async () => {
    setData({ items: [], count: 0 });
    await api('/notifications', { method: 'POST', body: { all: true } }).catch(() => {});
  };

  return (
    <>
      <button type="button" className="bell" onClick={() => { setOpen(true); setCompose(false); setSentNote(''); load(); }} aria-label={`Notifications${data.count ? `, ${data.count} unread` : ''}`}>
        <Icon name="bell" size={20} />
        {data.count > 0 && <span className="bell-count">{data.count > 9 ? '9+' : data.count}</span>}
      </button>
      {open && (
        <Modal title={compose ? 'Send a notification' : 'Notifications'} onClose={() => setOpen(false)}>
          {compose ? <Compose onCancel={() => setCompose(false)} onDone={(m) => { setCompose(false); setSentNote(m); }} /> : <>
          {sentNote && <div className="alert ok">{sentNote}</div>}
          {data.items.length === 0 ? <p className="muted" style={{ textAlign: 'center', padding: '18px 0' }}>You&apos;re all caught up.</p> : (
            <div className="notes">
              {data.items.map((n) => (
                <button type="button" key={n._id} className="note" onClick={() => read(n)}>
                  <span className="note-dot" />
                  <span className="note-main">
                    <b>{n.title}</b>
                    {n.body && <span className="note-body">{n.body}</span>}
                    <span className="muted small">{ago(n.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            {canSend && <button type="button" className="btn" style={{ marginRight: 'auto' }} onClick={() => setCompose(true)}>+ Send notification</button>}
            {data.items.length > 0 && <button type="button" className="btn" onClick={readAll}>Mark all as read</button>}
            <button type="button" className="btn primary" onClick={() => setOpen(false)}>Close</button>
          </div>
          </>}
        </Modal>
      )}
    </>
  );
}
