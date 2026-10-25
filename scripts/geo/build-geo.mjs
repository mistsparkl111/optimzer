#!/usr/bin/env node
/**
 * Builds the static geodata for the map (Natural Earth, public domain):
 *   web/public/geo/russia.topo.json  — 89 regions + surrounding context (national view)
 *   web/public/geo/front.topo.json   — detailed front-zone map: areas, rivers, water
 *   shared/regions.json              — region metadata (label point, centroid, neighbours, area)
 *   shared/cities.json               — settlements for labels / geocoding
 *
 * Usage: node scripts/geo/build-geo.mjs   (needs devDependencies: mapshaper, topojson-*, d3-geo)
 * Downloads go to scripts/geo/.cache (override: GEO_CACHE), Natural Earth ref: NE_REF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mapshaper from 'mapshaper';
import { topology } from 'topojson-server';
import { feature, merge, neighbors } from 'topojson-client';
import * as d3 from 'd3-geo';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = process.env.GEO_CACHE || path.join(HERE, '.cache');
const NE_REF = process.env.NE_REF || 'ca96624a56bd078437bca8184e78163e5039ad19';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_REF}/geojson`;
const SOURCES = [
  'ne_10m_admin_1_states_provinces',
  'ne_10m_rivers_lake_centerlines',
  'ne_10m_rivers_europe',
  'ne_10m_lakes',
  'ne_10m_populated_places',
];

const OUT = {
  russia: path.join(ROOT, 'web/public/geo/russia.topo.json'),
  front: path.join(ROOT, 'web/public/geo/front.topo.json'),
  regions: path.join(ROOT, 'shared/regions.json'),
  cities: path.join(ROOT, 'shared/cities.json'),
};

// Tuning knobs (size vs. detail).
const RUSSIA = { simplify: 800, quantization: 60000, minIslandKm2: 40, minContextIslandKm2: 150 };
const FRONT = { simplify: 100, quantization: 120000 };
const RUSSIA_CLIP = [10, 30, 192, 83.5]; // lon>180 is used for Chukotka (see below)
// Mapshaper only treats data as lat-long when lon is within ±180; shift the whole frame while it works.
const MAPSHAPER_LON_SHIFT = -20;
const FRONT_CLIP = [22, 42, 46, 56];
const FRONT_ZONE = { lon: [30, 41], lat: [45, 52] };
const EARTH_R = 6371;

// ───────────────────────── reference tables ─────────────────────────
// [id, Natural Earth iso_3166_2, name, short, district, capital]
// NE has the codes of Moscow city and Moscow oblast swapped (RU-MOS = Москва, RU-MOW = Московская).
const REGION_TABLE = [
  ['AD', 'RU-AD', 'Республика Адыгея', 'Адыгея', 'ЮФО', 'Майкоп'],
  ['AL', 'RU-AL', 'Республика Алтай', 'Респ. Алтай', 'СФО', 'Горно-Алтайск'],
  ['BA', 'RU-BA', 'Республика Башкортостан', 'Башкортостан', 'ПФО', 'Уфа'],
  ['BU', 'RU-BU', 'Республика Бурятия', 'Бурятия', 'ДФО', 'Улан-Удэ'],
  ['DA', 'RU-DA', 'Республика Дагестан', 'Дагестан', 'СКФО', 'Махачкала'],
  ['IN', 'RU-IN', 'Республика Ингушетия', 'Ингушетия', 'СКФО', 'Магас'],
  ['KB', 'RU-KB', 'Кабардино-Балкарская Республика', 'Кабардино-Балкария', 'СКФО', 'Нальчик'],
  ['KL', 'RU-KL', 'Республика Калмыкия', 'Калмыкия', 'ЮФО', 'Элиста'],
  ['KC', 'RU-KC', 'Карачаево-Черкесская Республика', 'Карачаево-Черкесия', 'СКФО', 'Черкесск'],
  ['KR', 'RU-KR', 'Республика Карелия', 'Карелия', 'СЗФО', 'Петрозаводск'],
  ['KO', 'RU-KO', 'Республика Коми', 'Коми', 'СЗФО', 'Сыктывкар'],
  ['ME', 'RU-ME', 'Республика Марий Эл', 'Марий Эл', 'ПФО', 'Йошкар-Ола'],
  ['MO', 'RU-MO', 'Республика Мордовия', 'Мордовия', 'ПФО', 'Саранск'],
  ['SA', 'RU-SA', 'Республика Саха (Якутия)', 'Якутия', 'ДФО', 'Якутск'],
  ['SE', 'RU-SE', 'Республика Северная Осетия — Алания', 'Северная Осетия', 'СКФО', 'Владикавказ'],
  ['TA', 'RU-TA', 'Республика Татарстан', 'Татарстан', 'ПФО', 'Казань'],
  ['TY', 'RU-TY', 'Республика Тыва', 'Тыва', 'СФО', 'Кызыл'],
  ['UD', 'RU-UD', 'Удмуртская Республика', 'Удмуртия', 'ПФО', 'Ижевск'],
  ['KK', 'RU-KK', 'Республика Хакасия', 'Хакасия', 'СФО', 'Абакан'],
  ['CE', 'RU-CE', 'Чеченская Республика', 'Чечня', 'СКФО', 'Грозный'],
  ['CU', 'RU-CU', 'Чувашская Республика', 'Чувашия', 'ПФО', 'Чебоксары'],
  ['ALT', 'RU-ALT', 'Алтайский край', 'Алтайский', 'СФО', 'Барнаул'],
  ['ZAB', 'RU-ZAB', 'Забайкальский край', 'Забайкальский', 'ДФО', 'Чита'],
  ['KAM', 'RU-KAM', 'Камчатский край', 'Камчатский', 'ДФО', 'Петропавловск-Камчатский'],
  ['KDA', 'RU-KDA', 'Краснодарский край', 'Краснодарский', 'ЮФО', 'Краснодар'],
  ['KYA', 'RU-KYA', 'Красноярский край', 'Красноярский', 'СФО', 'Красноярск'],
  ['PER', 'RU-PER', 'Пермский край', 'Пермский', 'ПФО', 'Пермь'],
  ['PRI', 'RU-PRI', 'Приморский край', 'Приморский', 'ДФО', 'Владивосток'],
  ['STA', 'RU-STA', 'Ставропольский край', 'Ставропольский', 'СКФО', 'Ставрополь'],
  ['KHA', 'RU-KHA', 'Хабаровский край', 'Хабаровский', 'ДФО', 'Хабаровск'],
  ['AMU', 'RU-AMU', 'Амурская область', 'Амурская', 'ДФО', 'Благовещенск'],
  ['ARK', 'RU-ARK', 'Архангельская область', 'Архангельская', 'СЗФО', 'Архангельск'],
  ['AST', 'RU-AST', 'Астраханская область', 'Астраханская', 'ЮФО', 'Астрахань'],
  ['BEL', 'RU-BEL', 'Белгородская область', 'Белгородская', 'ЦФО', 'Белгород'],
  ['BRY', 'RU-BRY', 'Брянская область', 'Брянская', 'ЦФО', 'Брянск'],
  ['VLA', 'RU-VLA', 'Владимирская область', 'Владимирская', 'ЦФО', 'Владимир'],
  ['VGG', 'RU-VGG', 'Волгоградская область', 'Волгоградская', 'ЮФО', 'Волгоград'],
  ['VLG', 'RU-VLG', 'Вологодская область', 'Вологодская', 'СЗФО', 'Вологда'],
  ['VOR', 'RU-VOR', 'Воронежская область', 'Воронежская', 'ЦФО', 'Воронеж'],
  ['IVA', 'RU-IVA', 'Ивановская область', 'Ивановская', 'ЦФО', 'Иваново'],
  ['IRK', 'RU-IRK', 'Иркутская область', 'Иркутская', 'СФО', 'Иркутск'],
  ['KGD', 'RU-KGD', 'Калининградская область', 'Калининградская', 'СЗФО', 'Калининград'],
  ['KLU', 'RU-KLU', 'Калужская область', 'Калужская', 'ЦФО', 'Калуга'],
  ['KEM', 'RU-KEM', 'Кемеровская область', 'Кемеровская', 'СФО', 'Кемерово'],
  ['KIR', 'RU-KIR', 'Кировская область', 'Кировская', 'ПФО', 'Киров'],
  ['KOS', 'RU-KOS', 'Костромская область', 'Костромская', 'ЦФО', 'Кострома'],
  ['KGN', 'RU-KGN', 'Курганская область', 'Курганская', 'УФО', 'Курган'],
  ['KRS', 'RU-KRS', 'Курская область', 'Курская', 'ЦФО', 'Курск'],
  ['LEN', 'RU-LEN', 'Ленинградская область', 'Ленинградская', 'СЗФО', 'Гатчина'],
  ['LIP', 'RU-LIP', 'Липецкая область', 'Липецкая', 'ЦФО', 'Липецк'],
  ['MAG', 'RU-MAG', 'Магаданская область', 'Магаданская', 'ДФО', 'Магадан'],
  ['MOS', 'RU-MOW', 'Московская область', 'Московская', 'ЦФО', 'Красногорск'],
  ['MUR', 'RU-MUR', 'Мурманская область', 'Мурманская', 'СЗФО', 'Мурманск'],
  ['NIZ', 'RU-NIZ', 'Нижегородская область', 'Нижегородская', 'ПФО', 'Нижний Новгород'],
  ['NGR', 'RU-NGR', 'Новгородская область', 'Новгородская', 'СЗФО', 'Великий Новгород'],
  ['NVS', 'RU-NVS', 'Новосибирская область', 'Новосибирская', 'СФО', 'Новосибирск'],
  ['OMS', 'RU-OMS', 'Омская область', 'Омская', 'СФО', 'Омск'],
  ['ORE', 'RU-ORE', 'Оренбургская область', 'Оренбургская', 'ПФО', 'Оренбург'],
  ['ORL', 'RU-ORL', 'Орловская область', 'Орловская', 'ЦФО', 'Орёл'],
  ['PNZ', 'RU-PNZ', 'Пензенская область', 'Пензенская', 'ПФО', 'Пенза'],
  ['PSK', 'RU-PSK', 'Псковская область', 'Псковская', 'СЗФО', 'Псков'],
  ['ROS', 'RU-ROS', 'Ростовская область', 'Ростовская', 'ЮФО', 'Ростов-на-Дону'],
  ['RYA', 'RU-RYA', 'Рязанская область', 'Рязанская', 'ЦФО', 'Рязань'],
  ['SAM', 'RU-SAM', 'Самарская область', 'Самарская', 'ПФО', 'Самара'],
  ['SAR', 'RU-SAR', 'Саратовская область', 'Саратовская', 'ПФО', 'Саратов'],
  ['SAK', 'RU-SAK', 'Сахалинская область', 'Сахалинская', 'ДФО', 'Южно-Сахалинск'],
  ['SVE', 'RU-SVE', 'Свердловская область', 'Свердловская', 'УФО', 'Екатеринбург'],
  ['SMO', 'RU-SMO', 'Смоленская область', 'Смоленская', 'ЦФО', 'Смоленск'],
  ['TAM', 'RU-TAM', 'Тамбовская область', 'Тамбовская', 'ЦФО', 'Тамбов'],
  ['TVE', 'RU-TVE', 'Тверская область', 'Тверская', 'ЦФО', 'Тверь'],
  ['TOM', 'RU-TOM', 'Томская область', 'Томская', 'СФО', 'Томск'],
  ['TUL', 'RU-TUL', 'Тульская область', 'Тульская', 'ЦФО', 'Тула'],
  ['TYU', 'RU-TYU', 'Тюменская область', 'Тюменская', 'УФО', 'Тюмень'],
  ['ULY', 'RU-ULY', 'Ульяновская область', 'Ульяновская', 'ПФО', 'Ульяновск'],
  ['CHE', 'RU-CHE', 'Челябинская область', 'Челябинская', 'УФО', 'Челябинск'],
  ['YAR', 'RU-YAR', 'Ярославская область', 'Ярославская', 'ЦФО', 'Ярославль'],
  ['MOW', 'RU-MOS', 'Москва', 'Москва', 'ЦФО', 'Москва'],
  ['SPE', 'RU-SPE', 'Санкт-Петербург', 'Санкт-Петербург', 'СЗФО', 'Санкт-Петербург'],
  ['YEV', 'RU-YEV', 'Еврейская автономная область', 'Еврейская АО', 'ДФО', 'Биробиджан'],
  ['NEN', 'RU-NEN', 'Ненецкий автономный округ', 'Ненецкий АО', 'СЗФО', 'Нарьян-Мар'],
  ['KHM', 'RU-KHM', 'Ханты-Мансийский автономный округ — Югра', 'ХМАО', 'УФО', 'Ханты-Мансийск'],
  ['CHU', 'RU-CHU', 'Чукотский автономный округ', 'Чукотка', 'ДФО', 'Анадырь'],
  ['YAN', 'RU-YAN', 'Ямало-Ненецкий автономный округ', 'ЯНАО', 'УФО', 'Салехард'],
  ['CR', 'UA-43', 'Республика Крым', 'Крым', 'ЮФО', 'Симферополь'],
  ['SEV', 'UA-40', 'Севастополь', 'Севастополь', 'ЮФО', 'Севастополь'],
  ['DPR', 'UA-14', 'Донецкая Народная Республика', 'ДНР', 'Новые регионы', 'Донецк'],
  ['LPR', 'UA-09', 'Луганская Народная Республика', 'ЛНР', 'Новые регионы', 'Луганск'],
  ['ZAP', 'UA-23', 'Запорожская область', 'Запорожская', 'Новые регионы', 'Запорожье'],
  ['KHE', 'UA-65', 'Херсонская область', 'Херсонская', 'Новые регионы', 'Херсон'],
];
const NEW_REGIONS = new Set(['CR', 'SEV', 'DPR', 'LPR', 'ZAP', 'KHE']);
const FORCED_NEIGHBORS = [['MOW', 'MOS'], ['SPE', 'LEN'], ['SEV', 'CR']];

// Ukrainian oblasts that are NOT among the six regions above.
const UA_OBLASTS = {
  'UA-74': 'Черниговская область',
  'UA-07': 'Волынская область',
  'UA-56': 'Ровненская область',
  'UA-18': 'Житомирская область',
  'UA-32': 'Киевская область',
  'UA-21': 'Закарпатская область',
  'UA-77': 'Черновицкая область',
  'UA-26': 'Ивано-Франковская область',
  'UA-51': 'Одесская область',
  'UA-05': 'Винницкая область',
  'UA-46': 'Львовская область',
  'UA-59': 'Сумская область',
  'UA-63': 'Харьковская область',
  'UA-48': 'Николаевская область',
  'UA-53': 'Полтавская область',
  'UA-68': 'Хмельницкая область',
  'UA-61': 'Тернопольская область',
  'UA-12': 'Днепропетровская область',
  'UA-71': 'Черкасская область',
  'UA-35': 'Кировоградская область',
  'UA-30': 'Киев',
};

// Context countries (all dissolved from NE admin-1 so borders are shared with the regions).
const COUNTRIES = {
  NOR: 'Норвегия', SWE: 'Швеция', FIN: 'Финляндия', EST: 'Эстония', LVA: 'Латвия', LTU: 'Литва',
  POL: 'Польша', BLR: 'Белоруссия', MDA: 'Молдавия', ROU: 'Румыния', BGR: 'Болгария', HUN: 'Венгрия',
  SVK: 'Словакия', CZE: 'Чехия', DEU: 'Германия', TUR: 'Турция', GEO: 'Грузия', ARM: 'Армения',
  AZE: 'Азербайджан', IRN: 'Иран', KAZ: 'Казахстан', UZB: 'Узбекистан', TKM: 'Туркмения',
  KGZ: 'Киргизия', TJK: 'Таджикистан', AFG: 'Афганистан', CHN: 'Китай', MNG: 'Монголия',
  PRK: 'КНДР', KOR: 'Южная Корея', JPN: 'Япония',
};

// NE keeps the Baikonur lease as a separate "country"; it is Kazakh territory on the map.
const ADM0_ALIAS = { KAB: 'KAZ' };

const FRONT_RU_IDS = ['BEL', 'BRY', 'KRS', 'ORL', 'VOR', 'ROS', 'KDA', 'LIP', 'TAM', 'KLU', 'SMO', 'VGG', 'AD', 'CR', 'SEV', 'DPR', 'LPR', 'ZAP', 'KHE'];
const FRONT_COUNTRY_IDS = ['BLR', 'MDA'];

// Rivers of the centerlines dataset have no name_ru: translate the ones in/near the front zone.
const RIVER_RU = {
  Dnipro: 'Днепр', Dnepre: 'Днепр', Dnepr: 'Днепр', Don: 'Дон', Donets: 'Северский Донец', Oka: 'Ока',
  Desna: 'Десна', Khopr: 'Хопёр', Seym: 'Сейм', Tsna: 'Цна', Pripyat: 'Припять', Dniester: 'Днестр',
  'Southern Bug': 'Южный Буг', Volga: 'Волга', Bug: 'Западный Буг', Mukhavyets: 'Мухавец', Sura: 'Сура',
  Kuban: 'Кубань', Kura: 'Кура', Danube: 'Дунай', Prut: 'Прут', Neman: 'Неман', Neris: 'Нярис',
  Daugava: 'Западная Двина', Mures: 'Муреш', Olt: 'Олт', Morava: 'Морава', Evros: 'Эврос',
  Strymnas: 'Струма', Ialomita: 'Яломица', Borcea: 'Борча', Bityog: 'Битюг', 'Zakhidnyy Buh': 'Западный Буг',
  Pissa: 'Писса', Yasyelda: 'Ясельда', Bistrita: 'Бистрица', 'Bratul Chillia': 'Килийское гирло',
  'Bratul Sfintu Gheorghe': 'Георгиевское гирло', 'Bratul Sulina': 'Сулинское гирло', 'Someşul Cald': 'Сомешул-Колд',
};

// Region capitals missing from Natural Earth populated places: [lon, lat, pop].
const MANUAL_CAPITALS = {
  Красногорск: [37.3303, 55.8204, 190000],
  Гатчина: [30.1283, 59.5765, 94000],
  Магас: [44.8167, 43.1667, 4000],
};

// ───────────────────────── helpers ─────────────────────────
const log = (...a) => console.log(...a);
const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const roundPt = (p) => [round(p[0]), round(p[1])];
const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const keyName = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
const geomKm2 = (g) => d3.geoArea(g) * EARTH_R * EARTH_R;
const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

async function download() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const name of SOURCES) {
    const file = path.join(CACHE, `${name}.geojson`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    const url = `${NE_BASE}/${name}.geojson`;
    log(`download ${url}`);
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
        fs.renameSync(`${file}.part`, file);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw new Error(`cannot download ${url}: ${lastErr.message}`);
  }
}

// Exterior rings clockwise, holes counter-clockwise (planar lon/lat) — what d3-geo and TopoJSON expect.
const ringSum = (r) => {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += (r[i + 1][0] - r[i][0]) * (r[i + 1][1] + r[i][1]);
  return s;
};
const orientPolygon = (poly) => poly.map((ring, i) => ((ringSum(ring) > 0) === (i === 0) ? ring : ring.slice().reverse()));
function rewind(geom) {
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: orientPolygon(geom.coordinates) };
  if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map(orientPolygon) };
  return geom;
}

const bboxOfRing = (ring) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

/**
 * Drops detached islands below minKm2 (the largest part is always kept). Parts that fill a hole of
 * another region (Zelenograd inside Moscow oblast, ...) are kept so no unfilled holes appear.
 */
