import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../../auth';
import { db } from '../../db';
import { decrypt, encrypt, maskSecret } from '../../crypto';
import { getSetting } from '../../settings';
import { body, fail, HOUR, MIN, parseJson } from '../../util';
import { isPlus } from '../../users';
import type { AiModelPublic, Forecast, ForecastResponse } from '../../../shared/types';
import { computeAnalytics } from './analytics';
import { evaluatePending, type ForecastEval } from './evaluate';
import { generateForecast, generateHeuristic, isGenerating, latestForecastRow, rowToForecast } from './forecast';
import { heuristicForecast, HEURISTIC_LABEL } from './heuristic';
import { chatCompletion, listRemoteModels, LlmError } from './llm';
import { defaultModel, isAiConfigured, usableModels, type ModelRow, type ProviderRow } from './models';

export { isAiConfigured };

const HEURISTIC_MAX_AGE = 3 * HOUR;

/* ====================================================================== */
/* Public routes (/api/ai)                                                */
/* ====================================================================== */

export const aiRoutes = new Hono<AppEnv>();

const isStaff = (u: { role: string } | null | undefined) => !!u && u.role !== 'user';

function freshHeuristic(): Forecast | null {
  const row = latestForecastRow(null);
  if (row && Date.now() - row.created_at <= HEURISTIC_MAX_AGE) return rowToForecast(row);
  try {
    return generateHeuristic();
  } catch (e) {
    console.error('[ai] heuristic', e);
    return row ? rowToForecast(row) : null;
  }
}

aiRoutes.get('/forecast', (c) => {
  const user = c.get('user');
  const staff = isStaff(user);
  const all = usableModels();
  const def = all[0] ?? null;
  const canChoose = getSetting('ai').userCanChoose || staff;
  const wanted = Number(c.req.query('model'));
  const chosen = canChoose && Number.isInteger(wanted) && wanted > 0 ? (all.find((m) => m.id === wanted) ?? def) : def;

  let forecast: Forecast | null = null;
  if (chosen) {
    const row = latestForecastRow(chosen.id, 'ok');
    if (row) forecast = rowToForecast(row);
  }
  forecast ??= freshHeuristic();

  const toPublic = (m: (typeof all)[number]): AiModelPublic => ({ id: m.id, label: m.label, provider: m.provider_name, isDefault: m.id === def?.id });
  const res: ForecastResponse = {
    forecast,
    models: (canChoose ? all : def ? [def] : []).map(toPublic),
    aiConfigured: all.length > 0,
    canRefresh: all.length > 0 && (isPlus(user) || staff),
    refreshing: isGenerating(chosen?.id ?? null),
  };
  return c.json(res);
});

let heuristicCache: { at: number; value: Forecast } | null = null;
aiRoutes.get('/heuristic', (c) => {
  const t = Date.now();
  if (!heuristicCache || t - heuristicCache.at > 60_000) heuristicCache = { at: t, value: heuristicForecast(computeAnalytics(t)) };
  return c.json(heuristicCache.value);
});

const lastRefresh = new Map<number, number>();

aiRoutes.post('/forecast/refresh', async (c) => {
  const user = requireUser(c);
  const staff = isStaff(user);
  if (!staff && !isPlus(user)) fail(403, 'Обновлять прогноз могут только подписчики Радар+');
  const d = await body(c, z.object({ modelId: z.number({ error: 'число' }).int().nullable().optional() }));
  const all = usableModels();
  if (!all.length) fail(503, 'ИИ-модели пока не настроены администратором');

  const ai = getSetting('ai');
  const t = Date.now();
  const cooldown = ai.refreshCooldownMin * MIN;
  const last = lastRefresh.get(user.id) ?? 0;
  if (!staff && cooldown > 0 && t - last < cooldown) {
    const left = Math.ceil((last + cooldown - t) / MIN);
    fail(429, `Прогноз можно обновлять раз в ${ai.refreshCooldownMin} мин. Попробуйте через ${left} мин.`);
  }

  const canChoose = ai.userCanChoose || staff;
  const model = canChoose && d.modelId ? all.find((m) => m.id === d.modelId) : all[0];
  if (!model) fail(400, 'Выбранная модель недоступна');

  lastRefresh.set(user.id, t);
  generateForecast(model.id).catch((e) => console.error('[ai] refresh', e));
  return c.json({ started: true });
});

/* ====================================================================== */
/* Admin routes (/api/admin: /ai/*, /forecasts/*)                         */
/* ====================================================================== */

export const adminAiRoutes = new Hono<AppEnv>();

const normalizeBaseUrl = (raw: string): string => {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return fail(400, 'baseUrl: укажите полный адрес, например https://api.openai.com/v1');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(400, 'baseUrl: поддерживаются только http:// и https://');
  return u.toString().replace(/\/+$/, '');
};

