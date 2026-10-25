import { z } from 'zod';
import { db } from '../../db';
import { bus } from '../../bus';
import { decrypt } from '../../crypto';
import { getSetting } from '../../settings';
import { parseJson } from '../../util';
import { riskLevel } from '../../../shared/constants';
import { REGION_BY_ID, isRegionId } from '../../../shared/regions';
import type { Forecast, ForecastEvent, ForecastRegion, ForecastVector } from '../../../shared/types';
import { computeAnalytics, type Analytics } from './analytics';
import { computeOverall, heuristicForecast } from './heuristic';
import { chatCompletion, extractJson, LlmError } from './llm';
import { getUsableModel, type UsableModel } from './models';
import { buildPrompt, selectPosts, type PromptPost } from './prompt';

export const LLM_WEIGHT = 0.65;

/* ---------- storage ---------- */

interface ForecastRow {
  id: number;
  model_id: number | null;
  model_label: string;
  status: Forecast['status'];
  created_at: number;
  horizon_from: number;
  horizon_to: number;
  data: string;
  error: string | null;
  tokens: number | null;
  eval: string | null;
  debug: string | null;
}

export function rowToForecast(row: ForecastRow): Forecast {
  const data = parseJson<Partial<Forecast>>(row.data, {});
  return {
    ...(data as Forecast),
    id: row.id,
    modelId: row.model_id,
    modelLabel: row.model_label,
    createdAt: row.created_at,
    status: row.status,
    horizon: { from: row.horizon_from, to: row.horizon_to },
    error: row.error,
  };
}

export function storeForecast(f: Forecast, extra: { tokens?: number | null; debug?: unknown } = {}): Forecast {
  const info = db
    .prepare(
      `INSERT INTO forecasts (model_id, model_label, status, created_at, horizon_from, horizon_to, data, error, tokens, debug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      f.modelId,
      f.modelLabel,
      f.status,
      f.createdAt,
      f.horizon.from,
      f.horizon.to,
      JSON.stringify(f),
      f.error ?? null,
      extra.tokens ?? null,
      extra.debug === undefined ? null : JSON.stringify(extra.debug),
    );
  return { ...f, id: Number(info.lastInsertRowid) };
}

export function latestForecastRow(modelId: number | null, status?: Forecast['status']): ForecastRow | undefined {
  return db
    .prepare(
      `SELECT * FROM forecasts WHERE model_id IS ? ${status ? 'AND status = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(...(status ? [modelId, status] : [modelId])) as ForecastRow | undefined;
}

/* ---------- heuristic ---------- */

export function generateHeuristic(now = Date.now(), analytics?: Analytics): Forecast {
  const f = heuristicForecast(analytics ?? computeAnalytics(now));
  const stored = storeForecast(f);
  bus.publish({ type: 'forecast', modelId: null, forecastId: stored.id });
  return stored;
}

/* ---------- LLM reply validation ---------- */

const numLike = z.preprocess(
  (v) => (typeof v === 'string' ? Number.parseFloat(v.replace(',', '.').replace('%', '')) : v),
  z.number().refine(Number.isFinite),
);
const str = (max: number) => z.string().transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max));

const regionItem = z.object({
  regionId: z.string(),
  risk: numLike,
  trend: z.string().optional().catch(undefined),
  reason: str(300).optional().catch(undefined),
  peakHours: str(40).nullable().optional().catch(undefined),
});
const vectorItem = z.object({
  type: z.string(),
  fromRegionId: z.string(),
  toRegionId: z.string(),
  confidence: numLike.optional().catch(undefined),
  window: str(80).optional().catch(undefined),
  note: str(300).optional().catch(undefined),
});
const eventItem = z.object({
  time: z.union([z.string(), z.number()]).nullable().optional().catch(undefined),
  text: str(320),
  sourceIds: z.array(numLike).catch([]),
  regionIds: z.array(z.string()).catch([]),
});
const llmSchema = z.object({
  summaryToday: z.string().catch(''),
  outlookTomorrow: z.string().catch(''),
  overall: z.object({ level: z.string().catch(''), score: numLike.optional().catch(undefined) }).catch({ level: '' }),
  regions: z.array(z.unknown()).catch([]),
  vectors: z.array(z.unknown()).catch([]),
  events: z.array(z.unknown()).catch([]),
  recommendations: z.array(z.unknown()).catch([]),
  confidenceNote: z.string().catch(''),
});