function dropSmallParts(geom, minKm2, holeBoxes = []) {
  if (geom.type !== 'MultiPolygon') return geom;
  const eps = 1e-6;
  const sized = geom.coordinates.map((coords) => ({ coords, km2: geomKm2({ type: 'Polygon', coordinates: coords }) }));
  const maxKm2 = Math.max(...sized.map((s) => s.km2));
  const kept = sized.filter(({ coords, km2 }) => {
    if (km2 >= minKm2 || km2 === maxKm2) return true;
    const [a, b, c, d] = bboxOfRing(coords[0]);
    return holeBoxes.some(([x0, y0, x1, y1]) => a >= x0 - eps && c <= x1 + eps && b >= y0 - eps && d <= y1 + eps);
  });
  const parts = kept.map((s) => s.coords);
  return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
}

function shiftLon(geom, dx) {
  const walk = (cs) => (typeof cs[0] === 'number' ? [cs[0] + dx, cs[1]] : cs.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

const holeBoxesOf = (geoms) =>
  geoms.flatMap((g) => polygonsOf(g).flatMap((poly) => poly.slice(1).map(bboxOfRing)));

async function runMapshaper(commands, files) {
  return mapshaper.applyCommands(commands, files);
}

// ───────────────────────── step 1: source geometry ─────────────────────────
async function loadAdmin1() {
  const admin1 = readJson(path.join(CACHE, 'ne_10m_admin_1_states_provinces.geojson'));
  const byCode = new Map();
  const shift = (cs) => (typeof cs[0] === 'number' ? [cs[0] < 0 ? cs[0] + 360 : cs[0], cs[1]] : cs.map(shift));
  const wanted = new Set([...Object.keys(COUNTRIES), ...Object.keys(ADM0_ALIAS), 'RUS', 'UKR']);
  const features = [];
  for (const f of admin1.features) {
    const p = f.properties;
    if (!wanted.has(p.adm0_a3)) continue;
    if (p.adm0_a3 === 'RUS' && (!p.iso_3166_2 || p.iso_3166_2.endsWith('~'))) continue; // nameless islet
    const adm0 = ADM0_ALIAS[p.adm0_a3] ?? p.adm0_a3;
    const id = p.iso_3166_2 || p.adm1_code;
    let geometry = f.geometry;
    // Chukotka crosses the antimeridian: use longitudes up to ~191 so it stays one connected shape.
    if (id === 'RU-CHU') geometry = { type: geometry.type, coordinates: shift(geometry.coordinates) };
    const feat = { type: 'Feature', properties: { adm0, ne: p.name }, geometry };
    byCode.set(id, feat);
    features.push({ ...feat, id: `${adm0}|${id}` });
  }
  // Unlike the other regions, the Chukotka pieces are cut at ±180° with different vertices on each side.
  const chuIdx = features.findIndex((f) => f.id === 'RUS|RU-CHU');
  const cleaned = await runMapshaper('-i chu.json -clean -o out.json', {
    'chu.json': JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { k: 1 }, geometry: features[chuIdx].geometry }] }),
  });
  features[chuIdx].geometry = JSON.parse(cleaned['out.json']).features[0].geometry;
  byCode.get('RU-CHU').geometry = features[chuIdx].geometry;
  for (const f of features) f.geometry = rewind(f.geometry);
  return { features, byCode };
}

