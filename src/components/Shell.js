'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/client';
import Icon from '@/components/Icon';
import Logo from '@/components/Logo';
import LocationGuard from '@/components/LocationGuard';
import Avatar from '@/components/Avatar';
import Notifications from '@/components/Notifications';

const Ctx = createContext(null);
export const useMe = () => useContext(Ctx);

const NAV = [
  { href: '/', label: 'Dashboard', icon: 'home' },
  { href: '/attendance', label: 'Attendance', icon: 'clock' },
  { href: '/tasks', label: 'Tasks', icon: 'tasks' },
  { href: '/requests', label: 'Requests', icon: 'inbox' },
  { href: '/users', label: 'People', icon: 'users', roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] },
  { href: '/departments', label: 'Departments', icon: 'building', roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] },
  { href: '/locations', label: 'Locations', icon: 'pin', roles: ['ADMIN', 'COO', 'MANAGER', 'HR'] },
  { href: '/crm', label: 'CRM', icon: 'chat', roles: ['ADMIN', 'COO'] },
  { href: '/users/import', label: 'Import', icon: 'upload', roles: ['ADMIN'] },
  { href: '/admin/audit-logs', label: 'Audit logs', icon: 'shield', roles: ['ADMIN'] },
  { href: '/settings', label: 'Settings', icon: 'cog', roles: ['ADMIN'] },
  { href: '/profile', label: 'My profile', icon: 'user' },
];

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Starting">
      <Logo size={112} className="pulse" />
      <div className="splash-name">Shine Attendance</div>
      <div className="splash-bar"><i /></div>
    </div>
  );
}

export default function Shell({ children }) {
  const [me, setMe] = useState(null);
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    api('/auth/me').then((d) => {
      if (d.user.mustChangePassword) router.replace('/change-password');
      else setMe(d.user);
    }).catch((e) => { if (e.status !== 401) window.location.href = '/login'; });
  }, [router]);
  useEffect(() => setOpen(false), [path]);
  // One bell only (it polls): in the top bar on phones, in the sidebar on wide screens.
  const [phone, setPhone] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)');
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // On phones tables turn into stacked cards: copy each column header onto its cells as a label.
  useEffect(() => {
    if (!me) return;
    const root = document.querySelector('.main');
    if (!root) return;
    const label = () => root.querySelectorAll('table').forEach((t) => {
      const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
      if (!heads.length) return;
      t.classList.add('stack');
      t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (td.dataset.label !== heads[i]) td.dataset.label = heads[i] || ''; }));
    });
    label();
    const mo = new MutationObserver(label);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [me, path]);

  if (!me) return <Splash />;
  const items = NAV.filter((n) => !n.roles || n.roles.includes(me.role));
  const active = items.filter((n) => (n.href === '/' ? path === '/' : path === n.href || path.startsWith(n.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); router.replace('/login'); };
  const primary = me.role === 'EMPLOYEE'
    ? ['/', '/attendance', '/tasks', '/requests', '/profile']
    : ['/', '/attendance', '/tasks', '/users'];
  const bottom = items.filter((n) => primary.includes(n.href));

  return (
    <Ctx.Provider value={me}>
      <div className="top">
        <div className="brand" style={{ padding: 0 }}><Logo size={32} /> Shine Attendance</div>
        <span className="top-right"><span className="top-user">{me.name.split(' ')[0]}</span>{phone && <Notifications />}</span>
      </div>
      <div className="shell">
        <aside className={`side ${open ? 'open' : ''}`}>
          <div className="brand"><Logo size={32} /> Shine Attendance{!phone && <span className="side-bell"><Notifications /></span>}</div>
          <nav>
            {items.map((n) => (
              <Link key={n.href} href={n.href} className={`nav ${active === n.href ? 'on' : ''}`}><Icon name={n.icon} /> {n.label}</Link>
            ))}
          </nav>
          <div className="who">
            <Avatar user={me} size={36} />
            <div style={{ minWidth: 0 }}>
              <div className="name">{me.name}</div>
              <div className="muted small">{me.role}</div>
            </div>
            <button className="btn sm icon" onClick={logout} title="Sign out" aria-label="Sign out"><Icon name="logout" size={16} /></button>
          </div>
        </aside>
        <main className="main fade">{children}</main>
      </div>
      {me.role !== 'ADMIN' && <LocationGuard />}
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <nav className="bottom" aria-label="Main">
        {bottom.map((n) => (
          <Link key={n.href} href={n.href} className={`tab ${active === n.href ? 'on' : ''}`}><Icon name={n.icon} size={22} /><span>{n.label === 'My profile' ? 'Profile' : n.label}</span></Link>
        ))}
        {me.role !== 'EMPLOYEE' && (
          <button className={`tab ${open ? 'on' : ''}`} onClick={() => setOpen(!open)}><Icon name="menu" size={22} /><span>More</span></button>
        )}
      </nav>
    </Ctx.Provider>
  );
}
