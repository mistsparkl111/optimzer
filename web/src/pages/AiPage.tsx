import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RISK_META, riskLevel, THREATS } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { Forecast, ForecastResponse } from '@shared/types';
import { get, post, errorText } from '../lib/api';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useApp } from '../lib/store';
import { RussiaMap, type RegionStyle } from '../components/RussiaMap';
import { Icon, ThreatIcon } from '../components/Icons';
import { Badge, Button, Card, cx, EmptyState, PlusBadge, Select, Spinner, Tabs, toast, useAsync } from '../components/ui';

export default function AiPage() {
  const { user } = useApp();
  const [mode, setMode] = useState<'ai' | 'algo'>('ai');
  const [modelId, setModelId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const resp = useAsync(() => get<ForecastResponse>(`/ai/forecast${modelId ? `?model=${modelId}` : ''}`), [modelId]);
  const algo = useAsync(() => (mode === 'algo' ? get<Forecast>('/ai/heuristic') : Promise.resolve(null)), [mode]);

  useEffect(() => {
    const onF = () => {
      resp.reload();
      setBusy(false);
    };
    window.addEventListener('radar:forecast', onF);
    return () => window.removeEventListener('radar:forecast', onF);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const data = resp.data;
  const forecast = mode === 'algo' ? algo.data : data?.forecast ?? null;
  const loading = mode === 'algo' ? algo.loading : resp.loading;

  const refresh = async () => {
    setBusy(true);
    try {
      await post('/ai/forecast/refresh', { modelId: modelId ?? data?.models.find((m) => m.isDefault)?.id ?? null });
      toast('ИИ анализирует данные — прогноз обновится автоматически', 'info');
    } catch (e) {
      setBusy(false);
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 lg:p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-accent">
              <Icon name="ai" className="size-4" /> ИИ-режим
            </div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight lg:text-3xl">Прогноз воздушных угроз</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Алгоритм подсчитывает все тревоги и метки по регионам, ИИ читает российские и украинские источники и делает сводку на сегодня и
              завтра с вероятными направлениями.
            </p>
          </div>
          <Tabs
            value={mode}
            onChange={setMode}
            tabs={[
              { id: 'ai', label: 'ИИ-прогноз' },
              { id: 'algo', label: 'Алгоритм' },
            ]}
          />
        </header>

        {mode === 'ai' && data && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel-2/60 p-3">
            {data.models.length > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Модель</span>
                <Select
                  value={modelId ?? data.models.find((m) => m.isDefault)?.id ?? data.models[0]?.id ?? ''}
                  onChange={(e) => setModelId(Number(e.target.value))}
                  className="w-auto min-w-48 py-2"
                >
                  {data.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.provider}
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <span className="text-sm text-muted">ИИ-провайдер ещё не подключён — показан прогноз алгоритма.</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {data.canRefresh ? (
                <Button onClick={refresh} loading={busy || data.refreshing} variant="outline">
                  <Icon name="refresh" className="size-4" /> Обновить прогноз
                </Button>
              ) : data.aiConfigured ? (
                <Link to={user ? '/plus' : '/profile'}>
                  <Button variant="plus" size="sm">
                    Обновлять по запросу — в Радар+
                  </Button>
                </Link>
              ) : null}
            </div>
          </div>
        )}

        {loading && !forecast ? (
          <div className="grid h-64 place-items-center">
            <Spinner className="size-7 text-accent" />
          </div>
        ) : !forecast ? (
          <EmptyState icon={<Icon name="ai" className="size-10" />} title="Прогноза пока нет" text="Он появится после первого анализа данных." />
        ) : (
          <ForecastView f={forecast} />
        )}
      </div>
    </div>
  );
}

function riskStyle(risk: number): RegionStyle | null {
  if (risk < 5) return null;
  const level = riskLevel(risk);
  return { fill: RISK_META[level].color, opacity: 0.12 + 0.6 * (risk / 100) };
}

function ForecastView({ f }: { f: Forecast }) {
  const { prefs } = useApp();
  const riskBy = useMemo(() => new Map(f.regions.map((r) => [r.regionId, r])), [f]);
  const values = useMemo(() => new Map(f.regions.filter((r) => r.risk >= 30).map((r) => [r.regionId, `${Math.round(r.risk)}%`])), [f]);
  const top = useMemo(() => [...f.regions].sort((a, b) => b.risk - a.risk).slice(0, 15), [f]);
  const mine = prefs.regionId ? riskBy.get(prefs.regionId) : null;
  const overall = RISK_META[f.overall.level];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[280px_1fr_1fr]">
        <Card className="relative overflow-hidden">
          <div className="absolute -right-10 -top-10 size-40 rounded-full blur-3xl" style={{ background: `${overall.color}33` }} />
          <div className="relative">
            <div className="text-xs font-bold uppercase tracking-wider text-muted">Общий уровень угрозы</div>
            <Gauge score={f.overall.score} color={overall.color} />
            <div className="-mt-2 text-center text-lg font-extrabold" style={{ color: overall.color }}>
              {overall.label}
            </div>
            <div className="mt-3 space-y-1 text-xs text-muted">
              <div className="flex items-center justify-between">
                <span>Источник</span>
                <span className="font-semibold text-text">{f.modelLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Сформирован</span>
                <span className="font-mono text-text">{fmtDateTime(f.createdAt)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Горизонт</span>
                <span className="font-mono text-text">
                  до {fmtTime(f.horizon.to)}
                </span>
              </div>
              {mine && prefs.regionId && (
                <div className="mt-2 flex items-center justify-between rounded-xl bg-panel-3 px-2.5 py-2">
                  <span>{regionName(prefs.regionId, true)}</span>
                  <span className="font-mono font-bold" style={{ color: RISK_META[mine.level].color }}>
                    {Math.round(mine.risk)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Icon name="clock" className="size-4 text-accent" /> Сводка на сегодня</span>}>
          <p className="whitespace-pre-line text-sm leading-relaxed text-text/90">{f.summaryToday}</p>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Icon name="ai" className="size-4 text-aviation" /> Прогноз на завтра</span>}>
          <p className="whitespace-pre-line text-sm leading-relaxed text-text/90">{f.outlookTomorrow}</p>
        </Card>
      </div>

      {f.status === 'error' && (
        <div className="flex items-start gap-2 rounded-2xl border border-uav/40 bg-uav/10 px-4 py-3 text-sm">
          <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-uav" />
          <span>ИИ-модель не ответила ({f.error || 'ошибка'}). Показан расчёт алгоритма.</span>
        </div>
      )}

      <Card padded={false} title="Карта риска и вероятные направления" action={<RiskLegend />}>
        <RussiaMap
          className="h-[52dvh] min-h-80 grid-bg"
          regionStyle={(id) => {
            const r = riskBy.get(id);
            return r ? riskStyle(r.risk) : null;
          }}
          vectors={f.vectors}
          values={values}
          initialRegion={prefs.regionId ?? 'MOS'}
          homeRegions={prefs.regionId ? [prefs.regionId] : []}
          wheel={false}
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Регионы с наибольшим риском">
          <div className="space-y-3">
            {top.map((r) => {
              const c = RISK_META[r.level].color;
              return (
                <div key={r.regionId}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-semibold">{regionName(r.regionId)}</span>
                    <span className="flex items-center gap-1.5 font-mono font-bold" style={{ color: c }}>
                      {r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : '→'} {Math.round(r.risk)}%
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full" style={{ width: `${r.risk}%`, background: `linear-gradient(90deg, ${c}88, ${c})` }} />
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {r.reason}
                    {r.peakHours ? ` · пик: ${r.peakHours}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Вероятные направления">
            {f.vectors.length ? (
              <div className="space-y-2">
                {f.vectors.map((v) => (
                  <div key={v.id} className="flex items-start gap-3 rounded-xl bg-panel-2 p-2.5">
                    <ThreatIcon type={v.type} className="mt-0.5 size-5 shrink-0" color={THREATS[v.type].color} />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-semibold">
                        {v.fromRegionId ? regionName(v.fromRegionId, true) : 'Граница'} → {v.toRegionId ? regionName(v.toRegionId, true) : '—'}
                      </div>
                      <div className="text-xs text-muted">
                        {v.window}
                        {v.note ? ` · ${v.note}` : ''}
                      </div>
                    </div>
                    <Badge color={v.confidence >= 0.6 ? '#ff3b4f' : v.confidence >= 0.35 ? '#ffb020' : '#7d899b'}>{Math.round(v.confidence * 100)}%</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Недостаточно данных, чтобы выделить устойчивые направления.</p>
            )}
          </Card>

          {f.events.length > 0 && (
            <Card title="Ключевые события">
              <ol className="relative space-y-3 border-l border-line-2 pl-4">
                {f.events.map((e, i) => (
                  <li key={i} className="text-sm">
                    <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full bg-accent" />
                    {e.time && <span className="mr-2 font-mono text-xs text-accent">{fmtTime(e.time)}</span>}
                    {e.text}
                    {e.sourceIds.length > 0 && <span className="ml-1 text-xs text-dim">({e.sourceIds.length} ист.)</span>}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {f.recommendations.length > 0 && (
            <Card title="Рекомендации">
              <ul className="space-y-2 text-sm">
                {f.recommendations.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-ok" />
                    {r}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <MiniStat label="Тревог за сутки" value={f.stats.alerts24h} />
        <MiniStat label="Меток за сутки" value={f.stats.reports24h} />
        <MiniStat label="Постов проанализировано" value={f.stats.postsAnalyzed} />
        <MiniStat label="Источников" value={f.stats.sourcesUsed} />
      </div>

      <p className={cx('rounded-2xl border border-line p-4 text-xs leading-relaxed text-dim')}>
        <b className="text-muted">Достоверность.</b> {f.confidenceNote} Прогноз — вероятностная оценка на основе открытых данных и не заменяет официальные
        оповещения. При сигнале тревоги действуйте по указаниям МЧС. <PlusBadge className="ml-1 align-middle" /> позволяет обновлять прогноз по
        запросу и выбирать модель.
      </p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-line bg-panel-2/60 px-4 py-3">
      <div className="font-mono text-xl font-bold">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function RiskLegend() {
  return (
    <div className="hidden items-center gap-2 text-[11px] text-muted sm:flex">
      {(['low', 'medium', 'high', 'critical'] as const).map((l) => (
        <span key={l} className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm" style={{ background: RISK_META[l].color }} />
          {RISK_META[l].label}
        </span>
      ))}
    </div>
  );
}

function Gauge({ score, color }: { score: number; color: string }) {
  const r = 70;
  const len = Math.PI * r;
  return (
    <svg viewBox="0 0 180 110" className="mx-auto mt-2 w-full max-w-[220px]">
      <path d="M20 95 A70 70 0 0 1 160 95" fill="none" stroke="#1b2432" strokeWidth="14" strokeLinecap="round" />
      <path
        d="M20 95 A70 70 0 0 1 160 95"
        fill="none"
        stroke={color}
        strokeWidth="14"
        strokeLinecap="round"
        strokeDasharray={`${(len * Math.max(2, score)) / 100} ${len}`}
        style={{ filter: `drop-shadow(0 0 8px ${color})`, transition: 'stroke-dasharray 0.8s ease' }}
      />
      <text x="90" y="88" textAnchor="middle" fontSize="34" fontWeight="800" fill="#e8eef7" className="font-mono">
        {Math.round(score)}
      </text>
    </svg>
  );
}
