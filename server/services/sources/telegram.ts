import { parse } from 'node-html-parser';

export interface RawPost {
  externalId: string;
  url: string | null;
  text: string;
  postedAt: number;
}

export const USER_AGENT = 'Mozilla/5.0 (compatible; RadarRussiaBot/1.0; +civilian-early-warning)';
export const FETCH_TIMEOUT_MS = 20_000;

/** Accepts `@name`, `name`, `t.me/name`, `https://t.me/s/name`; returns the bare username or null. */
export function normalizeTelegramHandle(raw: string): string | null {
  let h = raw.trim();
  h = h.replace(/^https?:\/\//i, '').replace(/^(?:www\.)?(?:t|telegram)\.me\//i, '');
  h = h.replace(/^s\//i, '').replace(/^@/, '');
  h = h.split(/[/?#]/)[0] ?? '';
  return /^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(h) ? h : null;
}

/** HTML fragment → plain text with line breaks preserved and entities decoded. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '');
  return parse(`<div>${withBreaks}</div>`)
    .text.replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse the `https://t.me/s/<handle>` preview page. */
export function parseTelegramHtml(html: string): RawPost[] {
  const root = parse(html);
  const out: RawPost[] = [];
  for (const el of root.querySelectorAll('.tgme_widget_message[data-post]')) {
    const dataPost = el.getAttribute('data-post');
    if (!dataPost) continue;
    const textEl = el.querySelector('.tgme_widget_message_text');
    const text = textEl ? htmlToText(textEl.innerHTML) : '';
    if (!text) continue;
    const datetime = el.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime');
    const ts = datetime ? Date.parse(datetime) : NaN;
    if (!Number.isFinite(ts)) continue;
    out.push({ externalId: dataPost, url: `https://t.me/${dataPost}`, text, postedAt: ts });
  }
  return out;
}

export async function fetchTelegram(handle: string): Promise<RawPost[]> {
  const name = normalizeTelegramHandle(handle);
  if (!name) throw new Error('Некорректное имя Telegram-канала');
  let res: Response;
  try {
    res = await fetch(`https://t.me/s/${name}`, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ru,uk;q=0.8,en;q=0.5', accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(timeout ? 'Telegram не ответил за 20 секунд' : 'Не удалось подключиться к Telegram');
  }
  if (res.status === 404) throw new Error('Канал не найден');
  if (!res.ok) throw new Error(`Telegram вернул ошибку ${res.status}`);
  const html = await res.text();
  const posts = parseTelegramHtml(html);
  if (!posts.length) {
    const hasWidget = html.includes('tgme_channel_history') || html.includes('tgme_widget_message');
    throw new Error(
      hasWidget
        ? 'В канале нет текстовых постов'
        : 'Канал не найден или у него отключён публичный просмотр (t.me/s/…)',
    );
  }
  return posts;
}
