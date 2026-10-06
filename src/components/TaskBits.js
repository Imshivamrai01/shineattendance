'use client';
import { fmtTime } from '@/lib/client';
import { taskPoints } from '@/lib/taskScore';

/** Task description: one point per line is shown as a list. */
export function TaskPoints({ details }) {
  const points = taskPoints(details);
  if (!points.length) return null;
  if (points.length === 1) return <div className="muted small">{points[0]}</div>;
  return <ul className="points">{points.map((p, i) => <li key={i}>{p}</li>)}</ul>;
}

/** What the assignee reported on the task. */
export function TaskUpdate({ update }) {
  if (!update?.text) return null;
  return (
    <div className="task-update">
      <b>{update.done ? 'Completed' : 'Not completed'}</b> · <span className="muted small">update at {fmtTime(update.at)}</span>
      <div>{update.text}</div>
    </div>
  );
}
