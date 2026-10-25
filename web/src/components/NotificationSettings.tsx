import { useEffect, useState } from 'react';
import { ALERT_TYPES, REPORT_TYPES, THREATS, type ThreatType } from '@shared/constants';
import { useApp } from '../lib/store';
import { disablePush, enablePush, getPushStatus, isAndroid, isIOS, isStandalone, testPush, type PushStatus } from '../lib/push';
import { playSiren, unlockAudio } from '../lib/siren';
import { ThreatIcon, Icon } from './Icons';
import { Badge, Button, cx, toast, Toggle } from './ui';
import { errorText } from '../lib/api';

const ALL_TYPES = [...new Set([...ALERT_TYPES, ...REPORT_TYPES])] as ThreatType[];

export function usePushStatus() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const refresh = () => void getPushStatus().then(setStatus);
  useEffect(refresh, []);
  return { status, refresh };
}

export function PushControl({ compact }: { compact?: boolean }) {
  const { meta, prefs, myRegions } = useApp();
  const { status, refresh } = usePushStatus();
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    if (!meta?.vapidPublicKey) return toast('Сервер уведомлений недоступен', 'error');
    if (!myRegions.length) return toast('Сначала выберите регион', 'error');
    setBusy(true);
    unlockAudio();
    try {
      await enablePush(meta.vapidPublicKey, myRegions, prefs.notify);
      toast('Уведомления о тревогах включены', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (status === 'needs-install') return <InstallHint />;
  if (status === 'unsupported')
    return <p className="text-sm text-muted">Этот браузер не поддерживает push-уведомления. Откройте Радар в Chrome или Safari и добавьте на главный экран.</p>;
  if (status === 'denied')
    return (
      <p className="text-sm text-alert">
        Уведомления заблокированы в настройках браузера. Разрешите их для этого сайта и вернитесь сюда.
      </p>
    );
  return (
    <div className={cx('flex flex-wrap items-center gap-2', compact && 'justify-center')}>
      {status === 'on' ? (
        <>
          <Badge color="#22c55e">
            <Icon name="bell" className="size-3" /> Уведомления на этом устройстве включены
          </Badge>
          <Button size="sm" variant="outline" onClick={() => testPush().then(() => toast('Тестовое уведомление отправлено', 'ok'), (e) => toast(errorText(e), 'error'))}>
            Проверить
          </Button>
          <Button size="sm" variant="ghost" onClick={() => disablePush().then(refresh)}>
            Отключить на устройстве
          </Button>
        </>
      ) : (
        <Button onClick={enable} loading={busy} size={compact ? 'lg' : 'md'} className={compact ? 'w-full' : undefined}>
          <Icon name="bell" className="size-4" /> Включить уведомления о тревогах
        </Button>
      )}
    </div>
  );
}

export function InstallHint() {
  if (isStandalone()) return null;
  if (isIOS())
    return (
      <div className="rounded-2xl border border-accent/25 bg-accent/5 p-4 text-sm">
        <div className="mb-2 font-bold text-accent">iPhone / iPad: установите Радар на экран «Домой»</div>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Нажмите <Icon name="share" className="inline size-4 align-text-bottom text-text" /> «Поделиться» в Safari
          </li>
          <li>Выберите «На экран “Домой”»</li>
          <li>Откройте Радар с иконки и включите уведомления (нужен iOS 16.4+)</li>
        </ol>
      </div>
    );
  return (
    <div className="rounded-2xl border border-line-2 bg-panel-2 p-4 text-sm text-muted">
      <span className="font-semibold text-text">{isAndroid() ? 'Android' : 'Компьютер'}:</span> откройте меню браузера → «Установить приложение» /
      «Добавить на главный экран», чтобы получать тревоги как обычное приложение.
    </div>
  );
}

export function NotificationSettings() {
  const { prefs, setPrefs } = useApp();
  const n = prefs.notify;
  const set = (p: Partial<typeof n>) => void setPrefs({ notify: p }).catch((e) => toast(errorText(e), 'error'));
  const toggleType = (t: ThreatType) => set({ types: n.types.includes(t) ? n.types.filter((x) => x !== t) : [...n.types, t] });
  return (
    <div className="space-y-1">
      <Toggle
        checked={n.enabled}
        onChange={(v) => set({ enabled: v })}
        label={n.enabled ? 'Тревоги включены' : 'Тревоги отключены'}
        description="Главный переключатель уведомлений по вашим регионам"
      />
      <div className={cx('space-y-1 transition', !n.enabled && 'pointer-events-none opacity-40')}>
        <Toggle checked={n.official} onChange={(v) => set({ official: v })} label="Официальные тревоги" description="Оперативные штабы, МЧС, губернаторы" />
        <Toggle
          checked={n.userReports}
          onChange={(v) => set({ userReports: v })}
          label="Метки людей"
          description="Сообщения пользователей о БПЛА, ракетах и т. п. (не чаще 1 раза в 10 мин)"
        />
        <Toggle checked={n.allClear} onChange={(v) => set({ allClear: v })} label="Отбой тревоги" />
        <Toggle
          checked={prefs.view.sound}
          onChange={(v) => {
            void setPrefs({ view: { sound: v } });
            if (v) playSiren('alert');
          }}
          label="Звук сирены в приложении"
          description="Короткий сигнал (~2 с), когда приложение открыто"
        />
        <div className="pt-2">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Типы угроз</div>
          <div className="flex flex-wrap gap-2">
            {ALL_TYPES.map((t) => {
              const on = n.types.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleType(t)}
                  className={cx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition', on ? 'border-transparent' : 'border-line-2 text-dim')}
                  style={on ? { color: THREATS[t].color, background: `${THREATS[t].color}1c`, boxShadow: `inset 0 0 0 1px ${THREATS[t].color}55` } : undefined}
                >
                  <ThreatIcon type={t} className="size-3.5" />
                  {THREATS[t].label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