function buildSource(admin1) {
  const { features, byCode } = admin1;
  const topo = topology({ admin1: { type: 'FeatureCollection', features } });
  const geoms = topo.objects.admin1.geometries;
  const geomById = new Map(geoms.map((g) => [g.id, g]));
  const idx = new Map(geoms.map((g, i) => [g.id, i]));
  const nb = neighbors(geoms);

  const regions = REGION_TABLE.map(([id, ne, name, short, district, capital]) => {
    const src = byCode.get(ne);
    if (!src) throw new Error(`Natural Earth has no ${ne} (${id})`);
    if (id === 'MOW' && src.properties.ne !== 'Moskva') throw new Error('NE Moscow codes changed, fix REGION_TABLE');
    if (id === 'MOS' && src.properties.ne !== 'Moskovskaya') throw new Error('NE Moscow codes changed, fix REGION_TABLE');
    const g = geomById.get(`${src.properties.adm0}|${ne}`);
    const f = feature(topo, g);
    return { id, ne, name, short, district, capital, isNew: NEW_REGIONS.has(id), feature: { type: 'Feature', id, properties: { id, name }, geometry: rewind(f.geometry) } };
  });

  const ua = Object.entries(UA_OBLASTS).map(([code, name]) => {
    const src = byCode.get(code);
    if (!src) throw new Error(`Natural Earth has no ${code}`);
    const f = feature(topo, geomById.get(`UKR|${code}`));
    return { id: code, name, feature: { type: 'Feature', id: code, properties: { id: code, name, kind: 'ua' }, geometry: rewind(f.geometry) } };
  });
  const uaCount = features.filter((f) => f.properties.adm0 === 'UKR').length;
  if (uaCount !== Object.keys(UA_OBLASTS).length + 4) throw new Error(`unexpected Ukraine admin-1 count ${uaCount}`);

  const countries = Object.entries(COUNTRIES).map(([a3, name]) => {
    const members = geoms.filter((g) => g.id.startsWith(`${a3}|`));
    if (!members.length) throw new Error(`no admin-1 for ${a3}`);
    return { id: a3, name, feature: { type: 'Feature', id: a3, properties: { id: a3, name, kind: 'country' }, geometry: rewind(merge(topo, members)) } };
  });

  // Region adjacency by shared arcs (full detail), plus enclave/coast pairs.
  const keyOf = (r) => `${byCode.get(r.ne).properties.adm0}|${r.ne}`;
  const idByKey = new Map(regions.map((r) => [keyOf(r), r.id]));
  const regionNeighbors = new Map(regions.map((r) => [r.id, new Set()]));
  for (const r of regions) {
    for (const j of nb[idx.get(keyOf(r))]) {
      const other = idByKey.get(geoms[j].id);
      if (other) regionNeighbors.get(r.id).add(other);
    }
  }
  for (const [a, b] of FORCED_NEIGHBORS) {
    regionNeighbors.get(a).add(b);
    regionNeighbors.get(b).add(a);
  }
  return { regions, ua, countries, regionNeighbors };
}

