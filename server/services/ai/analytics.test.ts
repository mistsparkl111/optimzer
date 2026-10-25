import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AnalyticsMod from './analytics';
import type * as HeuristicMod from './heuristic';
import type * as LlmMod from './llm';

let A: typeof AnalyticsMod;
let H: typeof HeuristicMod;
let L: typeof LlmMod;

beforeAll(async () => {
  vi.stubEnv('DB_FILE', ':memory:');
  vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'radar-ai-')));
  A = await import('./analytics');
  H = await import('./heuristic');
  L = await import('./llm');
});

const NOW = Date.parse('2026-10-25T12:00:00Z'); // 15:00 MSK
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const alert = (regionId: string, ago: number, durMin: number | null = 30, type = 'uav') => ({
  regionId,
  type,
  startedAt: NOW - ago,
  endedAt: durMin === null ? null : NOW - ago + durMin * MIN,
});
const empty = { alerts: [], reports: [], posts: [] };

describe('analyze on an empty database', () => {
  it('covers all regions with zeros and no NaN', () => {
    const a = A.analyze(empty, NOW);
    expect(Object.keys(a.regions)).toHaveLength(89);
    expect(a.historyDays).toBe(0);
    expect(a.national.alerts24h).toBe(0);
    expect(a.national.nightShare).toBe(0);
    expect(a.transitions).toEqual([]);
    expect(JSON.stringify(a)).not.toMatch(/NaN|null,null/);
  });

  it('heuristic forecast: low risks, honest low-data note', () => {
    const f = H.heuristicForecast(A.analyze(empty, NOW));
    expect(f.status).toBe('heuristic');
    expect(f.modelLabel).toBe('Алгоритм Радара');
    expect(f.regions).toHaveLength(89);
    expect(new Set(f.regions.map((r) => r.regionId)).size).toBe(89);
    expect(Math.max(...f.regions.map((r) => r.risk))).toBeLessThan(25);
    expect(f.regions.every((r) => Number.isFinite(r.risk) && r.risk >= 0 && r.risk <= 100)).toBe(true);
    expect(f.overall.level).toBe('low');
    expect(f.confidenceNote).toMatch(/Мало данных/);
    expect(f.vectors).toEqual([]);
    expect(f.horizon.to - f.horizon.from).toBe(DAY);
    expect(JSON.stringify(f)).not.toContain('NaN');
    // frontier regions carry the small prior
    const bel = f.regions.find((r) => r.regionId === 'BEL')!;
    const alt = f.regions.find((r) => r.regionId === 'ALT')!;
    expect(bel.risk).toBeGreaterThan(alt.risk);
  });
});

describe('episodes and counts', () => {
  it('merges overlapping and adjacent alerts of one region into an episode', () => {
    const eps = A.buildEpisodes(
      [alert('BEL', 3 * HOUR, 60), alert('BEL', 3 * HOUR - 20 * MIN, 30, 'air'), alert('BEL', 3 * HOUR - 70 * MIN, 10), alert('BEL', HOUR, 20)],
      NOW,
    );
    expect(eps).toHaveLength(2);
    expect(eps[0]!.types.get('air')).toBe(1);
  });

  it('counts windows, hourly histogram (MSK) and active alerts', () => {
    const a = A.analyze(
      {
        ...empty,
        alerts: [
          alert('BEL', 30 * MIN, null), // active, 14:30 MSK
          alert('KRS', 2 * HOUR),
          alert('KRS', 20 * HOUR),
          alert('KRS', 30 * HOUR),
          alert('KRS', 5 * DAY),
          alert('BRY', 9 * DAY),
        ],
      },
      NOW,
    );
    const krs = a.regions.KRS!;
    expect([krs.alerts1h, krs.alerts3h, krs.alerts24h, krs.alertsPrev24h, krs.alerts7d]).toEqual([0, 1, 2, 1, 4]);
    expect(a.regions.BEL!.activeTypes).toEqual(['uav']);
    expect(a.regions.BEL!.hourly[14]).toBe(1);
    expect(a.national.activeRegions).toBe(1);
    expect(a.national.alerts7d).toBe(5);
    expect(a.historyDays).toBeCloseTo(9, 0);
  });
});

