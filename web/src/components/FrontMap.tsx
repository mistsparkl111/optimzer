import { useEffect, useMemo, useRef, useState } from 'react';
import { geoPath, geoCentroid } from 'd3-geo';
import { frontProjection, loadFrontGeo, MAP_H, MAP_W, type FrontGeo } from '../lib/geo';
import { useSvgZoom } from '../lib/useZoom';
import { MapButton } from './RussiaMap';
import { cx, Spinner } from './ui';
import cities from '@shared/cities.json';
import type { FrontArrow, FrontData } from '@shared/types';

export interface FrontLayers {
  zones: boolean;
  line: boolean;
  arrows: boolean;
  rivers: boolean;
  cities: boolean;
}

type City = { name: string; lon: number; lat: number; pop: number; country: string; regionId: string | null; capital: boolean };

const ZONE_STYLE: Record<string, { fill: string; label: string }> = {
  occupied: { fill: '#ff3b4f', label: 'Под контролем ВС РФ' },
  gray: { fill: '#9ca3af', label: 'Серая зона' },
  contested: { fill: '#f59e0b', label: 'Оспариваемая территория' },
  liberated: { fill: '#3b82f6', label: 'Под контролем ВСУ (изменения)' },
};
export const FRONT_LEGEND = ZONE_STYLE;
export const ARROW_COLORS = { ru: '#ff3b4f', ua: '#3b82f6' } as const;

export function FrontMap({ data, layers, className }: { data: FrontData | null; layers: FrontLayers; className?: string }) {
  const [geo, setGeo] = useState<FrontGeo | null>(null);
  useEffect(() => {
    void loadFrontGeo().then(setGeo);
  }, []);
  if (!geo || !data)
    return (
      <div className={cx('grid place-items-center', className)}>
        <Spinner className="size-7 text-accent" />
      </div>
    );
  return <Inner geo={geo} data={data} layers={layers} className={className} />;
}

