// Minimal OpenAI-compatible chat client (works with OpenAI, OpenRouter, DeepSeek, Ollama, vLLM, …).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  jsonMode: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  tokens: number | null;
  finishReason: string | null;
  latencyMs: number;
}

export class LlmError extends Error {}

export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

function describeHttp(status: number, text: string): string {
  let detail = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === 'string' ? j.error : j.error?.message) || j.message || text;
  } catch {
    /* plain text */
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 240);
  const head =
    status === 401 || status === 403
      ? 'Провайдер отклонил ключ API'
      : status === 404
        ? 'Адрес или модель не найдены у провайдера'
        : status === 408 || status === 504
          ? 'Провайдер не успел ответить'
          : status === 429
            ? 'Превышен лимит запросов или баланс у провайдера'
            : status >= 500
              ? 'Ошибка на стороне провайдера'
              : 'Провайдер отклонил запрос';
  return `${head} (HTTP ${status})${detail ? `: ${detail}` : ''}`;
}

function contentOf(message: unknown): string {
  const c = (message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('');
  return '';
}

export async function chatCompletion(o: ChatOptions): Promise<ChatResult> {
  const timeoutMs = o.timeoutMs ?? 150_000;
  const payload: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    temperature: o.temperature,
    max_tokens: o.maxTokens,
  };
  if (o.jsonMode) payload.response_format = { type: 'json_object' };
  const started = Date.now();

  // Providers disagree on a few parameters; adapt up to three times based on the 400 message.
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(joinUrl(o.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new LlmError(timeout ? `Провайдер не ответил за ${Math.round(timeoutMs / 1000)} с` : 'Не удалось подключиться к провайдеру ИИ');
    }
    const text = await res.text();
    if (!res.ok) {
      const lower = text.toLowerCase();
      if (res.status === 400 || res.status === 422) {
        if ('response_format' in payload && lower.includes('response_format')) {
          delete payload.response_format;
          continue;
        }
        if ('max_tokens' in payload && lower.includes('max_completion_tokens')) {
          payload.max_completion_tokens = payload.max_tokens;
          delete payload.max_tokens;
          continue;
        }
        if ('temperature' in payload && lower.includes('temperature')) {
          delete payload.temperature;
          continue;
        }
      }
      throw new LlmError(describeHttp(res.status, text));
    }
    let data: { choices?: { message?: unknown; finish_reason?: string }[]; usage?: { total_tokens?: number } };
    try {
      data = JSON.parse(text);
    } catch {
      throw new LlmError('Провайдер вернул не JSON — проверьте base URL (он должен оканчиваться на /v1)');
    }
    const choice = data.choices?.[0];
    const content = contentOf(choice?.message);
    if (!content.trim()) throw new LlmError('Модель вернула пустой ответ');
    return { content, tokens: data.usage?.total_tokens ?? null, finishReason: choice?.finish_reason ?? null, latencyMs: Date.now() - started };
  }
  throw new LlmError('Провайдер не принял параметры запроса');
}

export async function listRemoteModels(baseUrl: string, apiKey: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(joinUrl(baseUrl, '/models'), {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new LlmError(timeout ? 'Провайдер не ответил за 15 секунд' : 'Не удалось подключиться к провайдеру');
  }
  const text = await res.text();
  if (!res.ok) throw new LlmError(describeHttp(res.status, text));
  try {
    const j = JSON.parse(text) as { data?: ({ id?: string; name?: string } | string)[]; models?: ({ id?: string; name?: string } | string)[] };
    const ids = (j.data ?? j.models ?? []).map((m) => (typeof m === 'string' ? m : (m.id ?? m.name ?? ''))).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch {
    throw new LlmError('Провайдер вернул не JSON со списком моделей');
  }
}

/* ---------- JSON extraction ---------- */

/** Close a JSON document that was cut off by the token limit: drop the unfinished tail, close brackets. */
export function repairTruncatedJson(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let safe = -1; // last index after which the document can be closed
  let safeStack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      safe = i + 1;
      safeStack = [...stack];
    } else if (ch === ',' && stack.length) {
      safe = i;
      safeStack = [...stack];
    }
  }
  if (safe < 0) return s;
  return s.slice(0, safe).replace(/,\s*$/, '') + [...safeStack].reverse().join('');
}

/** Pull a JSON object out of a model reply: strips ``` fences, takes the outermost {...}, repairs truncation. */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1]!.trim();
  const start = t.indexOf('{');
  if (start < 0) throw new LlmError('В ответе модели нет JSON');
  const end = t.lastIndexOf('}');
  const candidate = end > start ? t.slice(start, end + 1) : t.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(repairTruncatedJson(t.slice(start)));
  } catch {
    throw new LlmError('Не удалось разобрать JSON из ответа модели');
  }
}
