import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { THREATS, type ThreatType } from '@shared/constants';
import { DISTRICTS, REGIONS, regionName } from '@shared/regions';
import { Icon } from '../../components/Icons';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Spinner, Toggle, toast, useAsync } from '../../components/ui';
import { del, errorText, get, patch, post } from '../../lib/api';
import { fmtAgo, fmtDateTime } from '../../lib/format';

/* ---------- types ---------- */

type SourceType = 'telegram' | 'rss';
type Lang = 'ru' | 'uk' | 'en';
type Kind = 'official' | 'monitoring' | 'media' | 'military';
type Side = 'ru' | 'ua' | 'other';

interface Source {
  id: number;
  name: string;
  type: SourceType;
  handle: string;
  lang: Lang;
  kind: Kind;
  side: Side;
  regionId: string | null;
  autoAlerts: boolean;
  trust: number;
  enabled: boolean;
  pollSeconds: number;
  lastFetchAt: number | null;
  lastError: string | null;
  lastPostAt: number | null;
  posts24h: number;
}

interface Signals {
  threats: ('air' | 'uav' | 'missile' | 'aviation' | 'explosion')[];
  allClear: boolean;
  isThreatNotice: boolean;
  regions: string[];
  intercepts: { regionId: string | null; count: number; type: 'uav' | 'missile' }[];
}

interface Post {
  id?: number;
  sourceId?: number;
  sourceName?: string;
  url: string | null;
  text: string;
  postedAt: number;
  signals: Signals;
}

interface Form {
  name: string;
  type: SourceType;
  handle: string;
  lang: Lang;
  kind: Kind;
  side: Side;
  regionId: string;
  autoAlerts: boolean;
  trust: number;
  enabled: boolean;
  pollSeconds: number;
}

const KINDS: Record<Kind, { label: string; color: string }> = {
  official: { label: 'Официальный', color: '#22c55e' },
  military: { label: 'Военный', color: '#a78bfa' },
  monitoring: { label: 'Мониторинг', color: '#34e3ff' },
  media: { label: 'СМИ', color: '#7d899b' },
};
const SIDES: Record<Side, { label: string; color: string }> = {
  ru: { label: 'RU', color: '#ff6b6b' },
  ua: { label: 'UA', color: '#ffc845' },
  other: { label: 'Иное', color: '#7d899b' },
};
const LANGS: Record<Lang, string> = { ru: 'Русский', uk: 'Украинский', en: 'Английский' };

const EMPTY: Form = {
  name: '',
  type: 'telegram',
  handle: '',
  lang: 'ru',
  kind: 'media',
  side: 'ru',
  regionId: '',
  autoAlerts: false,
  trust: 0.5,
  enabled: true,
  pollSeconds: 300,
};

const REGIONS_BY_DISTRICT = DISTRICTS.map((d) => ({
  district: d,
  regions: REGIONS.filter((r) => r.district === d).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
})).filter((g) => g.regions.length);

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-line bg-panel-2/60 p-3 text-xs leading-relaxed text-muted">
      <Icon name="info" className="mt-0.5 size-4 shrink-0 text-accent" />
      <div>{children}</div>
    </div>
  );
}

/* ---------- signal badges ---------- */

function SignalBadges({ s }: { s: Signals }) {
  const items: ReactNode[] = [];
  if (s.isThreatNotice) items.push(<Badge key="notice" color="#ff3b4f">Оповещение</Badge>);
  if (s.allClear) items.push(<Badge key="clear" color="#22c55e">Отбой</Badge>);
  for (const t of s.threats) {
    const meta = THREATS[t as ThreatType];
    items.push(
      <Badge key={`t-${t}`} color={meta.color}>
        {meta.label}
      </Badge>,
    );
  }
  for (const r of s.regions.slice(0, 6)) items.push(<Badge key={`r-${r}`} color="#7d899b">{regionName(r, true)}</Badge>);
  if (s.regions.length > 6) items.push(<Badge key="r-more" color="#7d899b">+{s.regions.length - 6}</Badge>);
  for (const [i, x] of s.intercepts.entries()) {
    items.push(
      <Badge key={`i-${i}`} color={x.type === 'uav' ? '#ffb020' : '#ff2d6f'}>
        Перехват: {x.type === 'uav' ? 'БПЛА' : 'ракеты'} ×{x.count}
        {x.regionId ? ` · ${regionName(x.regionId, true)}` : ''}
      </Badge>,
    );
  }
  if (!items.length) return <span className="text-[11px] text-dim">сигналов не найдено</span>;
  return <div className="flex flex-wrap gap-1">{items}</div>;
}

