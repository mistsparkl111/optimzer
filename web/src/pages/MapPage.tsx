import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { THREATS } from '@shared/constants';
import { REGION_BY_ID, regionName } from '@shared/regions';
import type { Alert } from '@shared/types';
import { get } from '../lib/api';
import { fmtDuration, fmtTime } from '../lib/format';
import { useApp } from '../lib/store';
import { RussiaMap, type RegionStyle } from '../components/RussiaMap';
import { RegionSheet, ReportRow } from '../components/RegionSheet';
import { ReportComposer } from '../components/ReportComposer';
import { RegionPickerModal } from '../components/RegionPicker';
import { LiveDot } from '../components/Shell';
import { Icon, RadarLogo, ThreatBadge, ThreatIcon } from '../components/Icons';
import { Button, cx, EmptyState, Toggle, useAsync } from '../components/ui';

export function MapPage() {
  const { alerts, reports, prefs, now, connected } = useApp();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);

  // Deep links from push notifications: /?region=BEL
  useEffect(() => {
    const r = params.get('region');
    if (r && REGION_BY_ID.has(r)) {
      setFocus(r);
      setSelected(r);
      params.delete('region');
      params.delete('report');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const visibleAlerts = prefs.view.showOfficial ? alerts : [];
  const visibleReports = prefs.view.hideUserReports ? [] : reports;
  const alertRegions = useMemo(() => new Set(visibleAlerts.map((a) => a.regionId)), [visibleAlerts]);
  const reportRegions = useMemo(() => new Set(visibleReports.map((r) => r.regionId)), [visibleReports]);
  const regionStyle = useMemo(
    () =>
      (id: string): RegionStyle | null =>
        !alertRegions.has(id) && reportRegions.has(id) ? { fill: 'url(#hatch)', opacity: 1 } : null,
    [alertRegions, reportRegions],
  );

  const focusRegion = (id: string) => {
    setFocus(null);
    requestAnimationFrame(() => setFocus(id));
    setSelected(id);
  };

  return (
    <div className="flex h-full flex-col lg:flex-row-reverse">
      <div className="relative h-[56dvh] shrink-0 border-b border-line lg:h-full lg:flex-1 lg:border-b-0">
        <RussiaMap
          className="h-full grid-bg"
          alerts={visibleAlerts}
          reports={visibleReports}
          regionStyle={regionStyle}
          homeRegions={prefs.regionId ? [prefs.regionId] : []}
          selectedRegion={selected}
          focusRegion={focus}
          initialRegion={prefs.regionId}
          onRegionClick={setSelected}
          onReportClick={(r) => r.regionId && setSelected(r.regionId)}
          now={now}
        >
          {/* Mobile header overlay */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-bg via-bg/70 to-transparent px-4 pb-8 pt-3 safe-top lg:hidden">
            <div className="flex items-center gap-2.5">
              <RadarLogo className="size-9" />
              <div className="leading-tight">
                <div className="text-[15px] font-extrabold">Радар по всей России</div>
                <div className="text-[11px] text-muted">тревоги во всех регионах</div>
              </div>
            </div>
            <div className="mt-1 text-[11px]">
              <LiveDot connected={connected} />
            </div>
          </div>
          <Legend />
          <div className="absolute bottom-4 right-3 lg:bottom-6 lg:right-6">
            <Button size="lg" onClick={() => setComposer(true)} className="rounded-full pl-4 pr-5 shadow-[0_8px_30px_-6px_rgba(52,227,255,0.7)]">
              <Icon name="plus" className="size-5" strokeWidth={2.6} /> Отметить
            </Button>
          </div>
        </RussiaMap>
      </div>

      <aside className="min-h-0 flex-1 overflow-y-auto lg:w-[400px] lg:flex-none lg:border-r lg:border-line">
        <Panel onFocus={focusRegion} />
      </aside>

      <RegionSheet regionId={selected} onClose={() => setSelected(null)} />
      <ReportComposer open={composer} onClose={() => setComposer(false)} />
    </div>
  );
}

function Legend() {
  const items = [
    { color: THREATS.air.color, label: 'Тревога' },
    { color: THREATS.uav.color, label: 'БПЛА' },
    { color: THREATS.missile.color, label: 'Ракеты' },
  ];
  return (
    <div className="absolute bottom-4 left-3 hidden gap-3 rounded-xl border border-line bg-panel/80 px-3 py-2 text-[11px] font-semibold text-muted backdrop-blur sm:flex lg:bottom-6 lg:left-6">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg className="size-3" viewBox="0 0 10 10">
          <rect width="10" height="10" fill="#ffb02022" />
          <path d="M0 10 10 0M-2 4 4 -2M6 12 12 6" stroke="#ffb020" strokeWidth="1.5" />
        </svg>
        Метки людей
      </span>
    </div>
  );
}

function Panel({ onFocus }: { onFocus: (id: string) => void }) {
  const { alerts, reports, prefs, setPrefs, now } = useApp();
  const [picker, setPicker] = useState(false);
  const feed = useAsync(() => get<{ alerts: Alert[] }>('/feed?hours=24'), []);
  useEffect(() => {
    const t = setInterval(feed.reload, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byRegion = useMemo(() => {
    const m = new Map<string, Alert[]>();
    for (const a of alerts) m.set(a.regionId, [...(m.get(a.regionId) || []), a]);
    return [...m.entries()].sort((a, b) => Math.min(...a[1].map((x) => x.startedAt)) - Math.min(...b[1].map((x) => x.startedAt)));
  }, [alerts]);
  const myAlerts = alerts.filter((a) => a.regionId === prefs.regionId);
  const visibleReports = prefs.view.hideUserReports ? [] : reports;
  const ended = (feed.data?.alerts || []).filter((a) => a.endedAt).slice(0, 15);

  return (
    <div className="space-y-4 p-4 lg:p-5">
      <div className="hidden lg:block">
        <h1 className="text-2xl font-extrabold leading-tight tracking-tight">
          Радар по всей <span className="text-accent">России</span>
        </h1>
        <p className="mt-1 text-sm text-muted">Воздушные тревоги во всех регионах, включая новые. Время — московское.</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Counter label="Регионов с тревогой" value={byRegion.length} color={byRegion.length ? '#ff3b4f' : undefined} />
        <Counter label="Меток людей" value={reports.length} color={reports.length ? '#ffb020' : undefined} />
        <Counter label="МСК" value={fmtTime(now)} />
      </div>

      {/* My region */}
      <button
        onClick={() => (prefs.regionId ? onFocus(prefs.regionId) : setPicker(true))}
        className={cx(
          'flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition',
          myAlerts.length ? 'border-alert/40 bg-alert/10 shadow-[0_0_40px_-12px_rgba(255,59,79,0.6)]' : 'border-line bg-panel-2/70 hover:border-line-2',
        )}
      >
        {myAlerts.length ? (
          <ThreatBadge type={myAlerts[0]!.type} size={44} className="animate-pulse-soft" />
        ) : (
          <span className="grid size-11 place-items-center rounded-full bg-ok/10 text-ok">
            <Icon name="shield" className="size-6" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted">Мой регион</div>
          <div className="truncate font-bold">{prefs.regionId ? regionName(prefs.regionId) : 'Не выбран — нажмите, чтобы выбрать'}</div>
          {prefs.regionId && (
            <div className={cx('text-sm', myAlerts.length ? 'font-semibold text-alert' : 'text-ok')}>
              {myAlerts.length
                ? `${THREATS[myAlerts[0]!.type].long} · ${fmtDuration(now - myAlerts[0]!.startedAt)}`
                : 'Спокойно — тревоги нет'}
            </div>
          )}
        </div>
        <Icon name="chevron" className="size-5 text-dim" />
      </button>

      {/* Filters */}
      <div className="rounded-2xl border border-line bg-panel-2/50 px-4 py-1">
        <Toggle
          checked={prefs.view.showOfficial}
          onChange={(v) => void setPrefs({ view: { showOfficial: v } })}
          label={
            <span className="flex items-center gap-2">
              <Icon name="tower" className="size-4 text-accent" /> Официальные источники
            </span>
          }
        />
        <Toggle
          checked={prefs.view.hideUserReports}
          onChange={(v) => void setPrefs({ view: { hideUserReports: v } })}
          label={
            <span className="flex items-center gap-2">
              <Icon name="eyeOff" className="size-4 text-uav" /> Скрыть от людей
            </span>
          }
        />
      </div>

      {/* Active alerts */}
      <section>
        <SectionTitle icon="bolt" title="Активные тревоги" count={byRegion.length} />
        {!prefs.view.showOfficial ? (
          <p className="px-1 text-sm text-muted">Официальные источники скрыты фильтром.</p>
        ) : byRegion.length ? (
          <div className="space-y-1.5">
            {byRegion.map(([regionId, list]) => (
              <button
                key={regionId}
                onClick={() => onFocus(regionId)}
                className="flex w-full items-center gap-3 rounded-2xl border border-line bg-panel-2/70 p-3 text-left transition hover:border-alert/40"
              >
                <span className="relative">
                  <span className="absolute inset-0 animate-ping-slow rounded-full bg-alert/40" />
                  <ThreatBadge type={list[0]!.type} size={36} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{regionName(regionId)}</div>
                  <div className="flex flex-wrap gap-x-2 text-xs text-muted">
                    {list.map((a) => (
                      <span key={a.id} style={{ color: THREATS[a.type].color }}>
                        {THREATS[a.type].long}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right font-mono text-xs text-muted">
                  <div>{fmtTime(list[0]!.startedAt)}</div>
                  <div className="text-alert">{fmtDuration(now - list[0]!.startedAt)}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Icon name="shield" className="size-10" />} title="Тревог нет" text="Во всех регионах спокойно. Мы сообщим, если что-то изменится." />
        )}
      </section>

      {/* People's marks */}
      <section>
        <SectionTitle icon="users" title="Метки людей" count={visibleReports.length} />
        {prefs.view.hideUserReports ? (
          <p className="px-1 text-sm text-muted">Метки пользователей скрыты фильтром «Скрыть от людей».</p>
        ) : visibleReports.length ? (
          <div className="space-y-2">
            {visibleReports.slice(0, 30).map((r) => (
              <ReportRow key={r.id} r={r} onFocus={() => r.regionId && onFocus(r.regionId)} />
            ))}
          </div>
        ) : (
          <p className="px-1 text-sm text-muted">Активных меток нет. Метки исчезают автоматически через 10–25 минут.</p>
        )}
      </section>

      {/* Feed */}
      {ended.length > 0 && (
        <section>
          <SectionTitle icon="history" title="Отбой за сутки" count={ended.length} />
          <div className="space-y-0.5">
            {ended.map((a) => (
              <button key={a.id} onClick={() => onFocus(a.regionId)} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-white/5">
                <ThreatIcon type={a.type} className="size-4 shrink-0" color={THREATS[a.type].color} />
                <span className="min-w-0 flex-1 truncate">{regionName(a.regionId, true)}</span>
                <span className="font-mono text-xs text-dim">
                  {fmtTime(a.startedAt)}–{fmtTime(a.endedAt!)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <p className="flex gap-2 rounded-2xl border border-line px-3 py-2.5 text-xs text-dim">
        <Icon name="info" className="size-4 shrink-0" />
        <span>
          Радар не является официальным источником. Следуйте указаниям МЧС и региональных властей. <Link to="/about" className="text-accent">О сервисе</Link>
        </span>
      </p>
      <RegionPickerModal open={picker} onClose={() => setPicker(false)} value={prefs.regionId} onSelect={(id) => void setPrefs({ regionId: id })} />
    </div>
  );
}

function Counter({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2/70 px-3 py-2.5">
      <div className="font-mono text-xl font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-[10px] font-semibold leading-tight text-muted">{label}</div>
    </div>
  );
}

function SectionTitle({ icon, title, count }: { icon: 'bolt' | 'users' | 'history'; title: string; count: number }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-wider text-muted">
      <Icon name={icon} className="size-4" />
      {title}
      <span className="ml-auto rounded-full bg-panel-3 px-2 py-0.5 font-mono text-[11px] text-text">{count}</span>
    </h2>
  );
}
