import { XMLParser } from 'fast-xml-parser';
import { FETCH_TIMEOUT_MS, htmlToText, USER_AGENT, type RawPost } from './telegram';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  trimValues: true,
});

type Node = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** XML text node → string (handles `{ '#text': … }` objects produced for elements with attributes). */
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const t = (v as Node)['#text'];
    if (t !== undefined) return str(t);
    return '';
  }
  return '';
}

function atomLink(link: unknown): string {
  const links = arr(link as Node | Node[]);
  const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) ?? links[0];
  if (!alt) return '';
  return typeof alt === 'string' ? alt : str((alt as Node)['@_href']);
}

/** Parse an RSS 2.0 / Atom feed into posts. */
export function parseFeed(source: string, now = Date.now()): RawPost[] {
  const doc = xml.parse(source) as Node;
  const items: { id: string; url: string; title: string; body: string; date: string }[] = [];

  const channel = (doc.rss as Node | undefined)?.channel as Node | undefined;
  if (channel) {
    for (const it of arr(channel.item as Node | Node[])) {
      items.push({
        id: str(it.guid) || str(it.link) || str(it.title),
        url: str(it.link),
        title: str(it.title),
        body: str(it['content:encoded']) || str(it.description),
        date: str(it.pubDate) || str(it['dc:date']),
      });
    }
  }
  const feed = doc.feed as Node | undefined;
  if (feed) {
    for (const it of arr(feed.entry as Node | Node[])) {
      items.push({
        id: str(it.id) || atomLink(it.link) || str(it.title),
        url: atomLink(it.link),
        title: str(it.title),
        body: str(it.content) || str(it.summary),
        date: str(it.published) || str(it.updated),
      });
    }
  }
  const rdf = doc['rdf:RDF'] as Node | undefined;
  if (rdf) {
    for (const it of arr(rdf.item as Node | Node[])) {
      items.push({ id: str(it.link) || str(it.title), url: str(it.link), title: str(it.title), body: str(it.description), date: str(it['dc:date']) });
    }
  }

  const out: RawPost[] = [];
  for (const it of items) {
    const title = htmlToText(it.title);
    const body = htmlToText(it.body);
    const text = body && body !== title && !body.startsWith(title) ? `${title}\n${body}`.trim() : body || title;
    if (!text || !it.id) continue;
    const t = it.date ? Date.parse(it.date) : NaN;
    out.push({ externalId: it.id.slice(0, 500), url: it.url || null, text: text.slice(0, 4000), postedAt: Number.isFinite(t) ? Math.min(t, now) : now });
  }
  return out;
}

export function normalizeFeedUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchRss(url: string): Promise<RawPost[]> {
  const u = normalizeFeedUrl(url);
  if (!u) throw new Error('Некорректный адрес RSS-ленты');
  let res: Response;
  try {
    res = await fetch(u, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(timeout ? 'Лента не ответила за 20 секунд' : 'Не удалось подключиться к ленте');
  }
  if (!res.ok) throw new Error(`Лента вернула ошибку ${res.status}`);
  let posts: RawPost[];
  try {
    posts = parseFeed(await res.text());
  } catch {
    throw new Error('Не удалось разобрать RSS/Atom');
  }
  if (!posts.length) throw new Error('В ленте нет записей');
  return posts;
}