const alias = (o: unknown, ...pairs: [string, string][]) => {
  if (!o || typeof o !== 'object') return o;
  const r = { ...(o as Record<string, unknown>) };
  for (const [to, from] of pairs) if (r[to] === undefined && r[from] !== undefined) r[to] = r[from];
  return r;
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function vectorType(raw: string): ForecastVector['type'] | null {
  const t = raw.toLowerCase();
  if (t === 'uav' || /бпла|дрон|беспилот|drone/.test(t)) return 'uav';
  if (t === 'missile' || /ракет|rocket/.test(t)) return 'missile';
  if (t === 'aviation' || /авиа/.test(t)) return 'aviation';
  return null;
}

export interface MergeContext {
  prior: Forecast;
  activeIds: Set<string>;
  postIds: Set<number>;
  posts: PromptPost[];
  now: number;
}

export interface MergeNotes {
  regionsReturned: number;
  droppedRegionIds: string[];
  vectorsKept: number;
  eventsKept: number;
  eventsDropped: number;
}

/** Validate the model reply leniently and blend it with the statistical prior. */
export function mergeLlmForecast(reply: unknown, ctx: MergeContext): { forecast: Forecast; notes: MergeNotes } {
  const llm = llmSchema.parse(reply && typeof reply === 'object' ? reply : {});
  const { prior } = ctx;
  const dropped: string[] = [];

  const items = new Map<string, z.infer<typeof regionItem>>();
  for (const raw of llm.regions) {
    const r = regionItem.safeParse(alias(raw, ['regionId', 'region_id'], ['regionId', 'id'], ['regionId', 'region']));
    if (!r.success) continue;
    const id = r.data.regionId.trim().toUpperCase();
    if (!isRegionId(id)) {
      dropped.push(r.data.regionId);
      continue;
    }
    items.set(id, { ...r.data, regionId: id });
  }
  const asFraction = items.size >= 3 && [...items.values()].every((r) => r.risk <= 1);

  const regions: ForecastRegion[] = prior.regions.map((p) => {
    const m = items.get(p.regionId);
    let risk = p.risk;
    let trend = p.trend;
    let reason = p.reason;
    let peakHours = p.peakHours ?? null;
    if (m) {
      const llmRisk = clamp(Math.round(asFraction ? m.risk * 100 : m.risk), 0, 100);
      risk = Math.round(LLM_WEIGHT * llmRisk + (1 - LLM_WEIGHT) * p.risk);
      if (m.trend === 'up' || m.trend === 'down' || m.trend === 'flat') trend = m.trend;
      if (m.reason) reason = m.reason;
      if (m.peakHours !== undefined) peakHours = m.peakHours && m.peakHours.toLowerCase() !== 'null' ? m.peakHours : (p.peakHours ?? null);
    }
    if (ctx.activeIds.has(p.regionId)) risk = Math.max(risk, 85, p.risk);
    risk = clamp(risk, 0, 100);
    return { regionId: p.regionId, risk, level: riskLevel(risk), trend, reason, peakHours };
  });
  regions.sort((a, b) => b.risk - a.risk || a.regionId.localeCompare(b.regionId));

  const computed = computeOverall(regions);
  let overall = computed;
  if (llm.overall.score !== undefined) {
    const s = llm.overall.score <= 1 && computed.score > 5 ? llm.overall.score * 100 : llm.overall.score;
    const score = clamp(Math.round(0.5 * s + 0.5 * computed.score), 0, 100);
    overall = { level: riskLevel(score), score };
  }

  // Vectors: model first (mapped to region label points), then the prior's pattern/report vectors.
  const vectors: ForecastVector[] = [];
  const seen = new Set<string>();
  for (const raw of llm.vectors) {
    const v = vectorItem.safeParse(alias(raw, ['fromRegionId', 'from'], ['toRegionId', 'to'], ['fromRegionId', 'from_region_id'], ['toRegionId', 'to_region_id']));
    if (!v.success) continue;
    const type = vectorType(v.data.type);
    const from = REGION_BY_ID.get(v.data.fromRegionId.trim().toUpperCase());
    const to = REGION_BY_ID.get(v.data.toRegionId.trim().toUpperCase());
    if (!type || !from || !to || from.id === to.id) continue;
    const key = `${from.id}>${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let conf = v.data.confidence ?? 0.4;
    if (conf > 1) conf /= 100;
    vectors.push({
      id: `model:${type}:${key}`,
      type,
      from: from.label,
      to: to.label,
      fromRegionId: from.id,
      toRegionId: to.id,
      confidence: Math.round(clamp(conf, 0, 1) * 100) / 100,
      window: v.data.window || 'в ближайшие часы',
      note: v.data.note || '',
      basis: 'model',
    });
    if (vectors.length >= 10) break;
  }
  const modelVectors = vectors.length;
  for (const pv of prior.vectors) {
    const key = `${pv.fromRegionId}>${pv.toRegionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vectors.push(pv);
    if (vectors.length >= 20) break;
  }

  const events: ForecastEvent[] = [];
  let eventsDropped = 0;
  for (const raw of llm.events) {
    const e = eventItem.safeParse(raw);
    if (!e.success) {
      eventsDropped++;
      continue;
    }
    const sourceIds = [...new Set(e.data.sourceIds.map(Math.round).filter((id) => ctx.postIds.has(id)))];
    if (!sourceIds.length || !e.data.text) {
      eventsDropped++;
      continue;
    }
    let time: number | null = null;
    if (e.data.time !== null && e.data.time !== undefined) {
      const t = typeof e.data.time === 'number' ? e.data.time : Date.parse(e.data.time);
      if (Number.isFinite(t) && t > 0 && t <= ctx.now + 3600_000) time = t < 1e11 ? t * 1000 : t;
    }
    events.push({ time, text: e.data.text, sourceIds, regionIds: [...new Set(e.data.regionIds.map((r) => r.trim().toUpperCase()).filter(isRegionId))] });
    if (events.length >= 15) break;
  }
  events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));

  const recs = llm.recommendations
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.replace(/\s+/g, ' ').trim().slice(0, 240))
    .filter((r) => r.length > 5)
    .slice(0, 8);
  const text = (v: string, fallback: string) => (v.replace(/\s+/g, ' ').trim().length >= 20 ? v.trim().slice(0, 1500) : fallback);

  const forecast: Forecast = {
    ...prior,
    status: 'ok',
    overall,
    summaryToday: text(llm.summaryToday, prior.summaryToday),
    outlookTomorrow: text(llm.outlookTomorrow, prior.outlookTomorrow),
    regions,
    vectors,
    events,
    recommendations: recs.length >= 2 ? recs : prior.recommendations,
    confidenceNote: text(llm.confidenceNote, prior.confidenceNote),
    stats: { ...prior.stats, postsAnalyzed: ctx.posts.length, sourcesUsed: new Set(ctx.posts.map((p) => p.sourceId)).size },
    error: null,
  };
  return { forecast, notes: { regionsReturned: items.size, droppedRegionIds: dropped.slice(0, 20), vectorsKept: modelVectors, eventsKept: events.length, eventsDropped } };
}

