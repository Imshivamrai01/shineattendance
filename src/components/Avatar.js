'use client';
import { useState } from 'react';

/** Profile picture, or the person's initials when there is none (or it fails to load). */
export default function Avatar({ user, size = 36, className = '' }) {
  const [broken, setBroken] = useState(false);
  const initials = (user?.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (user?.photoUrl && !broken) {
    return <img className={`avatar img ${className}`} style={style} src={user.photoUrl} alt="" onError={() => setBroken(true)} />;
  }
  return <span className={`avatar ${className}`} style={style} aria-hidden="true">{initials}</span>;
}
