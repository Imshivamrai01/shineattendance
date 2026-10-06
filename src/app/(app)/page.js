'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLive } from '@/lib/useLive';
import { api, fmtTime, fmtDateTime } from '@/lib/client';
import { useMe } from '@/components/Shell';
import { Badge, Skeleton } from '@/components/ui';
import CameraCapture from '@/components/CameraCapture';
import { label12, minutesText } from '@/lib/hours';
import { quoteOfTheDay } from '@/lib/quotes';
import { taskTone } from '@/lib/taskScore';

// Phone GPS improves over the first seconds. Watch for up to `ms`, keep the most accurate fix,
// and stop early once a fix is good enough.
function getPosition({ ms = 12000, goodEnough = 5, onUpdate } = {}) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let best = null, done = false, id, timer;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); navigator.geolocation.clearWatch(id); resolve(best);
    };
    id = navigator.geolocation.watchPosition((p) => {
      const c = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      if (!best || c.accuracy < best.accuracy) best = c;
      onUpdate?.(best);
      if (best.accuracy <= goodEnough) finish();
    }, finish, { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    timer = setTimeout(finish, ms);
  });
}

// Today's status. After office hours: someone who came shows "Checked out", someone who never came shows "Absent".
function dayStatus(t) {
  if (t.record?.status === 'VOIDED') return <Badge tone="bad">Voided</Badge>;
  if (t.checkedIn) return <Badge tone="ok">Checked in</Badge>;
  if (t.record?.sessions?.length) return <Badge>Checked out</Badge>;
  if (t.weekOff) return <Badge>Week off</Badge>;
  return t.closed ? <Badge tone="bad">Absent</Badge> : <Badge tone="warn">Not checked in</Badge>;
}

