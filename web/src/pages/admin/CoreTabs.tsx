import { useEffect, useState } from 'react';
import { ALERT_TYPES, REPORT_TYPES, THREATS, type AlertType } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { Alert, FrontArrow, FrontData, PublicUser, Report } from '@shared/types';
import { del, get, patch, post, put, errorText } from '../../lib/api';
import { fmtAgo, fmtDateTime, fmtDuration, fmtMoney } from '../../lib/format';
import { useApp } from '../../lib/store';
import { RegionList } from '../../components/RegionPicker';
import { FrontMap } from '../../components/FrontMap';
import { Icon, ThreatIcon } from '../../components/Icons';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, PlusBadge, Select, Spinner, Stat, Textarea, Toggle, toast, useAsync } from '../../components/ui';

/* ---------------- Overview ---------------- */

interface Overview {
  users: number;
  plusUsers: number;
  newUsers24h: number;
  activeAlerts: number;
  alerts24h: number;
  activeReports: number;
  reports24h: number;
  pushSubscriptions: number;
  sources: number;
  posts24h: number;
  forecasts24h: number;
  revenue30d: number;
}

export function OverviewTab() {
  const { data } = useAsync(() => get<Overview>('/admin/overview'), []);
  if (!data) return <Loading />;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Пользователи" value={data.users} sub={`+${data.newUsers24h} за сутки`} />
      <Stat label="Радар+" value={data.plusUsers} color="#ffc845" />
      <Stat label="Активные тревоги" value={data.activeAlerts} color={data.activeAlerts ? '#ff3b4f' : undefined} sub={`${data.alerts24h} за сутки`} />
      <Stat label="Активные метки" value={data.activeReports} color="#ffb020" sub={`${data.reports24h} за сутки`} />
      <Stat label="Push-подписки" value={data.pushSubscriptions} />
      <Stat label="Источники" value={data.sources} sub={`${data.posts24h} постов за сутки`} />
      <Stat label="ИИ-прогнозы" value={data.forecasts24h} sub="за сутки" />
      <Stat label="Выручка 30 дн." value={fmtMoney(data.revenue30d)} color="#22c55e" />
    </div>
  );
}

/* ---------------- Alerts ---------------- */