describe('transitions', () => {
  // Belgorod is alerted 35 min before Kursk in every wave; Voronezh 35 min before Belgorod in the first two.
  const waves = Array.from({ length: 5 }, (_, i) => i).flatMap((i) => {
    const t = (i + 1) * 20 * HOUR + 3 * HOUR;
    return [alert('KRS', t, 40), alert('BEL', t + 35 * MIN, 40), ...(i < 2 ? [alert('VOR', t + 70 * MIN, 30)] : [])];
  });

  it('computes counts, conditional probability and median lag', () => {
    const a = A.analyze({ ...empty, alerts: waves }, NOW);
    expect(a.transitions.find((x) => x.from === 'KRS' && x.to === 'BEL')).toBeUndefined(); // never in this order
    const rev = a.transitions.find((x) => x.from === 'BEL' && x.to === 'KRS')!;
    expect(rev.count).toBe(5);
    expect(rev.fromCount).toBe(5);
    expect(rev.p).toBe(1);
    expect(rev.medianLagMin).toBe(35);
    const vor = a.transitions.find((x) => x.from === 'VOR' && x.to === 'BEL')!;
    expect(vor.count).toBe(2);
    expect(vor.p).toBe(1);
  });

  it('turns strong transitions from an active region into pattern vectors and inflow risk', () => {
    const quiet = A.analyze({ ...empty, alerts: waves }, NOW);
    const live = A.analyze({ ...empty, alerts: [...waves, alert('BEL', 10 * MIN, null)] }, NOW);
    const fq = H.heuristicForecast(quiet);
    const fl = H.heuristicForecast(live);
    const krsQuiet = fq.regions.find((r) => r.regionId === 'KRS')!;
    const krsLive = fl.regions.find((r) => r.regionId === 'KRS')!;
    expect(krsLive.risk).toBeGreaterThan(krsQuiet.risk);
    const vec = fl.vectors.find((v) => v.id === 'pattern:BEL>KRS')!;
    expect(vec).toBeDefined();
    expect(vec.basis).toBe('pattern');
    expect(vec.window).toMatch(/ближайшие/);
    expect(vec.from).toEqual(expect.any(Array));
    expect(new Set(fl.vectors.map((v) => v.id)).size).toBe(fl.vectors.length);
  });
});

describe('heuristic forecast', () => {
  it('forces risk ≥ 85 for regions with an active alert', () => {
    const f = H.heuristicForecast(A.analyze({ ...empty, alerts: [alert('SPE', 5 * MIN, null, 'missile')] }, NOW));
    const spe = f.regions.find((r) => r.regionId === 'SPE')!;
    expect(spe.risk).toBeGreaterThanOrEqual(85);
    expect(spe.level).toBe('critical');
    expect(spe.reason).toMatch(/Сейчас действует тревога/);
    expect(f.summaryToday).toMatch(/Сейчас тревога действует/);
    expect(f.recommendations[0]).toMatch(/укрытие/);
  });

  it('uses the 7-day rate with a bounded trend multiplier', () => {
    const steady = Array.from({ length: 14 }, (_, i) => alert('ROS', (i + 1) * 12 * HOUR - HOUR));
    const f = H.heuristicForecast(A.analyze({ ...empty, alerts: steady }, NOW));
    const ros = f.regions.find((r) => r.regionId === 'ROS')!;
    expect(ros.risk).toBeGreaterThan(60);
    expect(ros.risk).toBeLessThanOrEqual(99);
    expect(ros.peakHours).toMatch(/^\d{2}:00–\d{2}:00 МСК$/);
  });

  it('adds small contributions from source mentions and intercepts', () => {
    const base = H.heuristicForecast(A.analyze(empty, NOW)).regions.find((r) => r.regionId === 'TUL')!.risk;
    const posts = [1, 2].map((id) => ({
      sourceId: id,
      postedAt: NOW - HOUR,
      signals: { threats: ['uav' as const], allClear: false, isThreatNotice: true, regions: ['TUL'], intercepts: [{ regionId: 'TUL', count: 5, type: 'uav' as const }] },
    }));
    const f = H.heuristicForecast(A.analyze({ ...empty, posts }, NOW));
    const tul = f.regions.find((r) => r.regionId === 'TUL')!;
    expect(tul.risk).toBeGreaterThan(base + 10);
    expect(tul.risk).toBeLessThan(60);
    expect(f.stats.postsAnalyzed).toBe(2);
    expect(f.stats.sourcesUsed).toBe(2);
  });

  it('peakWindow finds the best cyclic 6-hour window', () => {
    const hist = new Array(24).fill(0);
    [22, 23, 0, 1, 2].forEach((h) => (hist[h] = 3));
    expect(H.peakWindow(hist)).toBe('22:00–04:00 МСК');
    expect(H.peakWindow(new Array(24).fill(0))).toBeNull();
  });
});