const idOf = (c: { req: { param: (k: string) => string } }, what: string): number => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) fail(404, `${what} не найден`);
  return id;
};

const providerPublic = (p: ProviderRow, models: ModelRow[]) => {
  const key = decrypt(p.api_key_enc);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    hasKey: !!key,
    keyMasked: maskSecret(key),
    jsonMode: !!p.json_mode,
    enabled: !!p.enabled,
    models: models
      .filter((m) => m.provider_id === p.id)
      .map((m) => ({
        id: m.id,
        model: m.model,
        label: m.label,
        enabled: !!m.enabled,
        isDefault: !!m.is_default,
        temperature: m.temperature,
        maxTokens: m.max_tokens,
      })),
  };
};

const loadProvider = (id: number) => db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as ProviderRow | undefined;
const loadModels = () => db.prepare('SELECT * FROM ai_models ORDER BY id').all() as ModelRow[];
const providerById = (id: number) => {
  const p = loadProvider(id);
  return p ? providerPublic(p, loadModels()) : null;
};
const keyChanged = (k: string | undefined) => !!k && !k.includes('•');

adminAiRoutes.get('/ai/providers', (c) => {
  const models = loadModels();
  const providers = (db.prepare('SELECT * FROM ai_providers ORDER BY id').all() as ProviderRow[]).map((p) => providerPublic(p, models));
  return c.json({ providers });
});

adminAiRoutes.post('/ai/providers', async (c) => {
  const d = await body(
    c,
    z.object({
      name: z.string({ error: 'укажите название' }).trim().min(1, 'укажите название').max(60, 'не длиннее 60 символов'),
      baseUrl: z.string({ error: 'укажите адрес' }).trim().min(1, 'укажите адрес').max(300, 'слишком длинный адрес'),
      apiKey: z.string().trim().max(500, 'слишком длинный ключ').optional(),
      jsonMode: z.boolean({ error: 'ожидается true или false' }).optional(),
    }),
  );
  const info = db
    .prepare('INSERT INTO ai_providers (name, base_url, api_key_enc, json_mode, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
    .run(d.name, normalizeBaseUrl(d.baseUrl), keyChanged(d.apiKey) ? encrypt(d.apiKey!) : null, d.jsonMode === false ? 0 : 1, Date.now());
  return c.json({ provider: providerById(Number(info.lastInsertRowid)) });
});

adminAiRoutes.patch('/ai/providers/:id', async (c) => {
  const id = idOf(c, 'Провайдер');
  if (!loadProvider(id)) fail(404, 'Провайдер не найден');
  const d = await body(
    c,
    z
      .object({
        name: z.string({ error: 'укажите название' }).trim().min(1, 'укажите название').max(60, 'не длиннее 60 символов'),
        baseUrl: z.string({ error: 'укажите адрес' }).trim().min(1, 'укажите адрес').max(300, 'слишком длинный адрес'),
        apiKey: z.string().trim().max(500, 'слишком длинный ключ'),
        jsonMode: z.boolean({ error: 'ожидается true или false' }),
        enabled: z.boolean({ error: 'ожидается true или false' }),
      })
      .partial(),
  );
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v));
  if (d.name !== undefined) set('name', d.name);
  if (d.baseUrl !== undefined) set('base_url', normalizeBaseUrl(d.baseUrl));
  if (keyChanged(d.apiKey)) set('api_key_enc', encrypt(d.apiKey!));
  if (d.jsonMode !== undefined) set('json_mode', d.jsonMode ? 1 : 0);
  if (d.enabled !== undefined) set('enabled', d.enabled ? 1 : 0);
  if (sets.length) db.prepare(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  return c.json({ provider: providerById(id) });
});

adminAiRoutes.delete('/ai/providers/:id', (c) => {
  const id = idOf(c, 'Провайдер');
  db.transaction(() => {
    if (!db.prepare('DELETE FROM ai_providers WHERE id = ?').run(id).changes) fail(404, 'Провайдер не найден');
    ensureDefault();
  })();
  return c.json({ ok: true });
});

adminAiRoutes.get('/ai/providers/:id/remote-models', async (c) => {
  const p = loadProvider(idOf(c, 'Провайдер'));
  if (!p) fail(404, 'Провайдер не найден');
  try {
    return c.json({ models: await listRemoteModels(p.base_url, decrypt(p.api_key_enc)) });
  } catch (e) {
    return fail(502, e instanceof LlmError ? e.message : 'Не удалось получить список моделей');
  }
});

