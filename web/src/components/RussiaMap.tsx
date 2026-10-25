import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { geoPath } from 'd3-geo';
import { pointer } from 'd3-selection';
import { destination, loadRussia, MAP_H, MAP_W, russiaProjection, type RussiaGeo } from '../lib/geo';
import { useSvgZoom } from '../lib/useZoom';
import { THREAT_PATHS, Icon } from './Icons';
import { cx, Spinner } from './ui';
import { THREATS, type ReportType } from '@shared/constants';
import { REGION_BY_ID } from '@shared/regions';
import cities from '@shared/cities.json';
import type { Alert, ForecastVector, Report } from '@shared/types';

export interface RegionStyle {
  fill: string;
  opacity?: number;
  pulse?: boolean;
  glow?: string;
}

export interface RussiaMapProps {
  className?: string;
  regionStyle?: (id: string) => RegionStyle | null;
  alerts?: Alert[];
  reports?: Report[];
  vectors?: ForecastVector[];
  homeRegions?: string[];
  selectedRegion?: string | null;
  focusRegion?: string | null;
  /** Region to frame loosely on first render (with its surroundings). */
  initialRegion?: string | null;
  onRegionClick?: (id: string) => void;
  onReportClick?: (r: Report) => void;
  pickMode?: boolean;
  onPick?: (lonlat: [number, number]) => void;
  picked?: { lonlat: [number, number]; type: ReportType; heading: number | null } | null;
  /** Value labels drawn at region label points (e.g. AI risk %). */
  values?: Map<string, string>;
  now?: number;
  wheel?: boolean;
  children?: ReactNode;
}

type City = { name: string; lon: number; lat: number; pop: number; country: string; regionId: string | null; capital: boolean };

export function RussiaMap(props: RussiaMapProps) {
  const [geo, setGeo] = useState<RussiaGeo | null>(null);
  useEffect(() => {
    void loadRussia().then(setGeo);
  }, []);
  if (!geo)
    return (
      <div className={cx('grid place-items-center', props.className)}>
        <Spinner className="size-7 text-accent" />
      </div>
    );
  return <MapInner {...props} geo={geo} />;
}

