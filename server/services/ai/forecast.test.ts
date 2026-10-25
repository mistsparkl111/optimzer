import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Mods = {
  db: typeof import('../../db').db;
  F: typeof import('./forecast');
  E: typeof import('./evaluate');
  A: typeof import('./analytics');
  H: typeof import('./heuristic');
  P: typeof import('./prompt');
  encrypt: typeof import('../../crypto').encrypt;
};
let m: Mods;

beforeAll(async () => {
  vi.stubEnv('DB_FILE', ':memory:');
  vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fc-')));
  m = {
    db: (await import('../../db')).db,
    F: await import('./forecast'),
    E: await import('./evaluate'),
    A: await import('./analytics'),
    H: await import('./heuristic'),
    P: await import('./prompt'),
    encrypt: (await import('../../crypto')).encrypt,
  };
});
afterEach(() => vi.unstubAllGlobals());

const NOW = Date.now();
const HOUR = 3600_000;

function priorWith(alerts: { regionId: string; type: string; startedAt: number; endedAt: number | null }[]) {
  const a = m.A.analyze({ alerts, reports: [], posts: [] }, NOW);
  return { a, prior: m.H.heuristicForecast(a) };
}

describe('mergeLlmForecast', () => {
  it('blends risk 0.65/0.35, drops unknown ids/sources, keeps active regions ≥ 85', () => {
    const { a, prior } = priorWith([{ regionId: 'KRS', type: 'uav', startedAt: NOW - 600_000, endedAt: null }]);
    const bel0 = prior.regions.find((r) => r.regionId === 'BEL')!.risk;
    const reply = {
      summaryToday: 'Сейчас напряжённо в приграничных регионах, ситуация меняется.',
      outlookTomorrow: 'Завтра ожидается сопоставимый уровень риска, ночью вероятность выше.',
      overall: { level: 'high', score: '70' },
      regions: [
        { regionId: 'BEL', risk: '90%', trend: 'up', reason: 'Много сообщений', peakHours: '22:00–04:00 МСК' },
        { regionId: 'KRS', risk: 10 },
        { regionId: 'NOPE', risk: 99 },
        { regionId: 'TUL', risk: 'много' },
      ],
      vectors: [
        { type: 'uav', fromRegionId: 'BRY', toRegionId: 'KLU', confidence: 55, window: 'в ближайшие 2 часа', note: 'по данным' },
        { type: 'uav', fromRegionId: 'BRY', toRegionId: 'KLU', confidence: 0.1 },
        { type: 'ракета', fromRegionId: 'ZZ', toRegionId: 'KLU' },
        { type: 'drone', fromRegionId: 'KLU', toRegionId: 'KLU' },
      ],
      events: [
        { time: new Date(NOW - 1800_000).toISOString(), text: 'Сообщили о БПЛА', sourceIds: [11, 999], regionIds: ['BEL', 'XX'] },
        { time: null, text: 'Выдуманное событие', sourceIds: [999], regionIds: [] },
      ],
      recommendations: ['Идите в укрытие при сигнале', 'Держите телефон заряженным'],
      confidenceNote: 'Данных умеренно, прогноз ориентировочный и может измениться.',
    };
    const { forecast, notes } = m.F.mergeLlmForecast(reply, {
      prior,
      activeIds: new Set(['KRS']),
      postIds: new Set([11, 12]),
      posts: [],
      now: NOW,
    });
    const bel = forecast.regions.find((r) => r.regionId === 'BEL')!;
    expect(bel.risk).toBe(Math.round(0.65 * 90 + 0.35 * bel0));
    expect(bel.trend).toBe('up');
    expect(bel.reason).toBe('Много сообщений');
    expect(forecast.regions.find((r) => r.regionId === 'KRS')!.risk).toBeGreaterThanOrEqual(85);
    expect(forecast.regions.find((r) => r.regionId === 'TUL')!.risk).toBe(prior.regions.find((r) => r.regionId === 'TUL')!.risk);
    expect(forecast.regions).toHaveLength(89);
    expect(notes.droppedRegionIds).toEqual(['NOPE']);
    expect(forecast.status).toBe('ok');
    expect(forecast.vectors.filter((v) => v.basis === 'model')).toHaveLength(1);
    const v = forecast.vectors.find((x) => x.id === 'model:uav:BRY>KLU')!;
    expect(v.confidence).toBe(0.55);
    expect(v.from).toHaveLength(2);
    expect(forecast.events).toHaveLength(1);
    expect(forecast.events[0]).toMatchObject({ sourceIds: [11], regionIds: ['BEL'] });
    expect(notes.eventsDropped).toBe(1);
    expect(forecast.recommendations).toHaveLength(2);
    expect(forecast.overall.score).toBeGreaterThan(0);
    expect(a.national.activeRegions).toBe(1);
  });

  it('falls back to the prior for garbage replies', () => {
    const { prior } = priorWith([]);
    const { forecast } = m.F.mergeLlmForecast({ regions: 'x', summaryToday: 5 }, { prior, activeIds: new Set(), postIds: new Set(), posts: [], now: NOW });
    expect(forecast.regions.map((r) => r.risk)).toEqual(prior.regions.map((r) => r.risk));
    expect(forecast.summaryToday).toBe(prior.summaryToday);
    expect(forecast.recommendations).toEqual(prior.recommendations);
  });

  it('treats fractional risks as probabilities', () => {
    const { prior } = priorWith([]);
    const { forecast } = m.F.mergeLlmForecast(
      { regions: [{ regionId: 'KRS', risk: 0.8 }, { regionId: 'BRY', risk: 0.6 }, { regionId: 'VOR', risk: 0.4 }] },
      { prior, activeIds: new Set(), postIds: new Set(), posts: [], now: NOW },
    );
    expect(forecast.regions.find((r) => r.regionId === 'KRS')!.risk).toBeGreaterThan(50);
  });
});

