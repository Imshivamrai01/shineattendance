'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';

/** Shimmering placeholder used instead of "Loading…" text. */
export function Skeleton({ rows = 5, title = true }) {
  return (
    <div className="skel-wrap" aria-busy="true" aria-live="polite">
      {title && <div className="skel" style={{ height: 26, width: '32%', marginBottom: 18 }} />}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ height: 16, width: `${92 - (i % 3) * 14}%`, marginBottom: 12 }} />
      ))}
    </div>
  );
}

export function Badge({ children, tone }) {
  return <span className={`badge ${tone || ''}`}>{children}</span>;
}
export const statusTone = (s) => ({ ACTIVE: 'ok', APPROVED: 'ok', INACTIVE: 'warn', ARCHIVED: 'bad', VOIDED: 'bad', REJECTED: 'bad' }[s] || 'warn');

export function Field({ label, children, span, hint }) {
  return (
    <div className={span ? 'span' : ''}>
      <label>{label}</label>
      {children}
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

export function Empty({ message, actionHref, actionLabel, onAction }) {
  return (
    <div className="empty">
      <p>{message}</p>
      {actionHref && <Link className="btn primary" href={actionHref}>{actionLabel}</Link>}
      {onAction && <button className="btn primary" onClick={onAction}>{actionLabel}</button>}
    </div>
  );
}

export function Modal({ title, children, onClose }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    // Stop the page behind from scrolling while a popup is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation with mandatory reason. `details` is a list of [label, value] shown before confirming.
 * onConfirm(reason) may throw; the message is shown inline.
 */
export function ConfirmModal({ title, question = 'Are you sure?', details = [], consequence, danger, reasonLabel = 'Reason', minReason = 5, confirmLabel = 'Confirm', onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr('');
    try { await onConfirm(reason.trim()); onClose(true); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={() => onClose(false)}>
      <p style={{ marginTop: 0 }}><b>{question}</b></p>
      {details.length > 0 && (
        <table style={{ marginBottom: 10 }}><tbody>
          {details.map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 130 }}>{k}</td><td>{v}</td></tr>)}
        </tbody></table>
      )}
      {consequence && <div className="alert warn">{consequence}</div>}
      <Field label={minReason > 0 ? `${reasonLabel} (required)` : `${reasonLabel} (optional)`}>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={go} disabled={busy || reason.trim().length < minReason}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function TempPassword({ value, onClose, who }) {
  return (
    <Modal title="Temporary password" onClose={onClose}>
      <p>Share this with {who || 'the user'} securely. It is shown <b>only once</b> and they must change it at first login.</p>
      <pre className="diff card" style={{ fontSize: 16 }}>{value}</pre>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(value)}>Copy</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