/** Keep exactly one default model whenever any model exists. */
function ensureDefault() {
  const has = db.prepare('SELECT COUNT(*) AS n FROM ai_models WHERE is_default = 1').get() as { n: number };
  if (has.n) return;
  db.prepare('UPDATE ai_models SET is_default = 1 WHERE id = (SELECT id FROM ai_models ORDER BY enabled DESC, id LIMIT 1)').run();
}

const modelPublic = (id: number) => {
  const m = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id) as ModelRow | undefined;
  return m
    ? { id: m.id, model: m.model, label: m.label, enabled: !!m.enabled, isDefault: !!m.is_default, temperature: m.temperature, maxTokens: m.max_tokens }
    : null;
};

const tempField = z.number({ error: 'число от 0 до 2' }).min(0, 'от 0 до 2').max(2, 'от 0 до 2');
const tokensField = z
  .number({ error: 'число от 256 до 128000' })
  .int('целое число')
  .min(256, 'от 256 до 128000')
  .max(128_000, 'от 256 до 128000');

adminAiRoutes.post('/ai/models', async (c) => {
  const d = await body(
    c,
    z.object({
      providerId: z.number({ error: 'укажите провайдера' }).int('укажите провайдера'),
      model: z.string({ error: 'укажите идентификатор модели' }).trim().min(1, 'укажите идентификатор модели').max(200, 'слишком длинный идентификатор'),
      label: z.string().trim().max(80, 'не длиннее 80 символов').optional(),
      temperature: tempField.optional(),
      maxTokens: tokensField.optional(),
    }),
  );
  if (!loadProvider(d.providerId)) fail(404, 'Провайдер не найден');
  if (db.prepare('SELECT 1 FROM ai_models WHERE provider_id = ? AND model = ?').get(d.providerId, d.model)) fail(409, 'Такая модель у этого провайдера уже добавлена');
  const info = db
    .prepare('INSERT INTO ai_models (provider_id, model, label, enabled, is_default, temperature, max_tokens, created_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?)')
    .run(d.providerId, d.model, d.label || d.model, d.temperature ?? 0.2, d.maxTokens ?? 6000, Date.now());
  ensureDefault();
  return c.json({ model: modelPublic(Number(info.lastInsertRowid)) });
});

