import { db } from '../../db';
import { decrypt } from '../../crypto';

export interface ProviderRow {
  id: number;
  name: string;
  base_url: string;
  api_key_enc: string | null;
  json_mode: number;
  enabled: number;
  created_at: number;
}

export interface ModelRow {
  id: number;
  provider_id: number;
  model: string;
  label: string;
  enabled: number;
  is_default: number;
  temperature: number;
  max_tokens: number;
  created_at: number;
}

export interface UsableModel extends ModelRow {
  provider_name: string;
  base_url: string;
  api_key_enc: string | null;
  json_mode: number;
}

/** Local endpoints (Ollama, vLLM on localhost) work without an API key. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === 'host.docker.internal';
  } catch {
    return false;
  }
}

export const providerUsable = (p: Pick<ProviderRow, 'api_key_enc' | 'base_url'>) => !!decrypt(p.api_key_enc) || isLocalUrl(p.base_url);

export function usableModels(): UsableModel[] {
  const rows = db
    .prepare(
      `SELECT m.*, p.name AS provider_name, p.base_url, p.api_key_enc, p.json_mode
       FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY m.is_default DESC, m.id`,
    )
    .all() as UsableModel[];
  return rows.filter(providerUsable);
}

export const defaultModel = (): UsableModel | null => usableModels()[0] ?? null;

export const getUsableModel = (id: number): UsableModel | null => usableModels().find((m) => m.id === id) ?? null;

export const isAiConfigured = (): boolean => usableModels().length > 0;
