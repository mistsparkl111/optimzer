import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Onboarding } from './components/Onboarding';
import { Spinner, Toaster } from './components/ui';
import { MapPage } from './pages/MapPage';
import { useApp } from './lib/store';

const FrontPage = lazy(() => import('./pages/FrontPage'));
const AiPage = lazy(() => import('./pages/AiPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const PlusPage = lazy(() => import('./pages/PlusPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

export function App() {
  const { prefs } = useApp();
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="grid h-full place-items-center">
            <Spinner className="size-7 text-accent" />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<MapPage />} />
          <Route path="/front" element={<FrontPage />} />
          <Route path="/ai" element={<AiPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/plus" element={<PlusPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {!prefs.onboarded && <Onboarding />}
      <Toaster />
    </Shell>
  );
}