// ───────────────────────── step 2: topology files ─────────────────────────
function prop(f, kind) {
  return { ...f, properties: { ...f.properties, kind } };
}

function toFeatures(geojsonText, restore) {
  const gj = JSON.parse(geojsonText);
  const features = gj.type === 'FeatureCollection' ? gj.features : [];
  return features.map((f) => restore(f)).filter(Boolean);
}

async function buildRussiaTopo(src) {
  const holes = holeBoxesOf([...src.regions, ...src.countries, ...src.ua].map((x) => x.feature.geometry));
  const items = [];
  for (const r of src.regions) {
    items.push({ ...r.feature, properties: { g: 'regions', id: r.id, name: r.name }, geometry: dropSmallParts(r.feature.geometry, RUSSIA.minIslandKm2, holes) });
  }
  for (const c of src.countries) {
    items.push({ ...c.feature, properties: { g: 'context', id: c.id, name: c.name, kind: 'country' }, geometry: dropSmallParts(c.feature.geometry, RUSSIA.minContextIslandKm2, holes) });
  }
  for (const u of src.ua) {
    items.push({ ...u.feature, properties: { g: 'context', id: u.id, name: u.name, kind: 'ua-oblast' }, geometry: dropSmallParts(u.feature.geometry, RUSSIA.minContextIslandKm2, holes) });
  }
  const shifted = items.map((f) => ({ ...f, geometry: shiftLon(f.geometry, MAPSHAPER_LON_SHIFT) }));
  const input = JSON.stringify({ type: 'FeatureCollection', features: shifted });
  const clip = [RUSSIA_CLIP[0] + MAPSHAPER_LON_SHIFT, RUSSIA_CLIP[1], RUSSIA_CLIP[2] + MAPSHAPER_LON_SHIFT, RUSSIA_CLIP[3]];
  const out = await runMapshaper(
    `-i all.json -proj init=EPSG:4326 -clip bbox=${clip.join(',')} -simplify weighted keep-shapes interval=${RUSSIA.simplify} -split g -o format=geojson target=*`,
    { 'all.json': input },
  );
  const back = (f) => ({ ...f, geometry: f.geometry && shiftLon(f.geometry, -MAPSHAPER_LON_SHIFT) });
  const regionsOut = new Map(), contextOut = new Map();
  for (const f of toFeatures(out['regions.json'], back)) regionsOut.set(f.properties.id, f);
  for (const f of toFeatures(out['context.json'], back)) contextOut.set(f.properties.id, f);
  const regionFeatures = src.regions.map((r) => {
    const f = regionsOut.get(r.id);
    if (!f || !f.geometry) throw new Error(`region ${r.id} vanished after simplification`);
    return { type: 'Feature', id: r.id, properties: { id: r.id, name: r.name }, geometry: rewind(f.geometry) };
  });
  const contextItems = [...src.countries.map((c) => [c, 'country']), ...src.ua.map((u) => [u, 'ua-oblast'])];
  const contextFeatures = [];
  for (const [c, kind] of contextItems) {
    const f = contextOut.get(c.id);
    if (!f || !f.geometry) { log(`  context ${c.id} dropped (outside clip)`); continue; }
    contextFeatures.push({ type: 'Feature', id: c.id, properties: { name: c.name, kind }, geometry: rewind(f.geometry) });
  }
  const topo = topology(
    { regions: { type: 'FeatureCollection', features: regionFeatures }, context: { type: 'FeatureCollection', features: contextFeatures } },
    RUSSIA.quantization,
  );
  fs.mkdirSync(path.dirname(OUT.russia), { recursive: true });
  fs.writeFileSync(OUT.russia, JSON.stringify(topo));
  log(`wrote ${path.relative(ROOT, OUT.russia)} ${kb(OUT.russia)}`);
  return topo;
}

