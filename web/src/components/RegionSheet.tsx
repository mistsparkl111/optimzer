import { Link } from 'react-router-dom';
import { THREATS } from '@shared/constants';
import { REGION_BY_ID } from '@shared/regions';
import type { RegionStats, Report } from '@shared/types';
import { get, post, errorText } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtDuration, fmtTime } from '../lib/format';
import { useApp } from '../lib/store';
import { Icon, ThreatBadge } from './Icons';
import { Badge, Button, Modal, PlusBadge, Spinner, toast, useAsync } from './ui';
import { MAX_EXTRA_REGIONS } from '@shared/constants';

export function RegionSheet({ regionId, onClose }: { regionId: string | null; onClose: () => void }) {
  const r = regionId ? REGION_BY_ID.get(regionId) : null;
  const { prefs, setPrefs, alerts, reports, now } = useApp();
  const { data, loading } = useAsync(() => (regionId ? get<RegionStats>(`/regions/${regionId}`) : Promise.resolve(null)), [regionId]);
  if (!r) return null;
  const active = alerts.filter((a) => a.regionId === r.id);
  const marks = prefs.view.hideUserReports ? [] : reports.filter((x) => x.regionId === r.id);
  const isHome = prefs.regionId === r.id;
  const watching = prefs.extraRegions.includes(r.id);

  return (
    <Modal open={!!regionId} onClose={onClose} title={r.name} wide>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge color="#7d899b">{r.district}</Badge>
          <span>Центр: {r.capital}</span>
          {r.isNew && <Badge color="#34e3ff">Новый регион</Badge>}
        </div>

        {active.length ? (
          <div className="space-y-2">
            {active.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-2xl border border-alert/30 bg-alert/10 p-3">
                <ThreatBadge type={a.type} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold" style={{ color: THREATS[a.type].color }}>
                    {THREATS[a.type].long}
                  </div>
                  <div className="text-xs text-muted">
                    с {fmtTime(a.startedAt)} · {fmtDuration(now - a.startedAt)} · {a.sourceName || 'Официальный источник'}
                  </div>
                  {a.message && <div className="mt-1 text-sm">{a.message}</div>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-2xl border border-ok/25 bg-ok/5 p-3 text-sm">
            <Icon name="shield" className="size-6 text-ok" />
            <span>Сейчас официальной тревоги нет</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!isHome && (
            <Button size="sm" variant="outline" onClick={() => void setPrefs({ regionId: r.id }).then(() => toast('Регион сохранён', 'ok'))}>
              <Icon name="home" className="size-4" /> Сделать моим
            </Button>
          )}
          {!isHome && (
            <Button
              size="sm"
              variant={watching ? 'subtle' : 'outline'}
              onClick={() => {
                if (!watching && prefs.extraRegions.length >= MAX_EXTRA_REGIONS) return toast(`Можно следить максимум за ${MAX_EXTRA_REGIONS} доп. регионами`, 'error');
                void setPrefs({ extraRegions: watching ? prefs.extraRegions.filter((x) => x !== r.id) : [...prefs.extraRegions, r.id] });
              }}
            >
              <Icon name={watching ? 'check' : 'bell'} className="size-4" /> {watching ? 'Слежу' : 'Следить'}
            </Button>
          )}
          {isHome && <Badge color="#34e3ff">Ваш регион</Badge>}
        </div>

        {marks.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Метки людей</h4>
            <div className="space-y-2">
              {marks.map((m) => (
                <ReportRow key={m.id} r={m} />
              ))}
            </div>
          </div>
        )}

        {loading && !data ? (
          <div className="grid place-items-center py-6">
            <Spinner className="text-accent" />
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <MiniStat label="За сутки" value={data.alerts24h} />
              <MiniStat label="За 7 дней" value={data.alerts7d} />
              <MiniStat label="Последняя" value={data.lastAlertAt ? fmtAgo(data.lastAlertAt, now) : '—'} small />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Тревоги по часам (МСК, {data.historyDays} дн.)</h4>
              <HourBars hourly={data.hourly} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">История</h4>
              {data.history.length ? (
                <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {data.history.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-sm hover:bg-white/5">
                      <span className="flex items-center gap-2">
                        <span className="size-2 rounded-full" style={{ background: THREATS[a.type].color }} />
                        {THREATS[a.type].long}
                      </span>
                      <span className="font-mono text-xs text-muted">
                        {fmtDateTime(a.startedAt)}
                        {a.endedAt ? ` · ${fmtDuration(a.endedAt - a.startedAt)}` : ' · идёт'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">За {data.historyDays} дн. тревог не было.</p>
              )}
              {data.historyDays < 30 && (
                <p className="mt-2 text-xs text-dim">
                  История за 30 дней — в <Link to="/plus" className="text-plus">Радар+</Link>
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function MiniStat({ label, value, small }: { label: string; value: React.ReactNode; small?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2 px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-dim">{label}</div>
      <div className={small ? 'mt-1 text-sm font-semibold' : 'mt-0.5 font-mono text-xl font-bold'}>{value}</div>
    </div>
  );
}

export function HourBars({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly);
  return (
    <svg viewBox="0 0 240 64" className="h-20 w-full">
      {hourly.map((v, h) => {
        const hgt = (v / max) * 48;
        const night = h >= 22 || h < 6;
        return (
          <g key={h}>
            <rect x={h * 10 + 1} y={52 - hgt} width={8} height={Math.max(1, hgt)} rx={2} fill={v ? (night ? '#a78bfa' : '#34e3ff') : '#1b2432'} opacity={v ? 0.9 : 1} />
            {h % 3 === 0 && (
              <text x={h * 10 + 5} y={62} fontSize={6.5} textAnchor="middle" fill="#4d5869">
                {h}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function ReportRow({ r, onFocus }: { r: Report; onFocus?: () => void }) {
  const { user, now } = useApp();
  const life = Math.max(0, Math.min(1, (r.expiresAt - now) / r.ttlMs));
  const vote = async (v: 1 | -1) => {
    if (!user) return toast('Войдите, чтобы голосовать', 'error');
    try {
      await post(`/reports/${r.id}/vote`, { vote: v });
      toast(v > 0 ? 'Спасибо, метка продлена' : 'Учтено', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const c = THREATS[r.type].color;
  return (
    <div className="rounded-2xl border border-line bg-panel-2/70 p-3">
      <div className="flex items-start gap-3">
        <button onClick={onFocus} className="shrink-0">
          <ThreatBadge type={r.type} size={38} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-bold" style={{ color: c }}>
              {THREATS[r.type].label}
              {r.count ? ` ×${r.count}` : ''}
            </span>
            {r.isPlus && <PlusBadge />}
            <span className="text-xs text-dim">
              {r.author} · {fmtAgo(r.createdAt, now)}
            </span>
          </div>
          {r.comment && <div className="mt-0.5 text-sm text-text/90">{r.comment}</div>}
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full transition-all" style={{ width: `${life * 100}%`, background: c }} />
            </div>
            <span className="font-mono text-[10px] text-dim">{fmtDuration(r.expiresAt - now)}</span>
          </div>
        </div>
      </div>
      {user && user.id && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="subtle" className="flex-1" onClick={() => vote(1)}>
            <Icon name="check" className="size-3.5" /> Подтверждаю {r.confirms ? `· ${r.confirms}` : ''}
          </Button>
          <Button size="sm" variant="ghost" className="flex-1 text-muted" onClick={() => vote(-1)}>
            Уже нет {r.dismisses ? `· ${r.dismisses}` : ''}
          </Button>
        </div>
      )}
    </div>
  );
}
