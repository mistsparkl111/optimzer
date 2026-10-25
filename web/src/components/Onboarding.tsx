import { useState } from 'react';
import { createPortal } from 'react-dom';
import { regionName } from '@shared/regions';
import { useApp } from '../lib/store';
import { RegionList } from './RegionPicker';
import { InstallHint, PushControl } from './NotificationSettings';
import { Icon, RadarLogo, ThreatBadge } from './Icons';
import { Button, cx, Toggle } from './ui';

/** First-run flow: pick the home region, then enable alerts. */
export function Onboarding() {
  const { prefs, setPrefs } = useApp();
  const [step, setStep] = useState(0);
  const [region, setRegion] = useState<string | null>(prefs.regionId);

  const finish = () => void setPrefs({ regionId: region, onboarded: true });

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 backdrop-blur-md sm:items-center">
      <div className="safe-bottom relative flex max-h-[96dvh] w-full max-w-lg animate-slide-up flex-col overflow-hidden rounded-t-3xl border border-line bg-panel sm:rounded-3xl">
        <div className="flex gap-1.5 px-6 pt-5">
          {[0, 1, 2].map((i) => (
            <span key={i} className={cx('h-1 flex-1 rounded-full transition', i <= step ? 'bg-accent' : 'bg-line-2')} />
          ))}
        </div>

        {step === 0 && (
          <div className="flex flex-col items-center gap-5 overflow-y-auto px-6 pb-6 pt-8 text-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-accent/20 blur-2xl" />
              <RadarLogo className="relative size-28" />
            </div>
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight">Радар по всей России</h1>
              <p className="mt-2 text-muted">Воздушные тревоги во всех регионах, включая новые, — в реальном времени.</p>
            </div>
            <div className="grid w-full gap-2 text-left text-sm">
              <Feature icon={<ThreatBadge type="air" size={34} />} title="Тревоги по регионам" text="Официальные источники и оперативные штабы" />
              <Feature icon={<ThreatBadge type="uav" size={34} />} title="Метки БПЛА и ракет" text="Сообщения людей с затуханием и подтверждением" />
              <Feature icon={<ThreatBadge type="aviation" size={34} />} title="ИИ-прогноз" text="Сводки на сегодня и завтра, вероятные направления" />
            </div>
            <Button size="lg" className="w-full" onClick={() => setStep(1)}>
              Начать
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="flex min-h-0 flex-col gap-4 px-6 pb-6 pt-6">
            <div>
              <h2 className="text-xl font-extrabold">Ваш регион</h2>
              <p className="mt-1 text-sm text-muted">Мы пришлём уведомление, когда в нём объявят тревогу. Позже можно добавить ещё регионы.</p>
            </div>
            <RegionList value={region} onSelect={setRegion} maxHeight="max-h-[48dvh]" />
            <Button
              size="lg"
              disabled={!region}
              onClick={() => {
                // Save the region first so the push subscription is targeted correctly.
                void setPrefs({ regionId: region });
                setStep(2);
              }}
            >
              {region ? `Продолжить — ${regionName(region, true)}` : 'Выберите регион'}
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4 overflow-y-auto px-6 pb-6 pt-6">
            <div className="flex items-center gap-3">
              <span className="grid size-12 place-items-center rounded-2xl bg-alert/15 text-alert">
                <Icon name="bell" className="size-6" />
              </span>
              <div>
                <h2 className="text-xl font-extrabold">Уведомления о тревогах</h2>
                <p className="text-sm text-muted">Короткий сигнал и уведомление — даже когда приложение закрыто.</p>
              </div>
            </div>
            <InstallHint />
            <PushControl compact />
            <div className="rounded-2xl border border-line bg-panel-2 px-4 py-2">
              <Toggle checked={prefs.view.showOfficial} onChange={(v) => void setPrefs({ view: { showOfficial: v } })} label="Официальные источники" />
              <Toggle
                checked={prefs.view.hideUserReports}
                onChange={(v) => void setPrefs({ view: { hideUserReports: v } })}
                label="Скрыть от людей"
                description="Не показывать метки пользователей"
              />
            </div>
            <Button size="lg" onClick={finish}>
              Готово
            </Button>
            <button className="text-sm text-muted hover:text-text" onClick={finish}>
              Пропустить уведомления
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-panel-2/70 px-3 py-2.5">
      {icon}
      <div>
        <div className="font-bold">{title}</div>
        <div className="text-xs text-muted">{text}</div>
      </div>
    </div>
  );
}
