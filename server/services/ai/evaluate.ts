// Scores finished forecasts against what actually happened so the models (and the prompt) can be calibrated.
import { db } from '../../db';
import { parseJson } from '../../util';
import type { Forecast } from '../../../shared/types';

export interface ForecastEval {
  /** Mean squared error of risk/100 against the 0/1 outcome over all regions (0 = perfect). */
  brier: number;
  /** Share of regions with risk ≥ 50 that had an alert; null when no region was flagged. */
  hitRate: number | null;
  /** Share of regions that had an alert but were forecast below 25; null when nothing happened. */
  missRate: number | null;
  /** Regions scored. */
  n: number;
  flagged: number;
  positives: number;
  topErrors: { regionId: string; risk: number; outcome: 0 | 1 }[];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function scoreForecast(regions: { regionId: string; risk: number }[], outcomes: Set<string>): ForecastEval {
  let sq = 0;
  let flagged = 0;
  let hits = 0;
  let positives = 0;
  let misses = 0;
  const errs: { regionId: string; risk: number; outcome: 0 | 1; err: number }[] = [];
  for (const r of regions) {
    const o: 0 | 1 = outcomes.has(r.regionId) ? 1 : 0;
    const p = Math.min(1, Math.max(0, r.risk / 100));
    sq += (p - o) ** 2;
    if (r.risk >= 50) {
      flagged++;
      if (o) hits++;
    }
    if (o) {
      positives++;
      if (r.risk < 25) misses++;
    }
    errs.push({ regionId: r.regionId, risk: r.risk, outcome: o, err: Math.abs(p - o) });
  }
  errs.sort((a, b) => b.err - a.err);
  return {
    brier: regions.length ? r4(sq / regions.length) : 0,
    hitRate: flagged ? r4(hits / flagged) : null,
    missRate: positives ? r4(misses / positives) : null,
    n: regions.length,
    flagged,
    positives,
    topErrors: errs.slice(0, 10).map(({ regionId, risk, outcome }) => ({ regionId, risk, outcome })),
  };
}

/** Regions that had an official alert in [from, to) (or one still running at `from`) or ≥ 2 user marks. */
export function outcomesBetween(from: number, to: number): Set<string> {
  const out = new Set<string>();
  const alerts = db
    .prepare('SELECT DISTINCT region_id FROM alerts WHERE started_at < ? AND (started_at >= ? OR ended_at IS NULL OR ended_at >= ?)')
    .all(to, from, from) as { region_id: string }[];
  for (const a of alerts) out.add(a.region_id);
  const reports = db
    .prepare(
      `SELECT region_id FROM reports WHERE created_at >= ? AND created_at < ? AND removed = 0 AND region_id IS NOT NULL
       GROUP BY region_id HAVING COUNT(*) >= 2`,
    )
    .all(from, to) as { region_id: string }[];
  for (const r of reports) out.add(r.region_id);
  return out;
}

/** Evaluate forecasts whose horizon has ended. Returns how many were scored. */
export function evaluatePending(now = Date.now(), limit = 200): number {
  const rows = db
    .prepare(
      `SELECT id, horizon_from, horizon_to, data FROM forecasts
       WHERE eval IS NULL AND horizon_to <= ? AND status IN ('ok', 'heuristic') ORDER BY id LIMIT ?`,
    )
    .all(now, limit) as { id: number; horizon_from: number; horizon_to: number; data: string }[];
  const upd = db.prepare('UPDATE forecasts SET eval = ? WHERE id = ?');
  let done = 0;
  for (const row of rows) {
    const regions = parseJson<Partial<Forecast>>(row.data, {}).regions ?? [];
    const ev = scoreForecast(regions, outcomesBetween(row.horizon_from, row.horizon_to));
    upd.run(JSON.stringify(ev), row.id);
    done++;
  }
  return done;
}
