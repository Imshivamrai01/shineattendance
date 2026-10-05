'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import Icon from '@/components/Icon';
import { Modal } from '@/components/ui';

const POLL_MS = 90000;
const ago = (d) => {
  const m = Math.floor((Date.now() - new Date(d)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** The bell: shows unread notifications; reading one (or all) clears it from the list. */
export default function Notifications() {
  const router = useRouter();
  const [data, setData] = useState({ items: [], count: 0 });
  const [open, setOpen] = useState(false);
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
      <button type="button" className="bell" onClick={() => { setOpen(true); load(); }} aria-label={`Notifications${data.count ? `, ${data.count} unread` : ''}`}>
        <Icon name="bell" size={20} />
        {data.count > 0 && <span className="bell-count">{data.count > 9 ? '9+' : data.count}</span>}
      </button>
      {open && (
        <Modal title="Notifications" onClose={() => setOpen(false)}>
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
            {data.items.length > 0 && <button type="button" className="btn" onClick={readAll}>Mark all as read</button>}
            <button type="button" className="btn primary" onClick={() => setOpen(false)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}