function buildRiverFeatures() {
  const files = ['ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe'];
  const out = [];
  for (const file of files) {
    for (const f of readJson(path.join(CACHE, `${file}.geojson`)).features) {
      const p = f.properties;
      const name = (p.name_ru || RIVER_RU[p.name] || p.name || '').trim();
      if (!name || !f.geometry) continue;
      out.push({ type: 'Feature', properties: { name }, geometry: f.geometry });
    }
  }
  return out;
}

function buildWaterFeatures() {
  const out = [];
  for (const f of readJson(path.join(CACHE, 'ne_10m_lakes.geojson')).features) {
    if (!f.geometry) continue;
    out.push({ type: 'Feature', properties: { name: f.properties.name_ru || f.properties.name || null }, geometry: rewind(f.geometry) });
  }
  return out;
}

async function buildFrontTopo(src) {
  const areaItems = [
    ...src.regions.filter((r) => FRONT_RU_IDS.includes(r.id)).map((r) => ({ ...r.feature, properties: { id: r.id, name: r.name, kind: 'ru' } })),
    ...src.ua.map((u) => u.feature),
    ...src.countries.filter((c) => FRONT_COUNTRY_IDS.includes(c.id)).map((c) => c.feature),
  ];
  if (areaItems.length !== FRONT_RU_IDS.length + src.ua.length + FRONT_COUNTRY_IDS.length) throw new Error('front areas selection mismatch');
  const bbox = FRONT_CLIP.join(',');
  const out = await runMapshaper(
    `-i areas.json rivers.json water.json combine-files -proj init=EPSG:4326 -clip bbox=${bbox} target=* -simplify weighted keep-shapes interval=${FRONT.simplify} -o format=geojson target=*`,
    {
      'areas.json': JSON.stringify({ type: 'FeatureCollection', features: areaItems }),
      'rivers.json': JSON.stringify({ type: 'FeatureCollection', features: buildRiverFeatures() }),
      'water.json': JSON.stringify({ type: 'FeatureCollection', features: buildWaterFeatures() }),
    },
  );
  const areas = toFeatures(out['areas.json'], (f) => ({ type: 'Feature', id: f.properties.id, properties: { id: f.properties.id, name: f.properties.name, kind: f.properties.kind }, geometry: rewind(f.geometry) }));
  const rivers = toFeatures(out['rivers.json'], (f) => ({ type: 'Feature', properties: { name: f.properties.name }, geometry: f.geometry }));
  const water = toFeatures(out['water.json'], (f) => ({ type: 'Feature', properties: { name: f.properties.name ?? null }, geometry: rewind(f.geometry) }));
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const topo = topology({ areas: fc(areas), rivers: fc(rivers), water: fc(water) }, FRONT.quantization);
  fs.writeFileSync(OUT.front, JSON.stringify(topo));
  log(`wrote ${path.relative(ROOT, OUT.front)} ${kb(OUT.front)} (areas ${areas.length}, rivers ${rivers.length}, water ${water.length})`);
  return topo;
}

