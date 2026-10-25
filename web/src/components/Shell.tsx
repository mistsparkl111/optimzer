import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon, Wordmark, type IconName } from './Icons';
import { cx, PlusBadge } from './ui';
import { useApp } from '../lib/store';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Карта', icon: 'map' },
  { to: '/front', label: 'Фронт', icon: 'front' },
  { to: '/ai', label: 'ИИ-режим', icon: 'ai' },
  { to: '/plus', label: 'Радар+', icon: 'crown' },
  { to: '/profile', label: 'Профиль', icon: 'user' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, connected, alerts } = useApp();
  const loc = useLocation();
  return (
    <div className="flex h-dvh flex-col">
      {/* Desktop top bar */}
      <header className="hidden h-16 shrink-0 items-center justify-between gap-6 border-b border-line bg-panel/70 px-5 backdrop-blur-xl lg:flex">
        <NavLink to="/">
          <Wordmark />
        </NavLink>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition',
                  isActive ? 'bg-panel-3 text-text shadow-[inset_0_0_0_1px_rgba(52,227,255,0.25)]' : 'text-muted hover:text-text',
                  n.to === '/plus' && 'text-plus',
                )
              }
            >
              <Icon name={n.icon} className="size-[18px]" />
              {n.label}
            </NavLink>
          ))}
          {user && user.role !== 'user' && (
            <NavLink
              to="/admin"
              className={({ isActive }) => cx('flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold', isActive ? 'bg-panel-3' : 'text-muted hover:text-text')}
            >
              <Icon name="admin" className="size-[18px]" />
              Админ
            </NavLink>
          )}
        </nav>
        <div className="flex items-center gap-3 text-xs">
          <LiveDot connected={connected} />
          <span className="font-mono text-muted">
            {alerts.length ? <span className="text-alert">{alerts.length} тревог</span> : 'тревог нет'}
          </span>
          {user?.isPlus && <PlusBadge />}
        </div>
      </header>

      <main className="relative min-h-0 flex-1">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="safe-bottom shrink-0 border-t border-line bg-panel/90 backdrop-blur-xl lg:hidden">
        <div className="grid grid-cols-5">
          {NAV.map((n) => {
            const active = n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to);
            return (
              <NavLink key={n.to} to={n.to} className="relative flex flex-col items-center gap-1 py-2.5 text-[10.5px] font-semibold">
                {active && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-accent shadow-[0_0_12px_rgba(52,227,255,0.9)]" />}
                <Icon name={n.icon} className={cx('size-[22px]', active ? (n.to === '/plus' ? 'text-plus' : 'text-accent') : 'text-dim')} />
                <span className={active ? 'text-text' : 'text-muted'}>{n.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 font-semibold" title={connected ? 'Онлайн: обновления в реальном времени' : 'Переподключение…'}>
      <span className="relative flex size-2.5">
        {connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-radar opacity-60" />}
        <span className={cx('relative inline-flex size-2.5 rounded-full', connected ? 'bg-radar' : 'bg-dim')} />
      </span>
      <span className={connected ? 'text-radar' : 'text-muted'}>{connected ? 'LIVE' : 'OFFLINE'}</span>
    </span>
  );
}