adminAiRoutes.patch('/ai/models/:id', async (c) => {
  const id = idOf(c, 'Модель');
  if (!modelPublic(id)) fail(404, 'Модель не найдена');
  const d = await body(
    c,
    z
      .object({
        label: z.string().trim().min(1, 'укажите название').max(80, 'не длиннее 80 символов'),
        enabled: z.boolean({ error: 'ожидается true или false' }),
        isDefault: z.boolean({ error: 'ожидается true или false' }),
        temperature: tempField,
        maxTokens: tokensField,
      })
      .partial(),
  );
  db.transaction(() => {
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v));
    if (d.label !== undefined) set('label', d.label);
    if (d.enabled !== undefined) set('enabled', d.enabled ? 1 : 0);
    if (d.temperature !== undefined) set('temperature', d.temperature);
    if (d.maxTokens !== undefined) set('max_tokens', d.maxTokens);
    if (d.isDefault !== undefined) set('is_default', d.isDefault ? 1 : 0);
    if (d.isDefault) db.prepare('UPDATE ai_models SET is_default = 0 WHERE id != ?').run(id);
    if (sets.length) db.prepare(`UPDATE ai_models SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    ensureDefault();
  })();
  return c.json({ model: modelPublic(id) });
});

adminAiRoutes.delete('/ai/models/:id', (c) => {
  const id = idOf(c, 'Модель');
  db.transaction(() => {
    if (!db.prepare('DELETE FROM ai_models WHERE id = ?').run(id).changes) fail(404, 'Модель не найдена');
    ensureDefault();
  })();
  return c.json({ ok: true });
});

adminAiRoutes.post('/ai/models/:id/test', async (c) => {
  const id = idOf(c, 'Модель');
  const m = db
    .prepare(
      `SELECT m.model, p.base_url, p.api_key_enc, p.json_mode FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id WHERE m.id = ?`,
    )
    .get(id) as { model: string; base_url: string; api_key_enc: string | null; json_mode: number } | undefined;
  if (!m) fail(404, 'Модель не найдена');
  const t = Date.now();
  try {
    const res = await chatCompletion({
      baseUrl: m.base_url,
      apiKey: decrypt(m.api_key_enc),
      model: m.model,
      messages: [{ role: 'user', content: 'Ответь одним словом: «готово».' }],
      temperature: 0,
      maxTokens: 300,
      jsonMode: false,
      timeoutMs: 45_000,
    });
    return c.json({ ok: true, latencyMs: res.latencyMs, reply: res.content.trim().slice(0, 200) });
  } catch (e) {
    return c.json({ ok: false, latencyMs: Date.now() - t, error: e instanceof Error ? e.message : 'Ошибка' });
  }
});

/** modelId: a model id, 0 = statistical algorithm only, null/absent = default model (or the algorithm when none). */
adminAiRoutes.post('/ai/run', async (c) => {
  const d = await body(c, z.object({ modelId: z.number({ error: 'число' }).int().min(0).nullable().optional() }));
  const target = d.modelId === 0 ? null : (d.modelId ?? defaultModel()?.id ?? null);
  if (target !== null && !usableModels().some((m) => m.id === target)) fail(400, 'Модель отключена или у её провайдера нет ключа');
  try {
    return c.json({ forecast: await generateForecast(target) });
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : 'Не удалось построить прогноз');
  }
});

adminAiRoutes.get('/forecasts', (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const rows = db
    .prepare('SELECT id, model_id, model_label, status, created_at, error, tokens, eval FROM forecasts ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as {
    id: number;
    model_id: number | null;
    model_label: string;
    status: string;
    created_at: number;
    error: string | null;
    tokens: number | null;
    eval: string | null;
  }[];
  return c.json({
    forecasts: rows.map((r) => ({
      id: r.id,
      modelId: r.model_id,
      modelLabel: r.model_label,
      status: r.status,
      createdAt: r.created_at,
      error: r.error,
      tokens: r.tokens,
      eval: parseJson<ForecastEval | null>(r.eval, null),
    })),
  });
});

adminAiRoutes.get('/forecasts/:id', (c) => {
  const id = idOf(c, 'Прогноз');
  const row = db.prepare('SELECT * FROM forecasts WHERE id = ?').get(id) as Parameters<typeof rowToForecast>[0] | undefined;
  if (!row) fail(404, 'Прогноз не найден');
  return c.json({ forecast: rowToForecast(row), debug: parseJson<unknown>(row.debug, null), eval: parseJson<ForecastEval | null>(row.eval, null) });
});

adminAiRoutes.get('/ai/accuracy', (c) => {
  const rows = db
    .prepare('SELECT model_id, model_label, eval FROM forecasts WHERE eval IS NOT NULL ORDER BY created_at DESC LIMIT 2000')
    .all() as { model_id: number | null; model_label: string; eval: string }[];
  const groups = new Map<string, { modelId: number | null; label: string; evals: ForecastEval[] }>();
  for (const r of rows) {
    const ev = parseJson<ForecastEval | null>(r.eval, null);
    if (!ev || !ev.n) continue;
    const key = String(r.model_id);
    const g = groups.get(key) ?? groups.set(key, { modelId: r.model_id, label: r.model_id === null ? HEURISTIC_LABEL : r.model_label, evals: [] }).get(key)!;
    g.evals.push(ev);
  }
  const mean = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number');
    return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10000) / 10000 : null;
  };
  const models = [...groups.values()]
    .map((g) => ({
      modelId: g.modelId,
      modelLabel: g.label,
      n: g.evals.length,
      brier: mean(g.evals.map((e) => e.brier)),
      hitRate: mean(g.evals.map((e) => e.hitRate)),
      missRate: mean(g.evals.map((e) => e.missRate)),
    }))
    .sort((a, b) => (a.brier ?? 9) - (b.brier ?? 9));
  return c.json({ models });
});

/* ====================================================================== */
/* Scheduler                                                              */
/* ====================================================================== */

export function startForecastScheduler(): void {
  let busy = false;
  let lastEval = 0;

  const tick = async (boot: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const ai = getSetting('ai');
      const model = defaultModel();
      const lastAny = (db.prepare('SELECT MAX(created_at) AS t FROM forecasts').get() as { t: number | null }).t ?? 0;
      const lastHeuristic = latestForecastRow(null)?.created_at ?? 0;

      if (model) {
        const lastModel = latestForecastRow(model.id)?.created_at ?? 0;
        const due = ai.autoIntervalMin > 0 && now - lastModel >= ai.autoIntervalMin * MIN;
        if (due || (boot && now - lastAny >= HOUR)) await generateForecast(model.id).catch((e) => console.error('[ai] auto forecast', e));
      }
      if (now - lastHeuristic >= HOUR) generateHeuristic(now);

      if (now - lastEval >= 30 * MIN) {
        lastEval = now;
        const n = evaluatePending(now);
        if (n) console.log(`[ai] оценено прогнозов: ${n}`);
      }
    } catch (e) {
      console.error('[ai] scheduler', e);
    } finally {
      busy = false;
    }
  };

  setTimeout(() => void tick(true), 5_000).unref();
  setInterval(() => void tick(false), MIN).unref();
}

