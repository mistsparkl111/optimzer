import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './env';

export const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'radar.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    region_id TEXT,
    extra_regions TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    plus_until INTEGER,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Official region-level alerts (admin or official sources)
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    region_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id INTEGER,
    source_post_id INTEGER,
    message TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    created_by INTEGER
  );
  CREATE INDEX alerts_active ON alerts(ended_at, region_id);
  CREATE INDEX alerts_started ON alerts(started_at);
  CREATE INDEX alerts_region_started ON alerts(region_id, started_at);

  -- Marks placed by people
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    region_id TEXT,
    heading REAL,
    count INTEGER,
    comment TEXT,
    is_plus INTEGER NOT NULL DEFAULT 0,
    ttl_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    confirms INTEGER NOT NULL DEFAULT 0,
    dismisses INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    expired_notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX reports_active ON reports(removed, expires_at);
  CREATE INDEX reports_user ON reports(user_id, created_at);
  CREATE INDEX reports_region ON reports(region_id, created_at);

  CREATE TABLE report_votes (
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (report_id, user_id)
  );

  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    device_id TEXT,
    regions TEXT NOT NULL DEFAULT '[]',
    prefs TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    fail_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- News / Telegram / RSS sources for the AI and auto-alerts
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    handle TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'ru',
    kind TEXT NOT NULL DEFAULT 'media',
    side TEXT NOT NULL DEFAULT 'ru',
    region_id TEXT,
    auto_alerts INTEGER NOT NULL DEFAULT 0,
    trust REAL NOT NULL DEFAULT 0.5,
    enabled INTEGER NOT NULL DEFAULT 1,
    poll_seconds INTEGER NOT NULL DEFAULT 300,
    last_fetch_at INTEGER,
    last_error TEXT,
    last_post_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE source_posts (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    url TEXT,
    text TEXT NOT NULL,
    posted_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    signals TEXT NOT NULL DEFAULT '{}',
    UNIQUE (source_id, external_id)
  );
  CREATE INDEX source_posts_time ON source_posts(posted_at);

  CREATE TABLE ai_providers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT,
    json_mode INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE ai_models (
    id INTEGER PRIMARY KEY,
    provider_id INTEGER NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    temperature REAL NOT NULL DEFAULT 0.2,
    max_tokens INTEGER NOT NULL DEFAULT 4000,
    created_at INTEGER NOT NULL,
    UNIQUE (provider_id, model)
  );

  CREATE TABLE forecasts (
    id INTEGER PRIMARY KEY,
    model_id INTEGER,
    model_label TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    horizon_from INTEGER NOT NULL,
    horizon_to INTEGER NOT NULL,
    data TEXT NOT NULL,
    error TEXT,
    tokens INTEGER,
    eval TEXT,
    debug TEXT
  );
  CREATE INDEX forecasts_model ON forecasts(model_id, created_at);

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT UNIQUE,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    applied INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX payments_user ON payments(user_id, created_at);
  `,
];

export function migrate() {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

migrate();

export type Row = Record<string, unknown>;

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: 'user' | 'moderator' | 'admin';
  region_id: string | null;
  extra_regions: string;
  settings: string;
  plus_until: number | null;
  banned: number;
  created_at: number;
}
