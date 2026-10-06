'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { Badge, Skeleton } from '@/components/ui';
import { taskTone } from '@/lib/taskScore';
import { TaskPoints, TaskUpdate } from '@/components/TaskBits';

const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });
const daysAgo = (n) => { const x = new Date(Date.now() + 330 * 60000 - n * 86400000); return x.toISOString().slice(0, 10); };

/** Day-by-day work status for one person (last 30 days): each task with Done / Late submission and the day's score. */
export default function TaskHistory({ userId, mine = false }) {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ from: daysAgo(30), to: daysAgo(-30) });
    if (mine) p.set('mine', '1'); else p.set('user', userId);
    api(`/tasks?${p}`).then((d) => setTasks(d.tasks)).catch((e) => setErr(e.message));
  }, [userId, mine]);
  if (err) return <div className="alert">{err}</div>;
  if (!tasks) return <div className="card"><Skeleton rows={3} /></div>;

  const byDay = {};
  for (const t of tasks) (byDay[t.date] ||= []).push(t);
  const days = Object.keys(byDay).sort().reverse();
  return (
    <div className="card">
      <h2>{mine ? 'My work status' : 'Work status'}</h2>
      {!days.length && <p className="muted">No tasks in the last 30 days.</p>}
      {days.map((day) => {
        const list = byDay[day];
        const score = list.reduce((a, t) => a + t.score, 0);
        const late = list.some((t) => t.late);
        return (
          <div key={day} style={{ marginTop: 14 }}>
            <div className="row between">
              <b>{dayLabel(day)}</b>
              <Badge tone={late ? 'bad' : score === list.length ? 'ok' : ''}>Score {score}/{list.length}</Badge>
            </div>
            {list.map((t) => (
              <div key={t._id} className="task">
                <div className="task-main">
                  <div className="task-title">{t.title}</div>
                  <TaskPoints details={t.details} />
                  <TaskUpdate update={t.update} />
                  <div className="muted small task-meta">Assigned by {t.assignedBy?.name || '—'}{t.note ? ` · Note: ${t.note}` : ''}</div>
                </div>
                <Badge tone={taskTone(t)}>{t.label}</Badge>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
