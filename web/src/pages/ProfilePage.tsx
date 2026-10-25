import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MAX_EXTRA_REGIONS, THREATS } from '@shared/constants';
import { regionName } from '@shared/regions';
import type { PaymentRow, PublicUser, Report } from '@shared/types';
import { del, get, post, errorText } from '../lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format';
import { useApp } from '../lib/store';
import { RegionPickerModal } from '../components/RegionPicker';
import { NotificationSettings, PushControl } from '../components/NotificationSettings';
import { Icon, RadarLogo, ThreatIcon } from '../components/Icons';
import { Badge, Button, Card, Field, Input, Modal, PlusBadge, Tabs, toast, useAsync } from '../components/ui';

export default function ProfilePage() {
  const { user } = useApp();
  return <div className="h-full overflow-y-auto">{user ? <Cabinet user={user} /> : <AuthForms />}</div>;
}

function AuthForms() {
  const { setUser, prefs } = useApp();
  const [tab, setTab] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r =
        tab === 'login'
          ? await post<{ user: PublicUser }>('/auth/login', { email, password })
          : await post<{ user: PublicUser }>('/auth/register', {
              email,
              password,
              name,
              regionId: prefs.regionId,
              extraRegions: prefs.extraRegions,
            });
      setUser(r.user);
      toast(tab === 'login' ? 'С возвращением!' : 'Аккаунт создан', 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-6 p-5">
      <div className="text-center">
        <RadarLogo className="mx-auto size-16" />
        <h1 className="mt-3 text-2xl font-extrabold">{tab === 'login' ? 'Вход в Радар' : 'Регистрация'}</h1>
        <p className="mt-1 text-sm text-muted">Аккаунт нужен, чтобы ставить метки, синхронизировать регионы и подключить Радар+.</p>
      </div>
      <Tabs
        className="self-center"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'register', label: 'Регистрация' },
          { id: 'login', label: 'Вход' },
        ]}
      />
      <form onSubmit={submit} className="space-y-4 rounded-3xl border border-line bg-panel/80 p-5">
        {tab === 'register' && (
          <Field label="Имя или ник" hint="Виден рядом с вашими метками">
            <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" />
          </Field>
        )}
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        <Field label="Пароль" hint={tab === 'register' ? 'Минимум 8 символов' : undefined}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={tab === 'register' ? 8 : 1}
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>
        {tab === 'register' && prefs.regionId && (
          <p className="text-xs text-muted">
            Регион: <b className="text-text">{regionName(prefs.regionId)}</b> — сохраним в аккаунт.
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          {tab === 'login' ? 'Войти' : 'Создать аккаунт'}
        </Button>
      </form>
      <Link to="/about" className="text-center text-xs text-dim hover:text-muted">
        Правила сервиса и конфиденциальность
      </Link>
    </div>
  );
}

