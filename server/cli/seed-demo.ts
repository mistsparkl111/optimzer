// Fills a development database with synthetic demo data (alerts history, active alerts, marks).
// Usage: npm run seed:demo            (refuses to run with NODE_ENV=production unless --force)
import { db } from '../db';
import { hashPassword } from '../crypto';
import { DAY, HOUR, MIN } from '../util';
import { THREATS } from '../../shared/constants';
import { REGION_BY_ID } from '../../shared/regions';

if (process.env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error('Демо-данные не загружаются в production (добавьте --force, если уверены).');
  process.exit(1);
}

const now = Date.now();
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;

function ensureUser(email: string, name: string, plusDays: number | null, role = 'user') {
  const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number } | undefined;
  if (ex) return ex.id;
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash, role, region_id, plus_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(email, name, hashPassword('demo12345'), role, 'BEL', plusDays ? now + plusDays * DAY : null, now - 10 * DAY);
  return Number(info.lastInsertRowid);
}

const plusUser = ensureUser('plus@radar.local', 'Наблюдатель+', 30);
const freeUser = ensureUser('demo@radar.local', 'Иван', null);

// Weighted regions: frontier regions much more active, a few inland targets occasionally.
const weights: [string, number][] = [
  ['BEL', 10], ['KRS', 9], ['BRY', 9], ['VOR', 6], ['ROS', 6], ['KDA', 4], ['CR', 5], ['SEV', 4], ['ZAP', 6], ['KHE', 5], ['DPR', 5], ['LPR', 4],
  ['ORL', 4], ['LIP', 3], ['TAM', 2], ['TUL', 3], ['KLU', 3], ['SMO', 3], ['MOS', 3], ['MOW', 2], ['RYA', 2], ['VGG', 3], ['SAR', 2], ['TVE', 1],
  ['NIZ', 1], ['TA', 1], ['BA', 1], ['AST', 1], ['YAR', 1], ['LEN', 1], ['KLU', 2],
];
const bag = weights.flatMap(([id, w]) => Array(w).fill(id) as string[]).filter((id) => REGION_BY_ID.has(id));
const corridors: string[][] = [
  ['BRY', 'KLU', 'MOS', 'MOW'],
  ['KRS', 'ORL', 'TUL', 'MOS'],
  ['BEL', 'VOR', 'LIP', 'TAM'],
  ['ROS', 'VGG', 'SAR'],
  ['KHE', 'CR', 'SEV'],
  ['ZAP', 'ROS', 'KDA'],
];

const insAlert = db.prepare(
  `INSERT INTO alerts (region_id, type, source, message, started_at, updated_at, ended_at, end_reason) VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)`,
);

db.transaction(() => {
  db.prepare("DELETE FROM alerts WHERE source = 'admin' AND message LIKE '[демо]%'").run();
  // 7 days of history, night-heavy.
  for (let d = 7; d >= 0; d--) {
    const waves = 2 + Math.floor(rnd() * 4);
    for (let w = 0; w < waves; w++) {
      const hour = rnd() < 0.7 ? pick([22, 23, 0, 1, 2, 3, 4, 5]) : pick([8, 11, 14, 17, 19]);
      let t = now - d * DAY - ((now / HOUR) % 24) * HOUR + (hour - 3) * HOUR + Math.floor(rnd() * 50) * MIN;
      if (t > now - 40 * MIN) continue;
      const path = rnd() < 0.6 ? pick(corridors) : [pick(bag)];
      for (const regionId of path) {
        const type = pick(['uav', 'uav', 'uav', 'air', 'missile']) as 'uav' | 'air' | 'missile';
        const dur = (20 + rnd() * 120) * MIN;
        insAlert.run(regionId, type, '[демо] сгенерировано', t, t, Math.min(t + dur, now - MIN), 'allclear');
        t += (15 + rnd() * 50) * MIN;
      }
    }
  }
  // Active alerts right now.
  for (const [regionId, type, ago] of [
    ['BEL', 'missile', 6],
    ['KRS', 'uav', 18],
    ['BRY', 'uav', 31],
    ['ORL', 'uav', 9],
    ['ROS', 'air', 4],
  ] as const) {
    if (!REGION_BY_ID.has(regionId)) continue;
    insAlert.run(regionId, type, `[демо] ${THREATS[type].long}`, now - ago * MIN, now - ago * MIN, null, null);
  }
})();

const insReport = db.prepare(
  `INSERT INTO reports (user_id, type, lat, lon, region_id, heading, count, comment, is_plus, ttl_ms, created_at, expires_at, confirms)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
db.prepare('DELETE FROM reports WHERE comment LIKE ?').run('%(демо)%');
const marks: [number, string, number, number, string, number | null, number | null, string, number][] = [
  [plusUser, 'uav', 52.95, 34.6, 'BRY', 40, 3, 'Низко, звук мопеда (демо)', 4],
  [plusUser, 'uav', 52.6, 35.9, 'ORL', 45, 1, 'Идёт на северо-восток (демо)', 2],
  [freeUser, 'explosion', 51.6, 36.3, 'KRS', null, null, 'Слышны хлопки (демо)', 1],
  [plusUser, 'missile', 50.7, 36.9, 'BEL', 20, 1, 'След в небе (демо)', 0],
  [plusUser, 'aviation', 47.6, 39.4, 'ROS', 270, null, '(демо)', 0],
];
for (const [uid, type, lat, lon, regionId, heading, count, comment, confirms] of marks) {
  const ttl = THREATS[type as 'uav'].ttlMin * MIN;
  const created = now - Math.floor(rnd() * ttl * 0.6);
  insReport.run(uid, type, lat, lon, regionId, heading, count, comment, uid === plusUser ? 1 : 0, ttl, created, created + ttl, confirms);
}

const n = db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE message LIKE '[демо]%'").get() as { n: number };
console.log(`Демо-данные: ${n.n} тревог, ${marks.length} меток. Пользователи: plus@radar.local / demo@radar.local (пароль demo12345)`);