function AttendanceCard({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [cam, setCam] = useState(null); // { kind, resolve }
  const [reason, setReason] = useState('');
  const [lateReason, setLateReason] = useState('');
  const askPhoto = (kind) => new Promise((resolve) => setCam({ kind, resolve }));
  const closeCam = (photo) => { cam.resolve(photo); setCam(null); };
  const act = async (kind) => {
    setBusy(true); setMsg(null);
    try {
      // Start reading GPS right away so it warms up while the camera photo is taken.
      const posPromise = getPosition({
        ms: kind === 'check-in' ? 12000 : 3000, // check-out doesn't need precision
        onUpdate: kind !== 'check-in' ? undefined : (b) => setMsg({ ok: true, text: `Getting a precise location… currently accurate to ±${Math.round(b.accuracy)} m` }),
      });
      let photo;
      if (data.today.photosRequired) {
        photo = await askPhoto(kind);
        if (!photo) { setMsg({ text: 'A live camera photo is required for attendance.' }); setBusy(false); return; }
      }
      const pos = await posPromise;
      if (!pos) { setMsg({ text: 'Could not read your location. Turn on location/GPS and allow it for this site.' }); setBusy(false); return; }
      await api(`/attendance/${kind}`, { method: 'POST', body: { ...pos, photo, reason: data.today.needsReason ? reason : undefined, lateReason: lateReason.trim() || undefined } });
      setReason(''); setLateReason('');
      setMsg({ ok: true, text: kind === 'check-in' ? 'Checked in' : 'Checked out' });
      window.dispatchEvent(new Event('attendance:changed')); // start / stop location tracking now
      reload();
    } catch (e) { setMsg({ text: e.message }); }
    setBusy(false);
  };
  const t = data.today;
  const [away, setAway] = useState(false);

  // Position tracking runs app-wide (LocationGuard in the Shell); show what it finds here.
  useEffect(() => {
    const onPing = (e) => {
      const r = e.detail || {};
      setAway(!!r.warning);
      if (typeof r.open === 'boolean' && r.open !== t.checkedIn && !r.autoCheckedOut) reload();
      if (r.autoCheckedOut) {
        setMsg({ text: r.endOfDay ? 'Office hours are over, so you were checked out automatically.' : `You moved away from the office (${r.distance} m) so you were checked out automatically.` });
        reload();
      }
    };
    window.addEventListener('attendance:ping', onPing);
    return () => window.removeEventListener('attendance:ping', onPing);
  }, [reload, t.checkedIn]);
  return (
    <div className="card">
      {cam && <CameraCapture title={cam.kind === 'check-in' ? 'Photo for check-in' : 'Photo for check-out'} onDone={closeCam} onCancel={() => closeCam(null)} />}
      <div className="row between">
        <div>
          <h2>Today · {t.date}</h2>
          <div className="muted small">
            {t.location ? `Assigned location: ${t.location.name} (check in within ${t.location.radiusMeters} m)` : 'No location assigned: check-in works at any office location.'}
            {data.office && <div>Office hours: {label12(data.office.workStart)} to {label12(data.office.workEnd)} · everyone still checked in is checked out at {label12(data.office.workEnd)}</div>}
            {data.office && <div>Lunch break: {label12(data.office.lunchStart)} to {label12(data.office.lunchEnd)}</div>}
          </div>
        </div>
        <div className="row">
          {dayStatus(t)}
          {t.flags?.late && <Badge tone="warn">Late {minutesText(t.flags.lateMinutes)}</Badge>}
          {data.office?.lunchNow && <Badge>Lunch time</Badge>}
        </div>
      </div>
      {t.needsReason && !t.checkedIn && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          <b>You left the office{t.leftAt ? ' at ' + fmtTime(t.leftAt) : ''}.</b> Enter a reason to check in again.
          <textarea rows={2} style={{ marginTop: 8 }} placeholder="Reason (e.g. client visit, lunch, personal work)" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {t.lateMinutes > 0 && !t.checkedIn && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          <b>You are {minutesText(t.lateMinutes)} late.</b> Enter the reason to check in.
          <textarea rows={2} style={{ marginTop: 8 }} placeholder="Reason for being late (e.g. traffic, doctor visit, client call)" value={lateReason} onChange={(e) => setLateReason(e.target.value)} maxLength={300} />
        </div>
      )}
      <div className="att-actions">
        <button className="btn primary big" disabled={busy || t.checkedIn || (t.needsReason && reason.trim().length < 3) || (t.lateMinutes > 0 && lateReason.trim().length < 3)} onClick={() => act('check-in')}>{busy && !t.checkedIn ? 'Please wait…' : 'Check in'}</button>
        <button className="btn big" disabled={busy || !t.checkedIn} onClick={() => act('check-out')}>{busy && t.checkedIn ? 'Please wait…' : 'Check out'}</button>
      </div>
      {t.tasksPending > 0 && t.checkedIn && <div className="alert warn" style={{ marginTop: 12 }}>Add your update on {t.tasksPending === 1 ? 'your task' : `your ${t.tasksPending} tasks`} before checking out. <Link href="/tasks">Open Tasks</Link></div>}
      {away && t.checkedIn && <div className="alert warn" style={{ marginTop: 12 }}>You appear to be leaving the office. Stay within range or you will be checked out.</div>}
      {msg && <div className={`alert ${msg.ok ? 'ok' : ''}`} style={{ marginTop: 12 }}>{msg.text}</div>}
      {t.record?.sessions?.length > 0 && (
        <div className="scroll" style={{ marginTop: 10 }}><table>
          <thead><tr><th>In</th><th>Out</th><th>Geofence</th></tr></thead>
          <tbody>{t.record.sessions.map((s) => (
            <tr key={s._id}><td>{fmtTime(s.checkIn)}</td><td>{fmtTime(s.checkOut)}</td>
              <td>{s.inGeo?.verified === true ? `Inside (${s.inGeo.distance} m)` : s.inGeo?.verified === false ? 'Outside' : 'Not checked'}</td></tr>
          ))}</tbody></table></div>
      )}
      <div className="muted small" style={{ marginTop: 8 }}>Hours today: {t.hours}</div>
    </div>
  );
}

function TodayTasks() {
  const [d, setD] = useState(null);
  const load = useCallback(() => api('/tasks?mine=1').then(setD).catch(() => {}), []);
  useLive(load, 30000);
  if (!d || !d.tasks.length) return null;
  const score = d.tasks.reduce((a, t) => a + t.score, 0);
  return (
    <div className="card">
      <div className="row between"><h2>Today&apos;s tasks</h2><Link className="small" href="/tasks">View all</Link></div>
      {d.tasks.map((t) => (
        <div key={t._id} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.title}</span><Badge tone={taskTone(t)}>{t.label}</Badge>
        </div>
      ))}
      <div className="muted small" style={{ marginTop: 6 }}>Score today: {score}/{d.tasks.length}</div>
    </div>
  );
}

