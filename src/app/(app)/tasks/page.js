'use client';
import { useCallback, useState } from 'react';
import { api } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import { useMe } from '@/components/Shell';
import { Badge, Empty, Field, Modal, Skeleton } from '@/components/ui';
import Avatar from '@/components/Avatar';
import TaskHistory from '@/components/TaskHistory';
import { taskTone } from '@/lib/taskScore';

const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

function AssignModal({ people, date, onClose }) {
  const [f, setF] = useState({ userId: '', date, title: '', details: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api('/tasks', { method: 'POST', body: f }); onClose(true); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Assign a task" onClose={() => onClose(false)}>
      <form onSubmit={save} className="form">
        <Field label="Person">
          <select value={f.userId} onChange={set('userId')} required>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p._id} value={p._id}>{p.name}{p.employeeId ? ` (${p.employeeId})` : ''}{p.designation ? ` · ${p.designation}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Day"><input type="date" value={f.date} onChange={set('date')} required /></Field>
        <Field label="Task" span><input value={f.title} onChange={set('title')} maxLength={200} required minLength={3} placeholder="e.g. Call 20 leads from the Gorakhpur list" /></Field>
        <Field label="Details (optional)" span><textarea rows={3} value={f.details} onChange={set('details')} maxLength={2000} /></Field>
        {err && <div className="alert span">{err}</div>}
        <div className="row span" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Assign'}</button>
        </div>
      </form>
    </Modal>
  );
}

function UpdateModal({ task, onClose }) {
  const [status, setStatus] = useState(task.status === 'PENDING' ? 'DONE' : task.status);
  const [note, setNote] = useState(task.note || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (body) => {
    setBusy(true); setErr('');
    try { await api(`/tasks/${task._id}`, { method: body ? 'DELETE' : 'PATCH', body: body ? undefined : { status, note } }); onClose(true); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Update work progress" onClose={() => onClose(false)}>
      <p style={{ marginTop: 0 }}><b>{task.title}</b><br /><span className="muted small">{task.user?.name} · {dayLabel(task.date)}</span></p>
      <Field label="Was it done?">
        <div className="row">
          <button type="button" className={`btn ${status === 'DONE' ? 'primary' : ''}`} onClick={() => setStatus('DONE')}>Done</button>
          <button type="button" className={`btn ${status === 'NOT_DONE' ? 'danger' : ''}`} onClick={() => setStatus('NOT_DONE')}>Not done</button>
          <button type="button" className={`btn ${status === 'PENDING' ? 'primary' : ''}`} onClick={() => setStatus('PENDING')}>Still pending</button>
        </div>
      </Field>
      {status === 'NOT_DONE' && <div className="alert warn" style={{ marginTop: 10 }}>This shows as a <b>late submission</b> and the task scores 0 for the day.</div>}
      <div style={{ marginTop: 12 }}><Field label="Progress note (optional)"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What was done / what is left" /></Field></div>
      {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
        <button type="button" className="btn sm" onClick={() => save(true)} disabled={busy}>Delete task</button>
        <div className="row">
          <button type="button" className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

function TaskRow({ t, onUpdate }) {
  return (
    <div className="task">
      <div className="task-main">
        <div className="task-title">{t.title}</div>
        {t.details && <div className="muted small">{t.details}</div>}
        <div className="muted small task-meta">Assigned by {t.assignedBy?.name || '—'}{t.note ? ` · Note: ${t.note}` : ''}</div>
      </div>
      <div className="task-actions">
        <Badge tone={taskTone(t)}>{t.label}</Badge>
        {onUpdate && <button className="btn sm" onClick={() => onUpdate(t)}>Update</button>}
      </div>
    </div>
  );
}

function TeamTasks({ me }) {
  const [date, setDate] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api(`/tasks${date ? `?date=${date}` : ''}`).then((x) => { setD(x); setErr(''); if (!date) setDate(x.today); }).catch((e) => setErr(e.message)), [date]);
  useLive(load, 20000);
  if (err && !d) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;

  const byPerson = {};
  for (const t of d.tasks) (byPerson[t.user?._id] ||= { user: t.user, list: [] }).list.push(t);
  const groups = Object.values(byPerson).sort((a, b) => (a.user?.name || '').localeCompare(b.user?.name || ''));
  const pending = d.tasks.filter((t) => t.status === 'PENDING').length;
  const close = (ok) => { setModal(null); if (ok) load(); };

  return (
    <>
      <div className="card">
        <div className="row between">
          <div className="datebar">
            <button className="btn sm" onClick={() => setDate(shift(date, -1))} aria-label="Previous day">‹</button>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <button className="btn sm" onClick={() => setDate(shift(date, 1))} aria-label="Next day">›</button>
            {date !== d.today && <button className="btn sm" onClick={() => setDate(d.today)}>Today</button>}
          </div>
          <button className="btn primary" onClick={() => setModal({ kind: 'assign' })} disabled={!d.people?.length}>+ Assign task</button>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {dayLabel(date)} · {d.tasks.length} task{d.tasks.length === 1 ? '' : 's'}{pending ? ` · ${pending} waiting for your update` : ''}.
          {' '}Update each task in the evening; anything not done is a late submission and scores 0. Tasks not updated by 8 PM are marked not done automatically.
        </div>
      </div>
      {!groups.length && <div className="card"><Empty message={d.people?.length ? 'No tasks for this day yet.' : 'There is nobody you can assign tasks to.'} onAction={d.people?.length ? () => setModal({ kind: 'assign' }) : undefined} actionLabel="+ Assign task" /></div>}
      {groups.map((g) => {
        const score = g.list.reduce((a, t) => a + t.score, 0);
        return (
          <div className="card" key={g.user?._id}>
            <div className="row between">
              <div className="person-head"><Avatar user={g.user} size={34} /><div><b>{g.user?.name}</b><div className="muted small">{g.user?.employeeId || g.user?.role}</div></div></div>
              <Badge tone={g.list.some((t) => t.late) ? 'bad' : score === g.list.length ? 'ok' : ''}>Score {score}/{g.list.length}</Badge>
            </div>
            {g.list.map((t) => <TaskRow key={t._id} t={t} onUpdate={(task) => setModal({ kind: 'update', task })} />)}
          </div>
        );
      })}
      {modal?.kind === 'assign' && <AssignModal people={d.people} date={date >= d.today ? date : d.today} onClose={close} />}
      {modal?.kind === 'update' && <UpdateModal task={modal.task} onClose={close} />}
      {me.role !== 'ADMIN' && <TaskHistory userId={me._id} mine />}
    </>
  );
}

function MyTasks({ me }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('/tasks?mine=1').then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useLive(load, 20000);
  if (err && !d) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const score = d.tasks.reduce((a, t) => a + t.score, 0);
  return (
    <>
      <div className="card">
        <div className="row between"><h2>Today · {dayLabel(d.today)}</h2>{d.tasks.length > 0 && <Badge tone={d.tasks.some((t) => t.late) ? 'bad' : ''}>Score {score}/{d.tasks.length}</Badge>}</div>
        {!d.tasks.length ? <p className="muted">No tasks assigned for today.</p> : d.tasks.map((t) => <TaskRow key={t._id} t={t} />)}
        <p className="muted small" style={{ marginTop: 10 }}>HR updates your work progress in the evening. A task not done shows as a late submission and scores 0 for that day.</p>
      </div>
      <TaskHistory userId={me._id} mine />
    </>
  );
}

export default function TasksPage() {
  const me = useMe();
  const assigner = ['ADMIN', 'COO', 'MANAGER', 'HR'].includes(me.role);
  return (
    <>
      <h1 style={{ marginBottom: 14 }}>{assigner ? 'Daily tasks' : 'My tasks'}</h1>
      {assigner ? <TeamTasks me={me} /> : <MyTasks me={me} />}
    </>
  );
}
