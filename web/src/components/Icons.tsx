import { useId, type ReactNode } from 'react';
import { THREATS, type ThreatType } from '@shared/constants';
import { cx } from './ui';

/** Filled glyphs on a 24×24 grid, used both in UI and inside the SVG map. */
export const THREAT_PATHS: Record<ThreatType, string> = {
  // Delta-wing loitering drone, top view, nose up
  uav: 'M12 2.4 13.3 8.9 21.6 16.2v1.9l-8.2-2.3-.4 3.7 2 1.5v.9L12 21l-3.4.9v-.9l2-1.5-.4-3.7-8.2 2.3v-1.9l8.3-7.3Z',
  // Missile, diagonal, with fins and exhaust
  missile:
    'M19.8 2.6c-2.2-.2-4.3.6-5.8 2.1L7.6 11.1 5 10.6l-1.6 1.6 3 1.2-.6.6 3.6 3.6.6-.6 1.2 3 1.6-1.6-.5-2.6 6.4-6.4c1.5-1.5 2.3-3.6 2.1-5.8ZM5.2 15.4l-2.4 4.1-.6 2.3 2.3-.6 4.1-2.4Z',
  // Jet aircraft, top view
  aviation: 'M12 2c.7 0 1.1 1.4 1.1 3.6v2.9l8.4 5.1v1.9l-8.4-2.4v4.4l2.3 1.7v1.4L12 19.6l-3.4 1v-1.4l2.3-1.7v-4.4l-8.4 2.4v-1.9l8.4-5.1V5.6C10.9 3.4 11.3 2 12 2Z',
  explosion: 'm12 1.8 1.9 6.3 6-3-3.2 5.6 5.5 2.1-5.8 1.6 2 6.1-5.2-3.7L12 22.4l-1.2-5.6-5.2 3.7 2-6.1-5.8-1.6 5.5-2.1-3.2-5.6 6 3Z',
  other: 'M12 2.5 22.5 20.5h-21Zm-1.1 6.3v6.4h2.2V8.8Zm0 8.2v2.2h2.2V17Z',
  // Siren
  air: 'M6.5 18.5V13a5.5 5.5 0 0 1 11 0v5.5Zm-2 1h15v2.6h-15ZM11 2h2v3h-2ZM3.4 5.3l1.4-1.4 2.2 2.2-1.4 1.4Zm16.2-1.4 1.4 1.4-2.2 2.2-1.4-1.4ZM1 12h3v2H1Zm19 0h3v2h-3Z',
};

export function ThreatIcon({ type, className, color }: { type: ThreatType; className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className || 'size-5'} fill={color || 'currentColor'} aria-hidden>
      <path d={THREAT_PATHS[type]} />
    </svg>
  );
}

/** Round coloured threat badge. */
export function ThreatBadge({ type, size = 36, className }: { type: ThreatType; size?: number; className?: string }) {
  const c = THREATS[type].color;
  return (
    <span
      className={cx('inline-grid shrink-0 place-items-center rounded-full', className)}
      style={{ width: size, height: size, background: `radial-gradient(circle at 30% 30%, ${c}55, ${c}22)`, boxShadow: `inset 0 0 0 1px ${c}66, 0 0 18px -6px ${c}` }}
    >
      <ThreatIcon type={type} color={c} className="size-[58%]" />
    </span>
  );
}

const ICONS: Record<string, ReactNode> = {
  map: <><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5V4l-6 2.5Z" /><path d="M9 4v13M15 6.5v13" /></>,
  front: <><path d="M3 17c3-1 4-5 7-6s4 3 7 1 3-6 4-7" /><path d="m15 15 2 2 3-3M6 7l2 2 3-3" /></>,
  ai: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><path d="M12 7.5 13.6 10.4 16.5 12l-2.9 1.6L12 16.5l-1.6-2.9L7.5 12l2.9-1.6Z" /><path d="m18.4 5.6-1.5 1.5M7.1 16.9l-1.5 1.5M18.4 18.4l-1.5-1.5M7.1 7.1 5.6 5.6" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4Z" /><path d="M10 21h4" /></>,
  bellOff: <><path d="M6 16V11a6 6 0 0 1 9.4-4.9M18 11v5l2 2H8" /><path d="M10 21h4M3 3l18 18" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  locate: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  shield: <path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>,
  home: <><path d="m3 11 9-7 9 7" /><path d="M5 10v10h14V10" /></>,
  eyeOff: <><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6M6.4 7.5C4.5 8.9 3.2 10.8 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  tower: <><path d="M12 10v11M8 21h8M9.5 10h5l-2.5-3Z" /><path d="M6.3 4.7a8 8 0 0 0 0 11.3M17.7 4.7a8 8 0 0 1 0 11.3M8.8 7.2a4.5 4.5 0 0 0 0 6.3M15.2 7.2a4.5 4.5 0 0 1 0 6.3" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.8 3 2.6 3.5 5.2" /></>,
  crown: <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5Z" />,
  install: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
  share: <><path d="M12 3v12M8 7l4-4 4 4" /><path d="M6 11H5v10h14V11h-1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3Z" /></>,
  logout: <><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5Z" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  warning: <><path d="M12 3 22 20H2Z" /><path d="M12 10v4M12 17v.5" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  sound: <><path d="M4 9.5h4l5-4v13l-5-4H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>,
  mute: <><path d="M4 9.5h4l5-4v13l-5-4H4Z" /><path d="m17 9.5 5 5M22 9.5l-5 5" /></>,
  arrow: <path d="M12 20V4M6 10l6-6 6 6" />,
  admin: <><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6Z" /><path d="m9 12 2 2 4-4" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7Z" />,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, className, strokeWidth = 1.8 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className || 'size-5'}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

/** Animated radar mark. */
export function RadarLogo({ className, animated = true }: { className?: string; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 64 64" className={className || 'size-10'} aria-hidden>
      <defs>
        <radialGradient id={`bg${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0b2a33" />
          <stop offset="100%" stopColor="#050a10" />
        </radialGradient>
        <linearGradient id={`sw${id}`} gradientUnits="userSpaceOnUse" x1="32" y1="8" x2="6" y2="26">
          <stop offset="0%" stopColor="#2dffb0" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#2dffb0" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#bg${id})`} stroke="#34e3ff" strokeOpacity="0.55" strokeWidth="1.5" />
      <g fill="none" stroke="#34e3ff" strokeOpacity="0.22" strokeWidth="1">
        <circle cx="32" cy="32" r="20" />
        <circle cx="32" cy="32" r="10" />
        <path d="M32 3v58M3 32h58" />
      </g>
      <g className={animated ? 'animate-sweep' : undefined} style={{ transformOrigin: '32px 32px' }}>
        <path d="M32 32 32 2A30 30 0 0 0 6 17Z" fill={`url(#sw${id})`} />
        <path d="M32 32V2" stroke="#2dffb0" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <circle cx="44" cy="21" r="2.6" fill="#ff3b4f" className={animated ? 'animate-pulse-soft' : undefined} />
      <circle cx="21" cy="40" r="1.8" fill="#ffb020" />
      <circle cx="32" cy="32" r="2" fill="#2dffb0" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cx('flex items-center gap-2.5', className)}>
      <RadarLogo className="size-9" />
      <div className="leading-none">
        <div className="text-lg font-extrabold tracking-[0.18em]">РАДАР</div>
        <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">по всей России</div>
      </div>
    </div>
  );
}
