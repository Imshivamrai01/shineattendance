'use client';
import { useEffect, useState } from 'react';
import { api, fmtTime } from '@/lib/client';
import { Badge, Skeleton } from '@/components/ui';
import { minutesText, label12 } from '@/lib/hours';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TONE = { PRESENT: 'ok', ABSENT: 'bad', VOIDED: 'bad', WEEK_OFF: '', FUTURE: '', BEFORE_START: '' };
const LABEL = { PRESENT: 'Present', ABSENT: 'Absent', VOIDED: 'Voided', WEEK_OFF: 'Week off', FUTURE: '—', BEFORE_START: '—' };
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

function Sessions({ day }) {
  if (!day.sessions.length) return <span className="muted">—</span>;
  return day.sessions.map((s) => (
    <div key={s._id} className="row" style={{ gap: 6, marginBottom: 4 }}>
      {s.inPhotoUrl && <a href={s.inPhotoUrl} target="_blank" rel="noreferrer"><img className="thumb" src={s.inPhotoUrl} alt="In" /></a>}
      <span>{fmtTime(s.checkIn)} – {fmtTime(s.checkOut)}</span>
      {s.outPhotoUrl && <a href={s.outPhotoUrl} target="_blank" rel="noreferrer"><img className="thumb" src={s.outPhotoUrl} alt="Out" /></a>}
      {s.corrected && <Badge tone="warn">corrected</Badge>}
      {s.autoCheckout && <Badge tone="warn">auto out</Badge>}
      {s.endOfDay && <Badge>office closed</Badge>}
      {s.lateReason && <span className="muted small">Late: {s.lateReason}</span>}
      {(s.breaks || []).map((b, i) => <span key={i} className="muted small">Away {fmtTime(b.outAt)} to {fmtTime(b.backAt)}{b.deductedMinutes ? ` (${minutesText(b.deductedMinutes)} not counted)` : ' (lunch, counted)'}: {b.reason}</span>)}
      {s.inGeo?.verified === false && <Badge tone="bad">outside</Badge>}
    </div>
  ));
}

