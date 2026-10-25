import { bus } from '../bus';
import { getJson, setJson } from '../settings';
import { MIN } from '../util';
import type { FrontAreaKind, FrontArrow, FrontData } from '../../shared/types';

const KEY = 'front';
const CONFIG_KEY = 'front_config';

export interface FrontConfig {
  /** GeoJSON URL to import from automatically (leave empty to edit manually). */
  sourceUrl: string;
  autoRefreshMin: number;
  lastError: string | null;
  lastImportAt: number | null;
}

const DEFAULT_CONFIG: FrontConfig = { sourceUrl: '', autoRefreshMin: 0, lastError: null, lastImportAt: null };

// Rough illustrative line used only until a real source is configured. Clearly flagged as demo in the UI.
const DEMO_LINE: [number, number][] = [
  [31.5, 46.58], [32.05, 46.5], [32.4, 46.52], [32.62, 46.58], [32.95, 46.66], [33.25, 46.74], [33.42, 46.78],
  [33.7, 46.98], [34.05, 47.25], [34.4, 47.45], [34.7, 47.52], [35.05, 47.53], [35.3, 47.48], [35.48, 47.58],
  [35.75, 47.55], [35.9, 47.45], [36.1, 47.55], [36.25, 47.66], [36.5, 47.72], [36.8, 47.83], [37.0, 47.95],
  [37.15, 48.05], [37.05, 48.18], [37.12, 48.3], [37.3, 48.36], [37.55, 48.45], [37.75, 48.42], [37.85, 48.55],
  [38.0, 48.72], [38.1, 48.86], [37.9, 48.98], [37.75, 49.1], [37.7, 49.35], [37.62, 49.62], [37.7, 49.85],
  [37.55, 50.05], [37.3, 50.22], [36.95, 50.3], [36.75, 50.36],
];
const DEMO_CLOSE: [number, number][] = [
  [37.4, 50.42], [38.2, 50.05], [38.9, 49.95], [39.6, 49.75], [40.15, 49.58], [40.1, 49.25], [39.9, 48.85],
  [39.85, 48.45], [39.75, 48.05], [39.0, 47.85], [38.3, 47.55], [38.25, 47.12], [37.55, 47.05], [36.8, 46.72],
  [35.9, 46.62], [35.3, 46.38], [34.95, 46.18], [34.8, 46.12], [33.65, 46.18], [32.9, 46.08], [32.4, 46.08],
  [31.95, 46.3], [31.5, 46.58],
];

export const DEMO_FRONT: FrontData = {
  isDemo: true,
  source: 'Демо-данные',
  note: 'Схематичная демонстрационная линия, не отражает актуальную обстановку. Подключите источник в админ-панели.',
  updatedAt: null,
  geojson: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { kind: 'occupied' },
        geometry: { type: 'Polygon', coordinates: [[...DEMO_LINE, ...DEMO_CLOSE]] },
      },
      { type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: DEMO_LINE } },
    ],
  },
  arrows: [
    { id: 'd1', side: 'ru', coords: [[37.02, 48.1], [37.12, 48.2], [37.26, 48.3]], label: 'Покровское (демо)' },
    { id: 'd2', side: 'ru', coords: [[37.9, 48.36], [37.78, 48.45], [37.66, 48.52]], label: 'Константиновское (демо)' },
    { id: 'd3', side: 'ru', coords: [[37.9, 49.76], [37.76, 49.72], [37.62, 49.7]], label: 'Купянское (демо)' },
    { id: 'd4', side: 'ru', coords: [[36.45, 47.6], [36.32, 47.66], [36.18, 47.72]], label: 'Гуляйпольское (демо)' },
    { id: 'd5', side: 'ua', coords: [[37.42, 48.66], [37.55, 48.62], [37.7, 48.57]], label: 'Контрудар (демо)' },
  ],
};

export function getFront(): FrontData {
  return getJson<FrontData | null>(KEY, null) ?? DEMO_FRONT;
}

export function getFrontConfig(): FrontConfig {
  return { ...DEFAULT_CONFIG, ...getJson<Partial<FrontConfig>>(CONFIG_KEY, {}) };
}

export function setFrontConfig(cfg: Partial<FrontConfig>) {
  setJson(CONFIG_KEY, { ...getFrontConfig(), ...cfg });
  scheduleFrontRefresh();
}

export function saveFront(data: Omit<FrontData, 'updatedAt'> & { updatedAt?: number | null }) {
  const value: FrontData = { ...data, updatedAt: data.updatedAt ?? Date.now() };
  setJson(KEY, value);
  bus.publish({ type: 'front', updatedAt: value.updatedAt! });
  return value;
}