describe('evaluation', () => {
  it('scoreForecast computes Brier, hit and miss rates', () => {
    const ev = m.E.scoreForecast(
      [
        { regionId: 'A', risk: 90 },
        { regionId: 'B', risk: 60 },
        { regionId: 'C', risk: 10 },
        { regionId: 'D', risk: 0 },
      ],
      new Set(['A', 'C']),
    );
    expect(ev.brier).toBeCloseTo((0.01 + 0.36 + 0.81 + 0) / 4, 4);
    expect(ev.hitRate).toBe(0.5);
    expect(ev.missRate).toBe(0.5);
    expect(ev.n).toBe(4);
    expect(ev.topErrors[0]).toEqual({ regionId: 'C', risk: 10, outcome: 1 });
  });

  it('evaluates finished forecasts against alerts and user marks', () => {
    const { db, F, E } = m;
    const f = F.storeForecast({ ...m.H.heuristicForecast(m.A.analyze({ alerts: [], reports: [], posts: [] }, NOW - 48 * HOUR)) });
    expect(f.id).toBeGreaterThan(0);
    const from = NOW - 48 * HOUR;
    db.prepare("INSERT INTO alerts (region_id, type, source, message, started_at, updated_at) VALUES ('BEL','uav','admin',NULL,?,?)").run(from + HOUR, from + HOUR);
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (1,'t@t','t','x',0)").run();
    for (const dt of [1, 2]) {
      db.prepare("INSERT INTO reports (user_id, type, lat, lon, region_id, ttl_ms, created_at, expires_at) VALUES (1,'uav',50,36,'KRS',1000,?,?)").run(from + dt * HOUR, from + dt * HOUR + 1000);
    }
    expect(E.evaluatePending(NOW)).toBeGreaterThanOrEqual(1);
    const row = db.prepare('SELECT eval FROM forecasts WHERE id = ?').get(f.id) as { eval: string };
    const ev = JSON.parse(row.eval);
    expect(ev.n).toBe(89);
    expect(ev.positives).toBe(2);
    expect(ev.brier).toBeGreaterThan(0);
    expect(E.evaluatePending(NOW)).toBe(0);
    // feeds the calibration block of the prompt
    db.prepare('UPDATE forecasts SET model_id = 5 WHERE id = ?').run(f.id);
    expect(m.P.calibrationSection(5)).toMatch(/Brier/);
    expect(m.P.calibrationSection(77)).toMatch(/пока нет/);
  });
});

describe('generateForecast with an OpenAI-compatible provider', () => {
  function addModel() {
    const { db, encrypt } = m;
    const p = db.prepare("INSERT INTO ai_providers (name, base_url, api_key_enc, json_mode, enabled, created_at) VALUES ('mock','http://mock.local/v1',?,1,1,0)").run(encrypt('sk-test'));
    const mm = db.prepare("INSERT INTO ai_models (provider_id, model, label, is_default, temperature, max_tokens, created_at) VALUES (?, 'mock-1','Mock',1,0.2,2000,0)").run(p.lastInsertRowid);
    return Number(mm.lastInsertRowid);
  }

  it('stores an ok forecast, retries without response_format, reports tokens', async () => {
    const id = addModel();
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        calls.push(body);
        expect(init.headers.authorization).toBe('Bearer sk-test');
        if (body.response_format) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'response_format'" } }), { status: 400 });
        const reply = { summaryToday: 'Ситуация спокойная, в большинстве регионов тревог не ожидается.', regions: [{ regionId: 'BRY', risk: 70, reason: 'Рядом активность' }] };
        return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(reply) + '\n```' }, finish_reason: 'stop' }], usage: { total_tokens: 1234 } }), { status: 200 });
      }),
    );
    const f = await m.F.generateForecast(id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.model).toBe('mock-1');
    expect(f.status).toBe('ok');
    expect(f.modelId).toBe(id);
    expect(f.regions.find((r) => r.regionId === 'BRY')!.reason).toBe('Рядом активность');
    const row = m.db.prepare('SELECT tokens, status, debug FROM forecasts WHERE id = ?').get(f.id) as { tokens: number; status: string; debug: string };
    expect(row).toMatchObject({ tokens: 1234, status: 'ok' });
    expect(JSON.parse(row.debug).promptSizes.systemChars).toBeGreaterThan(3000);
    expect(m.F.latestForecastRow(id, 'ok')!.id).toBe(f.id);
  });

  it('stores an error row with heuristic data when the provider fails', async () => {
    const id = Number((m.db.prepare('SELECT id FROM ai_models LIMIT 1').get() as { id: number }).id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })));
    const f = await m.F.generateForecast(id);
    expect(f.status).toBe('error');
    expect(f.error).toMatch(/отклонил ключ/);
    expect(f.regions).toHaveLength(89);
  });

  it('prompt contains the required sections and obeys extraPrompt', async () => {
    const sys = m.P.buildSystemPrompt('CALIB', 'Всегда пиши коротко.');
    for (const part of ['РОЛЬ', 'МЕТОД', 'РАБОТА С ИСТОЧНИКАМИ', 'КАЛИБРОВКА', 'ЖЁСТКИЕ ОГРАНИЧЕНИЯ', 'ФОРМАТ ОТВЕТА', 'summaryToday', 'CALIB', 'Всегда пиши коротко.']) {
      expect(sys).toContain(part);
    }
    expect(sys).toMatch(/оперативн/);
  });
});