describe('report vectors', () => {
  it('extrapolates an explicit heading and resolves regions', () => {
    const a = A.analyze(
      { ...empty, reports: [{ id: 1, type: 'uav', lat: 51.7, lon: 36.2, regionId: 'KRS', heading: 0, count: 3, createdAt: NOW - 10 * MIN }] },
      NOW,
    );
    expect(a.reportVectors).toHaveLength(1);
    const v = a.reportVectors[0]!;
    expect(v.fromRegionId).toBe('KRS');
    expect(v.pathRegionIds).toContain('ORL');
    expect(v.to[1]).toBeGreaterThan(53);
    const f = H.heuristicForecast(a);
    expect(f.vectors.some((x) => x.basis === 'reports')).toBe(true);
    expect(f.regions.find((r) => r.regionId === 'ORL')!.risk).toBeGreaterThan(f.regions.find((r) => r.regionId === 'ALT')!.risk);
  });

  it('derives a heading from a sequence of marks', () => {
    const reports = [
      { id: 1, type: 'uav', lat: 50.6, lon: 36.6, regionId: 'BEL', heading: null, count: null, createdAt: NOW - 50 * MIN },
      { id: 2, type: 'uav', lat: 51.0, lon: 36.5, regionId: 'BEL', heading: null, count: null, createdAt: NOW - 30 * MIN },
      { id: 3, type: 'uav', lat: 51.5, lon: 36.4, regionId: 'KRS', heading: null, count: null, createdAt: NOW - 10 * MIN },
    ];
    const a = A.analyze({ ...empty, reports }, NOW);
    const v = a.reportVectors.find((x) => x.kind === 'sequence')!;
    expect(v).toBeDefined();
    expect(v.reportCount).toBe(3);
    expect(v.heading).toBeGreaterThan(340);
    expect(v.heading <= 360 || v.heading < 10).toBe(true);
  });
});

describe('llm JSON extraction', () => {
  it('strips code fences and surrounding prose', () => {
    expect(L.extractJson('Вот прогноз:\n```json\n{"a": 1, "b": [1,2]}\n```\nУдачи')).toEqual({ a: 1, b: [1, 2] });
    expect(L.extractJson('текст {"x": {"y": "}"}} хвост')).toEqual({ x: { y: '}' } });
  });

  it('repairs output truncated by the token limit', () => {
    const cut = '{"summaryToday":"ok","regions":[{"regionId":"BEL","risk":80},{"regionId":"KRS","risk":7';
    const r = L.extractJson(cut) as { summaryToday: string; regions: { regionId: string; risk?: number }[] };
    expect(r.summaryToday).toBe('ok');
    expect(r.regions[0]).toEqual({ regionId: 'BEL', risk: 80 });
    expect(r.regions.slice(1).every((x) => x.risk === undefined)).toBe(true); // a half-written entry is kept without its value
    expect(() => L.extractJson('никакого json')).toThrow();
  });
});