// ───────────────────────── step 3: regions.json ─────────────────────────
// Polylabel (Mapbox) — pole of inaccessibility; works on projected coordinates with holes.
function polylabel(polygon, precision = 0.5) {
  const [x0, y0, x1, y1] = bboxOfRing(polygon[0]);
  const w = x1 - x0, h = y1 - y0;
  const size = Math.min(w, h);
  if (size === 0) return { x: x0, y: y0, d: 0 };
  const cell = (x, y, half) => {
    const d = pointToPolygonDist(x, y, polygon);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  const queue = [];
  const push = (c) => { queue.push(c); queue.sort((a, b) => a.max - b.max); };
  for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) push(cell(x + size / 2, y + size / 2, size / 2));
  let best = cell(x0 + w / 2, y0 + h / 2, 0);
  while (queue.length) {
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const half = c.half / 2;
    push(cell(c.x - half, c.y - half, half));
    push(cell(c.x + half, c.y - half, half));
    push(cell(c.x - half, c.y + half, half));
    push(cell(c.x + half, c.y + half, half));
  }
  return best;
}

function pointToPolygonDist(x, y, polygon) {
  let inside = false;
  let minSq = Infinity;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      let px = ax, py = ay, dx = bx - ax, dy = by - ay;
      if (dx !== 0 || dy !== 0) {
        const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
        if (t > 1) { px = bx; py = by; } else if (t > 0) { px += dx * t; py += dy * t; }
      }
      dx = x - px; dy = y - py;
      minSq = Math.min(minSq, dx * dx + dy * dy);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

const LABEL_PROJECTION = d3.geoConicEqualArea().rotate([-100, 0]).parallels([52, 64]).scale(EARTH_R).translate([0, 0]);

function largestPolygon(geom) {
  return polygonsOf(geom).reduce((best, coords) => {
    const km2 = geomKm2({ type: 'Polygon', coordinates: coords });
    return !best || km2 > best.km2 ? { coords, km2 } : best;
  }, null).coords;
}

function labelPoint(geom) {
  const coords = largestPolygon(geom);
  const poly = { type: 'Polygon', coordinates: coords };
  const projected = coords.map((ring) => ring.map((pt) => LABEL_PROJECTION(pt)));
  const best = polylabel(projected, 0.2);
  const p = LABEL_PROJECTION.invert([best.x, best.y]);
  if (p && d3.geoContains(poly, p)) return roundPt([normLon(p[0]), p[1]]);
  const c = d3.geoCentroid(poly);
  if (d3.geoContains(poly, c)) return roundPt(c);
  const [[bx0, by0], [bx1, by1]] = d3.geoBounds(poly);
  const xs = bx1 >= bx0 ? [bx0, bx1] : [bx0, bx1 + 360];
  for (let n = 4; n <= 256; n *= 2) {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const pt = [normLon(xs[0] + ((xs[1] - xs[0]) * i) / n), by0 + ((by1 - by0) * j) / n];
      if (d3.geoContains(poly, pt)) return roundPt(pt);
    }
  }
  throw new Error('no interior point found');
}

