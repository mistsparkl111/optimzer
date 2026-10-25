export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T>(path: string, method: Method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status);
  return data;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, 'GET', undefined, signal);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, 'POST', body);
export const put = <T>(path: string, body: unknown) => api<T>(path, 'PUT', body);
export const patch = <T>(path: string, body: unknown) => api<T>(path, 'PATCH', body);
export const del = <T>(path: string, body?: unknown) => api<T>(path, 'DELETE', body);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Что-то пошло не так');
