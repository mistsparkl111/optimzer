import type { AlertType, ReportType, RiskLevel } from './constants';

export type Role = 'user' | 'moderator' | 'admin';

export interface NotifyPrefs {
  /** Master switch: receive alert notifications at all. */
  enabled: boolean;
  /** Notifications from official sources / admins. */
  official: boolean;
  /** Notifications about marks placed by people. */
  userReports: boolean;
  /** "Отбой тревоги" notifications. */
  allClear: boolean;
  /** Threat types the user wants to be notified about. */
  types: (AlertType | ReportType)[];
}

export interface ViewPrefs {
  /** "Скрыть от людей" — hide marks placed by users. */
  hideUserReports: boolean;
  /** "Официальные источники" — show official alerts. */
  showOfficial: boolean;
  /** Play the in-app siren when an alert starts in my regions. */
  sound: boolean;
}

export interface UserSettings {
  notify: NotifyPrefs;
  view: ViewPrefs;
}

export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  regionId: string | null;
  extraRegions: string[];
  settings: UserSettings;
  plusUntil: number | null;
  isPlus: boolean;
  /** When the user may place the next mark (free tier cooldown); null = now. */
  nextReportAt: number | null;
  createdAt: number;
}

export interface Alert {
  id: number;
  regionId: string;
  type: AlertType;
  source: 'admin' | 'source';
  sourceName: string | null;
  message: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: 'allclear' | 'timeout' | 'admin' | null;
}

export interface Report {
  id: number;
  type: ReportType;
  lat: number;
  lon: number;
  regionId: string | null;
  /** Direction of movement, degrees clockwise from north. */
  heading: number | null;
  count: number | null;
  comment: string | null;
  author: string;
  isPlus: boolean;
  createdAt: number;
  expiresAt: number;
  /** Base lifetime used to compute fading on the client. */
  ttlMs: number;
  confirms: number;
  dismisses: number;
}

export interface LiveState {
  alerts: Alert[];
  reports: Report[];
  serverTime: number;
}

export type LiveEvent =
  | { type: 'alert'; alert: Alert }
  | { type: 'alert_end'; alert: Alert }
  | { type: 'report'; report: Report }
  | { type: 'report_remove'; id: number }
  | { type: 'forecast'; modelId: number | null; forecastId: number }
  | { type: 'front'; updatedAt: number };

export interface AppMeta {
  siteName: string;
  vapidPublicKey: string | null;
  plus: { priceMonth: number; priceYear: number; currency: string };
  limits: {
    freeCooldownMin: number;
    plusPerHour: number;
    historyDaysFree: number;
    historyDaysPlus: number;
  };
  /** Base mark lifetimes, minutes. */
  ttl: Record<ReportType, number>;
  paymentsEnabled: boolean;
  demoPayments: boolean;
  aiConfigured: boolean;
}

export interface RegionStats {
  regionId: string;
  active: Alert[];
  reports: Report[];
  alerts24h: number;
  alerts7d: number;
  reports24h: number;
  lastAlertAt: number | null;
  /** 24 buckets, Moscow time hour-of-day, alerts over the history window. */
  hourly: number[];
  history: Alert[];
  historyDays: number;
}

/* ---------- AI forecast ---------- */

export interface ForecastRegion {
  regionId: string;
  /** 0..100 probability-like score of an alert in the horizon. */
  risk: number;
  level: RiskLevel;
  trend: 'up' | 'down' | 'flat';
  reason: string;
  /** e.g. "22:00–05:00 МСК" */
  peakHours?: string | null;
}

export interface ForecastVector {
  id: string;
  type: 'uav' | 'missile' | 'aviation';
  /** [lon, lat] */
  from: [number, number];
  to: [number, number];
  fromRegionId?: string | null;
  toRegionId?: string | null;
  /** Optional intermediate points [lon, lat]. */
  via?: [number, number][];
  /** 0..1 */
  confidence: number;
  window: string;
  note: string;
  basis: 'pattern' | 'reports' | 'sources' | 'model';
}

export interface ForecastEvent {
  time: number | null;
  text: string;
  sourceIds: number[];
  regionIds: string[];
}

export interface Forecast {
  id: number;
  modelId: number | null;
  modelLabel: string;
  createdAt: number;
  status: 'ok' | 'heuristic' | 'error';
  horizon: { from: number; to: number };
  overall: { level: RiskLevel; score: number };
  summaryToday: string;
  outlookTomorrow: string;
  regions: ForecastRegion[];
  vectors: ForecastVector[];
  events: ForecastEvent[];
  recommendations: string[];
  confidenceNote: string;
  stats: {
    alerts24h: number;
    reports24h: number;
    activeRegions: number;
    postsAnalyzed: number;
    sourcesUsed: number;
  };
  error?: string | null;
}

export interface AiModelPublic {
  id: number;
  label: string;
  provider: string;
  isDefault: boolean;
}

export interface ForecastResponse {
  forecast: Forecast | null;
  models: AiModelPublic[];
  aiConfigured: boolean;
  /** Whether the current viewer may request a fresh forecast. */
  canRefresh: boolean;
  /** A generation for the requested model is currently running. */
  refreshing: boolean;
}

/* ---------- Front line ---------- */

export type FrontAreaKind = 'occupied' | 'gray' | 'liberated' | 'contested';

export interface FrontArrow {
  id: string;
  side: 'ru' | 'ua';
  /** [lon, lat][] from start to tip */
  coords: [number, number][];
  label?: string;
  date?: string;
}

export interface FrontData {
  /** GeoJSON FeatureCollection; polygons have properties.kind: FrontAreaKind, lines kind: 'line'. */
  geojson: GeoJSON.FeatureCollection;
  arrows: FrontArrow[];
  updatedAt: number | null;
  source: string | null;
  isDemo: boolean;
  note: string | null;
}

export interface PaymentRow {
  id: number;
  provider: string;
  plan: 'month' | 'year';
  amount: number;
  currency: string;
  status: string;
  createdAt: number;
  paidAt: number | null;
}