function MapInner({
  geo,
  className,
  regionStyle,
  alerts = [],
  reports = [],
  vectors = [],
  homeRegions = [],
  selectedRegion,
  focusRegion,
  initialRegion,
  onRegionClick,
  onReportClick,
  pickMode,
  onPick,
  picked,
  values,
  now = Date.now(),
  wheel = true,
  children,
}: RussiaMapProps & { geo: RussiaGeo }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const { t, zoomBy, reset, fitBounds } = useSvgZoom(svgRef, { width: MAP_W, height: MAP_H, wheel });
  const k = t.k;

  const projection = useMemo(() => russiaProjection(geo.regions), [geo]);
  const path = useMemo(() => geoPath(projection), [projection]);

  const regionShapes = useMemo(
    () =>
      geo.regions.map((f) => {
        const b = path.bounds(f);
        return { id: f.properties.id, d: path(f) || '', bounds: b, area: (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]) };
      }),
    [geo, path],
  );
  const shapeById = useMemo(() => new Map(regionShapes.map((s) => [s.id, s])), [regionShapes]);
  const contextD = useMemo(() => geo.context.map((f) => path(f) || '').join(''), [geo, path]);
  const innerD = useMemo(() => path(geo.innerBorders) || '', [geo, path]);
  const outlineD = useMemo(() => path(geo.outline) || '', [geo, path]);
  const proj = (lonlat: [number, number]) => projection(lonlat) as [number, number] | null;

  useEffect(() => {
    const s = initialRegion ? shapeById.get(initialRegion) : null;
    if (s) fitBounds(s.bounds, 6, 0.16);
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom to a region when focusRegion changes.
  useEffect(() => {
    if (!focusRegion) return;
    const s = shapeById.get(focusRegion);
    if (s) fitBounds(s.bounds, 14, 0.55);
  }, [focusRegion, shapeById, fitBounds]);

  const alertsByRegion = useMemo(() => {
    const m = new Map<string, Alert[]>();
    for (const a of alerts) m.set(a.regionId, [...(m.get(a.regionId) || []), a]);
    return m;
  }, [alerts]);

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!pickMode || !onPick || !gRef.current) return;
    const [x, y] = pointer(e.nativeEvent, gRef.current);
    const ll = projection.invert?.([x, y]);
    if (ll) onPick([ll[0], ll[1]]);
  };

  const inv = 1 / k;
  const labelVisible = (area: number) => area * k * k > 2600;

  return (
    <div className={cx('relative overflow-hidden', className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid meet"
        className={cx('map-svg h-full w-full', pickMode ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing')}
        onClick={handleClick}
      >
        <MapDefs />
        <g ref={gRef} transform={t.toString()}>
          <path d={contextD} fill="#0a0f16" stroke="#18212d" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          <RegionsLayer
            shapes={regionShapes}
            regionStyle={regionStyle}
            alertsByRegion={alertsByRegion}
            homeRegions={homeRegions}
            selectedRegion={selectedRegion}
            onRegionClick={pickMode ? undefined : onRegionClick}
          />
          <path d={innerD} fill="none" stroke="#2a3648" strokeWidth={0.6} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          <path d={outlineD} fill="none" stroke="#3d5570" strokeWidth={1.3} vectorEffect="non-scaling-stroke" pointerEvents="none" />

          {/* Home / selected outlines on top of borders */}
          {homeRegions.map((id) => {
            const s = shapeById.get(id);
            return s ? (
              <path key={`h${id}`} d={s.d} fill="none" stroke="#34e3ff" strokeWidth={1.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" pointerEvents="none" />
            ) : null;
          })}
          {selectedRegion && shapeById.get(selectedRegion) && (
            <path d={shapeById.get(selectedRegion)!.d} fill="none" stroke="#e8eef7" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}

          {/* Cities when zoomed in */}
          {k >= 3.5 &&
            (cities as City[])
              .filter((c) => c.country === 'RU' && (c.capital || k >= 7) && (c.pop >= 150000 || c.capital || k >= 10))
              .map((c) => {
                const p = proj([c.lon, c.lat]);
                if (!p) return null;
                return (
                  <g key={`${c.name}${c.lon}`} transform={`translate(${p[0]},${p[1]}) scale(${inv})`} pointerEvents="none">
                    <circle r={c.capital ? 2.6 : 1.8} fill="#9fb3c8" />
                    <text x={4} y={3.5} fontSize={c.capital ? 10 : 9} fill="#9fb3c8" className="font-sans" style={{ paintOrder: 'stroke' }} stroke="#05070b" strokeWidth={3}>
                      {c.name}
                    </text>
                  </g>
                );
              })}

          {/* Region labels + alert badges */}
          {regionShapes.map((s) => {
            const r = REGION_BY_ID.get(s.id);
            if (!r) return null;
            const p = proj(r.label);
            if (!p) return null;
            const regionAlerts = alertsByRegion.get(s.id);
            const value = values?.get(s.id);
            const showName = labelVisible(s.area) || (!!regionAlerts && k >= 2);
            if (!regionAlerts && !value && !showName) return null;
            return (
              <g key={`l${s.id}`} transform={`translate(${p[0]},${p[1]}) scale(${inv})`} pointerEvents="none">
                {regionAlerts && <AlertBadge types={regionAlerts.map((a) => a.type)} />}
                {value && (
                  <text y={regionAlerts ? 22 : 4} textAnchor="middle" fontSize={11} fontWeight={800} fill="#fff" className="font-mono" style={{ paintOrder: 'stroke' }} stroke="#05070b" strokeWidth={3}>
                    {value}
                  </text>
                )}
                {showName && !value && (
                  <text y={regionAlerts ? 22 : 4} textAnchor="middle" fontSize={10} fontWeight={600} fill={regionAlerts ? '#ffd5da' : '#7d899b'} style={{ paintOrder: 'stroke' }} stroke="#05070b" strokeWidth={3}>
                    {r.short}
                  </text>
                )}
              </g>
            );
          })}

          {/* AI / pattern vectors */}
          {vectors.map((v) => (
            <VectorArrow key={v.id} v={v} proj={proj} k={k} />
          ))}

          {/* People's marks */}
          {reports.map((r) => {
            const p = proj([r.lon, r.lat]);
            if (!p) return null;
            let angle: number | null = null;
            if (r.heading != null) {
              const q = proj(destination([r.lon, r.lat], r.heading, 60));
              if (q) angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
            }
            const life = Math.max(0, Math.min(1, (r.expiresAt - now) / r.ttlMs));
            return (
              <ReportMarker
                key={r.id}
                x={p[0]}
                y={p[1]}
                inv={inv}
                type={r.type}
                angle={angle}
                life={life}
                fresh={now - r.createdAt < 3 * 60_000}
                plus={r.isPlus}
                onClick={onReportClick && !pickMode ? () => onReportClick(r) : undefined}
              />
            );
          })}

          {picked && (() => {
            const p = proj(picked.lonlat);
            if (!p) return null;
            let angle: number | null = null;
            if (picked.heading != null) {
              const q = proj(destination(picked.lonlat, picked.heading, 60));
              if (q) angle = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
            }
            return <ReportMarker x={p[0]} y={p[1]} inv={inv} type={picked.type} angle={angle} life={1} fresh plus={false} />;
          })()}
        </g>
      </svg>

      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
        <MapButton onClick={() => zoomBy(1.8)} label="Приблизить" icon="plus" />
        <MapButton onClick={() => zoomBy(1 / 1.8)} label="Отдалить" icon="minus" />
        <MapButton onClick={reset} label="Вся страна" icon="home" />
        {homeRegions[0] && (
          <MapButton
            onClick={() => {
              const s = shapeById.get(homeRegions[0]!);
              if (s) fitBounds(s.bounds, 14, 0.55);
            }}
            label="Мой регион"
            icon="locate"
          />
        )}
      </div>
      {children}
    </div>
  );
}

export function MapButton({ onClick, label, icon }: { onClick: () => void; label: string; icon: 'plus' | 'minus' | 'home' | 'locate' | 'layers' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-9 place-items-center rounded-xl border border-line-2 bg-panel/85 text-muted backdrop-blur transition hover:border-accent/50 hover:text-accent"
    >
      <Icon name={icon} className="size-[18px]" />
    </button>
  );
}

function MapDefs() {
  return (
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#ffb02014" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="#ffb020" strokeOpacity="0.45" strokeWidth="1.5" />
      </pattern>
      <radialGradient id="mark-fresh">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

const RegionsLayer = memo(function RegionsLayer({
  shapes,
  regionStyle,
  alertsByRegion,
  homeRegions,
  selectedRegion,
  onRegionClick,
}: {
  shapes: { id: string; d: string }[];
  regionStyle?: (id: string) => RegionStyle | null;
  alertsByRegion: Map<string, Alert[]>;
  homeRegions: string[];
  selectedRegion?: string | null;
  onRegionClick?: (id: string) => void;
}) {
  return (
    <g>
      {shapes.map((s) => {
        const st = regionStyle?.(s.id);
        const alert = alertsByRegion.get(s.id);
        const color = alert ? THREATS[alert[0]!.type].color : null;
        const fill = st?.fill ?? (color ? color : homeRegions.includes(s.id) ? '#0f2230' : '#0e1520');
        const opacity = st?.opacity ?? (color ? 0.42 : 1);
        return (
          <g key={s.id}>
            {color && <path d={s.d} fill={color} opacity={0.25} filter="url(#glow)" className="alert-pulse" pointerEvents="none" />}
            <path
              d={s.d}
              className={cx('region', (st?.pulse || color) && 'alert-pulse', onRegionClick && 'cursor-pointer hover:brightness-150')}
              fill={fill}
              fillOpacity={opacity}
              stroke={selectedRegion === s.id ? '#fff' : 'transparent'}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              onClick={onRegionClick ? () => onRegionClick(s.id) : undefined}
            >
              <title>{REGION_BY_ID.get(s.id)?.name}</title>
            </path>
          </g>
        );
      })}
    </g>
  );
});

function AlertBadge({ types }: { types: Alert['type'][] }) {
  const uniq = [...new Set(types)];
  return (
    <g>
      {uniq.map((type, i) => {
        const c = THREATS[type].color;
        const x = (i - (uniq.length - 1) / 2) * 22;
        return (
          <g key={type} transform={`translate(${x},0)`}>
            <circle r={13} fill={c} opacity={0.25} className="alert-pulse" />
            <circle r={10} fill="#140608" stroke={c} strokeWidth={1.5} />
            <path d={THREAT_PATHS[type]} fill={c} transform="translate(-7,-7) scale(0.58)" />
          </g>
        );
      })}
    </g>
  );
}

function ReportMarker({
  x,
  y,
  inv,
  type,
  angle,
  life,
  fresh,
  plus,
  onClick,
}: {
  x: number;
  y: number;
  inv: number;
  type: ReportType;
  angle: number | null;
  life: number;
  fresh: boolean;
  plus: boolean;
  onClick?: () => void;
}) {
  const c = THREATS[type].color;
  // Marks fade as their lifetime runs out.
  const opacity = 0.3 + 0.7 * life;
  return (
    <g transform={`translate(${x},${y}) scale(${inv})`} opacity={opacity} onClick={onClick} className={onClick ? 'cursor-pointer' : undefined}>
      {fresh && <circle r={12} fill="none" stroke={c} strokeWidth={2} className="origin-center animate-ping-slow" style={{ transformBox: 'fill-box' }} />}
      {angle != null && (
        <g transform={`rotate(${angle})`}>
          <line x1={12} y1={0} x2={34} y2={0} stroke={c} strokeWidth={2} strokeDasharray="3 3" />
          <path d="M34 -5 L44 0 L34 5 Z" fill={c} />
        </g>
      )}
      <circle r={13} fill="#07090d" stroke={c} strokeWidth={2} />
      {/* remaining-life ring */}
      <circle r={16} fill="none" stroke={c} strokeOpacity={0.5} strokeWidth={2} strokeDasharray={`${life * 100.5} 200`} transform="rotate(-90)" />
      <path d={THREAT_PATHS[type]} fill={c} transform="translate(-8.5,-8.5) scale(0.71)" />
      {plus && <circle cx={10} cy={-10} r={4} fill="#ffc845" stroke="#07090d" strokeWidth={1.5} />}
    </g>
  );
}

function VectorArrow({ v, proj, k }: { v: ForecastVector; proj: (p: [number, number]) => [number, number] | null; k: number }) {
  const a = proj(v.from);
  const b = proj(v.to);
  if (!a || !b) return null;
  const color = THREATS[v.type].color;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return null;
  // Gentle curve: control point offset perpendicular to the chord.
  const cx = (a[0] + b[0]) / 2 - dy * 0.18;
  const cy = (a[1] + b[1]) / 2 + dx * 0.18;
  const d = `M${a[0]},${a[1]} Q${cx},${cy} ${b[0]},${b[1]}`;
  const ang = (Math.atan2(b[1] - cy, b[0] - cx) * 180) / Math.PI;
  const w = 1.5 + v.confidence * 3;
  return (
    <g pointerEvents="none" opacity={0.55 + v.confidence * 0.45}>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.25} strokeWidth={w + 5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={w} vectorEffect="non-scaling-stroke" className="flow" strokeLinecap="round" />
      <g transform={`translate(${b[0]},${b[1]}) rotate(${ang}) scale(${1 / k})`}>
        <path d={`M2,0 L-12,-7 L-8,0 L-12,7 Z`} fill={color} />
      </g>
    </g>
  );
}
