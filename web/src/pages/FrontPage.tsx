import { useEffect, useState } from 'react';
import type { FrontData } from '@shared/types';
import { get } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { ARROW_COLORS, FRONT_LEGEND, FrontMap, type FrontLayers } from '../components/FrontMap';
import { Icon } from '../components/Icons';
import { Badge, cx } from '../components/ui';

export default function FrontPage() {
  const [data, setData] = useState<FrontData | null>(null);
  const [layers, setLayers] = useState<FrontLayers>({ zones: true, line: true, arrows: true, rivers: true, cities: true });
  useEffect(() => {
    const load = () => void get<FrontData>('/front').then(setData);
    load();
    window.addEventListener('radar:front', load);
    return () => window.removeEventListener('radar:front', load);
  }, []);

  const toggles: { id: keyof FrontLayers; label: string }[] = [
    { id: 'zones', label: 'Зоны контроля' },
    { id: 'line', label: 'Линия фронта' },
    { id: 'arrows', label: 'Направления' },
    { id: 'rivers', label: 'Реки' },
    { id: 'cities', label: 'Города' },
  ];
  const kinds = new Set((data?.geojson.features || []).map((f) => String(f.properties?.kind || '')));

  return (
    <div className="flex h-full flex-col lg:flex-row-reverse">
      <div className="relative min-h-0 flex-1">
        <FrontMap data={data} layers={layers} className="h-full" />
        {data?.isDemo && (
          <div className="absolute inset-x-3 top-3 mx-auto flex max-w-xl items-start gap-2 rounded-2xl border border-uav/40 bg-panel/90 px-4 py-2.5 text-xs backdrop-blur safe-top">
            <Icon name="warning" className="mt-0.5 size-4 shrink-0 text-uav" />
            <span>
              <b className="text-uav">Демо-данные.</b> {data.note}
            </span>
          </div>
        )}
      </div>
      <aside className="max-h-[38dvh] shrink-0 overflow-y-auto border-t border-line p-4 lg:max-h-none lg:w-[340px] lg:border-r lg:border-t-0 lg:p-5">
        <h1 className="text-xl font-extrabold">Линия боевого соприкосновения</h1>
        <p className="mt-1 text-sm text-muted">
          Зоны контроля и направления продвижения. Источник: {data?.source || '—'}
          {data?.updatedAt ? `, обновлено ${fmtDateTime(data.updatedAt)}` : ''}.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {toggles.map((t) => (
            <button
              key={t.id}
              onClick={() => setLayers((l) => ({ ...l, [t.id]: !l[t.id] }))}
              className={cx(
                'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                layers[t.id] ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line-2 text-dim',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-5 space-y-2 text-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-muted">Легенда</div>
          <LegendRow swatch={<span className="block h-1 w-6 rounded-full bg-alert shadow-[0_0_8px_#ff3b4f]" />} label="Линия фронта" />
          {Object.entries(FRONT_LEGEND)
            .filter(([k]) => kinds.has(k) || k === 'occupied')
            .map(([k, v]) => (
              <LegendRow key={k} swatch={<span className="block size-4 rounded" style={{ background: `${v.fill}40`, boxShadow: `inset 0 0 0 1px ${v.fill}` }} />} label={v.label} />
            ))}
          <LegendRow swatch={<Arrow color={ARROW_COLORS.ru} />} label="Продвижение ВС РФ" />
          <LegendRow swatch={<Arrow color={ARROW_COLORS.ua} />} label="Продвижение ВСУ" />
        </div>
        {data && data.arrows.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Направления</div>
            <div className="flex flex-wrap gap-1.5">
              {data.arrows.map((a) => (
                <Badge key={a.id} color={ARROW_COLORS[a.side]}>
                  {a.label || 'Без названия'}
                </Badge>
              ))}
            </div>
          </div>
        )}
        <p className="mt-6 text-xs text-dim">
          Данные отображаются по подключённому администратором источнику и могут отставать от реальной обстановки.
        </p>
      </aside>
    </div>
  );
}

function LegendRow({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid w-7 place-items-center">{swatch}</span>
      <span>{label}</span>
    </div>
  );
}

function Arrow({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 28 12" className="h-3 w-7">
      <path d="M1 6h18" stroke={color} strokeWidth="4" strokeLinecap="round" />
      <path d="M18 0l9 6-9 6z" fill={color} />
    </svg>
  );
}
