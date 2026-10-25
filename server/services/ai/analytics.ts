// Statistical layer of the forecast: everything here is computed from our own data, no LLM involved.
import { db } from '../../db';
import { DAY, HOUR, MIN, mskHour } from '../../util';
import { bearing, destination, distanceKm, regionAt } from '../../geo';
import { REGIONS, REGION_BY_ID } from '../../../shared/regions';
import { readSignals, type PostSignals } from '../sources/parse';

/* ---------- inputs ---------- */

export interface AlertIn {
  regionId: string;
  type: string;
  startedAt: number;
  endedAt: number | null;
}
export interface ReportIn {
  id: number;
  type: string;
  lat: number;
  lon: number;
  regionId: string | null;
  heading: number | null;
  count: number | null;
  createdAt: number;
}
export interface PostIn {
  sourceId: number;
  postedAt: number;
  signals: PostSignals;
}
export interface AnalyticsInputs {
  alerts: AlertIn[];
  reports: ReportIn[];
  posts: PostIn[];
}

/* ---------- outputs ---------- */

export interface RegionAnalytics {
  regionId: string;
  /** Alert episodes (alerts of one region that overlap or follow within 15 min are merged). */
  alerts1h: number;
  alerts3h: number;
  alerts24h: number;
  alertsPrev24h: number;
  alerts7d: number;
  activeTypes: string[];
  activeSince: number | null;
  lastAlertAt: number | null;
  reports3h: number;
  reports24h: number;
  reportsByType: Record<string, number>;
  /** Episode starts by Moscow hour of day over the last 7 days. */
  hourly: number[];
  /** Interceptions reported in sources over 24 h. */
  interceptCount24h: number;
  /** Source posts about a threat in the region over 24 h. */
  mentions24h: number;
  mentionSources24h: number;
}

export interface Transition {
  from: string;
  to: string;
  /** Number of A episodes followed by an alert in B within 0–120 min. */
  count: number;
  fromCount: number;
  /** count / fromCount */
  p: number;
  medianLagMin: number;
  type: 'uav' | 'missile' | 'aviation';
}

export interface ReportVector {
  type: 'uav' | 'missile' | 'aviation';
  from: [number, number];
  to: [number, number];
  fromRegionId: string | null;
  toRegionId: string | null;
  /** Regions on the extrapolated path (150–300 km), excluding the origin. */
  pathRegionIds: string[];
  heading: number;
  reportCount: number;
  lastAt: number;
  kind: 'heading' | 'sequence';
}

export interface NationalAnalytics {
  alerts1h: number;
  alerts24h: number;
  alertsPrev24h: number;
  alerts7d: number;
  activeRegions: number;
  reports24h: number;
  trend: 'up' | 'down' | 'flat';
  trendRatio: number;
  /** Share of episodes that started between 22:00 and 06:00 MSK (0..1). */
  nightShare: number;
  hourly: number[];
  postsAnalyzed: number;
  sourcesUsed: number;
  interceptCount24h: number;
}

export interface Analytics {
  now: number;
  /** Days covered by alert history (0 when there are no alerts at all), max 14. */
  historyDays: number;
  regions: Record<string, RegionAnalytics>;
  transitions: Transition[];
  reportVectors: ReportVector[];
  national: NationalAnalytics;
}

/* ---------- helpers ---------- */

export function safeRegionAt(lon: number, lat: number): string | null {
  try {
    return regionAt(lon, lat);
  } catch {
    return null;
  }
}