function buildRegionsJson(src, russiaTopo) {
  const topoFeatures = new Map(feature(russiaTopo, russiaTopo.objects.regions).features.map((f) => [f.id, f]));
  const entries = src.regions.map((r) => {
    const drawn = topoFeatures.get(r.id);
    const full = r.feature;
    return {
      id: r.id,
      name: r.name,
      short: r.short,
      district: r.district,
      capital: r.capital,
      label: labelPoint(drawn.geometry),
      centroid: roundPt(d3.geoCentroid(full)),
      neighbors: [...src.regionNeighbors.get(r.id)].sort(),
      isNew: r.isNew,
      areaKm2: Math.round(geomKm2(full)),
    };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  writeLines(OUT.regions, entries);
  log(`wrote ${path.relative(ROOT, OUT.regions)} ${kb(OUT.regions)} (${entries.length})`);
  return entries;
}

function writeLines(file, rows) {
  fs.writeFileSync(file, `[\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`);
}

// ───────────────────────── step 4: cities.json ─────────────────────────
const TR_PAIRS = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'], ['yu', 'ю'],
  ['ya', 'я'], ['ye', 'е'], ['yo', 'ё'], ['iu', 'ю'], ['ia', 'я'], ['ie', 'е'],
];
const TR_SINGLE = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' };
function translit(ascii) {
  let s = ascii.toLowerCase().replace(/['’`]/g, '');
  let out = '';
  for (let i = 0; i < s.length;) {
    const pair = TR_PAIRS.find(([k]) => s.startsWith(k, i));
    if (pair) { out += pair[1]; i += pair[0].length; continue; }
    out += TR_SINGLE[s[i]] ?? s[i];
    i++;
  }
  return out.replace(/(^|[\s-])(.)/g, (_, a, b) => a + b.toUpperCase());
}

function buildCities(src) {
  const gj = readJson(path.join(CACHE, 'ne_10m_populated_places.geojson'));
  const regionGeo = src.regions.map((r) => ({ id: r.id, geometry: r.feature.geometry, bounds: d3.geoBounds(r.feature) }));
  const inBounds = ([[x0, y0], [x1, y1]], lon, lat) => lat >= y0 - 0.01 && lat <= y1 + 0.01 && (x0 <= x1 ? lon >= x0 - 0.01 && lon <= x1 + 0.01 : lon >= x0 - 0.01 || lon <= x1 + 0.01);
  const regionAt = (lon, lat) => {
    for (const r of regionGeo) if (inBounds(r.bounds, lon, lat) && d3.geoContains(r.geometry, [lon, lat])) return r.id;
    return null;
  };
  const nearestRegion = (lon, lat, maxKm) => {
    let best = null, bestD = maxKm;
    for (const r of regionGeo) {
      if (!inBounds(r.bounds, lon, lat) && Math.abs(r.bounds[0][1] - lat) > 2) continue;
      for (const poly of polygonsOf(r.geometry)) for (const [x, y] of poly[0]) {
        const d = d3.geoDistance([lon, lat], [x, y]) * EARTH_R;
        if (d < bestD) { bestD = d; best = r.id; }
      }
    }
    return best;
  };
  const uaGeo = new Map(src.ua.map((u) => [u.id, u.feature]));
  const uaZone = ['UA-63', 'UA-59', 'UA-12', 'UA-48'];
  const uaOblastAt = (lon, lat) => uaZone.find((id) => d3.geoContains(uaGeo.get(id), [lon, lat])) ?? null;
  const BORDER_RU = new Set(['BEL', 'KRS', 'BRY', 'ROS', 'VOR']);
  const EXTRA_UA = new Set(['Киев', 'Харьков', 'Днепр', 'Одесса', 'Николаев', 'Сумы', 'Чернигов', 'Полтава']);

  const places = [];
  let translitCount = 0;
  for (const f of gj.features) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const name = (p.NAME_RU || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const pop = Math.max(p.POP_MAX || 0, p.POP_MIN || 0);
    // Pre-filter cheaply: only things we could possibly keep.
    const inZone = lon >= FRONT_ZONE.lon[0] && lon <= FRONT_ZONE.lon[1] && lat >= FRONT_ZONE.lat[0] && lat <= FRONT_ZONE.lat[1];
    const inRu = lat > 40 && lat < 83 && (lon > 18 || lon < -165);
    if (!inRu && !inZone) continue;
    places.push({ p, name, pop, lon, lat, regionId: regionAt(lon, lat) });
  }

  const keep = new Map();
  const add = (pl, regionId, country, capital, forcedName) => {
    let name = forcedName || pl.name;
    if (!name) { name = translit(pl.p.NAMEASCII || pl.p.NAME || ''); translitCount++; }
    if (!name) return;
    const row = { name, lon: round(normLon(pl.lon)), lat: round(pl.lat), pop: pl.pop, country, regionId, capital };
    const key = `${keyName(name)}|${row.lon.toFixed(1)}|${row.lat.toFixed(1)}`;
    const prev = keep.get(key);
    // the capital entry (with its region from regions.json) wins over a plain containment match
    if (!prev || (capital && !prev.capital)) keep.set(key, row);
  };

  // (a) region capitals
  const missing = [];
  for (const r of src.regions) {
    const key = keyName(r.capital);
    const cand = places.filter((pl) => keyName(pl.name) === key && pl.regionId === r.id).sort((a, b) => b.pop - a.pop)[0];
    if (cand) { add(cand, r.id, 'RU', true, r.capital); continue; }
    const manual = MANUAL_CAPITALS[r.capital];
    if (manual) {
      const [lon, lat, pop] = manual;
      add({ name: r.capital, lon, lat, pop, p: {} }, r.id, 'RU', true);
      missing.push(`${r.capital} (manual)`);
      continue;
    }
    const near = places.filter((pl) => keyName(pl.name) === key).sort((a, b) => b.pop - a.pop)[0];
    if (!near) throw new Error(`capital ${r.capital} (${r.id}) not found`);
    const rid = nearestRegion(near.lon, near.lat, 15);
    if (rid !== r.id) throw new Error(`capital ${r.capital} (${r.id}) lies outside its region (${rid})`);
    add(near, r.id, 'RU', true, r.capital);
    missing.push(`${r.capital} (on the border, assigned to ${r.id})`);
  }
  if (missing.length) log(`  capitals not matched by containment: ${missing.join(', ')}`);

  for (const pl of places) {
    const country = pl.regionId ? 'RU' : (pl.p.ADM0_A3 === 'RUS' ? 'RU' : null);
    // (b) Russian cities with pop >= 150k (including the new regions)
    if (country === 'RU' && pl.pop >= 150000) add(pl, pl.regionId ?? nearestRegion(pl.lon, pl.lat, 25), 'RU', false);
    const inZone = pl.lon >= FRONT_ZONE.lon[0] && pl.lon <= FRONT_ZONE.lon[1] && pl.lat >= FRONT_ZONE.lat[0] && pl.lat <= FRONT_ZONE.lat[1];
    if (!inZone) continue;
    // (c) front zone: every place in the six new regions and the Russian border regions
    if (pl.regionId && (NEW_REGIONS.has(pl.regionId) || BORDER_RU.has(pl.regionId))) add(pl, pl.regionId, 'RU', false);
    else if (!pl.regionId && uaOblastAt(pl.lon, pl.lat)) add(pl, null, 'UA', false);
    // (d) major Ukrainian cities elsewhere
    else if (!pl.regionId && pl.p.ADM0_A3 === 'UKR' && EXTRA_UA.has(pl.name)) add(pl, null, 'UA', false);
  }

  const rows = [...keep.values()].sort((a, b) => b.pop - a.pop || a.name.localeCompare(b.name, 'ru'));
  writeLines(OUT.cities, rows);
  log(`wrote ${path.relative(ROOT, OUT.cities)} ${kb(OUT.cities)} (${rows.length}, transliterated ${translitCount})`);
  return rows;
}

// ───────────────────────── step 5: verification ─────────────────────────
function verify(russiaTopo, frontTopo, regionsJson, cities) {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };

  const ids = REGION_TABLE.map((r) => r[0]);
  const regionFeatures = feature(russiaTopo, russiaTopo.objects.regions).features;
  check(regionFeatures.length === 89, `regions: ${regionFeatures.length} features`);
  check(ids.every((id) => regionFeatures.some((f) => f.id === id && f.properties.id === id && f.properties.name)), 'regions: ids mismatch');
  check(regionsJson.length === 89 && ids.every((id) => regionsJson.some((r) => r.id === id)), 'regions.json: ids mismatch');

  const areaOk = (label, f) => {
    const a = d3.geoArea(f);
    check(f.geometry && a > 0 && a < 2 * Math.PI, `${label}: bad d3.geoArea ${a}`);
  };
  for (const [topo, name] of [[russiaTopo, 'russia'], [frontTopo, 'front']]) {
    for (const [key, obj] of Object.entries(topo.objects)) {
      const fc = feature(topo, obj);
      if (/rivers/.test(key)) continue;
      for (const f of fc.features) areaOk(`${name}.${key}.${f.id ?? f.properties.name}`, f);
    }
  }

  const byId = new Map(regionFeatures.map((f) => [f.id, f]));
  for (const r of regionsJson) {
    const poly = { type: 'Polygon', coordinates: largestPolygon(byId.get(r.id).geometry) };
    check(d3.geoContains(poly, r.label), `label of ${r.id} is outside its largest polygon`);
    check(d3.geoArea(byId.get(r.id)) > 0 && r.areaKm2 > 0, `${r.id}: zero area`);
  }
  const mow = byId.get('MOW'), spe = byId.get('SPE'), sev = byId.get('SEV');
  const lab = (id) => regionsJson.find((r) => r.id === id).label;
  check(!d3.geoContains(mow, lab('MOS')), 'MOS label inside Moscow city');
  check(!d3.geoContains(spe, lab('LEN')), 'LEN label inside Saint Petersburg');
  check(!d3.geoContains(sev, lab('CR')), 'CR label inside Sevastopol');

  // adjacency symmetry + agreement of simplified topology with the full-detail one
  const geoms = russiaTopo.objects.regions.geometries;
  const nbSimplified = neighbors(geoms);
  let diffs = 0;
  geoms.forEach((g, i) => {
    const expected = new Set(regionsJson.find((r) => r.id === g.id).neighbors);
    const got = new Set(nbSimplified[i].map((j) => geoms[j].id));
    for (const x of got) if (!expected.has(x)) { diffs++; log(`  note: ${g.id} touches ${x} in simplified topology only`); }
    for (const x of expected) if (!got.has(x) && !FORCED_NEIGHBORS.some(([a, b]) => (a === g.id && b === x) || (b === g.id && a === x))) { diffs++; log(`  note: ${g.id}-${x} border lost in simplification`); }
  });
  for (const r of regionsJson) for (const n of r.neighbors) check(regionsJson.find((x) => x.id === n)?.neighbors.includes(r.id), `neighbors not symmetric ${r.id}-${n}`);

  // front topology content
  const areas = feature(frontTopo, frontTopo.objects.areas).features;
  const wantedAreas = new Set([...FRONT_RU_IDS, ...Object.keys(UA_OBLASTS), ...FRONT_COUNTRY_IDS]);
  check(areas.length === wantedAreas.size && areas.every((f) => wantedAreas.has(f.id)), `front areas: ${areas.length} vs ${wantedAreas.size}`);
  const riverNames = new Set(feature(frontTopo, frontTopo.objects.rivers).features.map((f) => f.properties.name));
  for (const n of ['Днепр', 'Северский Донец', 'Оскол', 'Дон']) check(riverNames.has(n), `front rivers: ${n} missing`);

  // cities
  for (const r of regionsJson) check(cities.some((c) => c.capital && c.regionId === r.id && keyName(c.name) === keyName(r.capital)), `city for capital ${r.capital} missing`);
  check(cities.every((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat) && c.name), 'cities: bad entries');

  const size = (p) => fs.statSync(p).size / 1024;
  check(size(OUT.russia) <= 700, `russia.topo.json is ${size(OUT.russia).toFixed(0)} KB (> 700)`);
  check(size(OUT.front) <= 600, `front.topo.json is ${size(OUT.front).toFixed(0)} KB (> 600)`);
  if (errors.length) throw new Error(`verification failed:\n - ${errors.join('\n - ')}`);
  log(`verification passed (adjacency differences between full and simplified topology: ${diffs})`);
}

// ───────────────────────── main ─────────────────────────
async function main() {
  const t0 = Date.now();
  await download();
  log('load admin-1');
  const admin1 = await loadAdmin1();
  const src = buildSource(admin1);
  log(`source: ${src.regions.length} regions, ${src.ua.length} UA oblasts, ${src.countries.length} countries`);
  log('build russia.topo.json');
  const russiaTopo = await buildRussiaTopo(src);
  log('build front.topo.json');
  const frontTopo = await buildFrontTopo(src);
  const regionsJson = buildRegionsJson(src, russiaTopo);
  const cities = buildCities(src);
  verify(russiaTopo, frontTopo, regionsJson, cities);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
