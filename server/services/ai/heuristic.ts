// "Алгоритм Радара": a statistical prior for the next 24 hours, no LLM. Also the base the LLM adjusts.
import { FRONTIER_REGIONS, THREATS, riskLevel, RISK_META, type RiskLevel } from '../../../shared/constants';
import { REGIONS, REGION_BY_ID } from '../../../shared/regions';
import type { Forecast, ForecastRegion, ForecastVector } from '../../../shared/types';
import { DAY, HOUR, mskHour } from '../../util';
import { trendOf, type Analytics, type RegionAnalytics } from './analytics';

export const HEURISTIC_LABEL = 'Алгоритм Радара';
const FRONTIER = new Set(FRONTIER_REGIONS);

/* ---------- small helpers (shared with the prompt builder) ---------- */

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function shortName(id: string): string {
  const r = REGION_BY_ID.get(id);
  if (!r) return id;
  if (r.name.endsWith('область')) return `${r.short} обл.`;
  if (r.name.endsWith('край')) return `${r.short} край`;
  return r.short;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ts: number) => `${pad(mskHour(ts))}:${pad(new Date(ts).getUTCMinutes())}`;

const COMPASS = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;

/** Best contiguous (cyclic) window of `len` hours in a 24-bucket histogram. */
export function peakWindow(hist: number[], len = 6): string | null {
  const total = hist.reduce((s, x) => s + x, 0);
  if (!total) return null;
  let best = -1;
  let start = 0;
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let k = 0; k < len; k++) sum += hist[(s + k) % 24]!;
    // Ties go to the window that begins with activity rather than one padded with an empty hour.
    const score = sum * 10 + (hist[s]! > 0 ? 2 : 0) + (hist[(s + len - 1) % 24]! > 0 ? 1 : 0);
    if (score > best) (best = score), (start = s);
  }
  return `${pad(start)}:00–${pad((start + len) % 24)}:00 МСК`;
}