export function trendOf(cur: number, prev: number): 'up' | 'down' | 'flat' {
  if (cur >= 2 && cur >= prev * 1.5 && cur > prev) return 'up';
  if (prev >= 2 && cur <= prev * 0.5 && cur < prev) return 'down';
  return 'flat';
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const moving = (t: string): t is 'uav' | 'missile' | 'aviation' => t === 'uav' || t === 'missile' || t === 'aviation';
const alertThreat = (t: string): 'uav' | 'missile' | 'aviation' => (moving(t) ? t : 'uav');

const EPISODE_GAP = 15 * MIN;
const TRANSITION_WINDOW = 120 * MIN;
const TRANSITION_MAX_KM = 700;
const HISTORY_DAYS = 14;

interface Episode {
  regionId: string;
  start: number;
  lastStart: number;
  end: number;
  types: Map<string, number>;
}

export function buildEpisodes(alerts: AlertIn[], now: number): Episode[] {
  const byRegion = new Map<string, AlertIn[]>();
  for (const a of alerts) {
    if (!REGION_BY_ID.has(a.regionId)) continue;
    (byRegion.get(a.regionId) ?? byRegion.set(a.regionId, []).get(a.regionId)!).push(a);
  }
  const out: Episode[] = [];
  for (const [regionId, list] of byRegion) {
    list.sort((a, b) => a.startedAt - b.startedAt);
    let cur: Episode | null = null;
    for (const a of list) {
      const end = a.endedAt ?? now;
      if (cur && a.startedAt <= Math.max(cur.end, cur.lastStart) + EPISODE_GAP) {
        cur.end = Math.max(cur.end, end);
        cur.lastStart = a.startedAt;
        cur.types.set(a.type, (cur.types.get(a.type) ?? 0) + 1);
      } else {
        cur = { regionId, start: a.startedAt, lastStart: a.startedAt, end, types: new Map([[a.type, 1]]) };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function emptyRegion(regionId: string): RegionAnalytics {
  return {
    regionId,
    alerts1h: 0,
    alerts3h: 0,
    alerts24h: 0,
    alertsPrev24h: 0,
    alerts7d: 0,
    activeTypes: [],
    activeSince: null,
    lastAlertAt: null,
    reports3h: 0,
    reports24h: 0,
    reportsByType: {},
    hourly: new Array(24).fill(0),
    interceptCount24h: 0,
    mentions24h: 0,
    mentionSources24h: 0,
  };
}

/* ---------- transitions ---------- */

const pairOk = new Map<string, boolean>();
function nearby(a: string, b: string): boolean {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  let ok = pairOk.get(key);
  if (ok === undefined) {
    const ra = REGION_BY_ID.get(a)!;
    const rb = REGION_BY_ID.get(b)!;
    ok = ra.neighbors.includes(b) || rb.neighbors.includes(a) || distanceKm(ra.label, rb.label) <= TRANSITION_MAX_KM;
    pairOk.set(key, ok);
  }
  return ok;
}

function computeTransitions(episodes: Episode[]): Transition[] {
  const fromCount = new Map<string, number>();
  const pairs = new Map<string, { from: string; to: string; lags: number[]; types: Map<string, number> }>();
  for (let i = 0; i < episodes.length; i++) {
    const a = episodes[i]!;
    fromCount.set(a.regionId, (fromCount.get(a.regionId) ?? 0) + 1);
    const seen = new Set<string>();
    for (let j = i + 1; j < episodes.length; j++) {
      const b = episodes[j]!;
      const lag = b.start - a.start;
      if (lag > TRANSITION_WINDOW) break;
      if (b.regionId === a.regionId || seen.has(b.regionId) || !nearby(a.regionId, b.regionId)) continue;
      seen.add(b.regionId);
      const key = `${a.regionId}>${b.regionId}`;
      const rec = pairs.get(key) ?? pairs.set(key, { from: a.regionId, to: b.regionId, lags: [], types: new Map() }).get(key)!;
      rec.lags.push(lag / MIN);
      for (const [t, n] of a.types) rec.types.set(t, (rec.types.get(t) ?? 0) + n);
    }
  }
  const out: Transition[] = [];
  for (const rec of pairs.values()) {
    const fc = fromCount.get(rec.from) ?? rec.lags.length;
    let best = 'uav';
    let bestN = -1;
    for (const [t, n] of rec.types) if (n > bestN) (best = t), (bestN = n);
    out.push({
      from: rec.from,
      to: rec.to,
      count: rec.lags.length,
      fromCount: fc,
      p: rec.lags.length / fc,
      medianLagMin: Math.round(median(rec.lags)),
      type: alertThreat(best),
    });
  }
  return out.sort((a, b) => b.p * Math.log2(1 + b.count) - a.p * Math.log2(1 + a.count));
}

/* ---------- report vectors ---------- */

function makeVector(
  type: 'uav' | 'missile' | 'aviation',
  from: [number, number],
  heading: number,
  reportCount: number,
  lastAt: number,
  kind: ReportVector['kind'],
  fallbackRegion: string | null,
): ReportVector {
  const samples = [150, 200, 250, 300].map((km) => {
    const pt = destination(from, heading, km);
    return { pt, regionId: safeRegionAt(pt[0], pt[1]) };
  });
  const fromRegionId = safeRegionAt(from[0], from[1]) ?? fallbackRegion;
  const path = [...new Set(samples.map((s) => s.regionId).filter((r): r is string => !!r && r !== fromRegionId))];
  const to = samples[2]!.pt;
  const toRegionId = samples[2]!.regionId ?? samples[1]!.regionId ?? samples[0]!.regionId ?? null;
  return { type, from, to, fromRegionId, toRegionId: toRegionId === fromRegionId ? (path[0] ?? null) : toRegionId, pathRegionIds: path, heading, reportCount, lastAt, kind };
}

function computeReportVectors(reports: ReportIn[], now: number): ReportVector[] {
  const fresh = reports.filter((r) => moving(r.type) && now - r.createdAt <= 3 * HOUR);
  const vectors: ReportVector[] = [];

  for (const r of fresh) {
    if (r.heading !== null && Number.isFinite(r.heading)) {
      vectors.push(makeVector(r.type as 'uav', [r.lon, r.lat], ((r.heading % 360) + 360) % 360, 1, r.createdAt, 'heading', r.regionId));
    }
  }

  // Chains of same-type marks: each next mark ≤ 60 min and ≤ 150 km from the previous one.
  for (const type of ['uav', 'missile', 'aviation'] as const) {
    const list = reports.filter((r) => r.type === type).sort((a, b) => a.createdAt - b.createdAt);
    const chains: ReportIn[][] = [];
    for (const r of list) {
      let best: ReportIn[] | null = null;
      let bestD = Infinity;
      for (const ch of chains) {
        const last = ch[ch.length - 1]!;
        const dt = r.createdAt - last.createdAt;
        if (dt <= 0 || dt > 60 * MIN) continue;
        const d = distanceKm([last.lon, last.lat], [r.lon, r.lat]);
        if (d <= 150 && d < bestD) (best = ch), (bestD = d);
      }
      if (best) best.push(r);
      else chains.push([r]);
    }
    for (const ch of chains) {
      if (ch.length < 2) continue;
      const last = ch[ch.length - 1]!;
      if (now - last.createdAt > 3 * HOUR) continue;
      const first = ch[Math.max(0, ch.length - 3)]!;
      const a: [number, number] = [first.lon, first.lat];
      const b: [number, number] = [last.lon, last.lat];
      if (distanceKm(a, b) < 8) continue;
      vectors.push(makeVector(type, b, bearing(a, b), ch.length, last.createdAt, 'sequence', last.regionId));
    }
  }

  const byKey = new Map<string, ReportVector>();
  for (const v of vectors) {
    if (!v.fromRegionId && !v.toRegionId) continue;
    const key = `${v.type}:${v.fromRegionId}>${v.toRegionId}`;
    const cur = byKey.get(key);
    if (!cur || v.reportCount > cur.reportCount || (v.reportCount === cur.reportCount && v.lastAt > cur.lastAt)) byKey.set(key, v);
  }
  return [...byKey.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 20);
}

/* ---------- main ---------- */

export function analyze(input: AnalyticsInputs, now: number): Analytics {
  const regions: Record<string, RegionAnalytics> = Object.fromEntries(REGIONS.map((r) => [r.id, emptyRegion(r.id)]));
  const episodes = buildEpisodes(input.alerts, now);

  const nationalHourly = new Array<number>(24).fill(0);
  let night = 0;
  let n7 = 0;
  for (const e of episodes) {
    const r = regions[e.regionId]!;
    const age = now - e.start;
    if (age < 0) continue;
    if (age <= HOUR) r.alerts1h++;
    if (age <= 3 * HOUR) r.alerts3h++;
    if (age <= DAY) r.alerts24h++;
    else if (age <= 2 * DAY) r.alertsPrev24h++;
    if (age <= 7 * DAY) {
      r.alerts7d++;
      const h = mskHour(e.start);
      r.hourly[h]!++;
      nationalHourly[h]!++;
      n7++;
      if (h >= 22 || h < 6) night++;
    }
    r.lastAlertAt = Math.max(r.lastAlertAt ?? 0, e.start);
  }
  for (const a of input.alerts) {
    const r = regions[a.regionId];
    if (!r || a.endedAt !== null) continue;
    if (!r.activeTypes.includes(a.type)) r.activeTypes.push(a.type);
    r.activeSince = Math.min(r.activeSince ?? Infinity, a.startedAt);
  }

  for (const rep of input.reports) {
    const r = rep.regionId ? regions[rep.regionId] : undefined;
    if (!r) continue;
    const age = now - rep.createdAt;
    if (age <= DAY) {
      r.reports24h++;
      r.reportsByType[rep.type] = (r.reportsByType[rep.type] ?? 0) + 1;
    }
    if (age <= 3 * HOUR) r.reports3h++;
  }

  const sourcesUsed = new Set<number>();
  const mentionSources = new Map<string, Set<number>>();
  let interceptTotal = 0;
  for (const p of input.posts) {
    if (now - p.postedAt > DAY) continue;
    sourcesUsed.add(p.sourceId);
    for (const i of p.signals.intercepts) {
      interceptTotal += i.count;
      if (i.regionId && regions[i.regionId]) regions[i.regionId]!.interceptCount24h += i.count;
    }
    if (p.signals.allClear || !(p.signals.threats.length || p.signals.intercepts.length)) continue;
    for (const rid of p.signals.regions) {
      const r = regions[rid];
      if (!r) continue;
      r.mentions24h++;
      (mentionSources.get(rid) ?? mentionSources.set(rid, new Set()).get(rid)!).add(p.sourceId);
    }
  }
  for (const [rid, set] of mentionSources) regions[rid]!.mentionSources24h = set.size;

  const regionList = Object.values(regions);
  const sum = (f: (r: RegionAnalytics) => number) => regionList.reduce((s, r) => s + f(r), 0);
  const a24 = sum((r) => r.alerts24h);
  const prev24 = sum((r) => r.alertsPrev24h);
  const ratio = (a24 + 1) / (prev24 + 1);
  const firstAlert = input.alerts.reduce((m, a) => Math.min(m, a.startedAt), Infinity);

  return {
    now,
    historyDays: Number.isFinite(firstAlert) ? Math.min(HISTORY_DAYS, Math.max(0, (now - firstAlert) / DAY)) : 0,
    regions,
    transitions: computeTransitions(episodes),
    reportVectors: computeReportVectors(input.reports, now),
    national: {
      alerts1h: sum((r) => r.alerts1h),
      alerts24h: a24,
      alertsPrev24h: prev24,
      alerts7d: sum((r) => r.alerts7d),
      activeRegions: regionList.filter((r) => r.activeTypes.length).length,
      reports24h: input.reports.filter((r) => now - r.createdAt <= DAY).length,
      trend: ratio >= 1.3 ? 'up' : ratio <= 0.7 ? 'down' : 'flat',
      trendRatio: Math.round(ratio * 100) / 100,
      nightShare: n7 ? night / n7 : 0,
      hourly: nationalHourly,
      postsAnalyzed: input.posts.filter((p) => now - p.postedAt <= DAY).length,
      sourcesUsed: sourcesUsed.size,
      interceptCount24h: interceptTotal,
    },
  };
}

export function loadInputs(now: number): AnalyticsInputs {
  const alerts = (
    db
      .prepare('SELECT region_id, type, started_at, ended_at FROM alerts WHERE started_at >= ? OR ended_at IS NULL')
      .all(now - HISTORY_DAYS * DAY) as { region_id: string; type: string; started_at: number; ended_at: number | null }[]
  ).map((r) => ({ regionId: r.region_id, type: r.type, startedAt: r.started_at, endedAt: r.ended_at }));

  const reports = (
    db
      .prepare('SELECT id, type, lat, lon, region_id, heading, count, created_at FROM reports WHERE created_at >= ? AND removed = 0')
      .all(now - DAY) as {
      id: number;
      type: string;
      lat: number;
      lon: number;
      region_id: string | null;
      heading: number | null;
      count: number | null;
      created_at: number;
    }[]
  ).map((r) => ({ id: r.id, type: r.type, lat: r.lat, lon: r.lon, regionId: r.region_id, heading: r.heading, count: r.count, createdAt: r.created_at }));

  const posts = (
    db
      .prepare(
        `SELECT p.source_id, p.posted_at, p.signals FROM source_posts p JOIN sources s ON s.id = p.source_id
         WHERE p.posted_at >= ? AND s.enabled = 1`,
      )
      .all(now - DAY) as { source_id: number; posted_at: number; signals: string }[]
  ).map((r) => ({ sourceId: r.source_id, postedAt: r.posted_at, signals: readSignals(r.signals) }));

  return { alerts, reports, posts };
}

export function computeAnalytics(now = Date.now()): Analytics {
  return analyze(loadInputs(now), now);
}
