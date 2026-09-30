'use client';

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal: AbortSignal.timeout(60000),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return res;
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) window.location.href = '/login';
    if (data.code === 'PASSWORD_CHANGE_REQUIRED') window.location.href = '/change-password';
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');
export const NP = 'Not Provided';
export const show = (v) => (v == null || v === '' ? NP : v);
export const toLocalInput = (d) => {
  if (!d) return '';
  const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};

// One-shot message shown on the next page (used after saving on a separate page).
export const setFlash = (msg) => { try { sessionStorage.setItem('flash', msg); } catch { /* private mode */ } };
export const takeFlash = () => { try { const m = sessionStorage.getItem('flash'); sessionStorage.removeItem('flash'); return m || ''; } catch { return ''; } };
