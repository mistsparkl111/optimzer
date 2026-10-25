import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RISK_META } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { Forecast } from '@shared/types';
import { Icon } from '../../components/Icons';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Stat, Textarea, Toggle, toast, useAsync } from '../../components/ui';
import { del, errorText, get, patch, post, put } from '../../lib/api';
import { fmtAgo, fmtDateTime } from '../../lib/format';

/* ---------- types ---------- */

interface ModelRow {
  id: number;
  model: string;
  label: string;
  enabled: boolean;
  isDefault: boolean;
  temperature: number;
  maxTokens: number;
}
interface ProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  keyMasked: string;
  jsonMode: boolean;
  enabled: boolean;
  models: ModelRow[];
}
interface EvalRow {
  brier: number;
  hitRate: number | null;
  missRate: number | null;
  n: number;
}
interface ForecastListRow {
  id: number;
  modelId: number | null;
  modelLabel: string;
  status: 'ok' | 'heuristic' | 'error';
  createdAt: number;
  error: string | null;
  tokens: number | null;
  eval: EvalRow | null;
}
interface AccuracyRow {
  modelId: number | null;
  modelLabel: string;
  n: number;
  brier: number | null;
  hitRate: number | null;
  missRate: number | null;
}
interface AiSettings {
  autoIntervalMin: number;
  userCanChoose: boolean;
  refreshCooldownMin: number;
  extraPrompt: string;
  maxPosts: number;
}

const PRESETS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { name: 'Ollama (локально)', url: 'http://localhost:11434/v1' },
];

const STATUS: Record<ForecastListRow['status'], { label: string; color: string }> = {
  ok: { label: 'ИИ', color: '#22c55e' },
  heuristic: { label: 'Алгоритм', color: '#38bdf8' },
  error: { label: 'Ошибка', color: '#ff3b4f' },
};

const pct = (x: number | null | undefined) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-line bg-panel-2/60 p-3 text-xs leading-relaxed text-muted">
      <Icon name="info" className="mt-0.5 size-4 shrink-0 text-accent" />
      <div>{children}</div>
    </div>
  );
}

/* ====================================================================== */

export default function AiTab() {
  const providers = useAsync(() => get<{ providers: ProviderRow[] }>('/admin/ai/providers'), []);
  const [historyKey, setHistoryKey] = useState(0);
  const list = providers.data?.providers ?? [];

  return (
    <div className="space-y-5">
      <ProvidersCard providers={list} loading={providers.loading && !providers.data} error={providers.error} reload={providers.reload} />
      <SettingsCard />
      <RunCard providers={list} onDone={() => setHistoryKey((k) => k + 1)} />
      <HistoryCard refreshKey={historyKey} />
    </div>
  );
}

/* ---------- providers ---------- */