function PostItem({ post, showSource }: { post: Post; showSource?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = post.text.length > 280;
  return (
    <div className="rounded-xl border border-line bg-panel-2/50 p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
        {showSource && post.sourceName && <span className="font-semibold text-text">{post.sourceName}</span>}
        <span title={fmtDateTime(post.postedAt)}>{fmtAgo(post.postedAt)}</span>
        {post.url && (
          <a href={post.url} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
            открыть ↗
          </a>
        )}
      </div>
      <p className="whitespace-pre-line break-words text-sm leading-relaxed">{open || !long ? post.text : `${post.text.slice(0, 280)}…`}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs font-semibold text-accent">
          {open ? 'Свернуть' : 'Показать полностью'}
        </button>
      )}
      <div className="mt-2">
        <SignalBadges s={post.signals} />
      </div>
    </div>
  );
}

/* ====================================================================== */

export default function SourcesTab() {
  const sources = useAsync(() => get<{ sources: Source[] }>('/admin/sources'), []);
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const [feedKey, setFeedKey] = useState(0);
  const [fetching, setFetching] = useState<number | null>(null);
  const list = sources.data?.sources ?? [];

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      sources.reload();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const fetchNow = async (s: Source) => {
    setFetching(s.id);
    try {
      const r = await post<{ added: number }>(`/admin/sources/${s.id}/fetch`);
      toast(r.added ? `${s.name}: новых постов — ${r.added}` : `${s.name}: новых постов нет`, 'ok');
      setFeedKey((k) => k + 1);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setFetching(null);
      sources.reload();
    }
  };

  const remove = (s: Source) => window.confirm(`Удалить источник «${s.name}» вместе с его постами?`) && act(() => del(`/admin/sources/${s.id}`), 'Источник удалён');

  return (
    <div className="space-y-5">
      <Card
        title="Источники новостей и оповещений"
        action={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Icon name="plus" className="size-4" /> Источник
          </Button>
        }
      >
        <div className="space-y-4">
          <Hint>
            Публичные Telegram-каналы и RSS читаются автоматически и попадают в ИИ-прогноз (российские и украинские — все сразу). Официальные источники
            («Официальный») с галочкой «Автотревоги» <b>сами создают и закрывают официальные тревоги</b>: пост свежее 30 минут, регион берётся из привязки к
            региону или из текста (1–3 региона). «Отбой» в тексте закрывает тревоги этого источника. Остальные типы источников только питают прогноз.
            Примеры источников добавлены выключенными — проверьте их кнопкой «Проверить» и включите.
          </Hint>
          {sources.loading && !sources.data && (
            <div className="grid h-24 place-items-center">
              <Spinner className="text-accent" />
            </div>
          )}
          {sources.error && <div className="text-sm text-alert">{sources.error}</div>}
          {!sources.loading && !sources.error && !list.length && (
            <EmptyState icon={<Icon name="tower" className="size-10" />} title="Источников нет" text="Добавьте Telegram-канал или RSS-ленту." action={<Button onClick={() => setEditing('new')}>Добавить источник</Button>} />
          )}
          <div className="space-y-2">
            {list.map((s) => (
              <div key={s.id} className={`rounded-2xl border border-line bg-panel-2/50 p-3 ${s.enabled ? '' : 'opacity-70'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{s.name}</span>
                      <Badge color={KINDS[s.kind].color}>{KINDS[s.kind].label}</Badge>
                      <Badge color={SIDES[s.side].color}>{SIDES[s.side].label}</Badge>
                      <Badge color="#7d899b">{s.lang.toUpperCase()}</Badge>
                      {s.autoAlerts && (
                        <Badge color="#ff3b4f">
                          <Icon name="bolt" className="size-3" /> Автотревоги
                        </Badge>
                      )}
                      {s.regionId && <Badge color="#34e3ff">{regionName(s.regionId, true)}</Badge>}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-muted">
                      {s.type === 'telegram' ? (
                        <a href={`https://t.me/s/${s.handle}`} target="_blank" rel="noreferrer noopener" className="hover:text-accent">
                          t.me/{s.handle}
                        </a>
                      ) : (
                        s.handle
                      )}
                      <span className="ml-2 text-dim">
                        доверие {Math.round(s.trust * 100)}% · раз в {s.pollSeconds >= 120 ? `${Math.round(s.pollSeconds / 60)} мин` : `${s.pollSeconds} с`}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-12" title={s.enabled ? 'Включён' : 'Отключён'}>
                      <Toggle checked={s.enabled} onChange={(v) => act(() => patch(`/admin/sources/${s.id}`, { enabled: v }))} />
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-xs text-muted">
                    {s.lastFetchAt ? <>Обновлён {fmtAgo(s.lastFetchAt)}</> : 'Ещё не загружался'} · постов за 24 ч: <span className="font-mono text-text">{s.posts24h}</span>
                    {s.lastPostAt && <> · последний пост {fmtAgo(s.lastPostAt)}</>}
                    {s.lastError && <div className="mt-1 break-words text-alert">✕ {s.lastError}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="subtle" loading={fetching === s.id} onClick={() => fetchNow(s)}>
                      <Icon name="refresh" className="size-4" /> Обновить сейчас
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                      Изменить
                    </Button>
                    <Button size="sm" variant="danger" aria-label="Удалить источник" onClick={() => remove(s)}>
                      <Icon name="trash" className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <PostsFeed sources={list} refreshKey={feedKey} />

      <SourceModal
        open={editing !== null}
        source={editing && editing !== 'new' ? editing : null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          sources.reload();
          setFeedKey((k) => k + 1);
        }}
      />
    </div>
  );
}

/* ---------- add / edit ---------- */

function SourceModal({ open, source, onClose, onSaved }: { open: boolean; source: Source | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<Post[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setPreviewError(null);
    setForm(
      source
        ? {
            name: source.name,
            type: source.type,
            handle: source.handle,
            lang: source.lang,
            kind: source.kind,
            side: source.side,
            regionId: source.regionId ?? '',
            autoAlerts: source.autoAlerts,
            trust: source.trust,
            enabled: source.enabled,
            pollSeconds: source.pollSeconds,
          }
        : EMPTY,
    );
  }, [open, source]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const check = async () => {
    setChecking(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const r = await post<{ posts: Post[] }>('/admin/sources/preview', { type: form.type, handle: form.handle });
      setPreview(r.posts);
    } catch (e) {
      setPreviewError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        type: form.type,
        handle: form.handle,
        lang: form.lang,
        kind: form.kind,
        side: form.side,
        regionId: form.regionId || null,
        autoAlerts: form.autoAlerts && form.kind === 'official',
        trust: form.trust,
        enabled: form.enabled,
        pollSeconds: form.pollSeconds,
      };
      if (source) await patch(`/admin/sources/${source.id}`, payload);
      else await post('/admin/sources', payload);
      toast(source ? 'Источник обновлён' : 'Источник добавлен', 'ok');
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const official = form.kind === 'official';
  const valid = form.name.trim() && form.handle.trim();

  return (
    <Modal open={open} onClose={onClose} title={source ? 'Изменить источник' : 'Новый источник'} wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Название">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Губернатор Белгородской области" maxLength={80} />
          </Field>
          <Field label="Тип">
            <Select value={form.type} onChange={(e) => set('type', e.target.value as SourceType)}>
              <option value="telegram">Telegram-канал</option>
              <option value="rss">RSS / Atom</option>
            </Select>
          </Field>
        </div>
        <Field
          label={form.type === 'telegram' ? 'Канал' : 'Адрес ленты'}
          hint={form.type === 'telegram' ? 'Подойдёт @name, t.me/name или https://t.me/s/name. Канал должен быть публичным с включённым просмотром.' : 'Полный URL RSS/Atom-ленты (https://…)'}
        >
          <Input
            value={form.handle}
            onChange={(e) => set('handle', e.target.value)}
            placeholder={form.type === 'telegram' ? '@mod_russia' : 'https://example.ru/rss.xml'}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Тип источника" hint="Официальные — власти и штабы; военные — сводки ведомств">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KINDS[k].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Сторона" hint="Для сопоставления российских и украинских данных">
            <Select value={form.side} onChange={(e) => set('side', e.target.value as Side)}>
              <option value="ru">Россия</option>
              <option value="ua">Украина</option>
              <option value="other">Нейтральная / иная</option>
            </Select>
          </Field>
          <Field label="Язык">
            <Select value={form.lang} onChange={(e) => set('lang', e.target.value as Lang)}>
              {(Object.keys(LANGS) as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {LANGS[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Привязка к региону" hint="Для региональных каналов (губернатор, штаб): тревоги создаются в этом регионе">
            <Select value={form.regionId} onChange={(e) => set('regionId', e.target.value)}>
              <option value="">Без привязки (регионы из текста)</option>
              {REGIONS_BY_DISTRICT.map((g) => (
                <optgroup key={g.district} label={g.district}>
                  {g.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label={`Доверие: ${Math.round(form.trust * 100)}%`} hint="Вес источника для ИИ: официальные ≈ 90%, мониторинг ≈ 50–70%">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={form.trust}
              onChange={(e) => set('trust', Number(e.target.value))}
              className="h-10 w-full accent-[#34e3ff]"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Частота опроса" hint="От 60 секунд до часа">
            <Select value={String(form.pollSeconds)} onChange={(e) => set('pollSeconds', Number(e.target.value))}>
              {[60, 120, 180, 300, 600, 900, 1800, 3600].map((s) => (
                <option key={s} value={s}>
                  {s < 120 ? `${s} секунд` : `${s / 60} мин`}
                </option>
              ))}
              {![60, 120, 180, 300, 600, 900, 1800, 3600].includes(form.pollSeconds) && <option value={form.pollSeconds}>{form.pollSeconds} с</option>}
            </Select>
          </Field>
          <div className="space-y-1">
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} label="Включён" description="Опрашивать источник" />
            <Toggle
              checked={form.autoAlerts && official}
              onChange={(v) => set('autoAlerts', v)}
              disabled={!official}
              label="Автотревоги"
              description={official ? 'Создавать и закрывать официальные тревоги по постам' : 'Доступно только для типа «Официальный»'}
            />
          </div>
        </div>
        {form.autoAlerts && official && (
          <Hint>
            Тревога создаётся, только если пост опубликован не более 30 минут назад и содержит угрозу (БПЛА, ракеты, авиация, воздушная тревога). Регион:{' '}
            {form.regionId ? <b>{regionName(form.regionId)}</b> : 'из текста поста, если упомянуто от 1 до 3 регионов'}. «Отбой» закроет тревоги, созданные этим источником.
            Проверьте предпросмотр ниже перед включением.
          </Hint>
        )}

        <div className="space-y-3 rounded-2xl border border-line bg-panel-2/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold">Предпросмотр</div>
            <Button size="sm" variant="subtle" loading={checking} disabled={!form.handle.trim()} onClick={check}>
              Проверить
            </Button>
          </div>
          {previewError && <div className="break-words text-sm text-alert">✕ {previewError}</div>}
          {preview && (
            <div className="space-y-2">
              <div className="text-xs text-ok">✓ Источник доступен, последних постов: {preview.length}</div>
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {preview.map((p, i) => (
                  <PostItem key={i} post={p} />
                ))}
              </div>
            </div>
          )}
          {!preview && !previewError && !checking && <div className="text-xs text-dim">Нажмите «Проверить», чтобы увидеть последние посты и найденные сигналы — ничего не сохраняется.</div>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button loading={busy} disabled={!valid} onClick={save}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- posts feed ---------- */

function PostsFeed({ sources, refreshKey }: { sources: Source[]; refreshKey: number }) {
  const [sourceId, setSourceId] = useState('');
  const feed = useAsync(
    () => get<{ posts: Post[] }>(`/admin/sources/posts?limit=50${sourceId ? `&sourceId=${sourceId}` : ''}`),
    [sourceId, refreshKey],
  );
  const posts = feed.data?.posts ?? [];
  const options = useMemo(() => [...sources].sort((a, b) => a.name.localeCompare(b.name, 'ru')), [sources]);

  return (
    <Card
      title="Лента постов"
      action={
        <Button size="sm" variant="ghost" onClick={feed.reload} aria-label="Обновить ленту">
          <Icon name="refresh" className="size-4" />
        </Button>
      }
    >
      <div className="space-y-3">
        <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Источник">
          <option value="">Все источники</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {feed.loading && !feed.data && (
          <div className="grid h-24 place-items-center">
            <Spinner className="text-accent" />
          </div>
        )}
        {feed.error && <div className="text-sm text-alert">{feed.error}</div>}
        {!feed.loading && !posts.length && !feed.error && (
          <div className="py-6 text-center text-sm text-muted">Постов пока нет. Включите источник или нажмите «Обновить сейчас».</div>
        )}
        <div className="space-y-2">
          {posts.map((p) => (
            <PostItem key={p.id} post={p} showSource />
          ))}
        </div>
      </div>
    </Card>
  );
}
