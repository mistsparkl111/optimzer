import { useState } from 'react';
import { Link } from 'react-router-dom';
import { REPORT_TYPES, THREATS, type ReportType } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { Report } from '@shared/types';
import { post, errorText } from '../lib/api';
import { getPosition } from '../lib/geo';
import { fmtDuration } from '../lib/format';
import { useApp } from '../lib/store';
import { RussiaMap } from './RussiaMap';
import { Icon, ThreatBadge } from './Icons';
import { Button, cx, Input, Modal, PlusBadge, toast } from './ui';

const DIRS = [
  { label: 'С', deg: 0 },
  { label: 'СВ', deg: 45 },
  { label: 'В', deg: 90 },
  { label: 'ЮВ', deg: 135 },
  { label: 'Ю', deg: 180 },
  { label: 'ЮЗ', deg: 225 },
  { label: 'З', deg: 270 },
  { label: 'СЗ', deg: 315 },
];

export function ReportComposer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, meta, prefs, now, refreshUser } = useApp();
  const [type, setType] = useState<ReportType | null>(null);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  const close = () => {
    setType(null);
    setPoint(null);
    setHeading(null);
    setCount(null);
    setComment('');
    onClose();
  };

  const submit = async () => {
    if (!type || !point) return;
    setBusy(true);
    try {
      await post<{ report: Report }>('/reports', { type, lon: point[0], lat: point[1], heading, count, comment: comment || null });
      toast(`Метка «${THREATS[type].label}» опубликована`, 'ok');
      void refreshUser();
      close();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    setLocating(true);
    try {
      setPoint(await getPosition());
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setLocating(false);
    }
  };

  if (!user)
    return (
      <Modal open={open} onClose={close} title="Отметить угрозу">
        <div className="space-y-4 text-center">
          <p className="text-muted">Чтобы ставить метки, войдите в аккаунт — это защищает карту от спама.</p>
          <Link to="/profile" onClick={close}>
            <Button className="w-full" size="lg">
              Войти или зарегистрироваться
            </Button>
          </Link>
        </div>
      </Modal>
    );

  const cooldown = user.nextReportAt && user.nextReportAt > now ? user.nextReportAt - now : 0;
  if (cooldown)
    return (
      <Modal open={open} onClose={close} title="Отметить угрозу">
        <div className="space-y-4 text-center">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-plus/10 text-plus">
            <Icon name="clock" className="size-8" />
          </div>
          <p>
            Без подписки можно ставить <b>1 метку в {meta?.limits.freeCooldownMin ?? 60} мин</b>.<br />
            Следующая — через <b className="font-mono">{fmtDuration(cooldown)}</b>.
          </p>
          <p className="text-sm text-muted">
            С <PlusBadge /> метки без ограничений — подписка защищает ленту от спама и окупает работу сервиса.
          </p>
          <Link to="/plus" onClick={close}>
            <Button variant="plus" className="w-full" size="lg">
              Подключить Радар+
            </Button>
          </Link>
        </div>
      </Modal>
    );

  return (
    <Modal open={open} onClose={close} title="Отметить угрозу" wide>
      {!type ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Что вы видите или слышите?</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {REPORT_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className="flex flex-col items-center gap-2 rounded-2xl border border-line bg-panel-2 px-3 py-4 transition hover:border-line-2 hover:bg-panel-3"
              >
                <ThreatBadge type={t} size={48} />
                <span className="font-bold">{THREATS[t].label}</span>
                <span className="text-[11px] text-dim">исчезнет через {meta?.ttl[t] ?? THREATS[t].ttlMin} мин</span>
              </button>
            ))}
          </div>
          <Rules />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <button onClick={() => setType(null)} className="flex items-center gap-2 text-sm font-semibold">
              <ThreatBadge type={type} size={32} />
              {THREATS[type].label}
              <span className="text-xs text-accent">изменить</span>
            </button>
            <Button size="sm" variant="outline" onClick={locate} loading={locating}>
              <Icon name="locate" className="size-4" /> Я здесь
            </Button>
          </div>
          <div className="relative h-[42dvh] overflow-hidden rounded-2xl border border-line bg-bg">
            <RussiaMap
              className="h-full"
              pickMode
              onPick={setPoint}
              picked={point ? { lonlat: point, type, heading } : null}
              focusRegion={prefs.regionId}
              homeRegions={prefs.regionId ? [prefs.regionId] : []}
            />
            <div className="pointer-events-none absolute inset-x-3 top-3 rounded-xl bg-panel/85 px-3 py-2 text-center text-xs font-semibold backdrop-blur">
              {point ? 'Точка выбрана — можно уточнить касанием' : 'Коснитесь карты, где замечена угроза'}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Куда движется</div>
            <div className="grid grid-cols-9 gap-1">
              <DirButton active={heading === null} onClick={() => setHeading(null)}>
                ?
              </DirButton>
              {DIRS.map((d) => (
                <DirButton key={d.label} active={heading === d.deg} onClick={() => setHeading(d.deg)}>
                  <span style={{ transform: `rotate(${d.deg}deg)` }}>
                    <Icon name="arrow" className="size-4" strokeWidth={2.4} />
                  </span>
                  <span className="text-[9px]">{d.label}</span>
                </DirButton>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Сколько</div>
              <div className="flex items-center rounded-xl border border-line-2 bg-panel-2">
                <button className="px-3 py-2 text-muted" onClick={() => setCount((c) => (c && c > 1 ? c - 1 : null))}>
                  −
                </button>
                <span className="flex-1 text-center font-mono font-bold">{count ?? '—'}</span>
                <button className="px-3 py-2 text-muted" onClick={() => setCount((c) => Math.min(500, (c ?? 0) + 1))}>
                  +
                </button>
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Комментарий</div>
              <Input value={comment} onChange={(e) => setComment(e.target.value.slice(0, 140))} placeholder="Например: слышен звук мопеда, низко" />
            </div>
          </div>

          <Rules />
          <Button size="lg" className="w-full" disabled={!point} loading={busy} onClick={submit}>
            {point ? 'Опубликовать метку' : 'Выберите точку на карте'}
          </Button>
          {!user.isPlus && user.role === 'user' && (
            <p className="text-center text-xs text-dim">
              Без Радар+ — 1 метка в {meta?.limits.freeCooldownMin ?? 60} мин. <Link className="text-plus" to="/plus">Подробнее</Link>
            </p>
          )}
          {point && <p className="text-center text-xs text-dim">Регион определится автоматически{prefs.regionId ? ` (ваш: ${regionName(prefs.regionId, true)})` : ''}</p>}
        </div>
      )}
    </Modal>
  );
}

function DirButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-xl border text-xs font-bold transition',
        active ? 'border-accent bg-accent/15 text-accent' : 'border-line-2 bg-panel-2 text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function Rules() {
  return (
    <div className="flex gap-2.5 rounded-2xl border border-line bg-panel-2/60 p-3 text-xs text-muted">
      <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-accent" />
      <p>
        Отмечайте только то, что видите или слышите сами. Запрещено публиковать места работы ПВО, позиции военных и последствия ударов —
        такие метки удаляются, а аккаунт блокируется. Метки исчезают сами по истечении времени; другие пользователи могут подтвердить или
        скрыть их.
      </p>
    </div>
  );
}
