import data from './regions.json';

export interface RegionInfo {
  id: string;
  name: string;
  short: string;
  district: string;
  capital: string;
  /** Interior point for labels, [lon, lat]. */
  label: [number, number];
  centroid: [number, number];
  neighbors: string[];
  isNew: boolean;
  areaKm2: number;
}

export const REGIONS = data as RegionInfo[];
export const REGION_BY_ID = new Map(REGIONS.map((r) => [r.id, r]));
export const DISTRICTS = ['ЦФО', 'СЗФО', 'ЮФО', 'СКФО', 'ПФО', 'УФО', 'СФО', 'ДФО', 'Новые регионы'];

export function isRegionId(id: unknown): id is string {
  return typeof id === 'string' && REGION_BY_ID.has(id);
}

export function regionName(id: string | null | undefined, short = false): string {
  if (!id) return '—';
  const r = REGION_BY_ID.get(id);
  return r ? (short ? r.short : r.name) : id;
}
