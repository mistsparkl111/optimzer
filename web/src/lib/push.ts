import { post } from './api';
import type { NotifyPrefs } from '@shared/types';

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = () => /android/i.test(navigator.userAgent);
export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export type PushStatus = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) || null;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function deviceId() {
  let id = localStorage.getItem('radar.device');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('radar.device', id);
  }
  return id;
}

/** Must be called from a user gesture (iOS requirement). */
export async function enablePush(vapidKey: string, regions: string[], prefs: NotifyPrefs) {
  if (!pushSupported()) throw new Error(isIOS() ? 'Сначала добавьте Радар на экран «Домой»' : 'Браузер не поддерживает уведомления');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления запрещены в настройках браузера');
  const reg = (await getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
  }
  await post('/push/subscribe', { subscription: sub.toJSON(), regions, prefs, deviceId: deviceId() });
  return sub;
}

/** Re-send region/preferences for an existing subscription. */
export async function syncPush(regions: string[], prefs: NotifyPrefs) {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  await post('/push/subscribe', { subscription: sub.toJSON(), regions, prefs, deviceId: deviceId() });
  return true;
}

export async function disablePush() {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export async function testPush() {
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) throw new Error('Уведомления не включены на этом устройстве');
  await post('/push/test', { endpoint: sub.endpoint });
}
