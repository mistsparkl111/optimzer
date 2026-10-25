import { geoConicEqualArea, geoMercator, geoPath, type GeoProjection } from 'd3-geo';
import { feature, mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';

export type RegionFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { id: string; name: string }>;
export type ContextFeature = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { name: string; kind: string }>;

export interface RussiaGeo {
  regions: RegionFeature[];
  context: ContextFeature[];
  innerBorders: GeoJSON.MultiLineString;
  outline: GeoJSON.MultiLineString;
}

let russiaPromise: Promise<RussiaGeo> | null = null;

export function loadRussia(): Promise<RussiaGeo> {
  russiaPromise ??= fetch('/geo/russia.topo.json')
    .then((r) => r.json() as Promise<Topology>)
    .then((topo) => {
      const regionsObj = topo.objects.regions as GeometryCollection;
      const regions = (feature(topo, regionsObj) as unknown as GeoJSON.FeatureCollection).features as RegionFeature[];
      const context = (feature(topo, topo.objects.context as GeometryCollection) as unknown as GeoJSON.FeatureCollection)
        .features as ContextFeature[];
      return {
        regions,
        context,
        innerBorders: mesh(topo, regionsObj, (a, b) => a !== b),
        outline: mesh(topo, regionsObj, (a, b) => a === b),
      };
    });
  return russiaPromise;
}

export interface FrontGeo {
  areas: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { id: string; name: string; kind: string }>[];
  rivers: GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString, { name: string }>[];
  water: GeoJSON.Feature[];
  adminBorders: GeoJSON.MultiLineString;
  countryBorders: GeoJSON.MultiLineString;
}

let frontPromise: Promise<FrontGeo> | null = null;
export function loadFrontGeo(): Promise<FrontGeo> {
  frontPromise ??= fetch('/geo/front.topo.json')
    .then((r) => r.json() as Promise<Topology>)
    .then((topo) => {
      const areasObj = topo.objects.areas as GeometryCollection<{ kind: string }>;
      const fc = (o: string) =>
        topo.objects[o] ? ((feature(topo, topo.objects[o] as GeometryCollection) as unknown as GeoJSON.FeatureCollection).features as never[]) : [];
      return {
        areas: fc('areas'),
        rivers: fc('rivers'),
        water: fc('water'),
        adminBorders: mesh(topo, areasObj, (a, b) => a !== b),
        countryBorders: mesh(topo, areasObj, (a, b) => {
          const ka = (a.properties as { kind?: string })?.kind;
          const kb = (b.properties as { kind?: string })?.kind;
          return a === b || ka !== kb;
        }),
      };
    });
  return frontPromise;
}

export const MAP_W = 1000;
export const MAP_H = 600;

export function russiaProjection(regions: RegionFeature[], w = MAP_W, h = MAP_H): GeoProjection {
  return geoConicEqualArea()
    .rotate([-100, 0])
    .parallels([52, 64])
    .fitExtent(
      [
        [12, 12],
        [w - 12, h - 12],
      ],
      { type: 'FeatureCollection', features: regions },
    );
}

export function frontProjection(w = MAP_W, h = MAP_H): GeoProjection {
  // MultiPoint avoids polygon winding pitfalls of d3's spherical geometry.
  const box: GeoJSON.MultiPoint = { type: 'MultiPoint', coordinates: [[30.6, 45.2], [40.6, 51.6], [30.6, 51.6], [40.6, 45.2]] };
  return geoMercator().fitExtent(
    [
      [10, 10],
      [w - 10, h - 10],
    ],
    box,
  );
}

export const pathFor = (p: GeoProjection) => geoPath(p);

/** Destination point from start, bearing (deg) and distance (km). */
export function destination(start: [number, number], brg: number, km: number): [number, number] {
  const toR = Math.PI / 180;
  const d = km / 6371;
  const t = brg * toR;
  const [l1, p1] = [start[0] * toR, start[1] * toR];
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 / toR + 540) % 360) - 180, p2 / toR];
}

/** Client-side point-in-region lookup (used for geolocation). */
export async function regionAtPoint(lon: number, lat: number): Promise<string | null> {
  const { geoContains } = await import('d3-geo');
  const g = await loadRussia();
  return g.regions.find((f) => geoContains(f, [lon, lat]))?.properties.id ?? null;
}

export function getPosition(): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Геолокация недоступна'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.longitude, p.coords.latitude]),
      () => reject(new Error('Не удалось определить местоположение')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });
}
