import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { get, patch } from './api';
import { playSiren } from './siren';
import { syncPush } from './push';
import { toast } from '../components/ui';
import { ALERT_TYPES, REPORT_TYPES, THREATS } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { Alert, AppMeta, LiveEvent, LiveState, NotifyPrefs, PublicUser, Report, ViewPrefs } from '@shared/types';

export const DEFAULT_NOTIFY: NotifyPrefs = {
  enabled: true,
  official: true,
  userReports: true,
  allClear: true,
  types: [...new Set([...ALERT_TYPES, ...REPORT_TYPES])],
};
export const DEFAULT_VIEW: ViewPrefs = { hideUserReports: false, showOfficial: true, sound: true };

export interface Prefs {
  regionId: string | null;
  extraRegions: string[];
  notify: NotifyPrefs;
  view: ViewPrefs;
  onboarded: boolean;
}

export interface PrefsPatch {
  regionId?: string | null;
  extraRegions?: string[];
  notify?: Partial<NotifyPrefs>;
  view?: Partial<ViewPrefs>;
  onboarded?: boolean;
}

const LS_KEY = 'radar.prefs.v1';

function loadLocal(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Partial<Prefs>;
    return {
      regionId: p.regionId ?? null,
      extraRegions: p.extraRegions ?? [],
      notify: { ...DEFAULT_NOTIFY, ...(p.notify || {}) },
      view: { ...DEFAULT_VIEW, ...(p.view || {}) },
      onboarded: !!p.onboarded,
    };
  } catch {
    return { regionId: null, extraRegions: [], notify: DEFAULT_NOTIFY, view: DEFAULT_VIEW, onboarded: false };
  }
}

interface Ctx {
  meta: AppMeta | null;
  user: PublicUser | null;
  setUser: (u: PublicUser | null) => void;
  refreshUser: () => Promise<void>;
  prefs: Prefs;
  setPrefs: (p: PrefsPatch) => Promise<void>;
  myRegions: string[];
  alerts: Alert[];
  reports: Report[];
  connected: boolean;
  /** Server-aligned clock, ticks every second. */
  now: number;
}

const AppContext = createContext<Ctx | null>(null);

