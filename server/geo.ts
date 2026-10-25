import fs from 'node:fs';
import path from 'node:path';
import { geoBounds, geoContains, geoDistance } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { GEO_DIR } from './env';
import { REGIONS } from '../shared/regions';

type RegionFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { id: string; name: string }>;

let features: { id: string; f: RegionFeature; b: [[number, number], [number, number]] }[] = [];

function load() {
  if (features.length) return features;
  const file = path.join(GEO_DIR, 'russia.topo.json');
  const topo = JSON.parse(fs.readFileSync(file, 'utf8')) as Topology;
  const fc = feature(topo, topo.objects.regions!) as unknown as GeoJSON.FeatureCollection<
    RegionFeature['geometry'],
    RegionFeature['properties']
  >;
  features = fc.features.map((f) => ({ id: f.properties.id, f: f as RegionFeature, b: geoBounds(f) }));
  return features;
}

function inBounds(lon: number, lat: number, b: [[number, number], [number, number]]) {
  const [[x0, y0], [x1, y1]] = b;
  if (lat < y0 - 0.01 || lat > y1 + 0.01) return false;
  if (x0 <= x1) return lon >= x0 - 0.01 && lon <= x1 + 0.01;
  return lon >= x0 - 0.01 || lon <= x1 + 0.01; // crosses the antimeridian
}

/** Region id containing the point, or null when outside every region. */
export function regionAt(lon: number, lat: number): string | null {
  for (const r of load()) if (inBounds(lon, lat, r.b) && geoContains(r.f, [lon, lat])) return r.id;
  return null;
}

/** Nearest region by label point within maxKm (for points slightly off-coast). */
export function nearestRegion(lon: number, lat: number, maxKm = 60): string | null {
  const exact = regionAt(lon, lat);
  if (exact) return exact;
  let best: string | null = null;
  let bestD = Infinity;
  for (const r of REGIONS) {
    const d = geoDistance([lon, lat], r.label) * 6371;
    if (d < bestD) {
      bestD = d;
      best = r.id;
    }
  }
  return bestD <= maxKm ? best : null;
}

export const distanceKm = (a: [number, number], b: [number, number]) => geoDistance(a, b) * 6371;

/** Initial bearing a→b in degrees. */
export function bearing(a: [number, number], b: [number, number]): number {
  const toR = Math.PI / 180;
  const [l1, p1] = [a[0] * toR, a[1] * toR];
  const [l2, p2] = [b[0] * toR, b[1] * toR];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Destination point from start, bearing (deg) and distance (km). */
export function destination(start: [number, number], brg: number, km: number): [number, number] {
  const toR = Math.PI / 180;
  const d = km / 6371;
  const t = brg * toR;
  const [l1, p1] = [start[0] * toR, start[1] * toR];
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(((l2 / toR + 540) % 360) - 180), p2 / toR];
}