function Completion({ c }) {
  if (c.percent === 100) return null;
  return (
    <div className="card">
      <div className="row between"><h2>Profile completion</h2><b>{c.percent}%</b></div>
      <div className="bar"><i style={{ width: `${c.percent}%` }} /></div>
      <p className="muted small" style={{ marginBottom: 6 }}>Missing: {c.missing.join(', ')}</p>
      <Link href="/profile">Submit missing information</Link>
    </div>
  );
}

function Checklist({ items }) {
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <div className="card">
      <div className="row between"><h2>Getting started</h2><span className="muted small">{done} of {items.length} done</span></div>
      <div className="bar" style={{ marginBottom: 8 }}><i style={{ width: `${(done / items.length) * 100}%` }} /></div>
      {items.map((i) => (
        <div className="check" key={i.key}>
          <span className={`tick ${i.done ? 'done' : ''}`}>{i.done ? '✓' : ''}</span>
          <span style={{ flex: 1 }} className={i.done ? 'muted' : ''}>{i.label}</span>
          {!i.done && i.href && <Link href={i.href}>Set up →</Link>}
        </div>
      ))}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const ROLE_NAME = { ADMIN: 'Admin', COO: 'Chief Operating Officer', MANAGER: 'Manager', HR: 'HR', EMPLOYEE: 'Employee' };
const TYPE = { PROFILE_CHANGE: 'Profile change', ATTENDANCE_CORRECTION: 'Attendance correction' };
const initials = (n = '?') => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function Stat({ label, value, href, tone }) {
  const inner = <><span className="muted">{label}</span><b style={tone ? { color: `var(--${tone})` } : undefined}>{value}</b></>;
  return href ? <Link className="stat" href={href}>{inner}</Link> : <div className="stat">{inner}</div>;
}

function Person({ name, sub, right, photo }) {
  return (
    <div className="li">
      {photo ? <img className="thumb round" src={photo} alt="" /> : <span className="avatar sm">{initials(name)}</span>}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="li-name">{name}</div>
        <div className="muted small">{sub}</div>
      </div>
      <div className="row li-tags">{right}</div>
    </div>
  );
}

function Overview({ me, d }) {
  const o = d.overview, c = o.counts;
  const admin = me.role === 'ADMIN';
  const attention = [
    o.attention.noManager > 0 && admin && { text: `${o.attention.noManager} employee(s) have no manager assigned`, href: '/users?role=EMPLOYEE' },
    o.attention.incompleteProfiles > 0 && { text: `${o.attention.incompleteProfiles} profile(s) are incomplete`, href: '/users' },
    o.attention.lateToday > 0 && { text: `${o.attention.lateToday} ${o.attention.lateToday === 1 ? 'person' : 'people'} checked in late today`, href: '/attendance' },
    o.attention.outsideToday > 0 && { text: `${o.attention.outsideToday} check-in(s) today were outside the geofence`, href: '/attendance' },
    o.attention.autoCheckoutToday > 0 && { text: `${o.attention.autoCheckoutToday} auto check-out(s) today (left the office)`, href: '/attendance' },
    o.attention.silentNow > 0 && { text: `${o.attention.silentNow} checked-in ${o.attention.silentNow === 1 ? 'phone is' : 'phones are'} not sending location (app closed or stopped by the phone)`, href: '/attendance' },
  ].filter(Boolean);
  const maxDept = Math.max(1, ...o.departments.map((x) => x.n));

  return (
    <>
      <div className="grid" style={{ marginBottom: 16 }}>
        {(admin || me.role === 'COO') ? (
          <>
            <Stat label="COO" value={c.coo} href="/users?role=COO" />
            <Stat label="Managers" value={c.managers} href="/users?role=MANAGER" />
            <Stat label="HR users" value={c.hr} href="/users?role=HR" />
            <Stat label="Employees" value={c.employees} href="/users?role=EMPLOYEE" />
          </>
        ) : <Stat label="People I oversee" value={c.team} href="/users" />}
        <Stat label="Present today" value={c.presentToday} tone="ok" href="/attendance" />
        <Stat label="In office now" value={c.checkedInNow} />
        <Stat label={d.today.closed ? 'Absent today' : 'Not in yet'} value={c.absentToday} tone={c.absentToday ? (d.today.closed ? 'bad' : 'warn') : undefined} />
        <Stat label={admin ? 'Pending requests' : 'Waiting for me'} value={c.pendingRequests} tone={c.pendingRequests ? 'warn' : undefined} href="/requests" />
      </div>

      <div className="cols">
        <div className="card">
          <div className="row between"><h2>Today's attendance</h2><Link className="small" href="/attendance">View all</Link></div>
          {o.present.length === 0 ? <p className="muted">Nobody has checked in yet today.</p> : o.present.map((p) => (
            <Person key={p.id} name={p.name} photo={p.photo} sub={`${p.employeeId || ''} · in ${fmtTime(p.checkIn)}${p.checkOut ? ` · out ${fmtTime(p.checkOut)}` : ''}`}
              right={<>{p.open ? <Badge tone="ok">In office</Badge> : <Badge>Checked out</Badge>}{p.open && p.silentMinutes > 0 && !d.office?.lunchNow && <Badge tone="bad">No location {minutesText(p.silentMinutes)}</Badge>}{p.flags?.late && <Badge tone="warn">Late {minutesText(p.flags.lateMinutes)}</Badge>}{p.outside && <Badge tone="bad">Outside</Badge>}{p.auto && <Badge tone="warn">Auto out</Badge>}</>} />
          ))}
        </div>
        <div className="card">
          <div className="row between"><h2>{d.today.closed ? 'Absent today' : 'Not checked in yet'}</h2><span className="muted small">{c.absentToday} total</span></div>
          {o.absent.length === 0 ? <p className="muted">{c.team ? 'Everyone has checked in.' : 'No one to show yet.'}</p> : o.absent.map((p) => (
            <Person key={p.id} name={p.name} sub={`${p.employeeId || ''}${p.department ? ` · ${p.department}` : ''}`}
              right={<>{d.today.closed && <Badge tone="bad">Absent</Badge>}<Link className="small" href={`/users/${p.id}`}>Open</Link></>} />
          ))}
          {c.absentToday > o.absent.length && <p className="muted small" style={{ marginBottom: 0 }}>+ {c.absentToday - o.absent.length} more</p>}
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <div className="row between"><h2>Needs your attention</h2></div>
          {o.pending.length === 0 && attention.length === 0 && <p className="muted">All clear. Nothing needs action.</p>}
          {o.pending.map((r) => (
            <div className="li" key={r.id}>
              <span className="avatar sm">{initials(r.subject)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="li-name">{TYPE[r.type]} · {r.subject}</div>
                <div className="muted small">{r.requester} ({r.requesterRole}) · “{r.reason}”</div>
              </div>
              <Link className="btn sm" href="/requests">Review</Link>
            </div>
          ))}
          {attention.map((a, i) => <div className="li" key={i}><span className="dot warn" /><Link href={a.href} style={{ flex: 1 }}>{a.text}</Link></div>)}
        </div>
        <div className="card">
          <h2>People by department</h2>
          {o.departments.length === 0 ? <p className="muted">No people added yet.</p> : o.departments.map((x) => (
            <div key={x.name} style={{ marginBottom: 10 }}>
              <div className="row between small"><span>{x.name}</span><b>{x.n}</b></div>
              <div className="bar"><i style={{ width: `${(x.n / maxDept) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      {admin && (
        <div className="card">
          <div className="row between"><h2>Recent activity</h2><Link className="small" href="/admin/audit-logs">Audit logs</Link></div>
          {o.activity.length === 0 ? <p className="muted">No activity yet.</p> : o.activity.map((a, i) => (
            <div className="li" key={i}>
              <span className="dot" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="li-name">{a.action.replace(/_/g, ' ').toLowerCase()} {a.override && <Badge tone="warn">override</Badge>}</div>
                <div className="muted small">{a.actor || 'system'}{a.subject ? ` → ${a.subject}` : ''}</div>
              </div>
              <span className="muted small">{fmtDateTime(a.at)}</span>
            </div>
          ))}
        </div>
      )}

    </>
  );
}

function QuickActions({ me }) {
  const acts = [];
  if (me.role === 'ADMIN') acts.push(['/users/new?role=EMPLOYEE', '+ Employee'], ['/users/new?role=HR', '+ HR'], ['/users/new?role=MANAGER', '+ Manager'], ['/users/new?role=COO', '+ COO'], ['/users/import', 'Import CSV']);
  if (me.role === 'HR') acts.push(['/users/new?role=EMPLOYEE', '+ Employee']);
  acts.push(['/attendance', 'Attendance'], ['/requests', 'Requests']);
  return <div className="row">{acts.map(([h, l]) => <Link key={h} className={`btn sm ${l.startsWith('+') ? 'primary' : ''}`} href={h}>{l}</Link>)}</div>;
}

function Recent({ items }) {
  if (!items?.length) return null;
  return (
    <div className="card scroll">
      <div className="row between"><h2>My last 7 days</h2><Link className="small" href="/profile">Full history</Link></div>
      <div className="daylist">
        {items.map((r) => {
          const d = new Date(`${r.date}T00:00:00`);
          return (
            <div key={r.date} className="dayrow">
              <div className="daybox"><b>{r.date.slice(8)}</b><span>{d.toLocaleDateString('en-IN', { weekday: 'short' })}</span></div>
              <div className="dayrow-main">
                <div className="dayrow-times">{fmtTime(r.in)} <span className="muted">→</span> {r.out ? fmtTime(r.out) : 'in office'}</div>
                <div className="muted small">{d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}</div>
              </div>
              <div className="dayrow-end">
                <b>{r.hours ? `${r.hours} h` : '—'}</b>
                <Badge tone={r.status === 'VOIDED' ? 'bad' : 'ok'}>{r.status === 'VOIDED' ? 'Voided' : 'Present'}</Badge>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const me = useMe();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('/dashboard').then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useLive(load, 15000);
  if (err && !d) return <div className="alert">{err}</div>;
  if (!d) return <Skeleton />;
  const isAdmin = me.role === 'ADMIN';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const quote = quoteOfTheDay(d.today.date);

  return (
    <>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div>
          <h1>{greeting()}, {me.name.split(' ')[0]} 👋</h1>
          <div className="muted">{ROLE_NAME[me.role]} · {today}</div>
        </div>
        {me.role !== 'EMPLOYEE' && <QuickActions me={me} />}
      </div>
      <figure className="quote">
        <blockquote>{quote.text}</blockquote>
        <figcaption>{quote.author}</figcaption>
      </figure>
      {!isAdmin && <AttendanceCard data={d} reload={load} />}
      {!isAdmin && <TodayTasks />}
      {d.overview && <Overview me={me} d={d} />}
      {isAdmin && <Checklist items={d.checklist} />}
      {!isAdmin && <Completion c={d.completion} />}
      {!isAdmin && <Recent items={d.recent} />}
    </>
  );
}