function ProvidersCard({ providers, loading, error, reload }: { providers: ProviderRow[]; loading: boolean; error: string | null; reload: () => void }) {
  const [editing, setEditing] = useState<ProviderRow | 'new' | null>(null);
  const [remoteFor, setRemoteFor] = useState<ProviderRow | null>(null);

  const remove = async (p: ProviderRow) => {
    if (!window.confirm(`Удалить провайдера «${p.name}» вместе со всеми его моделями?`)) return;
    try {
      await del(`/admin/ai/providers/${p.id}`);
      toast('Провайдер удалён', 'ok');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const toggle = async (p: ProviderRow, enabled: boolean) => {
    try {
      await patch(`/admin/ai/providers/${p.id}`, { enabled });
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <Card
      title="ИИ-провайдеры и модели"
      action={
        <Button size="sm" onClick={() => setEditing('new')}>
          <Icon name="plus" className="size-4" /> Провайдер
        </Button>
      }
    >
      <div className="space-y-4">
        <Hint>
          Подключите любой OpenAI-совместимый API: адрес (base URL), ключ и модель. Модель по умолчанию строит автоматические прогнозы; остальные пользователи могут
          выбирать на странице ИИ (если разрешено в настройках ниже). Ключ хранится в базе в зашифрованном виде и никогда не отдаётся обратно.
        </Hint>
        {loading && (
          <div className="grid h-24 place-items-center">
            <Spinner className="text-accent" />
          </div>
        )}
        {error && <div className="text-sm text-alert">{error}</div>}
        {!loading && !error && !providers.length && (
          <EmptyState
            icon={<Icon name="ai" className="size-10" />}
            title="Провайдеров пока нет"
            text="Без подключённой модели работает только статистический «Алгоритм Радара». Добавьте провайдера, чтобы включить ИИ-прогнозы."
            action={<Button onClick={() => setEditing('new')}>Добавить провайдера</Button>}
          />
        )}
        {providers.map((p) => (
          <div key={p.id} className="rounded-2xl border border-line bg-panel-2/50">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{p.name}</span>
                  <Badge color={p.hasKey ? '#22c55e' : '#ffb020'}>{p.hasKey ? `Ключ ${p.keyMasked}` : 'Без ключа'}</Badge>
                  <Badge color="#7d899b">{p.jsonMode ? 'JSON-режим' : 'Обычный текст'}</Badge>
                </div>
                <div className="mt-1 break-all font-mono text-xs text-muted">{p.baseUrl}</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-12" title={p.enabled ? 'Включён' : 'Отключён'}>
                  <Toggle checked={p.enabled} onChange={(v) => toggle(p, v)} />
                </div>
                <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                  Изменить
                </Button>
                <Button size="sm" variant="danger" onClick={() => remove(p)} aria-label="Удалить провайдера">
                  <Icon name="trash" className="size-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2 p-3">
              {p.models.map((m) => (
                <ModelItem key={m.id} model={m} reload={reload} />
              ))}
              {!p.models.length && <div className="text-sm text-muted">Моделей нет — загрузите список у провайдера или добавьте вручную.</div>}
              <div className="pt-1">
                <Button size="sm" variant="subtle" onClick={() => setRemoteFor(p)}>
                  <Icon name="refresh" className="size-4" /> Загрузить модели провайдера
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <ProviderModal
        open={editing !== null}
        provider={editing && editing !== 'new' ? editing : null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
      <RemoteModelsModal provider={remoteFor} onClose={() => setRemoteFor(null)} onAdded={reload} />
    </Card>
  );
}

function ModelItem({ model, reload }: { model: ModelRow; reload: () => void }) {
  const [temp, setTemp] = useState(String(model.temperature));
  const [tokens, setTokens] = useState(String(model.maxTokens));
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setTemp(String(model.temperature));
    setTokens(String(model.maxTokens));
  }, [model.temperature, model.maxTokens]);

  const dirty = Number(temp) !== model.temperature || Number(tokens) !== model.maxTokens;
  const run = async (fn: () => Promise<unknown>, okText?: string) => {
    try {
      await fn();
      if (okText) toast(okText, 'ok');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await post<{ ok: boolean; latencyMs: number; reply?: string; error?: string }>(`/admin/ai/models/${model.id}/test`);
      setResult({ ok: r.ok, text: r.ok ? `Ответ за ${(r.latencyMs / 1000).toFixed(1)} с: ${r.reply || '—'}` : r.error || 'Ошибка' });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{model.label}</span>
            {model.isDefault && <Badge color="#34e3ff">По умолчанию</Badge>}
            {!model.enabled && <Badge color="#7d899b">Отключена</Badge>}
          </div>
          <div className="break-all font-mono text-[11px] text-dim">{model.model}</div>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-12" title={model.enabled ? 'Включена' : 'Отключена'}>
            <Toggle checked={model.enabled} onChange={(v) => run(() => patch(`/admin/ai/models/${model.id}`, { enabled: v }))} />
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Температура">
          <Input type="number" min={0} max={2} step={0.05} value={temp} onChange={(e) => setTemp(e.target.value)} />
        </Field>
        <Field label="Макс. токенов">
          <Input type="number" min={256} max={128000} step={256} value={tokens} onChange={(e) => setTokens(e.target.value)} />
        </Field>
        <div className="col-span-2 flex flex-wrap items-end gap-2 sm:col-span-1">
          {dirty && (
            <Button size="sm" onClick={() => run(() => patch(`/admin/ai/models/${model.id}`, { temperature: Number(temp), maxTokens: Number(tokens) }), 'Сохранено')}>
              Сохранить
            </Button>
          )}
          {!model.isDefault && (
            <Button size="sm" variant="outline" onClick={() => run(() => patch(`/admin/ai/models/${model.id}`, { isDefault: true, enabled: true }), 'Модель по умолчанию изменена')}>
              По умолчанию
            </Button>
          )}
          <Button size="sm" variant="subtle" loading={testing} onClick={test}>
            Проверить
          </Button>
          <Button
            size="sm"
            variant="danger"
            aria-label="Удалить модель"
            onClick={() => window.confirm(`Удалить модель «${model.label}»?`) && run(() => del(`/admin/ai/models/${model.id}`), 'Модель удалена')}
          >
            <Icon name="trash" className="size-4" />
          </Button>
        </div>
      </div>
      {result && <div className={`mt-2 break-words text-xs ${result.ok ? 'text-ok' : 'text-alert'}`}>{result.ok ? '✓ ' : '✕ '}{result.text}</div>}
    </div>
  );
}

function ProviderModal({ open, provider, onClose, onSaved }: { open: boolean; provider: ProviderRow | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [jsonMode, setJsonMode] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setBaseUrl(provider?.baseUrl ?? '');
    setApiKey('');
    setJsonMode(provider?.jsonMode ?? true);
  }, [open, provider]);

  const save = async () => {
    setBusy(true);
    try {
      const payload = { name, baseUrl, jsonMode, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      if (provider) await patch(`/admin/ai/providers/${provider.id}`, payload);
      else await post('/admin/ai/providers', payload);
      toast(provider ? 'Провайдер обновлён' : 'Провайдер добавлен', 'ok');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={provider ? 'Изменить провайдера' : 'Новый провайдер ИИ'}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.url}
              type="button"
              onClick={() => {
                setBaseUrl(p.url);
                if (!name.trim()) setName(p.name.replace(' (локально)', ''));
              }}
              className="rounded-full border border-line-2 px-3 py-1 text-xs font-semibold text-muted transition hover:border-accent/50 hover:text-text"
            >
              {p.name}
            </button>
          ))}
        </div>
        <Field label="Название">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenRouter" maxLength={60} />
        </Field>
        <Field label="Base URL" hint="Адрес API без /chat/completions, обычно оканчивается на /v1">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" inputMode="url" autoCapitalize="none" />
        </Field>
        <Field
          label="API-ключ"
          hint={provider?.hasKey ? `Сейчас сохранён ключ ${provider.keyMasked}. Оставьте поле пустым, чтобы не менять.` : 'Для локальных серверов (Ollama) ключ не нужен.'}
        >
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
        </Field>
        <Toggle
          checked={jsonMode}
          onChange={setJsonMode}
          label="JSON-режим"
          description="Просить у провайдера строго JSON (response_format). Если провайдер не поддерживает — Радар повторит запрос без него."
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button loading={busy} disabled={!name.trim() || !baseUrl.trim()} onClick={save}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RemoteModelsModal({ provider, onClose, onAdded }: { provider: ProviderRow | null; onClose: () => void; onAdded: () => void }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [manual, setManual] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setModels(null);
    setError(null);
    setQ('');
    setManual('');
    if (!provider) return;
    setAdded(new Set(provider.models.map((m) => m.model)));
    let alive = true;
    get<{ models: string[] }>(`/admin/ai/providers/${provider.id}/remote-models`).then(
      (r) => alive && setModels(r.models),
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  const add = async (model: string) => {
    if (!provider || !model.trim()) return;
    setAdding(model);
    try {
      await post('/admin/ai/models', { providerId: provider.id, model: model.trim() });
      setAdded((s) => new Set(s).add(model.trim()));
      setManual('');
      toast(`Модель «${model.trim()}» добавлена`, 'ok');
      onAdded();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setAdding(null);
    }
  };

  const filtered = useMemo(() => (models ?? []).filter((m) => m.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [models, q]);

  return (
    <Modal open={!!provider} onClose={onClose} title={provider ? `Модели: ${provider.name}` : ''}>
      <div className="space-y-4">
        <Field label="Добавить вручную" hint="Если провайдер не отдаёт список моделей — введите идентификатор, например gpt-4o-mini">
          <div className="flex gap-2">
            <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="идентификатор модели" onKeyDown={(e) => e.key === 'Enter' && add(manual)} />
            <Button loading={adding === manual.trim() && !!manual.trim()} disabled={!manual.trim()} onClick={() => add(manual)}>
              Добавить
            </Button>
          </div>
        </Field>
        {!models && !error && (
          <div className="grid h-24 place-items-center">
            <Spinner className="text-accent" />
          </div>
        )}
        {error && <div className="rounded-xl border border-alert/30 bg-alert/10 p-3 text-sm text-alert">{error}</div>}
        {models && (
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Поиск среди ${models.length} моделей`} />
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
              {filtered.map((m) => (
                <div key={m} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel-2/60 px-3 py-2">
                  <span className="min-w-0 break-all font-mono text-xs">{m}</span>
                  {added.has(m) ? (
                    <Badge color="#22c55e">Добавлена</Badge>
                  ) : (
                    <Button size="sm" variant="outline" loading={adding === m} onClick={() => add(m)}>
                      Добавить
                    </Button>
                  )}
                </div>
              ))}
              {!filtered.length && <div className="py-6 text-center text-sm text-muted">Ничего не найдено</div>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------- settings ---------- */

function SettingsCard() {
  const { data, loading, reload } = useAsync(() => get<{ ai: AiSettings }>('/admin/settings'), []);
  const [form, setForm] = useState<AiSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data?.ai) setForm({ ...data.ai });
  }, [data]);

  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const num = (v: string) => (v === '' ? 0 : Number(v));

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await put('/admin/settings/ai', {
        autoIntervalMin: Math.round(form.autoIntervalMin),
        userCanChoose: form.userCanChoose,
        refreshCooldownMin: Math.round(form.refreshCooldownMin),
        maxPosts: Math.round(form.maxPosts),
        extraPrompt: form.extraPrompt,
      });
      toast('Настройки ИИ сохранены', 'ok');
      reload();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Настройки ИИ-прогноза">
      {loading && !form && (
        <div className="grid h-24 place-items-center">
          <Spinner className="text-accent" />
        </div>
      )}
      {form && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Авто-прогноз, мин" hint="0 — только алгоритм раз в час, без вызовов ИИ">
              <Input type="number" min={0} max={1440} value={form.autoIntervalMin} onChange={(e) => set('autoIntervalMin', num(e.target.value))} />
            </Field>
            <Field label="Пауза обновления, мин" hint="Как часто один пользователь Радар+ может запросить новый прогноз">
              <Input type="number" min={0} max={1440} value={form.refreshCooldownMin} onChange={(e) => set('refreshCooldownMin', num(e.target.value))} />
            </Field>
            <Field label="Постов в запросе" hint="Сколько свежих постов из источников попадёт в промпт (0–600)">
              <Input type="number" min={0} max={600} value={form.maxPosts} onChange={(e) => set('maxPosts', num(e.target.value))} />
            </Field>
          </div>
          <Toggle
            checked={form.userCanChoose}
            onChange={(v) => set('userCanChoose', v)}
            label="Пользователи выбирают модель"
            description="Выключено — все видят прогноз модели по умолчанию"
          />
          <Field
            label="Дополнительные инструкции для модели"
            hint="Добавляются в конец системного промпта. Например: региональные особенности или стиль сводок. Правила безопасности и формат ответа менять не нужно."
          >
            <Textarea
              rows={5}
              maxLength={8000}
              value={form.extraPrompt}
              onChange={(e) => set('extraPrompt', e.target.value)}
              placeholder="Например: в сводках всегда упоминай ночной пик активности и называй не более пяти регионов."
            />
          </Field>
          <div className="flex justify-end">
            <Button loading={busy} onClick={save}>
              Сохранить настройки
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------- run ---------- */

function RunCard({ providers, onDone }: { providers: ProviderRow[]; onDone: () => void }) {
  const options = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ id: m.id, label: `${m.label} · ${p.name}`, isDefault: m.isDefault }))),
    [providers],
  );
  const [modelId, setModelId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = modelId || String(options.find((o) => o.isDefault)?.id ?? options[0]?.id ?? 0);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ forecast: Forecast }>('/admin/ai/run', { modelId: Number(selected) });
      setResult(r.forecast);
      if (r.forecast.status === 'error') toast('Модель вернула ошибку — показан запасной прогноз алгоритма', 'error');
      else toast('Прогноз построен', 'ok');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const top = result?.regions.slice(0, 5) ?? [];

  return (
    <Card title="Сгенерировать прогноз сейчас">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Модель" className="flex-1">
            <Select value={selected} onChange={(e) => setModelId(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.isDefault ? ' (по умолчанию)' : ''}
                </option>
              ))}
              <option value="0">Алгоритм Радара (без ИИ)</option>
            </Select>
          </Field>
          <Button loading={busy} onClick={run}>
            <Icon name="bolt" className="size-4" /> Сгенерировать
          </Button>
        </div>
        {busy && <div className="text-xs text-muted">Запрос к модели может занять до 2–3 минут…</div>}
        {error && <div className="rounded-xl border border-alert/30 bg-alert/10 p-3 text-sm text-alert">{error}</div>}
        {result && (
          <div className="space-y-3 rounded-2xl border border-line bg-panel-2/50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={STATUS[result.status].color}>{STATUS[result.status].label}</Badge>
              <span className="text-sm font-semibold">{result.modelLabel}</span>
              <span className="text-xs text-muted">{fmtDateTime(result.createdAt)}</span>
              <Badge color={RISK_META[result.overall.level].color}>
                {RISK_META[result.overall.level].label} · {result.overall.score}
              </Badge>
            </div>
            {result.error && <div className="text-sm text-alert">Ошибка: {result.error}</div>}
            <p className="text-sm leading-relaxed">{result.summaryToday}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Направлений" value={result.vectors.length} />
              <Stat label="Событий" value={result.events.length} />
              <Stat label="Постов" value={result.stats.postsAnalyzed} />
              <Stat label="Источников" value={result.stats.sourcesUsed} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {top.map((r) => (
                <Badge key={r.regionId} color={RISK_META[r.level].color}>
                  {regionName(r.regionId, true)} · {r.risk}%
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ---------- history & accuracy ---------- */

function HistoryCard({ refreshKey }: { refreshKey: number }) {
  const history = useAsync(() => get<{ forecasts: ForecastListRow[] }>('/admin/forecasts?limit=50'), [refreshKey]);
  const accuracy = useAsync(() => get<{ models: AccuracyRow[] }>('/admin/ai/accuracy'), [refreshKey]);
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = history.data?.forecasts ?? [];
  const acc = accuracy.data?.models ?? [];

  return (
    <Card
      title="История прогнозов и точность"
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            history.reload();
            accuracy.reload();
          }}
          aria-label="Обновить"
        >
          <Icon name="refresh" className="size-4" />
        </Button>
      }
    >
      <div className="space-y-5">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Точность по моделям</div>
          {acc.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[460px] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-semibold">Модель</th>
                    <th className="py-1.5 pr-3 font-semibold">Оценок</th>
                    <th className="py-1.5 pr-3 font-semibold" title="Среднеквадратичная ошибка вероятностей: меньше — лучше">
                      Brier
                    </th>
                    <th className="py-1.5 pr-3 font-semibold" title="Доля регионов с риском ≥ 50%, где тревога действительно была">
                      Попадания
                    </th>
                    <th className="py-1.5 font-semibold" title="Доля регионов с тревогой, где риск был < 25%">
                      Пропуски
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {acc.map((a) => (
                    <tr key={String(a.modelId)} className="border-t border-line">
                      <td className="py-2 pr-3 font-semibold">{a.modelLabel}</td>
                      <td className="py-2 pr-3 font-mono">{a.n}</td>
                      <td className="py-2 pr-3 font-mono">{a.brier?.toFixed(3) ?? '—'}</td>
                      <td className="py-2 pr-3 font-mono">{pct(a.hitRate)}</td>
                      <td className="py-2 font-mono">{pct(a.missRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-muted">Оценок пока нет: прогноз оценивается по фактам через 24 часа после создания.</div>
          )}
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Последние прогнозы</div>
          {history.loading && !history.data && (
            <div className="grid h-20 place-items-center">
              <Spinner className="text-accent" />
            </div>
          )}
          {history.error && <div className="text-sm text-alert">{history.error}</div>}
          {!history.loading && !rows.length && !history.error && <div className="text-sm text-muted">Прогнозов ещё не было.</div>}
          <div className="space-y-2">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setOpenId(r.id)}
                className="block w-full rounded-xl border border-line bg-panel-2/50 p-3 text-left transition hover:border-accent/40"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge color={STATUS[r.status].color}>{STATUS[r.status].label}</Badge>
                  <span className="text-sm font-semibold">{r.modelLabel}</span>
                  <span className="text-xs text-muted" title={fmtDateTime(r.createdAt)}>
                    {fmtAgo(r.createdAt)}
                  </span>
                  {r.tokens !== null && <span className="font-mono text-xs text-dim">{r.tokens} ток.</span>}
                  <span className="ml-auto text-xs text-muted">
                    {r.eval ? (
                      <>
                        Brier <span className="font-mono text-text">{r.eval.brier.toFixed(3)}</span> · попад. {pct(r.eval.hitRate)} · проп. {pct(r.eval.missRate)}
                      </>
                    ) : (
                      'ещё не оценён'
                    )}
                  </span>
                </div>
                {r.error && <div className="mt-1.5 line-clamp-2 break-words text-xs text-alert">{r.error}</div>}
              </button>
            ))}
          </div>
        </div>
      </div>
      <ForecastModal id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

function ForecastModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [data, setData] = useState<{ forecast: Forecast; debug: Record<string, unknown> | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (id === null) return;
    let alive = true;
    get<{ forecast: Forecast; debug: Record<string, unknown> | null }>(`/admin/forecasts/${id}`).then(
      (r) => alive && setData(r),
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  const f = data?.forecast;
  const rawReply = typeof data?.debug?.rawReply === 'string' ? (data.debug.rawReply as string) : null;
  const debugRest = data?.debug ? Object.fromEntries(Object.entries(data.debug).filter(([k]) => k !== 'rawReply')) : null;

  return (
    <Modal open={id !== null} onClose={onClose} title={f ? `Прогноз #${f.id} · ${f.modelLabel}` : 'Прогноз'} wide>
      {!data && !error && (
        <div className="grid h-32 place-items-center">
          <Spinner className="text-accent" />
        </div>
      )}
      {error && <div className="text-sm text-alert">{error}</div>}
      {f && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={STATUS[f.status].color}>{STATUS[f.status].label}</Badge>
            <Badge color={RISK_META[f.overall.level].color}>
              {RISK_META[f.overall.level].label} · {f.overall.score}
            </Badge>
            <span className="text-xs text-muted">{fmtDateTime(f.createdAt)}</span>
          </div>
          {f.error && <div className="rounded-xl border border-alert/30 bg-alert/10 p-3 text-sm text-alert">{f.error}</div>}
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">Сегодня</div>
            <p className="mt-1 text-sm leading-relaxed">{f.summaryToday}</p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">Завтра</div>
            <p className="mt-1 text-sm leading-relaxed">{f.outlookTomorrow}</p>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Регионы с наибольшим риском</div>
            <div className="flex flex-wrap gap-1.5">
              {f.regions.slice(0, 12).map((r) => (
                <Badge key={r.regionId} color={RISK_META[r.level].color}>
                  {regionName(r.regionId, true)} · {r.risk}%
                </Badge>
              ))}
            </div>
          </div>
          {!!f.vectors.length && (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">Направления</div>
              <ul className="space-y-1 text-sm">
                {f.vectors.slice(0, 8).map((v) => (
                  <li key={v.id}>
                    {regionName(v.fromRegionId, true)} → {regionName(v.toRegionId, true)} <span className="text-muted">({Math.round(v.confidence * 100)}%, {v.basis})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-xs text-muted">{f.confidenceNote}</div>
          {debugRest && (
            <details className="rounded-xl border border-line bg-panel-2/50 p-3">
              <summary className="cursor-pointer text-sm font-semibold">Отладка: запрос и метрики</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{JSON.stringify(debugRest, null, 2)}</pre>
            </details>
          )}
          {rawReply && (
            <details className="rounded-xl border border-line bg-panel-2/50 p-3">
              <summary className="cursor-pointer text-sm font-semibold">Отладка: сырой ответ модели</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{rawReply}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}
