// Extraction of threat signals from Russian / Ukrainian news and Telegram texts.
import { REGIONS, type RegionInfo } from '../../../shared/regions';
import citiesData from '../../../shared/cities.json';

export type SignalThreat = 'air' | 'uav' | 'missile' | 'aviation' | 'explosion';

export interface Intercept {
  /** null = a national total that was not broken down by region. */
  regionId: string | null;
  count: number;
  type: 'uav' | 'missile';
}

export interface PostSignals {
  threats: SignalThreat[];
  allClear: boolean;
  isThreatNotice: boolean;
  regions: string[];
  intercepts: Intercept[];
}

export const emptySignals = (): PostSignals => ({ threats: [], allClear: false, isThreatNotice: false, regions: [], intercepts: [] });

/* ---------- normalisation ---------- */

/** ё→е and unified apostrophes; case is preserved (a few patterns are case-sensitive). */
export function normalizeText(s: string): string {
  return s
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .replace(/[’ʼ`´]/g, "'");
}

/* ---------- region matchers ---------- */

const LB = '(?<![\\p{L}-])';
const ENDINGS = '(?:а|ы|е|у|о|э|ой|ою|ей|ею|и|я|ю|ем|ом|ь|ая|ую|ое|ие|ого|ому|им|ым|ых|ий|ый)';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const GENERIC_WORDS = new Set(['республика', 'область', 'край', 'автономный', 'автономная', 'округ', 'народная', 'ао', 'респ.']);

/** Drop the inflection of a Russian proper noun / adjective (белгородская → белгородск, Тула → тул). */
function stemOf(word: string): string {
  const w = word.toLowerCase();
  if (/(?:ий|ая|ой|ый|ое|яя|ее)$/.test(w)) return w.slice(0, -2);
  if (/[аяьйоеиыуэю]$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Ukrainian spellings of derived stems (белгородск → белгородськ, новороссийск → новоросійськ). */
function ukVariant(stem: string): string | null {
  const v = stem.replace(/ийск$/, 'ійськ').replace(/цк$/, 'цьк').replace(/([^ь])ск$/, '$1ськ');
  return v !== stem ? v : null;
}

/** Pattern for a single word: loose prefix match for long stems, strict word forms for short ones. */
function wordPatterns(word: string, optionalEnding = false): string[] {
  const w = word.toLowerCase();
  const stem = stemOf(w);
  const out: string[] = [];
  const push = (s: string) => {
    if (s.length >= 5) out.push(`${esc(s)}\\p{L}*`);
    else if (s.length >= 3) out.push(`${esc(s)}${ENDINGS}${s.length >= 4 || optionalEnding ? '?' : ''}(?!\\p{L})`);
    else out.push(`${esc(w)}(?:ы|е|у|ой)?(?!\\p{L})`);
  };
  push(stem);
  const uk = ukVariant(stem);
  if (uk) push(uk);
  return out;
}

function phrasePatterns(phrase: string): string[] {
  let p = phrase.toLowerCase().replace(/\(.*?\)/g, ' ').trim();
  if (p.includes('-на-')) p = p.split('-на-')[0]!;
  const tokens = p.split(/[\s-]+/).filter((t) => t && !GENERIC_WORDS.has(t));
  if (!tokens.length) return [];
  if (tokens.length === 1) return wordPatterns(tokens[0]!);
  const head = tokens.slice(0, -1).map((t) => `${esc(stemOf(t))}\\p{L}*`).join('[-\\s]+');
  return wordPatterns(tokens[tokens.length - 1]!, true).map((last) => `${head}[-\\s]+${last}`);
}

/** Names that are common words or personal names: handled by MANUAL patterns only. */
const DENY_NAMES = new Set(['Курган', 'Киров', 'Владимир', 'Грозный', 'Орёл', 'Иваново', 'Шахты', 'Находка', 'Волжский', 'Магас']);

/** City names the dataset assigns to the wrong region (or twice). */
const CITY_OVERRIDES: Record<string, string> = { Подольск: 'MOS', Находка: 'PRI', Ногинск: 'MOS', Абакан: 'KK' };

interface Manual {
  ci?: string[];
  cs?: string[];
}

/** Hand-written patterns that REPLACE the generated ones for ambiguous regions. */
const MANUAL: Record<string, Manual> = {
  MOW: { ci: ['москв(?:а|ы|е|у|ой|ою|и)(?!\\p{L})', 'москв\\p{L}*[-\\s]сити', 'московск\\p{L}*\\s+регион\\p{L}*', 'московськ\\p{L}*\\s+регіон\\p{L}*'] },
  MOS: {
    ci: [
      'подмосков\\p{L}*',
      'підмосков\\p{L}*',
      'московск\\p{L}*\\s+област\\p{L}*',
      'московськ\\p{L}*\\s+област\\p{L}*',
      'московск\\p{L}*\\s+регион\\p{L}*',
      'московськ\\p{L}*\\s+регіон\\p{L}*',
      'московщин\\p{L}*',
      'красногорск\\p{L}*',
      'подольск\\p{L}*',
      'ногинск\\p{L}*',
    ],
  },
  SPE: { ci: ['санкт[-\\s]*петербург\\p{L}*', 'петербург\\p{L}*', 'питер(?:а|е|у|ом)?(?![\\p{L}-])', 'спб(?!\\p{L})'] },
  LEN: {
    ci: [
      'ленинградск\\p{L}*\\s+област\\p{L}*',
      'ленінградськ\\p{L}*\\s+област\\p{L}*',
      'ленобласт\\p{L}*',
      'гатчин\\p{L}*',
      'усть[-\\s]луг\\p{L}*',
      'кириш\\p{L}*',
      'приморск(?:а|е|у|ом)?(?![\\p{L}-])',
      'приозерск\\p{L}*',
    ],
  },
  ORL: {
    ci: ['орловск\\p{L}*', 'орловськ\\p{L}*', 'орловщин\\p{L}*'],
    cs: ['Орел(?!\\p{L})', 'Орл(?:а|е|у|ом)(?!\\p{L})'],
  },
  VLA: {
    ci: ['владимирск\\p{L}*', 'владимирськ\\p{L}*', 'владимирщин\\p{L}*', '(?:во|г\\.\\s*|город\\p{L}*\\s+)владимир(?:е|а)?(?![\\p{L}-])', 'ковров\\p{L}*'],
  },
  KIR: { ci: ['кировск(?:ая|ой|ую|ою)\\s+област\\p{L}*', 'кіровськ\\p{L}*\\s+област\\p{L}*'], cs: ['Киров(?:а|е|у|ом)?(?![\\p{L}-])'] },
  IVA: { ci: ['иваново(?!\\p{L})', 'ивановск\\p{L}*\\s+област\\p{L}*', 'ивановщин\\p{L}*'] },
  CE: { ci: ['чечн(?:я|и|е|ю|ей)(?!\\p{L})', 'чечен\\p{L}*', 'чеченськ\\p{L}*'], cs: ['Грозн(?:ый|ого|ом|ым|ому)(?![\\p{L}-])'] },
  AL: { ci: ['горно[-\\s]алтайск\\p{L}*', 'республик\\p{L}*\\s+алтай(?!ск)'] },
  ALT: { ci: ['алтайск\\p{L}*', 'барнаул\\p{L}*', 'алтайськ\\p{L}*', 'бийск(?:а|е|у|ом)?(?!\\p{L})', 'рубцовск\\p{L}*'] },
  KO: { ci: ['коми(?![\\p{L}-])', 'сыктывкар\\p{L}*', 'ухт(?:а|ы|е|у|ой)(?!\\p{L})', 'воркут\\p{L}*'] },
  KHM: { ci: ['ханты[-\\s]*мансийск\\p{L}*', 'хмао(?!\\p{L})', 'югр(?:а|ы|е|у|ой)(?!\\p{L})', 'сургут\\p{L}*', 'нижневартовск\\p{L}*'] },
  YAN: { ci: ['ямало[-\\s]*ненецк\\p{L}*', 'янао(?!\\p{L})', 'салехард\\p{L}*', 'ямал(?:а|е|у|ом)?(?![\\p{L}-])', 'новый\\s+уренгой', 'нового\\s+уренгоя'] },
  NEN: { ci: ['ненецк\\p{L}*', 'нарьян[-\\s]*мар\\p{L}*'] },
  YEV: { ci: ['еврейск\\p{L}*\\s+автономн\\p{L}*', 'биробиджан\\p{L}*'] },
  SE: { ci: ['северн\\p{L}*\\s+осети\\p{L}*', 'осети\\p{L}*\\s*[-—–]\\s*алани\\p{L}*', 'владикавказ\\p{L}*', 'алани(?:я|и|ю|ей)(?!\\p{L})'] },
  PRI: { ci: ['приморск(?:ий|ого|ому|им|ом)\\s+кра\\p{L}*', 'приморь(?:е|я|ю|ем)(?!\\p{L})', 'владивосток\\p{L}*', 'уссурийск\\p{L}*'] },
  KGN: { ci: ['курганск\\p{L}*', '(?:г\\.\\s*|город\\p{L}*\\s+|в\\s+|над\\s+)курган(?:е|а|у|ом)?(?![\\p{L}-])'] },
};

/** Extra patterns ADDED to the generated ones: Ukrainian spellings, frequently mentioned towns and landmarks. */
const EXTRA: Record<string, string[]> = {
  BEL: ['бєлгород\\p{L}*', 'белгородщин\\p{L}*', 'бєлгородщин\\p{L}*', 'шебекін\\p{L}*', 'грайворон\\p{L}*', 'старий\\s+оскіл\\p{L}*', 'губкін\\p{L}*', 'валуйк\\p{L}*'],
  KRS: ['курськ\\p{L}*', 'курщин\\p{L}*', 'судж(?:а|и|е|у|ей|ею)(?!\\p{L})', 'рыльск\\p{L}*', 'рильськ\\p{L}*', 'курчатов\\p{L}*', 'льгів\\p{L}*'],
  BRY: ['брянськ\\p{L}*', 'брянщин\\p{L}*', 'клинц\\p{L}*', 'новозыбков\\p{L}*', 'новозибків\\p{L}*', 'почеп\\p{L}*', 'унеч\\p{L}*', 'севск\\p{L}*', 'севськ\\p{L}*', 'трубчевск\\p{L}*'],
  VOR: ['воронежськ\\p{L}*', 'воронежчин\\p{L}*', 'борисоглебск\\p{L}*', 'россош\\p{L}*'],
  ROS: ['ростовськ\\p{L}*', 'ростовщин\\p{L}*', 'морозовск\\p{L}*', 'азов(?:а|е|у|ом)?(?![\\p{L}-])', 'ростов\\p{L}*'],
  KDA: [
    'туапсе(?!\\p{L})',
    'туапсин\\p{L}*',
    'кубан(?:ь|и|ью)(?!\\p{L})',
    'кубанск\\p{L}*',
    'ейск\\p{L}*',
    'анап(?:а|ы|е|у|ой)(?!\\p{L})',
    'темрюк\\p{L}*',
    'тихорецк\\p{L}*',
    'славянск[-\\s]на[-\\s]кубан\\p{L}*',
    'афипск\\p{L}*',
    'кореновск\\p{L}*',
    'крымск(?:а|е|у|ом)?(?![\\p{L}-])',
    'новоросійськ\\p{L}*',
    'новоросийск\\p{L}*',
    'краснодарськ\\p{L}*',
    'кущевск\\p{L}*',
    'приморско[-\\s]ахтарск\\p{L}*',
  ],
  CR: [
    'крым(?:а|у|е|ом)?(?![\\p{L}-])',
    'крымск(?:ий|ого|ому|им|ом|ая|ой|ую|ое|ие|их|ими)(?!\\p{L})',
    'крим(?:у|ом|і|а|е|ові)?(?![\\p{L}-])',
    'кримськ\\p{L}*',
    'феодоси\\p{L}*',
    'феодосі\\p{L}*',
    'ялт(?:а|ы|е|у|ой)(?!\\p{L})',
    'бахчисара\\p{L}*',
    'сімферопол\\p{L}*',
    'євпаторі\\p{L}*',
    'джанкой\\p{L}*',
    'саки(?![\\p{L}-])',
  ],
  SEV: ['севастопол\\p{L}*'],
  DPR: ['днр(?!\\p{L})', 'донецьк\\p{L}*', 'донеччин\\p{L}*', 'маріупол\\p{L}*', 'горлівк\\p{L}*', 'макіївк\\p{L}*', 'краматорськ\\p{L}*', 'бахмут\\p{L}*', 'артемовск\\p{L}*', 'авдеевк\\p{L}*', 'авдіївк\\p{L}*', 'покровськ\\p{L}*', 'покровск\\p{L}*', 'угледар\\p{L}*'],
  LPR: ['лнр(?!\\p{L})', 'луганськ\\p{L}*', 'луганщин\\p{L}*', 'лисичанськ\\p{L}*', 'северодонецк\\p{L}*', 'сєвєродонецьк\\p{L}*', 'старобільськ\\p{L}*', 'старобельск\\p{L}*', 'алчевськ\\p{L}*', 'алчевск\\p{L}*'],
  ZAP: ['запоріж\\p{L}*', 'запорізьк\\p{L}*', 'мелітопол\\p{L}*', 'бердянськ\\p{L}*', 'енергодар\\p{L}*', 'василівк\\p{L}*', 'токмак\\p{L}*'],
  KHE: ['херсонщин\\p{L}*', 'херсонськ\\p{L}*', 'каховк\\p{L}*', 'олешк\\p{L}*', 'алешк\\p{L}*', 'скадовськ\\p{L}*', 'скадовск\\p{L}*', 'геническ\\p{L}*', 'генічеськ\\p{L}*'],
  TUL: ['тульськ\\p{L}*', 'щекин\\p{L}*'],
  KLU: ['калузьк\\p{L}*', 'обнинск\\p{L}*'],
  SMO: ['смоленськ\\p{L}*', 'смоленщин\\p{L}*', 'рославл\\p{L}*'],
  TAM: ['мичурин\\p{L}*', 'моршанск\\p{L}*'],
  SAR: ['енгельс\\p{L}*', 'саратовськ\\p{L}*'],
  RYA: ['рязан\\p{L}*', 'рязанськ\\p{L}*'],
  YAR: ['ярослав(?:л|ск|ськ)\\p{L}*'],
  KGD: ['калінінград\\p{L}*'],
};

interface Matcher {
  id: string;
  ci: RegExp | null;
  cs: RegExp | null;
}

function compileList(list: string[], flags: string): RegExp | null {
  const uniq = [...new Set(list)];
  return uniq.length ? new RegExp(`${LB}(?:${uniq.join('|')})`, flags) : null;
}

interface CityRow {
  name: string;
  regionId: string | null;
}

function buildMatchers(): Matcher[] {
  const cityByRegion = new Map<string, Set<string>>();
  const cityRegions = new Map<string, Set<string>>();
  for (const c of citiesData as CityRow[]) {
    const rid = CITY_OVERRIDES[c.name] ?? c.regionId;
    if (!rid) continue;
    (cityRegions.get(c.name) ?? cityRegions.set(c.name, new Set()).get(c.name)!).add(rid);
  }
  const capitals = new Map(REGIONS.map((r) => [r.capital, r.id]));
  for (const [name, set] of cityRegions) {
    let rid: string | undefined;
    if (set.size === 1) rid = [...set][0];
    else rid = capitals.get(name) && set.has(capitals.get(name)!) ? capitals.get(name) : undefined;
    if (!rid) continue;
    (cityByRegion.get(rid) ?? cityByRegion.set(rid, new Set()).get(rid)!).add(name);
  }

  return REGIONS.map((r: RegionInfo) => {
    const manual = MANUAL[r.id];
    const ci: string[] = [];
    if (manual?.ci) ci.push(...manual.ci);
    else {
      for (const phrase of [r.name, r.short]) {
        if (/^[А-ЯЁ]{2,6}$/.test(phrase)) ci.push(`${phrase.toLowerCase()}(?!\\p{L})`);
        else ci.push(...phrasePatterns(phrase));
      }
      const names = new Set([r.capital, ...(cityByRegion.get(r.id) ?? [])]);
      for (const n of names) if (!DENY_NAMES.has(n)) ci.push(...phrasePatterns(n));
    }
    ci.push(...(EXTRA[r.id] ?? []));
    return { id: r.id, ci: compileList(ci, 'giu'), cs: compileList(manual?.cs ?? [], 'gu') };
  });
}

let matchers: Matcher[] | null = null;

export interface RegionMention {
  id: string;
  start: number;
  end: number;
}

/** All region mentions with offsets (in the normalised text), ordered by position. */
export function findRegionMentions(text: string): RegionMention[] {
  matchers ??= buildMatchers();
  const out: RegionMention[] = [];
  for (const m of matchers) {
    for (const re of [m.ci, m.cs]) {
      if (!re) continue;
      for (const hit of text.matchAll(re)) out.push({ id: m.id, start: hit.index!, end: hit.index! + hit[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function detectRegions(text: string): string[] {
  const seen = new Set<string>();
  for (const m of findRegionMentions(normalizeText(text))) seen.add(m.id);
  return [...seen];
}

/* ---------- threats ---------- */

const rx = (s: string) => new RegExp(s, 'iu');

const UAV = rx(`${LB}(?:бпла|бпак|беспилот|безпілот|безпилот|дрон|шахед|шахід|геран|квадрокоптер|fpv)`);
const MISSILE = rx(
  `${LB}(?:ракет|баллист|балістик|крылат|крилат|искандер|іскандер|кинжал|кинджал|калибр(?:ы|ов|ами)(?!\\p{L})|циркон|оникс|х-(?:101|22|32)|himars|хаймарс|атакмс|atacms|storm\\s+shadow|нептун|точк[аи]-у)`,
);
const AVIATION = rx(
  `${LB}(?:авиаци|авіаці|авиабомб|авіабомб|авиаудар|авіаудар|каб(?:ы|ов|ами|и|ів)?(?!\\p{L})|ту-(?:95|160|22)|міг-31|миг-31|су-(?:24|34|35|57)|штурмовик|бомбардировщик|бомбардувальник)`,
);
const AIR = rx(`${LB}(?:воздушн\\p{L}*\\s+тревог|повітрян\\p{L}*\\s+тривог|сирен|тревог|тривог)`);
const EXPLOSION = rx(`${LB}(?:взрыв|вибух|прилет|приліт|хлопк|детонаци|громк\\p{L}*\\s+звук|слышн\\p{L}*\\s+звук)`);

const ALLCLEAR = new RegExp(
  [
    `${LB}(?:отбой|відбій)(?:\\s+\\p{L}+){0,3}`,
    `${LB}отмен\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}?(?:угроз|тревог|опасност)\\p{L}*`,
    `${LB}(?:угроз|опасност|тревог)\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}?(?:миновал|снят|отмен|ликвидирован)\\p{L}*`,
    `${LB}режим\\p{L}*\\s+(?:\\p{L}+\\s+){0,6}?(?:снят|отмен)\\p{L}*`,
    `${LB}ліквідован\\p{L}*\\s+загроз\\p{L}*`,
    `${LB}загроз\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}?(?:минул|знят|скасован)\\p{L}*`,
    `${LB}скасован\\p{L}*\\s+(?:\\p{L}+\\s+){0,3}?(?:тривог|загроз)\\p{L}*`,
    `${LB}тривог\\p{L}*\\s+(?:\\p{L}+\\s+){0,2}?(?:скасован|відмінен)\\p{L}*`,
  ].join('|'),
  'giu',
);

const NOTICE = rx(
  `${LB}(?:опасност|угроз|тревог|тривог|загроз|небезпек|атак|налет|залп|пуск|вылет|взлет|подн[яи]т|летят|летит|сирен|движ|курс|вражеск|ворож|сбит|сбил|перехват|уничтож|знищен|збит|прилет|приліт|взрыв|вибух|удар|обстрел|обстріл|пво|ппо|внимание|увага|укрыт|укритт|напрям|повз|рухаєт|рухают)`,
);
const DRILL = rx(`${LB}(?:учебн|учени(?:я|е|й)|тренировк|проверк\\p{L}*\\s+(?:системы\\s+)?оповещени|тестов\\p{L}*\\s+(?:сообщени|оповещени)|навчальн)`);
const SUMMARY = rx(
  `(?:${LB}за\\s+(?:прошедш\\p{L}*\\s+|минувш\\p{L}*\\s+)?(?:ночь|сутки|неделю)|${LB}в\\s+течение\\s+(?:прошедш\\p{L}*\\s+)?(?:ночи|суток|дня)|${LB}с\\s+\\d{1,2}[:.]\\d{2}\\s+до\\s+\\d{1,2}[:.]\\d{2}|${LB}за\\s+ніч|${LB}протягом\\s+(?:минулої\\s+)?(?:ночі|доби))`,
);

/* ---------- interceptions ("перехвачены и уничтожены 23 БПЛА: 12 – над Брянской областью…") ---------- */

const INTERCEPT_VERB = rx(`${LB}(?:перехвач|уничтож|сбит|сбил|збит|знищ|нейтрализ|подавлен)`);
const TYPE_UAV_G = new RegExp(`${LB}(?:бпла|беспилот|безпілот|дрон|шахед|шахід|геран)`, 'giu');
const TYPE_MISSILE_G = new RegExp(`${LB}(?:ракет|баллист|балістик|крылат|крилат)`, 'giu');
const BEFORE_NUM = /(?<![\d:.,])(\d{1,4})(?!\d)(?:\s*(?:шт\.?|единиц\p{L}*))?([^\d]*)$/u;
const AFTER_NUM =
  /^\s*(?:област\p{L}*|кра(?:й|я|ем)|республик\p{L}*)?\s*(?:[–—−:-]\s*|(?:(?:уничтожен\p{L}*|сбит\p{L}*|перехвачен\p{L}*|знищен\p{L}*|збит\p{L}*)\s+))(\d{1,4})(?!\d|[:.]\d)/iu;
const LIST_GAP = /^\s*(?:област\p{L}*|кра(?:й|я|ем)|республик\p{L}*)?\s*(?:,|\sи\s)\s*$/iu;
const TOTAL_RE = /(\d{1,4})\s+(?:[\p{L}-]+\s+){0,5}?(беспилотн|безпілотн|бпла|дрон|ракет)/iu;

function sentenceSpans(text: string): [number, number][] {
  const cuts: number[] = [0];
  for (const m of text.matchAll(/(?<=[.!?])\s+(?=[A-ZА-ЯІЇЄҐ«"“(])|\n+/gu)) cuts.push(m.index! + m[0].length);
  cuts.push(text.length);
  const spans: [number, number][] = [];
  for (let i = 0; i < cuts.length - 1; i++) if (cuts[i + 1]! > cuts[i]!) spans.push([cuts[i]!, cuts[i + 1]!]);
  return spans;
}

function typeWordsIn(s: string): { pos: number; type: 'uav' | 'missile' }[] {
  const out: { pos: number; type: 'uav' | 'missile' }[] = [];
  for (const m of s.matchAll(TYPE_UAV_G)) out.push({ pos: m.index!, type: 'uav' });
  for (const m of s.matchAll(TYPE_MISSILE_G)) out.push({ pos: m.index!, type: 'missile' });
  return out.sort((a, b) => a.pos - b.pos);
}

export function parseIntercepts(text: string, mentions = findRegionMentions(text)): Intercept[] {
  const acc = new Map<string, Intercept>();
  const add = (regionId: string | null, type: 'uav' | 'missile', count: number) => {
    if (count < 1) return;
    const key = `${regionId}|${type}`;
    const cur = acc.get(key);
    if (cur) cur.count += count;
    else acc.set(key, { regionId, count, type });
  };

  for (const [s0, s1] of sentenceSpans(text)) {
    const sentence = text.slice(s0, s1);
    if (!INTERCEPT_VERB.test(sentence)) continue;
    const types = typeWordsIn(sentence);
    if (!types.length) continue;
    const entries = mentions
      .filter((m) => m.start >= s0 && m.end <= s1)
      .map((m) => {
        const before = sentence.slice(0, m.start - s0);
        const after = sentence.slice(m.end - s0);
        let count: number | null = null;
        let via: 'before' | 'after' | null = null;
        const b = BEFORE_NUM.exec(before.slice(-90));
        if (b && b[2]!.length <= 70 && !/[,;:()]/.test(b[2]!)) (count = Number(b[1])), (via = 'before');
        if (count === null) {
          const a = AFTER_NUM.exec(after);
          if (a) (count = Number(a[1])), (via = 'after');
        }
        const pos = m.start - s0;
        const prev = [...types].reverse().find((t) => t.pos < pos);
        return { m, count, via, type: (prev ?? types.find((t) => t.pos >= pos))!.type };
      });
    let paired = 0;
    entries.forEach((e, i) => {
      if (e.count === null) return;
      const next = entries[i + 1];
      // "38 БПЛА над территориями Брянской, Белгородской, Курской областей": one total for a list of regions.
      if (e.via === 'before' && next && next.count === null && LIST_GAP.test(text.slice(e.m.end, next.m.start))) add(null, e.type, e.count);
      else add(e.m.id, e.type, e.count);
      paired++;
    });
    if (!paired) {
      const t = TOTAL_RE.exec(sentence);
      if (t) add(null, /ракет/i.test(t[2]!) ? 'missile' : 'uav', Number(t[1]));
    }
  }
  return [...acc.values()];
}

/* ---------- entry point ---------- */

const THREAT_ORDER: [SignalThreat, RegExp][] = [
  ['air', AIR],
  ['uav', UAV],
  ['missile', MISSILE],
  ['aviation', AVIATION],
  ['explosion', EXPLOSION],
];

export function parseSignals(rawText: string): PostSignals {
  const text = normalizeText(rawText || '');
  if (!text.trim()) return emptySignals();

  const mentions = findRegionMentions(text);
  const regions = [...new Set(mentions.map((m) => m.id))];

  const allClear = new RegExp(ALLCLEAR.source, 'iu').test(text);
  const threatText = allClear ? text.replace(ALLCLEAR, ' ') : text;
  const threats = THREAT_ORDER.filter(([, re]) => re.test(threatText)).map(([t]) => t);

  const intercepts = parseIntercepts(text, mentions);
  const summary = SUMMARY.test(text);
  const isThreatNotice =
    !allClear && threats.length > 0 && NOTICE.test(threatText) && !DRILL.test(text) && !(summary && intercepts.length > 0);

  return { threats, allClear, isThreatNotice, regions, intercepts };
}

/** Safely read a stored `signals` JSON column. */
export function readSignals(json: string | null | undefined): PostSignals {
  try {
    const v = JSON.parse(json || '{}') as Partial<PostSignals>;
    return {
      threats: Array.isArray(v.threats) ? v.threats : [],
      allClear: !!v.allClear,
      isThreatNotice: !!v.isThreatNotice,
      regions: Array.isArray(v.regions) ? v.regions : [],
      intercepts: Array.isArray(v.intercepts) ? v.intercepts : [],
    };
  } catch {
    return emptySignals();
  }
}