/* ---------- generation ---------- */

const running = new Map<string, Promise<Forecast>>();
const keyOf = (modelId: number | null) => (modelId === null ? 'heuristic' : String(modelId));

export const isGenerating = (modelId: number | null) => running.has(keyOf(modelId));

async function runModel(model: UsableModel, now: number): Promise<Forecast> {
  const analytics = computeAnalytics(now);
  const prior = heuristicForecast(analytics);
  const posts = selectPosts(now, getSetting('ai').maxPosts);
  const activeAlerts = Object.values(analytics.regions).flatMap((r) =>
    r.activeTypes.map((type) => ({ regionId: r.regionId, type, startedAt: r.activeSince ?? now })),
  );
  const prompt = buildPrompt({ now, analytics, prior, posts, activeAlerts }, model.id);
  const debug: Record<string, unknown> = {
    model: model.model,
    provider: model.provider_name,
    promptSizes: prompt.sizes,
    temperature: model.temperature,
    maxTokens: model.max_tokens,
  };
  const base: Forecast = { ...prior, modelId: model.id, modelLabel: model.label, createdAt: now };
  let tokens: number | null = null;
  try {
    const res = await chatCompletion({
      baseUrl: model.base_url,
      apiKey: decrypt(model.api_key_enc),
      model: model.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: model.temperature,
      maxTokens: model.max_tokens,
      jsonMode: !!model.json_mode,
    });
    tokens = res.tokens;
    Object.assign(debug, { latencyMs: res.latencyMs, finishReason: res.finishReason, tokens, replyChars: res.content.length, rawReply: res.content.slice(0, 8000) });
    const merged = mergeLlmForecast(extractJson(res.content), {
      prior: base,
      activeIds: new Set(activeAlerts.map((a) => a.regionId)),
      postIds: new Set(posts.map((p) => p.id)),
      posts,
      now,
    });
    debug.merge = merged.notes;
    if (res.finishReason === 'length') debug.warning = 'Ответ обрезан по лимиту токенов — увеличьте max_tokens модели';
    return storeForecast({ ...merged.forecast, status: 'ok' }, { tokens, debug });
  } catch (e) {
    const message = (e instanceof LlmError || e instanceof Error ? e.message : 'Неизвестная ошибка').slice(0, 400);
    debug.error = message;
    return storeForecast({ ...base, status: 'error', error: message }, { tokens, debug });
  }
}

/** Generate and store a forecast. `null` = statistical algorithm only. Concurrent calls per model share one run. */
export function generateForecast(modelId: number | null): Promise<Forecast> {
  const key = keyOf(modelId);
  const existing = running.get(key);
  if (existing) return existing;
  const p = (async () => {
    const now = Date.now();
    try {
      if (modelId === null) return generateHeuristic(now);
      const model = getUsableModel(modelId);
      if (!model) throw new Error('Модель не найдена, отключена или у провайдера нет ключа');
      const f = await runModel(model, now);
      bus.publish({ type: 'forecast', modelId, forecastId: f.id });
      return f;
    } catch (e) {
      console.error('[ai] generateForecast', e);
      throw e;
    }
  })().finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