function Inner({ geo, data, layers, className }: { geo: FrontGeo; data: FrontData; layers: FrontLayers; className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { t, zoomBy, reset } = useSvgZoom(svgRef, { width: MAP_W, height: MAP_H, maxK: 30 });
  const k = t.k;
  const projection = useMemo(() => frontProjection(), []);
  const path = useMemo(() => geoPath(projection), [projection]);

  const areas = useMemo(
    () => geo.areas.map((f) => ({ f, d: path(f) || '', c: projection(geoCentroid(f)) })),
    [geo, path, projection],
  );
  const landD = useMemo(() => areas.map((a) => a.d).join(''), [areas]);
  const riversD = useMemo(() => geo.rivers.map((f) => path(f) || '').join(''), [geo, path]);
  const waterD = useMemo(() => geo.water.map((f) => path(f as GeoJSON.Feature) || '').join(''), [geo, path]);
  const adminD = useMemo(() => path(geo.adminBorders) || '', [geo, path]);
  const countryD = useMemo(() => path(geo.countryBorders) || '', [geo, path]);

  const zones = useMemo(
    () =>
      data.geojson.features
        .filter((f) => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
        .map((f, i) => ({ key: i, kind: String(f.properties?.kind || 'occupied'), d: path(f) || '' })),
    [data, path],
  );
  const lines = useMemo(
    () =>
      data.geojson.features
        .filter((f) => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'))
        .map((f) => path(f) || '')
        .join(''),
    [data, path],
  );

  const inv = 1 / k;
  const fill = (kind: string) => (kind === 'ru' ? '#111926' : kind === 'ua' ? '#0c121b' : '#090d13');

  return (
    <div className={cx('relative overflow-hidden', className)}>
      <svg ref={svgRef} viewBox={`0 0 ${MAP_W} ${MAP_H}`} preserveAspectRatio="xMidYMid slice" className="map-svg h-full w-full cursor-grab active:cursor-grabbing">
        <defs>
          <clipPath id="front-land">
            <path d={landD} />
          </clipPath>
          <pattern id="occ-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#ff3b4f" strokeOpacity="0.35" strokeWidth="1.2" />
          </pattern>
          <filter id="line-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={MAP_W} height={MAP_H} fill="#060b12" />
        <g transform={t.toString()}>
          {areas.map((a) => (
            <path key={a.f.properties.id || a.f.properties.name} d={a.d} fill={fill(a.f.properties.kind)}>
              <title>{a.f.properties.name}</title>
            </path>
          ))}
          {waterD && <path d={waterD} fill="#071624" />}
          {layers.zones && (
            <g clipPath="url(#front-land)">
              {zones.map((z) => (
                <g key={z.key}>
                  <path d={z.d} fill={ZONE_STYLE[z.kind]?.fill || '#ff3b4f'} fillOpacity={0.16} />
                  {z.kind === 'occupied' && <path d={z.d} fill="url(#occ-hatch)" />}
                </g>
              ))}
            </g>
          )}
          {layers.rivers && <path d={riversD} fill="none" stroke="#1d5f8f" strokeOpacity={0.8} strokeWidth={1.1} vectorEffect="non-scaling-stroke" />}
          <path d={adminD} fill="none" stroke="#273246" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <path d={countryD} fill="none" stroke="#5b6f88" strokeWidth={1.4} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />

          {/* oblast names */}
          {areas.map((a) =>
            a.c && a.f.properties.kind !== 'country' ? (
              <text
                key={`n${a.f.properties.id}`}
                transform={`translate(${a.c[0]},${a.c[1]}) scale(${inv})`}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill="#3f4c60"
                className="uppercase tracking-widest"
                pointerEvents="none"
              >
                {a.f.properties.name.replace(/ (область|Народная Республика)$/, '')}
              </text>
            ) : null,
          )}

          {layers.line && lines && (
            <>
              <path d={lines} fill="none" stroke="#ff3b4f" strokeWidth={3.2} vectorEffect="non-scaling-stroke" filter="url(#line-glow)" strokeLinejoin="round" />
              <path d={lines} fill="none" stroke="#ffd5da" strokeWidth={0.8} vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />
            </>
          )}

          {layers.arrows && data.arrows.map((a) => <FrontArrowShape key={a.id} a={a} project={(p) => projection(p) as [number, number] | null} k={k} />)}

          {layers.cities &&
            (cities as City[])
              .filter((c) => c.lon > 29 && c.lon < 42 && c.lat > 44 && c.lat < 53 && (c.pop >= 60000 || c.capital || k >= 3))
              .map((c) => {
                const p = projection([c.lon, c.lat]);
                if (!p) return null;
                const big = c.pop >= 400000 || c.capital;
                return (
                  <g key={`${c.name}${c.lon}`} transform={`translate(${p[0]},${p[1]}) scale(${inv})`} pointerEvents="none">
                    <circle r={big ? 3 : 2} fill="#e8eef7" stroke="#05070b" strokeWidth={1} />
                    <text x={5} y={4} fontSize={big ? 11 : 9.5} fontWeight={big ? 700 : 500} fill="#c9d4e2" style={{ paintOrder: 'stroke' }} stroke="#05070b" strokeWidth={3}>
                      {c.name}
                    </text>
                  </g>
                );
              })}
        </g>
      </svg>
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
        <MapButton onClick={() => zoomBy(1.8)} label="Приблизить" icon="plus" />
        <MapButton onClick={() => zoomBy(1 / 1.8)} label="Отдалить" icon="minus" />
        <MapButton onClick={reset} label="Сбросить" icon="home" />
      </div>
    </div>
  );
}

function FrontArrowShape({ a, project, k }: { a: FrontArrow; project: (p: [number, number]) => [number, number] | null; k: number }) {
  const pts = a.coords.map(project).filter((p): p is [number, number] => !!p);
  if (pts.length < 2) return null;
  const color = ARROW_COLORS[a.side];
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i]![0] + pts[i + 1]![0]) / 2;
    const my = (pts[i]![1] + pts[i + 1]![1]) / 2;
    d += ` Q${pts[i]![0]},${pts[i]![1]} ${mx},${my}`;
  }
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2]!;
  d += ` L${last[0]},${last[1]}`;
  const ang = (Math.atan2(last[1] - prev[1], last[0] - prev[0]) * 180) / Math.PI;
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke="#05070b" strokeWidth={9} strokeOpacity={0.6} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <g transform={`translate(${last[0]},${last[1]}) rotate(${ang}) scale(${1 / k})`}>
        <path d="M10,0 L-8,-11 L-4,0 L-8,11 Z" fill={color} stroke="#05070b" strokeWidth={1.5} />
      </g>
      {a.label && k >= 1.6 && (
        <text transform={`translate(${pts[0]![0]},${pts[0]![1]}) scale(${1 / k})`} y={-10} textAnchor="middle" fontSize={10} fontWeight={700} fill={color} style={{ paintOrder: 'stroke' }} stroke="#05070b" strokeWidth={3}>
          {a.label}
        </text>
      )}
    </g>
  );
}
