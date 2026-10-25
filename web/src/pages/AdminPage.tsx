import { lazy, Suspense } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../lib/store';
import { Icon } from '../components/Icons';
import { Button, EmptyState, Tabs } from '../components/ui';
import { AlertsTab, FrontTab, Loading, OverviewTab, PaymentsTab, ReportsTab, SettingsTab, UsersTab } from './admin/CoreTabs';

const AiTab = lazy(() => import('./admin/AiTab'));
const SourcesTab = lazy(() => import('./admin/SourcesTab'));

const TABS = [
  { id: 'overview', label: 'Обзор', staff: true },
  { id: 'alerts', label: 'Тревоги', staff: true },
  { id: 'reports', label: 'Метки', staff: true },
  { id: 'users', label: 'Пользователи', staff: false },
  { id: 'sources', label: 'Источники', staff: false },
  { id: 'ai', label: 'ИИ', staff: false },
  { id: 'front', label: 'Линия фронта', staff: false },
  { id: 'payments', label: 'Радар+ и оплата', staff: false },
  { id: 'settings', label: 'Лимиты', staff: false },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function AdminPage() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  if (!user)
    return (
      <EmptyState
        icon={<Icon name="admin" className="size-10" />}
        title="Требуется вход"
        action={
          <Link to="/profile">
            <Button>Войти</Button>
          </Link>
        }
      />
    );
  if (user.role === 'user') return <EmptyState icon={<Icon name="admin" className="size-10" />} title="Нет доступа" text="Раздел доступен администраторам и модераторам." />;

  const available = TABS.filter((t) => user.role === 'admin' || t.staff);
  const tab = (available.find((t) => t.id === params.get('tab'))?.id || 'overview') as TabId;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-5 p-4 lg:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-2xl font-extrabold">
            <Icon name="admin" className="size-6 text-accent" /> Админ-панель
          </h1>
        </div>
        <Tabs value={tab} onChange={(id) => setParams({ tab: id })} tabs={available.map((t) => ({ id: t.id as TabId, label: t.label }))} />
        <Suspense fallback={<Loading />}>
          {tab === 'overview' && <OverviewTab />}
          {tab === 'alerts' && <AlertsTab />}
          {tab === 'reports' && <ReportsTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'sources' && <SourcesTab />}
          {tab === 'ai' && <AiTab />}
          {tab === 'front' && <FrontTab />}
          {tab === 'payments' && <PaymentsTab />}
          {tab === 'settings' && <SettingsTab />}
        </Suspense>
      </div>
    </div>
  );
}