/** Monthly and daily attendance for one person, from the month their account started. */
export default function AttendanceHistory({ userId }) {
  const [mode, setMode] = useState('monthly');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    api(`/users/${userId}/attendance${month ? `?month=${month}` : ''}`).then((d) => { setData(d); if (!month) setMonth(d.month); })
      .catch((e) => setErr(e.message));
  }, [userId, month]);

  if (err) return <div className="alert">{err}</div>;
  if (!data) return <div className="card"><Skeleton rows={4} /></div>;
  const s = data.summary;
  // Days that can have data: not in the future and not before the person was added to the app. Newest first.
  const shown = data.days.filter((x) => (x.status !== 'FUTURE' && x.status !== 'BEFORE_START') || x.sessions.length).reverse();
  const selected = data.days.find((x) => x.date === day) || data.days.find((x) => x.date === data.today) || data.days[0];
  const pickDay = (d) => { setDay(d); setMode('daily'); };
  const onDate = (d) => { if (!d) return; setDay(d); if (d.slice(0, 7) !== data.month) setMonth(d.slice(0, 7)); };

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Attendance</h2>
        <div className="row">
          <div className="tabs" style={{ margin: 0 }}>
            <button className={`btn sm ${mode === 'monthly' ? 'primary' : ''}`} onClick={() => setMode('monthly')}>Monthly</button>
            <button className={`btn sm ${mode === 'daily' ? 'primary' : ''}`} onClick={() => setMode('daily')}>Daily</button>
          </div>
          {mode === 'monthly' ? (
            <select style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)}>
              {data.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          ) : (
            <input type="date" style={{ width: 'auto' }} min={data.start} max={data.today} value={selected.date} onChange={(e) => onDate(e.target.value)} />
          )}
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>Records start on {dayLabel(data.start)} (the day this account was added). Office hours {label12(data.office.start)} to {label12(data.office.end)}, lunch {label12(data.office.lunchStart)} to {label12(data.office.lunchEnd)}{data.office.grace ? ` (+${data.office.grace} min grace)` : ''}. Sunday is the weekly off.</p>

      {mode === 'monthly' ? (
        <>
          <div className="grid stats-mini">
            <div className="stat"><span className="muted">Present days</span><b style={{ color: 'var(--ok)' }}>{s.present}</b></div>
            <div className="stat"><span className="muted">Absent days</span><b style={{ color: s.absent ? 'var(--bad)' : undefined }}>{s.absent}</b></div>
            <div className="stat"><span className="muted">Late days</span><b style={{ color: s.lateDays ? 'var(--warn)' : undefined }}>{s.lateDays}</b></div>
            <div className="stat"><span className="muted">Total hours</span><b>{s.totalHours}</b></div>
            <div className="stat"><span className="muted">Avg / day</span><b>{s.avgHours}</b></div>
          </div>
          {!shown.length && <p className="muted" style={{ textAlign: 'center', padding: '18px 0' }}>No data found.</p>}
          <div className="scroll" hidden={!shown.length}><table className="days">
            <thead><tr><th>Date</th><th>Status</th><th>Sessions</th><th>Hours</th></tr></thead>
            <tbody>{shown.map((x) => (
              <tr key={x.date} style={{ cursor: 'pointer', opacity: x.status === 'WEEK_OFF' ? 0.6 : 1 }} onClick={() => pickDay(x.date)}>
                <td style={{ whiteSpace: 'nowrap' }}>{x.date.slice(8)} {WD[x.weekday]}</td>
                <td><Badge tone={TONE[x.status]}>{LABEL[x.status]}</Badge>{x.flags?.late && <> <Badge tone="warn">Late {minutesText(x.flags.lateMinutes)}</Badge></>}{x.flags?.early && <> <Badge tone="warn">Left early</Badge></>}</td>
                <td className={x.sessions.length ? '' : 'none'}><Sessions day={x} /></td>
                <td>{x.hours ? <>{x.hours}<span className="unit"> h</span></> : '—'}</td>
              </tr>))}</tbody>
          </table></div>
        </>
      ) : (
        <div>
          <div className="row between" style={{ marginBottom: 8 }}>
            <b>{dayLabel(selected.date)} · {WD[selected.weekday]}</b>
            <span className="row" style={{ gap: 6 }}><Badge tone={TONE[selected.status]}>{LABEL[selected.status]}</Badge>{selected.flags?.late && <Badge tone="warn">Late {minutesText(selected.flags.lateMinutes)}</Badge>}{selected.flags?.early && <Badge tone="warn">Left {minutesText(selected.flags.earlyMinutes)} early</Badge>}</span>
          </div>
          {selected.voidReason && <div className="alert warn">Voided: {selected.voidReason}</div>}
          {selected.sessions.length === 0 ? <p className="muted">{selected.status === 'BEFORE_START' ? 'No data found.' : 'No attendance recorded on this day.'}</p> : selected.sessions.map((x, i) => (
            <div key={x._id} className="card" style={{ marginBottom: 10, boxShadow: 'none' }}>
              <div className="row between"><b>Session {i + 1}</b><span className="muted small">{!x.checkOut && 'Still checked in'}</span></div>
              <div className="sess-pair">
                {[['Check-in', x.checkIn, x.inPhotoUrl, x.inGeo], ['Check-out', x.checkOut, x.outPhotoUrl, x.outGeo]].map(([label, t, photo, geo]) => (
                  <div key={label}>
                    <div className="muted small">{label}</div>
                    <div style={{ fontWeight: 600, fontSize: 18 }}>{fmtTime(t)}</div>
                    {geo?.distance != null && <div className="muted small">{geo.distance} m from office</div>}
                    {photo && <a href={photo} target="_blank" rel="noreferrer"><img src={photo} alt={label} className="sess-photo" /></a>}
                  </div>))}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                {x.corrected && <Badge tone="warn">corrected by admin</Badge>}
                {x.autoCheckout && <Badge tone="warn">auto check-out (left office)</Badge>}
                {x.inGeo?.verified === false && <Badge tone="bad">check-in outside geofence</Badge>}
              </div>
            </div>))}
          {selected.hours > 0 && <p className="muted small">Total hours: {selected.hours}</p>}
        </div>
      )}
    </div>
  );
}