export function useApp() {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(loadLocal);
  const [alerts, setAlerts] = useState<Map<number, Alert>>(new Map());
  const [reports, setReports] = useState<Map<number, Report>>(new Map());
  const [connected, setConnected] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(t);
  }, [offset]);

  const persistLocal = (p: Prefs) => localStorage.setItem(LS_KEY, JSON.stringify(p));

  const applyUser = useCallback((u: PublicUser | null) => {
    setUserState(u);
    if (!u) return;
    setPrefsState((cur) => {
      const next: Prefs = {
        regionId: u.regionId ?? cur.regionId,
        extraRegions: u.regionId ? u.extraRegions : cur.extraRegions,
        notify: u.settings.notify,
        view: u.settings.view,
        onboarded: cur.onboarded || !!u.regionId,
      };
      persistLocal(next);
      return next;
    });
    // First login after anonymous onboarding: carry the chosen region into the account.
    const local = prefsRef.current;
    if (!u.regionId && local.regionId) {
      void patch<{ user: PublicUser }>('/me', {
        regionId: local.regionId,
        extraRegions: local.extraRegions,
        settings: { notify: local.notify, view: local.view },
      }).then((r) => setUserState(r.user));
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const r = await get<{ user: PublicUser | null }>('/auth/me');
    applyUser(r.user);
  }, [applyUser]);

  const loadState = useCallback(async () => {
    const s = await get<LiveState>('/state');
    setOffset(s.serverTime - Date.now());
    setAlerts(new Map(s.alerts.map((a) => [a.id, a])));
    setReports(new Map(s.reports.map((r) => [r.id, r])));
  }, []);

  useEffect(() => {
    void get<AppMeta>('/meta').then(setMeta).catch(() => undefined);
    void refreshUser().catch(() => undefined);
    void loadState().catch(() => undefined);
  }, [refreshUser, loadState]);

  const myRegions = useMemo(
    () => [prefs.regionId, ...prefs.extraRegions].filter((x): x is string => !!x),
    [prefs.regionId, prefs.extraRegions],
  );
  const myRegionsRef = useRef(myRegions);
  myRegionsRef.current = myRegions;

  // Live updates over SSE.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', () => {
      setConnected(true);
      void loadState().catch(() => undefined);
    });
    es.onerror = () => setConnected(false);
    es.addEventListener('live', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as LiveEvent;
      const p = prefsRef.current;
      const mine = (id: string | null | undefined) => !!id && myRegionsRef.current.includes(id);
      switch (ev.type) {
        case 'alert':
          setAlerts((m) => {
            const isNew = !m.has(ev.alert.id);
            if (isNew && mine(ev.alert.regionId) && p.view.showOfficial && p.notify.enabled && p.notify.official) {
              if (p.view.sound) playSiren('alert');
              toast(
                <span>
                  <b>{THREATS[ev.alert.type].long}</b> — {regionName(ev.alert.regionId)}. Пройдите в укрытие.
                </span>,
                'alert',
              );
            }
            return new Map(m).set(ev.alert.id, ev.alert);
          });
          break;
        case 'alert_end':
          setAlerts((m) => {
            if (!m.has(ev.alert.id)) return m;
            const n = new Map(m);
            n.delete(ev.alert.id);
            if (mine(ev.alert.regionId) && p.notify.enabled && p.notify.allClear && ![...n.values()].some((a) => a.regionId === ev.alert.regionId)) {
              if (p.view.sound) playSiren('allclear');
              toast(<span><b>Отбой тревоги</b> — {regionName(ev.alert.regionId)}</span>, 'ok');
            }
            return n;
          });
          break;
        case 'report':
          setReports((m) => {
            const isNew = !m.has(ev.report.id);
            if (isNew && mine(ev.report.regionId) && !p.view.hideUserReports && p.notify.enabled && p.notify.userReports) {
              if (p.view.sound) playSiren('report');
              toast(
                <span>
                  <b>{THREATS[ev.report.type].label}</b>: метка {ev.report.isPlus ? 'Радар+' : 'пользователя'} — {regionName(ev.report.regionId)}
                </span>,
                'info',
              );
            }
            return new Map(m).set(ev.report.id, ev.report);
          });
          break;
        case 'report_remove':
          setReports((m) => {
            if (!m.has(ev.id)) return m;
            const n = new Map(m);
            n.delete(ev.id);
            return n;
          });
          break;
        case 'forecast':
          window.dispatchEvent(new CustomEvent('radar:forecast', { detail: ev }));
          break;
        case 'front':
          window.dispatchEvent(new CustomEvent('radar:front', { detail: ev }));
          break;
      }
    });
    return () => es.close();
  }, [loadState]);

  // Messages from the service worker (push received while the app is open).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; kind?: string };
      if (d?.type === 'push' && prefsRef.current.view.sound) playSiren(d.kind === 'allclear' ? 'allclear' : d.kind === 'report' ? 'report' : 'alert');
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  const setPrefs = useCallback(
    async (p: PrefsPatch) => {
      const cur = prefsRef.current;
      const next: Prefs = {
        regionId: p.regionId !== undefined ? p.regionId : cur.regionId,
        extraRegions: p.extraRegions ?? cur.extraRegions,
        notify: { ...cur.notify, ...(p.notify || {}) },
        view: { ...cur.view, ...(p.view || {}) },
        onboarded: p.onboarded ?? cur.onboarded,
      };
      next.extraRegions = next.extraRegions.filter((r) => r !== next.regionId);
      setPrefsState(next);
      persistLocal(next);
      if (user) {
        const r = await patch<{ user: PublicUser }>('/me', {
          regionId: next.regionId,
          extraRegions: next.extraRegions,
          settings: { notify: next.notify, view: next.view },
        });
        setUserState(r.user);
      }
      if (p.regionId !== undefined || p.extraRegions || p.notify) {
        await syncPush([next.regionId, ...next.extraRegions].filter(Boolean) as string[], next.notify).catch(() => undefined);
      }
    },
    [user],
  );

  const value = useMemo<Ctx>(
    () => ({
      meta,
      user,
      setUser: applyUser,
      refreshUser,
      prefs,
      setPrefs,
      myRegions,
      alerts: [...alerts.values()].sort((a, b) => b.startedAt - a.startedAt),
      reports: [...reports.values()].filter((r) => r.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt),
      connected,
      now,
    }),
    [meta, user, applyUser, refreshUser, prefs, setPrefs, myRegions, alerts, reports, connected, now],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
