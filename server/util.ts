import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { HTTPException } from 'hono/http-exception';

export const now = () => Date.now();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function fail(status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503, message: string): never {
  throw new HTTPException(status, { message });
}

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'Некорректный JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    fail(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Некорректные данные');
  }
  return r.data;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const buckets = new Map<string, number[]>();
/** Sliding-window in-memory rate limiter. Returns true when the call is allowed. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const t = Date.now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(t);
  buckets.set(key, arr);
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of buckets) if (!v.length || t - v[v.length - 1]! > DAY) buckets.delete(k);
}, HOUR).unref();

export function clientIp(c: Context): string {
  return (
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ||
    'unknown'
  );
}

/** Moscow hour (0..23) for a timestamp. */
export function mskHour(ts: number): number {
  return new Date(ts + 3 * HOUR).getUTCHours();
}
