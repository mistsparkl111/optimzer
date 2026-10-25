// Shared domain constants for server and client.

/** Official region-level alert types. */
export const ALERT_TYPES = ['air', 'uav', 'missile', 'aviation', 'other'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/** Types of user marks ("метки"). */
export const REPORT_TYPES = ['uav', 'missile', 'aviation', 'explosion', 'other'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export type ThreatType = AlertType | ReportType;

export interface ThreatMeta {
  label: string;
  long: string;
  color: string;
  /** Default lifetime of a user mark, minutes (marks only). */
  ttlMin: number;
}

export const THREATS: Record<ThreatType, ThreatMeta> = {
  air: { label: 'Тревога', long: 'Воздушная тревога', color: '#ff3b4f', ttlMin: 30 },
  uav: { label: 'БПЛА', long: 'Беспилотная опасность', color: '#ffb020', ttlMin: 25 },
  missile: { label: 'Ракета', long: 'Ракетная опасность', color: '#ff2d6f', ttlMin: 10 },
  aviation: { label: 'Авиация', long: 'Авиационная опасность', color: '#a78bfa', ttlMin: 15 },
  explosion: { label: 'Взрывы', long: 'Сообщения о взрывах', color: '#ff7a2f', ttlMin: 20 },
  other: { label: 'Другое', long: 'Другая угроза', color: '#38bdf8', ttlMin: 15 },
};

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_META: Record<RiskLevel, { label: string; color: string }> = {
  low: { label: 'Низкий', color: '#22c55e' },
  medium: { label: 'Средний', color: '#eab308' },
  high: { label: 'Высокий', color: '#f97316' },
  critical: { label: 'Критический', color: '#ef4444' },
};

export function riskLevel(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Regions considered frontline/border for analytics priors. */
export const FRONTIER_REGIONS = ['BEL', 'KRS', 'BRY', 'VOR', 'ROS', 'KDA', 'CR', 'SEV', 'DPR', 'LPR', 'ZAP', 'KHE'];

export const MAX_EXTRA_REGIONS = 4;
export const PLUS_NAME = 'Радар+';