export function computeOverall(regions: ForecastRegion[]): { level: RiskLevel; score: number } {
  const top = [...regions].sort((a, b) => b.risk - a.risk).slice(0, 3);
  const w = [0.5, 0.3, 0.2];
  const score = Math.round(top.reduce((s, r, i) => s + r.risk * w[i]!, 0));
  return { level: riskLevel(score), score };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/* ---------- region scoring ---------- */

interface RegionScore {
  risk: number;
  rate: number;
  inflow: { from: string; p: number; count: number; of: number; lag: number } | null;
  ext: number;
}

const isFresh = (r: RegionAnalytics, now: number, windowMs: number) =>
  r.activeTypes.length > 0 || (r.lastAlertAt !== null && now - r.lastAlertAt <= windowMs);

export function scoreRegions(a: Analytics): Map<string, RegionScore> {
  const out = new Map<string, RegionScore>();
  const days = Math.min(7, a.historyDays);
  const inflowP = new Map<string, number>();
  const inflowBest = new Map<string, RegionScore['inflow']>();

  for (const t of a.transitions) {
    if (t.count < 2) continue;
    const src = a.regions[t.from];
    if (!src || !isFresh(src, a.now, 2 * HOUR)) continue;
    const p = t.p * (t.count / (t.count + 2));
    inflowP.set(t.to, 1 - (1 - (inflowP.get(t.to) ?? 0)) * (1 - p));
    const best = inflowBest.get(t.to);
    if (!best || p > best.p) inflowBest.set(t.to, { from: t.from, p: t.p, count: t.count, of: t.fromCount, lag: t.medianLagMin });
  }
  const vectorP = new Map<string, number>();
  for (const v of a.reportVectors) {
    const base = clamp(0.2 + 0.1 * Math.min(v.reportCount, 3), 0.2, 0.5);
    v.pathRegionIds.forEach((rid, i) => {
      const p = i === 0 ? base : base * 0.5;
      vectorP.set(rid, 1 - (1 - (vectorP.get(rid) ?? 0)) * (1 - p));
    });
  }

  for (const r of Object.values(a.regions)) {
    const rate = days >= 0.25 ? r.alerts7d / Math.max(days, 1) : 0;
    const mult = days >= 1 ? clamp((r.alerts24h + 1) / (rate + 1), 0.5, 2) : 1;
    const ext = Math.min(0.5, 0.12 * Math.min(r.mentionSources24h, 3) + 0.04 * Math.min(r.interceptCount24h, 15));
    const rep = Math.min(0.9, 0.3 * r.reports3h + 0.05 * Math.max(0, r.reports24h - r.reports3h));
    const lambda = rate * mult + (FRONTIER.has(r.regionId) ? 0.15 : 0.01) + ext + rep;
    const pBase = 1 - Math.exp(-lambda);
    const p = 1 - (1 - pBase) * (1 - (inflowP.get(r.regionId) ?? 0)) * (1 - (vectorP.get(r.regionId) ?? 0));
    let risk = Math.round(clamp(p, 0, 0.99) * 100);
    if (r.activeTypes.length) risk = Math.max(risk, 85 + Math.min(9, (r.activeTypes.length - 1) * 3));
    out.set(r.regionId, { risk, rate, inflow: inflowBest.get(r.regionId) ?? null, ext });
  }
  return out;
}

function reasonFor(r: RegionAnalytics, s: RegionScore, a: Analytics): string {
  const parts: string[] = [];
  if (r.activeTypes.length) {
    const types = r.activeTypes.map((t) => THREATS[t as keyof typeof THREATS]?.label ?? t).join(', ');
    parts.push(`Сейчас действует тревога (${types})${r.activeSince ? ` с ${hhmm(r.activeSince)} МСК` : ''}.`);
  }
  if (r.alerts7d > 0) {
    parts.push(
      `За 24 ч — ${r.alerts24h} ${plural(r.alerts24h, 'тревога', 'тревоги', 'тревог')}, за 7 суток — ${r.alerts7d}${a.historyDays >= 2 ? ` (≈${s.rate.toFixed(1)} в сутки)` : ''}.`,
    );
  } else if (a.historyDays >= 2) {
    parts.push('За последние 7 суток официальных тревог не было.');
  }
  if (s.inflow && s.inflow.p >= 0.15) {
    parts.push(`Возможное продолжение волны: после тревоги в регионе «${shortName(s.inflow.from)}» здесь объявляли в ${Math.round(s.inflow.p * 100)}% случаев.`);
  }
  if (r.mentionSources24h || r.interceptCount24h) {
    const bits: string[] = [];
    if (r.mentionSources24h) bits.push(`упоминаний в источниках: ${r.mentions24h}`);
    if (r.interceptCount24h) bits.push(`сообщено о перехватах: ${r.interceptCount24h}`);
    parts.push(`За сутки ${bits.join(', ')}.`);
  }
  if (r.reports3h) parts.push(`Отметок людей за 3 ч: ${r.reports3h}.`);
  if (!parts.length) parts.push(FRONTIER.has(r.regionId) ? 'Приграничный регион — повышенный фоновый риск.' : 'Фоновый риск: тревоги в регионе бывают редко.');
  return parts.slice(0, 3).join(' ');
}

/* ---------- vectors ---------- */

function patternVectors(a: Analytics): ForecastVector[] {
  const cand = a.transitions.filter((t) => t.p >= 0.25 && t.count >= 2 && REGION_BY_ID.has(t.from) && REGION_BY_ID.has(t.to));
  const fresh: ForecastVector[] = [];
  const typical: ForecastVector[] = [];
  for (const t of cand) {
    const src = a.regions[t.from]!;
    const isNow = isFresh(src, a.now, 3 * HOUR);
    const shrunk = t.p * (t.count / (t.count + 2));
    const v: ForecastVector = {
      id: `pattern:${t.from}>${t.to}`,
      type: t.type,
      from: REGION_BY_ID.get(t.from)!.label,
      to: REGION_BY_ID.get(t.to)!.label,
      fromRegionId: t.from,
      toRegionId: t.to,
      confidence: Math.round(clamp(isNow ? shrunk : shrunk * 0.5, 0.05, 0.9) * 100) / 100,
      window: isNow ? 'в ближайшие 2 часа' : 'если тревога начнётся в регионе-источнике',
      note: `После тревог в регионе «${shortName(t.from)}» в «${shortName(t.to)}» объявляли в ${Math.round(t.p * 100)}% случаев (${t.count} из ${t.fromCount}), медианная задержка ${t.medianLagMin} мин.`,
      basis: 'pattern',
    };
    (isNow ? fresh : typical).push(v);
  }
  const byConf = (x: ForecastVector, y: ForecastVector) => y.confidence - x.confidence;
  return [...fresh.sort(byConf).slice(0, 12), ...typical.sort(byConf).slice(0, 6)];
}

function reportVectors(a: Analytics): ForecastVector[] {
  const out: ForecastVector[] = [];
  a.reportVectors.forEach((v, i) => {
    if (!v.toRegionId && !v.pathRegionIds.length) return;
    const names = v.pathRegionIds.slice(0, 3).map(shortName).join(', ');
    out.push({
      id: `reports:${v.type}:${v.fromRegionId ?? 'x'}>${v.toRegionId ?? 'x'}:${i}`,
      type: v.type,
      from: v.from,
      to: v.to,
      fromRegionId: v.fromRegionId,
      toRegionId: v.toRegionId,
      confidence: Math.round(clamp(v.kind === 'heading' ? 0.35 : 0.3 + 0.1 * v.reportCount, 0.2, 0.7) * 100) / 100,
      window: 'в ближайший час',
      note: `По отметкам людей (${v.reportCount}): ${THREATS[v.type].label.toLowerCase()} движется на ${compass(v.heading)}${names ? `, возможный выход к: ${names}` : ''}. Непроверенные данные.`,
      basis: 'reports',
    });
  });
  return out;
}

/* ---------- texts ---------- */

const RECOMMENDATIONS = [
  'Включите оповещения для своего региона и держите телефон заряженным.',
  'Заранее определите ближайшее укрытие (подвал, паркинг, помещение без окон, правило двух стен) и путь к нему.',
  'При сигнале тревоги пройдите в укрытие и оставайтесь там до отбоя; не снимайте и не публикуйте работу ПВО и последствия.',
  'Держите дома запас воды, документы, аптечку и фонарь.',
  'Опирайтесь на официальные каналы и не распространяйте непроверенные сообщения.',
];

function summaryText(a: Analytics, regions: ForecastRegion[], active: ForecastRegion[]): string {
  const n = a.national;
  const parts: string[] = [];
  if (active.length) {
    const names = active.slice(0, 5).map((r) => shortName(r.regionId)).join(', ');
    parts.push(`Сейчас тревога действует в ${plural(active.length, 'регионе', 'регионах', 'регионах')} (${active.length}): ${names}${active.length > 5 ? ' и других' : ''}.`);
  } else {
    parts.push('Сейчас официальных тревог нет.');
  }
  if (n.alerts24h || n.alertsPrev24h) {
    const cmp = n.trend === 'up' ? 'это выше, чем за предыдущие сутки' : n.trend === 'down' ? 'это ниже, чем за предыдущие сутки' : 'это на уровне предыдущих суток';
    parts.push(`За последние 24 часа зафиксировано ${n.alerts24h} ${plural(n.alerts24h, 'тревога', 'тревоги', 'тревог')} (${n.alertsPrev24h} за предыдущие сутки) — ${cmp}.`);
  } else if (a.historyDays >= 1) {
    parts.push('За последние двое суток официальных тревог не зафиксировано.');
  } else {
    parts.push('Данных об официальных тревогах пока мало — оценка опирается на базовые значения для приграничных регионов.');
  }
  const top = regions.slice(0, 3).filter((r) => r.risk >= 10);
  if (top.length) parts.push(`Наибольший риск на ближайшие 24 часа: ${top.map((r) => `${shortName(r.regionId)} — ${r.risk}%`).join(', ')}.`);
  if (n.reports24h) parts.push(`Людьми отмечено ${n.reports24h} ${plural(n.reports24h, 'событие', 'события', 'событий')} (не проверено).`);
  return parts.join(' ');
}

function outlookText(a: Analytics, overall: { level: RiskLevel }): string {
  const n = a.national;
  const parts: string[] = [];
  if (n.alerts7d >= 10) {
    const peak = peakWindow(n.hourly);
    parts.push(`По статистике 7 суток около ${Math.round(n.nightShare * 100)}% тревог приходится на ночные часы (22:00–06:00 МСК).`);
    if (peak) parts.push(`Самое активное окно — ${peak}.`);
    const tone = n.trend === 'up' ? 'возможно дальнейшее усиление' : n.trend === 'down' ? 'вероятно снижение активности' : 'ожидается уровень, близкий к сегодняшнему';
    parts.push(`На завтра ${tone}; общий уровень риска — «${RISK_META[overall.level].label.toLowerCase()}».`);
  } else {
    parts.push(`Для прогноза на завтра накоплено слишком мало данных; ориентируйтесь на общий уровень риска — «${RISK_META[overall.level].label.toLowerCase()}».`);
  }
  return parts.join(' ');
}

/* ---------- entry point ---------- */

export function heuristicForecast(a: Analytics): Forecast {
  const scores = scoreRegions(a);
  const regions: ForecastRegion[] = REGIONS.map((reg) => {
    const r = a.regions[reg.id]!;
    const s = scores.get(reg.id)!;
    const active = r.activeTypes.length > 0;
    const trend = active ? (r.activeSince && a.now - r.activeSince <= 3 * HOUR ? 'up' : 'flat') : trendOf(r.alerts24h, r.alertsPrev24h);
    const peak = r.alerts7d >= 3 ? peakWindow(r.hourly) : a.national.alerts7d >= 10 ? peakWindow(a.national.hourly) : null;
    return { regionId: reg.id, risk: s.risk, level: riskLevel(s.risk), trend, reason: reasonFor(r, s, a), peakHours: peak };
  }).sort((x, y) => y.risk - x.risk || x.regionId.localeCompare(y.regionId));

  const overall = computeOverall(regions);
  const active = regions.filter((r) => a.regions[r.regionId]!.activeTypes.length > 0);
  const n = a.national;
  const mkVec = [...patternVectors(a), ...reportVectors(a)];
  const seen = new Set<string>();
  const vectors = mkVec.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));

  const confidenceNote =
    a.historyDays < 1 || n.alerts7d < 5
      ? `Мало данных: за ${a.historyDays < 1 ? 'последние сутки' : `${Math.floor(a.historyDays)} сут.`} в базе ${n.alerts7d} ${plural(n.alerts7d, 'тревога', 'тревоги', 'тревог')}. Оценка ориентировочная и опирается на базовые значения.`
      : `Оценка построена по данным за 7 суток (тревог: ${n.alerts7d}, источников: ${n.sourcesUsed}, постов: ${n.postsAnalyzed}). Это вероятностная модель, неожиданные события она не учитывает.`;

  return {
    id: 0,
    modelId: null,
    modelLabel: HEURISTIC_LABEL,
    createdAt: a.now,
    status: 'heuristic',
    horizon: { from: a.now, to: a.now + DAY },
    overall,
    summaryToday: summaryText(a, regions, active),
    outlookTomorrow: outlookText(a, overall),
    regions,
    vectors,
    events: [],
    recommendations: active.length
      ? ['Если вы в регионе с действующей тревогой — немедленно пройдите в укрытие и оставайтесь там до отбоя.', ...RECOMMENDATIONS]
      : RECOMMENDATIONS,
    confidenceNote,
    stats: {
      alerts24h: n.alerts24h,
      reports24h: n.reports24h,
      activeRegions: n.activeRegions,
      postsAnalyzed: n.postsAnalyzed,
      sourcesUsed: n.sourcesUsed,
    },
  };
}

