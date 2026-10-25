import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { PublicUser } from '@shared/types';
import { post, errorText } from '../lib/api';
import { fmtDate, fmtMoney } from '../lib/format';
import { useApp } from '../lib/store';
import { Icon, ThreatBadge, type IconName } from '../components/Icons';
import { Button, cx, toast } from '../components/ui';

const FEATURES: { icon: IconName | 'uav'; title: string; text: string }[] = [
  { icon: 'uav', title: 'Метки без ограничений', text: 'Отмечайте БПЛА, ракеты, авиацию и взрывы сколько нужно. Без подписки — 1 метка в час.' },
  { icon: 'crown', title: 'Значок «Радар+» на метках', text: 'Метки подписчиков заметнее, их голоса «подтверждаю / уже нет» весят вдвое.' },
  { icon: 'ai', title: 'ИИ-прогноз по запросу', text: 'Обновляйте сводку в любой момент и выбирайте ИИ-модель для анализа.' },
  { icon: 'history', title: 'История за 30 дней', text: 'Подробная статистика тревог по регионам и часам суток.' },
];

export default function PlusPage() {
  const { user, meta, refreshUser, setUser } = useApp();
  const [plan, setPlan] = useState<'month' | 'year'>('year');
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();

  // Back from the payment page: the webhook may land a few seconds later.
  useEffect(() => {
    if (!params.get('payment')) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      void refreshUser();
      if (n > 10) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [params, refreshUser]);

  const price = meta?.plus;
  const monthly = price ? Math.round(price.priceYear / 12) : 0;
  const save = price ? Math.round(100 - (price.priceYear / (price.priceMonth * 12)) * 100) : 0;

  const checkout = async () => {
    setBusy(true);
    try {
      const r = await post<{ confirmationUrl?: string; demo?: boolean; user?: PublicUser }>('/billing/checkout', { plan });
      if (r.confirmationUrl) window.location.href = r.confirmationUrl;
      else if (r.demo && r.user) {
        setUser(r.user);
        toast('Радар+ активирован (тестовый режим без оплаты)', 'ok');
      }
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 p-4 lg:p-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-plus/25 bg-gradient-to-br from-[#1a1405] via-panel to-panel p-6 lg:p-10">
          <div className="absolute -right-24 -top-24 size-72 rounded-full bg-plus/20 blur-3xl" />
          <div className="absolute -bottom-32 left-10 size-72 rounded-full bg-plus-2/10 blur-3xl" />
          <div className="relative max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-plus/30 bg-plus/10 px-3 py-1 text-xs font-bold text-plus">
              <Icon name="crown" className="size-4" /> Подписка
            </div>
            <h1 className="mt-4 text-4xl font-extrabold tracking-tight lg:text-5xl">
              <span className="text-gradient-plus">Радар+</span>
            </h1>
            <p className="mt-3 text-lg text-text/85">
              Отмечайте угрозы без ограничений и помогайте соседям узнавать о них раньше. Подписка защищает карту от спама: метки
              подписчиков видят все, но любой может скрыть их галочкой «Скрыть от людей».
            </p>
            {user?.isPlus && (
              <div className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-ok/10 px-4 py-2 text-sm font-semibold text-ok">
                <Icon name="check" className="size-4" /> Активна до {fmtDate(user.plusUntil!)}
              </div>
            )}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex gap-4 rounded-3xl border border-line bg-panel/80 p-5">
              {f.icon === 'uav' ? (
                <ThreatBadge type="uav" size={44} />
              ) : (
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-plus/10 text-plus">
                  <Icon name={f.icon} className="size-5" />
                </span>
              )}
              <div>
                <div className="font-bold">{f.title}</div>
                <div className="mt-1 text-sm text-muted">{f.text}</div>
              </div>
            </div>
          ))}
        </section>

        {price && (
          <section className="mx-auto max-w-xl space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <PlanCard active={plan === 'month'} onClick={() => setPlan('month')} title="Месяц" price={fmtMoney(price.priceMonth, price.currency)} sub="помесячно" />
              <PlanCard
                active={plan === 'year'}
                onClick={() => setPlan('year')}
                title="Год"
                price={fmtMoney(price.priceYear, price.currency)}
                sub={`≈ ${fmtMoney(monthly, price.currency)} / мес`}
                badge={save > 0 ? `−${save}%` : undefined}
              />
            </div>
            {user ? (
              <Button variant="plus" size="lg" className="w-full" loading={busy} onClick={checkout}>
                {user.isPlus ? 'Продлить Радар+' : 'Подключить Радар+'}
              </Button>
            ) : (
              <Link to="/profile">
                <Button variant="plus" size="lg" className="w-full">
                  Войдите, чтобы подключить
                </Button>
              </Link>
            )}
            <p className="text-center text-xs text-dim">
              {meta?.paymentsEnabled
                ? 'Оплата картой или СБП через ЮKassa. Подписка не продлевается автоматически.'
                : meta?.demoPayments
                  ? 'Платёжная система не подключена: включён тестовый режим — подписка активируется без оплаты.'
                  : 'Оплата временно недоступна.'}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function PlanCard({ active, onClick, title, price, sub, badge }: { active: boolean; onClick: () => void; title: string; price: string; sub: string; badge?: string }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'relative rounded-3xl border p-5 text-left transition',
        active ? 'border-plus bg-plus/10 shadow-[0_0_40px_-12px_rgba(255,200,69,0.6)]' : 'border-line bg-panel hover:border-line-2',
      )}
    >
      {badge && <span className="absolute right-3 top-3 rounded-full bg-gradient-plus px-2 py-0.5 text-[11px] font-extrabold text-[#1b1000]">{badge}</span>}
      <div className="text-sm font-semibold text-muted">{title}</div>
      <div className="mt-1 text-2xl font-extrabold">{price}</div>
      <div className="text-xs text-dim">{sub}</div>
    </button>
  );
}