export function resetFrontToDemo() {
  setJson(KEY, null);
  bus.publish({ type: 'front', updatedAt: Date.now() });
}

const AREA_KINDS: FrontAreaKind[] = ['occupied', 'gray', 'liberated', 'contested'];

function classify(props: Record<string, unknown>): FrontAreaKind {
  const k = String(props.kind ?? props.status ?? '').toLowerCase();
  if ((AREA_KINDS as string[]).includes(k)) return k as FrontAreaKind;
  const text = Object.values(props)
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (/(сір|сер[аы]я|gray|grey|contested|спорн)/.test(text)) return 'gray';
  if (/(звільн|освобожд|liberat|deoccup)/.test(text)) return 'liberated';
  if (/(окуп|occup|контрол[ья] рф|russia)/.test(text)) return 'occupied';
  const color = String(props.fill ?? props.color ?? props.stroke ?? '').replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(color)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
    if (r > 120 && r > g * 1.4 && r > b * 1.4) return 'occupied';
    if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25) return 'gray';
    if (b > r || g > r) return 'liberated';
  }
  return 'occupied';
}

const roundCoords = (c: unknown): unknown =>
  Array.isArray(c) ? (typeof c[0] === 'number' ? c.slice(0, 2).map((x: number) => Math.round(x * 1e4) / 1e4) : c.map(roundCoords)) : c;

/** Accepts a FeatureCollection (or common wrappers like { map: FeatureCollection }) and normalises it. */
export function normalizeFrontGeoJson(input: unknown): { geojson: GeoJSON.FeatureCollection; arrows: FrontArrow[] } {
  let fc = input as { type?: string; features?: unknown[]; map?: unknown; geojson?: unknown };
  if (fc && !Array.isArray(fc.features)) fc = (fc.map || fc.geojson || {}) as typeof fc;
  if (!fc || !Array.isArray(fc.features)) throw new Error('Ожидается GeoJSON FeatureCollection');
  const features: GeoJSON.Feature[] = [];
  const arrows: FrontArrow[] = [];
  fc.features.forEach((raw, i) => {
    const f = raw as GeoJSON.Feature;
    if (!f?.geometry) return;
    const props = (f.properties || {}) as Record<string, unknown>;
    const g = f.geometry;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      features.push({ type: 'Feature', properties: { kind: classify(props), name: props.name ?? null }, geometry: { ...g, coordinates: roundCoords(g.coordinates) } as GeoJSON.Geometry });
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      if (String(props.kind || '').toLowerCase() === 'arrow' && g.type === 'LineString') {
        arrows.push({
          id: String(props.id ?? `a${i}`),
          side: String(props.side || 'ru') === 'ua' ? 'ua' : 'ru',
          coords: roundCoords(g.coordinates) as [number, number][],
          label: typeof props.label === 'string' ? props.label : undefined,
        });
      } else {
        features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { ...g, coordinates: roundCoords(g.coordinates) } as GeoJSON.Geometry });
      }
    }
  });
  if (!features.length) throw new Error('В GeoJSON нет полигонов или линий');
  return { geojson: { type: 'FeatureCollection', features }, arrows };
}

export async function importFrontFromUrl(url: string) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Только http(s) ссылки');
  const res = await fetch(u, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'RadarBot/1.0' } });
  if (!res.ok) throw new Error(`Источник ответил ${res.status}`);
  const text = await res.text();
  if (text.length > 40_000_000) throw new Error('Файл слишком большой');
  const { geojson, arrows } = normalizeFrontGeoJson(JSON.parse(text));
  const prev = getFront();
  const saved = saveFront({
    geojson,
    arrows: arrows.length ? arrows : prev.isDemo ? [] : prev.arrows,
    source: u.host,
    isDemo: false,
    note: null,
  });
  setJson(CONFIG_KEY, { ...getFrontConfig(), lastError: null, lastImportAt: Date.now() });
  return saved;
}

let timer: NodeJS.Timeout | null = null;
export function scheduleFrontRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
  const cfg = getFrontConfig();
  if (!cfg.sourceUrl || cfg.autoRefreshMin <= 0) return;
  timer = setInterval(
    () =>
      importFrontFromUrl(cfg.sourceUrl).catch((e) =>
        setJson(CONFIG_KEY, { ...getFrontConfig(), lastError: String(e?.message || e) }),
      ),
    Math.max(5, cfg.autoRefreshMin) * MIN,
  );
  timer.unref();
}
