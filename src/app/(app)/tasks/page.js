'use client';
import { useCallback, useState } from 'react';
import { api } from '@/lib/client';
import { useLive } from '@/lib/useLive';
import { useMe } from '@/components/Shell';
import { Badge, Empty, Field, Modal, Skeleton } from '@/components/ui';
import Avatar from '@/components/Avatar';
import TaskHistory from '@/components/TaskHistory';
import { taskTone } from '@/lib/taskScore';
import { TaskPoints, TaskUpdate } from '@/components/TaskBits';

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
        <Field label="Task description (optional)" span hint="Write one point per line; each line is shown as a separate point.">
          <textarea rows={5} value={f.details} onChange={set('details')} maxLength={2000} placeholder={'Call the 20 leads in the Gorakhpur list\nNote who is interested\nShare the summary by 5 PM'} />
        </Field>
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
  const [status, setStatus] = useState(['PENDING', 'SUBMITTED'].includes(task.status) ? 'DONE' : task.status);
  const [note, setNote] = useState(task.note || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (body) => {
    setBusy(true); setErr('');
    try { await api(`/tasks/${task._id}`, { method: body ? 'DELETE' : 'PATCH', body: body ? undefined : { status, note } }); onClose(true); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Review task" onClose={() => onClose(false)}>
      <p style={{ marginTop: 0 }}><b>{task.title}</b><br /><span className="muted small">{task.user?.name} · {dayLabel(task.date)}</span></p>
      <TaskPoints details={task.details} />
      {task.update?.text ? <TaskUpdate update={task.update} /> : <div className="alert warn" style={{ marginTop: 10 }}>{task.user?.name?.split(' ')[0] || 'They'} has not added an update on this task yet.</div>}
      <div style={{ marginTop: 12 }}><Field label="Your decision">
        <div className="row">
          <button type="button" className={`btn ${status === 'DONE' ? 'primary' : ''}`} onClick={() => setStatus('DONE')}>Approve (done)</button>
          <button type="button" className={`btn ${status === 'NOT_DONE' ? 'danger' : ''}`} onClick={() => setStatus('NOT_DONE')}>Not done</button>
          <button type="button" className={`btn ${status === 'PENDING' ? 'primary' : ''}`} onClick={() => setStatus('PENDING')}>Send back</button>
        </div>
      </Field></div>
      {status === 'NOT_DONE' && <div className="alert warn" style={{ marginTop: 10 }}>This shows as a <b>late submission</b> and the task scores 0 for the day.</div>}
      <div style={{ marginTop: 12 }}><Field label="Your note (optional)"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Shown to the employee" /></Field></div>
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

// The assignee's own update: what they did, and whether they finished. Required before checking out.
function MyUpdateModal({ task, onClose }) {
  const [done, setDone] = useState(task.update ? !!task.update.done : true);
  const [text, setText] = useState(task.update?.text || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await api(`/tasks/${task._id}/update`, { method: 'POST', body: { text, done } }); onClose(true); } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="My update" onClose={() => onClose(false)}>
      <form onSubmit={save}>
        <p style={{ marginTop: 0 }}><b>{task.title}</b><br /><span className="muted small">{dayLabel(task.date)}</span></p>
        <TaskPoints details={task.details} />
        <div style={{ marginTop: 12 }}><Field label="Did you complete it?">
          <div className="row">
            <button type="button" className={`btn ${done ? 'primary' : ''}`} onClick={() => setDone(true)}>Yes, completed</button>
            <button type="button" className={`btn ${!done ? 'danger' : ''}`} onClick={() => setDone(false)}>Not completed</button>
          </div>
        </Field></div>
        <div style={{ marginTop: 12 }}><Field label="What did you do?" hint="HR reads this and approves the task.">
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} required minLength={3} placeholder={done ? 'e.g. Called all 20 leads, 6 are interested, sheet updated' : 'What is done, what is left, and why'} />
        </Field></div>
        {err && <div className="alert" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || text.trim().length < 3}>{busy ? 'Saving…' : 'Submit update'}</button>
        </div>
      </form>
    </Modal>
  );
}

function TaskRow({ t, onUpdate, onMine }) {
  const open = ['PENDING', 'SUBMITTED'].includes(t.status);
  return (
    <div className="task">
      <div className="task-main">
        <div className="task-title">{t.title}</div>
        <TaskPoints details={t.details} />
        <TaskUpdate update={t.update} />
        <div className="muted small task-meta">Assigned by {t.assignedBy?.name || '—'}{t.note ? ` · Note: ${t.note}` : ''}</div>
      </div>
      <div className="task-actions">
        <Badge tone={taskTone(t)}>{t.label}</Badge>
        {onUpdate && <button className={`btn sm ${t.status === 'SUBMITTED' ? 'primary' : ''}`} onClick={() => onUpdate(t)}>{t.status === 'SUBMITTED' ? 'Review' : 'Update'}</button>}
        {onMine && open && <button className={`btn sm ${t.status === 'PENDING' ? 'primary' : ''}`} onClick={() => onMine(t)}>{t.update ? 'Edit update' : 'Add update'}</button>}
      </div>
    </div>
  );
}

// Today's tasks of the signed-in person, with the "Add update" action. Used by everyone who can be given tasks.
function MyToday({ hideWhenEmpty }) {
  const [d, setD] = useState(null);
  const [modal, setModal] = useState(null);
  const load = useCallback(() => api('/tasks?mine=1').then(setD).catch(() => {}), []);
  useLive(load, 20000);
  if (!d) return hideWhenEmpty ? null : <Skeleton />;
  if (!d.tasks.length && hideWhenEmpty) return null;
  const score = d.tasks.reduce((a, t) => a + t.score, 0);
  const todo = d.tasks.filter((t) => t.status === 'PENDING').length;
  return (
    <div className="card">
      <div className="row between"><h2>My tasks today · {dayLabel(d.today)}</h2>{d.tasks.length > 0 && <Badge tone={d.tasks.some((t) => t.late) ? 'bad' : ''}>Score {score}/{d.tasks.length}</Badge>}</div>
      {todo > 0 && <div className="alert warn">Add your update on {todo === 1 ? 'this task' : `these ${todo} tasks`} before you check out.</div>}
      {!d.tasks.length ? <p className="muted">No tasks assigned for today.</p> : d.tasks.map((t) => <TaskRow key={t._id} t={t} onMine={(task) => setModal(task)} />)}
      <p className="muted small" style={{ marginTop: 10 }}>Write what you did on each task before checking out. HR then approves it. A task that is not done shows as a late submission and scores 0 for that day.</p>
      {modal && <MyUpdateModal task={modal} onClose={(ok) => { setModal(null); if (ok) load(); }} />}
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
  const toReview = d.tasks.filter((t) => t.status === 'SUBMITTED').length;
  const noUpdate = d.tasks.filter((t) => t.status === 'PENDING').length;
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
          {dayLabel(date)} · {d.tasks.length} task{d.tasks.length === 1 ? '' : 's'}{toReview ? ` · ${toReview} waiting for your approval` : ''}{noUpdate ? ` · ${noUpdate} with no update yet` : ''}.
          {' '}Each person adds their update before checking out; you then approve it or mark it not done. Not done is a late submission (score 0). Tasks with no update by 8 PM are marked not done automatically.
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
      {me.role !== 'ADMIN' && <MyToday hideWhenEmpty />}
      {me.role !== 'ADMIN' && <TaskHistory userId={me._id} mine />}
    </>
  );
}

function MyTasks({ me }) {
  return (
    <>
      <MyToday />
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