export function AlertsTab() {
  const { alerts, now } = useApp();
  const [regions, setRegions] = useState<string[]>([]);
  const [type, setType] = useState<AlertType>('air');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState(false);
  const recent = useAsync(() => get<{ alerts: Alert[] }>('/admin/alerts'), []);

  const start = async () => {
    setBusy(true);
    try {
      await post('/admin/alerts', { regionIds: regions, type, message: message || null });
      toast(`Тревога объявлена в ${regions.length} рег.`, 'ok');
      setRegions([]);
      setMessage('');
      recent.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const end = async (id: number) => {
    try {
      await post(`/admin/alerts/${id}/end`);
      recent.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
      <Card title="Объявить тревогу">
        <div className="space-y-4">
          <Field label="Регионы">
            <button onClick={() => setPick(true)} className="flex min-h-11 w-full flex-wrap items-center gap-1.5 rounded-xl border border-line-2 bg-panel-2 px-3 py-2 text-left text-sm">
              {regions.length ? regions.map((r) => <Badge key={r}>{regionName(r, true)}</Badge>) : <span className="text-dim">Выберите регионы…</span>}
            </button>
          </Field>
          <Field label="Тип">
            <Select value={type} onChange={(e) => setType(e.target.value as AlertType)}>
              {ALERT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {THREATS[t].long}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Сообщение (необязательно)">
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="Пройдите в укрытие…" />
          </Field>
          <Button variant="danger" className="w-full" size="lg" disabled={!regions.length} loading={busy} onClick={start}>
            <Icon name="bolt" className="size-4" /> Объявить и разослать push
          </Button>
        </div>
      </Card>
      <div className="space-y-5">
        <Card title={`Активные (${alerts.length})`}>
          {alerts.length ? (
            <div className="space-y-1.5">
              {alerts.map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-xl bg-panel-2 px-3 py-2 text-sm">
                  <ThreatIcon type={a.type} className="size-5" color={THREATS[a.type].color} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{regionName(a.regionId)}</div>
                    <div className="text-xs text-muted">
                      {THREATS[a.type].long} · {a.sourceName} · {fmtDuration(now - a.startedAt)}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => end(a.id)}>
                    Отбой
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Активных тревог нет.</p>
          )}
        </Card>
        <Card title="За 3 дня">
          <div className="max-h-96 space-y-0.5 overflow-y-auto">
            {recent.data?.alerts.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-1 py-1 text-sm">
                <ThreatIcon type={a.type} className="size-4" color={THREATS[a.type].color} />
                <span className="flex-1 truncate">{regionName(a.regionId, true)}</span>
                <span className="text-xs text-dim">{a.sourceName}</span>
                <span className="font-mono text-xs text-muted">{fmtDateTime(a.startedAt)}</span>
                <span className="w-20 text-right text-xs text-muted">{a.endedAt ? fmtDuration(a.endedAt - a.startedAt) : 'идёт'}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Modal open={pick} onClose={() => setPick(false)} title="Регионы тревоги">
        <RegionList multi selected={regions} onSelect={(id) => setRegions((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))} maxHeight="max-h-[55dvh]" />
        <Button className="mt-4 w-full" onClick={() => setPick(false)}>
          Готово ({regions.length})
        </Button>
      </Modal>
    </div>
  );
}

/* ---------------- Reports moderation ---------------- */

export function ReportsTab() {
  const { now } = useApp();
  const list = useAsync(() => get<{ reports: (Report & { removed?: boolean })[] }>('/admin/reports'), []);
  const remove = async (id: number) => {
    try {
      await del(`/admin/reports/${id}`);
      list.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  if (!list.data) return <Loading />;
  if (!list.data.reports.length) return <EmptyState title="Меток за 2 дня нет" />;
  return (
    <Card title="Метки за 48 часов" padded={false}>
      <div className="divide-y divide-line">
        {list.data.reports.map((r) => {
          const active = r.expiresAt > now;
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <ThreatIcon type={r.type} className="size-5" color={THREATS[r.type].color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-semibold">
                  {THREATS[r.type].label} · {regionName(r.regionId, true)} {r.isPlus && <PlusBadge />}
                </div>
                <div className="text-xs text-muted">
                  {r.author} · {fmtAgo(r.createdAt, now)} · ✓{r.confirms} ✕{r.dismisses} · {r.lat.toFixed(2)}, {r.lon.toFixed(2)}
                  {r.comment ? ` · «${r.comment}»` : ''}
                </div>
              </div>
              <Badge color={active ? '#22c55e' : '#7d899b'}>{active ? 'активна' : 'истекла'}</Badge>
              {active && (
                <Button size="sm" variant="danger" onClick={() => remove(r.id)}>
                  Удалить
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------------- Users ---------------- */

type AdminUser = PublicUser & { banned: boolean; reports: number };

export function UsersTab() {
  const { user: me } = useApp();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => get<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(query)}`), [query]);
  const update = async (id: number, body: Record<string, unknown>) => {
    try {
      await patch(`/admin/users/${id}`, body);
      list.reload();
      toast('Сохранено', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q);
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по email или имени" />
        <Button type="submit" variant="outline">
          Найти
        </Button>
      </form>
      {!list.data ? (
        <Loading />
      ) : (
        <div className="space-y-2">
          {list.data.users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel/80 p-3 text-sm">
              <div className="min-w-48 flex-1">
                <div className="flex items-center gap-2 font-semibold">
                  {u.name} {u.isPlus && <PlusBadge />} {u.banned && <Badge color="#ff3b4f">бан</Badge>}
                </div>
                <div className="text-xs text-muted">
                  {u.email} · {u.regionId ? regionName(u.regionId, true) : 'регион не выбран'} · меток: {u.reports}
                  {u.isPlus && u.plusUntil ? ` · Радар+ до ${fmtDateTime(u.plusUntil)}` : ''}
                </div>
              </div>
              <Select value={u.role} disabled={u.id === me?.id} onChange={(e) => update(u.id, { role: e.target.value })} className="w-auto py-1.5 text-xs">
                <option value="user">Пользователь</option>
                <option value="moderator">Модератор</option>
                <option value="admin">Администратор</option>
              </Select>
              <Button size="sm" variant="outline" onClick={() => update(u.id, { grantPlusDays: 30 })}>
                +30 дн. Радар+
              </Button>
              {u.isPlus && (
                <Button size="sm" variant="ghost" onClick={() => update(u.id, { revokePlus: true })}>
                  Снять Радар+
                </Button>
              )}
              {u.id !== me?.id && (
                <Button size="sm" variant={u.banned ? 'subtle' : 'danger'} onClick={() => update(u.id, { banned: !u.banned })}>
                  {u.banned ? 'Разбанить' : 'Забанить'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Front line ---------------- */

interface FrontConfig {
  sourceUrl: string;
  autoRefreshMin: number;
  lastError: string | null;
  lastImportAt: number | null;
}

export function FrontTab() {
  const res = useAsync(() => get<{ front: FrontData; config: FrontConfig }>('/admin/front'), []);
  const [cfg, setCfg] = useState<FrontConfig | null>(null);
  const [arrowsText, setArrowsText] = useState('');
  const [geoText, setGeoText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (res.data) {
      setCfg(res.data.config);
      setArrowsText(JSON.stringify(res.data.front.arrows, null, 2));
    }
  }, [res.data]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'ok');
      res.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!res.data || !cfg) return <Loading />;
  const front = res.data.front;

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_460px]">
      <Card padded={false} title={front.isDemo ? 'Предпросмотр — демо-данные' : `Предпросмотр — ${front.source || ''}`}>
        <FrontMap data={front} layers={{ zones: true, line: true, arrows: true, rivers: true, cities: true }} className="h-[60dvh]" />
      </Card>
      <div className="space-y-5">
        <Card title="Автоимпорт из источника">
          <div className="space-y-3">
            <Field label="URL GeoJSON" hint="FeatureCollection с полигонами зон (properties.kind: occupied / gray / liberated) и линиями. Поддерживаются обёртки вида { map: … }. Используйте источники, на которые у вас есть права.">
              <Input value={cfg.sourceUrl} onChange={(e) => setCfg({ ...cfg, sourceUrl: e.target.value })} placeholder="https://…/front.geojson" />
            </Field>
            <Field label="Обновлять каждые, мин (0 — вручную)">
              <Input type="number" min={0} value={cfg.autoRefreshMin} onChange={(e) => setCfg({ ...cfg, autoRefreshMin: Number(e.target.value) })} />
            </Field>
            {cfg.lastError && <p className="text-xs text-alert">Ошибка: {cfg.lastError}</p>}
            {cfg.lastImportAt && <p className="text-xs text-muted">Последний импорт: {fmtDateTime(cfg.lastImportAt)}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={busy === 'cfg'} onClick={() => run('cfg', () => put('/admin/front/config', { sourceUrl: cfg.sourceUrl, autoRefreshMin: cfg.autoRefreshMin }), 'Настройки сохранены')}>
                Сохранить
              </Button>
              <Button size="sm" variant="outline" loading={busy === 'imp'} onClick={() => run('imp', () => post('/admin/front/import', { url: cfg.sourceUrl }), 'Данные импортированы')}>
                Импортировать сейчас
              </Button>
            </div>
          </div>
        </Card>
        <Card title="Загрузить вручную">
          <div className="space-y-3">
            <input
              type="file"
              accept=".json,.geojson,application/json"
              className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-panel-3 file:px-3 file:py-2 file:text-text"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setGeoText(await f.text());
              }}
            />
            <Textarea value={geoText} onChange={(e) => setGeoText(e.target.value)} placeholder='{"type":"FeatureCollection","features":[…]}' className="font-mono text-xs" />
            <Button
              size="sm"
              disabled={!geoText}
              loading={busy === 'geo'}
              onClick={() =>
                run(
                  'geo',
                  async () => {
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(geoText);
                    } catch {
                      throw new Error('Некорректный JSON');
                    }
                    await put('/admin/front', { geojson: parsed, source: 'Загружено вручную' });
                  },
                  'Линия фронта обновлена',
                )
              }
            >
              Сохранить GeoJSON
            </Button>
          </div>
        </Card>
        <Card title="Стрелки продвижения">
          <div className="space-y-3">
            <p className="text-xs text-muted">
              Массив объектов: <code className="text-accent">{'{ id, side: "ru"|"ua", coords: [[lon,lat],…], label }'}</code>. Последняя точка — наконечник.
            </p>
            <Textarea value={arrowsText} onChange={(e) => setArrowsText(e.target.value)} className="min-h-48 font-mono text-xs" />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={busy === 'arr'}
                onClick={() =>
                  run(
                    'arr',
                    async () => {
                      let arrows: FrontArrow[];
                      try {
                        arrows = JSON.parse(arrowsText);
                      } catch {
                        throw new Error('Некорректный JSON стрелок');
                      }
                      await put('/admin/front', { arrows });
                    },
                    'Стрелки сохранены',
                  )
                }
              >
                Сохранить стрелки
              </Button>
              <Button size="sm" variant="ghost" loading={busy === 'demo'} onClick={() => run('demo', () => post('/admin/front/reset-demo'), 'Возвращены демо-данные')}>
                Сбросить к демо
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Payments ---------------- */

interface SettingsAll {
  site: { name: string };
  limits: {
    freeCooldownMin: number;
    plusPerHour: number;
    alertMaxHours: number;
    ttl: Record<string, number>;
    dismissThreshold: number;
    historyDaysFree: number;
    historyDaysPlus: number;
  };
  plus: { priceMonth: number; priceYear: number; currency: string };
  yookassa: { enabled: boolean; shopId: string; secretKey: string; receipt: boolean; vatCode: number };
}

function useSettings() {
  const res = useAsync(() => get<SettingsAll>('/admin/settings'), []);
  const save = async (key: keyof SettingsAll, value: unknown) => {
    try {
      await put(`/admin/settings/${key}`, value);
      toast('Сохранено', 'ok');
      res.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return { data: res.data, save };
}

export function PaymentsTab() {
  const { data, save } = useSettings();
  const payments = useAsync(() => get<{ payments: { id: number; email: string; provider: string; plan: string; amount: number; currency: string; status: string; created_at: number }[] }>('/admin/payments'), []);
  const [plus, setPlus] = useState<SettingsAll['plus'] | null>(null);
  const [yk, setYk] = useState<SettingsAll['yookassa'] | null>(null);
  useEffect(() => {
    if (data) {
      setPlus(data.plus);
      setYk(data.yookassa);
    }
  }, [data]);
  if (!plus || !yk) return <Loading />;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <Card title="Цены Радар+">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Месяц, ₽">
              <Input type="number" value={plus.priceMonth} onChange={(e) => setPlus({ ...plus, priceMonth: Number(e.target.value) })} />
            </Field>
            <Field label="Год, ₽">
              <Input type="number" value={plus.priceYear} onChange={(e) => setPlus({ ...plus, priceYear: Number(e.target.value) })} />
            </Field>
          </div>
          <Button className="mt-4" size="sm" onClick={() => save('plus', plus)}>
            Сохранить цены
          </Button>
        </Card>
        <Card title="ЮKassa">
          <div className="space-y-3">
            <Toggle checked={yk.enabled} onChange={(v) => setYk({ ...yk, enabled: v })} label="Приём платежей включён" />
            <Field label="shopId">
              <Input value={yk.shopId} onChange={(e) => setYk({ ...yk, shopId: e.target.value })} />
            </Field>
            <Field label="Секретный ключ" hint="Хранится в зашифрованном виде. Оставьте маску, чтобы не менять.">
              <Input type="password" value={yk.secretKey} onChange={(e) => setYk({ ...yk, secretKey: e.target.value })} autoComplete="off" />
            </Field>
            <Checkbox checked={yk.receipt} onChange={(v) => setYk({ ...yk, receipt: v })} label="Передавать чек (54-ФЗ)" />
            {yk.receipt && (
              <Field label="Код НДС (vat_code)">
                <Input type="number" min={1} max={12} value={yk.vatCode} onChange={(e) => setYk({ ...yk, vatCode: Number(e.target.value) })} />
              </Field>
            )}
            <p className="rounded-xl bg-panel-2 p-3 text-xs text-muted">
              В личном кабинете ЮKassa укажите HTTP-уведомления на
              <code className="mt-1 block break-all text-accent">{location.origin}/api/billing/webhook/yookassa</code>
              событие <b>payment.succeeded</b> и <b>payment.canceled</b>. Платёж перепроверяется через API перед активацией подписки.
            </p>
            <Button size="sm" onClick={() => save('yookassa', yk)}>
              Сохранить
            </Button>
          </div>
        </Card>
      </div>
      <Card title="Платежи" padded={false}>
        <div className="max-h-[70dvh] divide-y divide-line overflow-y-auto">
          {payments.data?.payments.length ? (
            payments.data.payments.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1 truncate">{p.email}</span>
                <span className="text-xs text-muted">{p.plan === 'year' ? 'год' : 'мес'}</span>
                <span>{fmtMoney(p.amount / 100, p.currency)}</span>
                <Badge color={p.status === 'succeeded' ? '#22c55e' : p.status === 'pending' ? '#ffb020' : '#7d899b'}>
                  {p.provider === 'demo' ? 'тест' : p.status}
                </Badge>
                <span className="font-mono text-xs text-dim">{fmtDateTime(p.created_at)}</span>
              </div>
            ))
          ) : (
            <p className="p-4 text-sm text-muted">Платежей пока нет.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Limits / settings ---------------- */

export function SettingsTab() {
  const { data, save } = useSettings();
  const [limits, setLimits] = useState<SettingsAll['limits'] | null>(null);
  const [site, setSite] = useState<SettingsAll['site'] | null>(null);
  useEffect(() => {
    if (data) {
      setLimits(data.limits);
      setSite(data.site);
    }
  }, [data]);
  if (!limits || !site) return <Loading />;
  const num = (k: keyof SettingsAll['limits'], label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" value={limits[k] as number} onChange={(e) => setLimits({ ...limits, [k]: Number(e.target.value) })} />
    </Field>
  );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Метки и тревоги">
        <div className="grid grid-cols-2 gap-3">
          {num('freeCooldownMin', 'Без подписки: 1 метка в N мин')}
          {num('plusPerHour', 'Радар+: макс. меток в час', 'Защита от спама')}
          {num('dismissThreshold', '«Уже нет» для скрытия', 'Голоса Радар+ весят ×2')}
          {num('alertMaxHours', 'Автоотбой через, ч', 'Если источник не прислал отбой')}
          {num('historyDaysFree', 'История без подписки, дн.')}
          {num('historyDaysPlus', 'История Радар+, дн.')}
        </div>
        <div className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">Время жизни меток, мин</div>
        <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-5">
          {REPORT_TYPES.map((t) => (
            <Field key={t} label={THREATS[t].label}>
              <Input type="number" value={limits.ttl[t]} onChange={(e) => setLimits({ ...limits, ttl: { ...limits.ttl, [t]: Number(e.target.value) } })} />
            </Field>
          ))}
        </div>
        <Button className="mt-4" size="sm" onClick={() => save('limits', limits)}>
          Сохранить
        </Button>
      </Card>
      <Card title="Сайт">
        <Field label="Название">
          <Input value={site.name} onChange={(e) => setSite({ name: e.target.value })} />
        </Field>
        <Button className="mt-4" size="sm" onClick={() => save('site', site)}>
          Сохранить
        </Button>
      </Card>
    </div>
  );
}

export function Loading() {
  return (
    <div className="grid h-40 place-items-center">
      <Spinner className="text-accent" />
    </div>
  );
}