function Cabinet({ user }: { user: PublicUser }) {
  const { setUser, prefs, setPrefs, now } = useApp();
  const [picker, setPicker] = useState<'home' | 'extra' | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const myReports = useAsync(() => get<{ reports: Report[] }>('/me/reports'), []);
  const payments = useAsync(() => get<{ payments: PaymentRow[] }>('/me/payments'), []);

  const logout = async () => {
    await post('/auth/logout');
    setUser(null);
    toast('Вы вышли из аккаунта', 'info');
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-4 rounded-3xl border border-line bg-gradient-to-br from-panel-2 to-panel p-5">
        <div className="grid size-14 place-items-center rounded-2xl bg-accent/10 text-2xl font-extrabold text-accent">{user.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-extrabold">{user.name}</h1>
            {user.isPlus && <PlusBadge />}
            {user.role !== 'user' && <Badge color="#a78bfa">{user.role === 'admin' ? 'Администратор' : 'Модератор'}</Badge>}
          </div>
          <div className="text-sm text-muted">
            {user.email} · с {fmtDate(user.createdAt)}
          </div>
        </div>
        <div className="flex gap-2">
          {user.role !== 'user' && (
            <Link to="/admin">
              <Button variant="outline" size="sm">
                <Icon name="admin" className="size-4" /> Админ-панель
              </Button>
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={logout}>
            <Icon name="logout" className="size-4" /> Выйти
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card title="Радар+">
            {user.isPlus ? (
              <div className="space-y-2">
                <p className="text-sm">
                  Подписка активна до <b>{fmtDate(user.plusUntil!)}</b>. Метки без ограничений, ИИ-прогноз по запросу, история за 30 дней.
                </p>
                <Link to="/plus">
                  <Button variant="outline" size="sm">
                    Продлить
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">Сейчас: 1 метка в час. С Радар+ — без ограничений и с приоритетным значком.</p>
                <Link to="/plus">
                  <Button variant="plus">Подключить</Button>
                </Link>
              </div>
            )}
            {!user.isPlus && user.nextReportAt && user.nextReportAt > now && (
              <p className="mt-2 text-xs text-dim">Следующая метка доступна в {new Date(user.nextReportAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</p>
            )}
          </Card>

          <Card title="Мои регионы">
            <div className="space-y-3">
              <button onClick={() => setPicker('home')} className="flex w-full items-center justify-between rounded-2xl border border-accent/30 bg-accent/5 px-4 py-3 text-left">
                <span>
                  <span className="block text-[11px] font-bold uppercase tracking-wider text-accent">Основной</span>
                  <span className="font-semibold">{prefs.regionId ? regionName(prefs.regionId) : 'Не выбран'}</span>
                </span>
                <Icon name="chevron" className="size-5 text-dim" />
              </button>
              <div className="flex flex-wrap gap-2">
                {prefs.extraRegions.map((id) => (
                  <span key={id} className="flex items-center gap-1.5 rounded-full border border-line-2 bg-panel-2 py-1 pl-3 pr-1.5 text-sm">
                    {regionName(id, true)}
                    <button
                      className="grid size-6 place-items-center rounded-full text-dim hover:bg-white/10 hover:text-text"
                      onClick={() => void setPrefs({ extraRegions: prefs.extraRegions.filter((x) => x !== id) })}
                      aria-label="Убрать"
                    >
                      <Icon name="x" className="size-3.5" />
                    </button>
                  </span>
                ))}
                {prefs.extraRegions.length < MAX_EXTRA_REGIONS && (
                  <Button size="sm" variant="outline" onClick={() => setPicker('extra')}>
                    <Icon name="plus" className="size-4" /> Добавить регион
                  </Button>
                )}
              </div>
              <p className="text-xs text-dim">Уведомления приходят по основному и дополнительным регионам (до {MAX_EXTRA_REGIONS}).</p>
            </div>
          </Card>

          <Card title="Безопасность">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
                Сменить пароль
              </Button>
              <Button variant="danger" size="sm" onClick={() => setDelOpen(true)}>
                <Icon name="trash" className="size-4" /> Удалить аккаунт
              </Button>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Уведомления о тревогах">
            <div className="space-y-4">
              <PushControl />
              <NotificationSettings />
            </div>
          </Card>

          <Card title="Мои метки">
            {myReports.data?.reports.length ? (
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {myReports.data.reports.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm">
                    <ThreatIcon type={r.type} className="size-4" color={THREATS[r.type].color} />
                    <span className="flex-1 truncate">
                      {THREATS[r.type].label} · {regionName(r.regionId, true)}
                    </span>
                    <span className="font-mono text-xs text-dim">{fmtDateTime(r.createdAt)}</span>
                    <span className="text-xs text-muted">✓{r.confirms}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Вы ещё не ставили меток.</p>
            )}
          </Card>

          <Card title="Платежи">
            {payments.data?.payments.length ? (
              <div className="space-y-1">
                {payments.data.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-sm">
                    <span>Радар+ · {p.plan === 'year' ? '12 мес.' : '1 мес.'}</span>
                    <span className="font-mono text-xs text-muted">{fmtDateTime(p.createdAt)}</span>
                    <span>{fmtMoney(p.amount, p.currency)}</span>
                    <Badge color={p.status === 'succeeded' ? '#22c55e' : p.status === 'pending' ? '#ffb020' : '#7d899b'}>
                      {p.status === 'succeeded' ? (p.provider === 'demo' ? 'тест' : 'оплачен') : p.status === 'pending' ? 'ожидает' : 'отменён'}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Платежей нет.</p>
            )}
          </Card>
        </div>
      </div>

      <RegionPickerModal
        open={picker !== null}
        onClose={() => setPicker(null)}
        value={picker === 'home' ? prefs.regionId : null}
        title={picker === 'home' ? 'Основной регион' : 'Добавить регион'}
        onSelect={(id) => {
          if (picker === 'home') void setPrefs({ regionId: id });
          else if (!prefs.extraRegions.includes(id) && id !== prefs.regionId) void setPrefs({ extraRegions: [...prefs.extraRegions, id] });
        }}
      />
      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <DeleteModal open={delOpen} onClose={() => setDelOpen(false)} onDeleted={() => setUser(null)} />
    </div>
  );
}

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Смена пароля">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post('/auth/password', { current, next });
            toast('Пароль изменён', 'ok');
            onClose();
          } catch (err) {
            toast(errorText(err), 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Текущий пароль">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label="Новый пароль" hint="Минимум 8 символов">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Сохранить
        </Button>
      </form>
    </Modal>
  );
}

function DeleteModal({ open, onClose, onDeleted }: { open: boolean; onClose: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <Modal open={open} onClose={onClose} title="Удалить аккаунт">
      <div className="space-y-4">
        <p className="text-sm text-muted">Аккаунт, метки и подписка будут удалены без возможности восстановления.</p>
        <Input type="password" placeholder="Пароль для подтверждения" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button
          variant="danger"
          className="w-full"
          onClick={async () => {
            try {
              await del('/me', { password });
              onDeleted();
              toast('Аккаунт удалён', 'info');
            } catch (e) {
              toast(errorText(e), 'error');
            }
          }}
        >
          Удалить навсегда
        </Button>
      </div>
    </Modal>
  );
}
