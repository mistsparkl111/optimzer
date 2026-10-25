import { beforeAll, describe, expect, it } from 'vitest';
import { detectRegions, parseIntercepts, parseSignals } from './parse';
import { normalizeText } from './parse';

const sig = (t: string) => parseSignals(t);

describe('parseSignals: threats (RU)', () => {
  it('detects UAV danger in a region', () => {
    const s = sig('⚠️ Белгородская область: угроза атаки БПЛА! Просьба находиться в укрытиях.');
    expect(s.threats).toContain('uav');
    expect(s.regions).toEqual(['BEL']);
    expect(s.isThreatNotice).toBe(true);
    expect(s.allClear).toBe(false);
  });

  it('detects missile danger and air alert', () => {
    const s = sig('Внимание! Ракетная опасность в Курской области. Воздушная тревога. Пройдите в укрытие.');
    expect(s.threats).toEqual(expect.arrayContaining(['air', 'missile']));
    expect(s.regions).toEqual(['KRS']);
    expect(s.isThreatNotice).toBe(true);
  });

  it('recognises slang and aviation threats', () => {
    expect(sig('Над Воронежем работает ПВО, летят шахеды').threats).toContain('uav');
    expect(sig('Взлёт Ту-95 с аэродрома Оленья, угроза ракетного удара').threats).toEqual(expect.arrayContaining(['aviation', 'missile']));
    expect(sig('Угроза применения КАБ в приграничных районах').threats).toContain('aviation');
  });

  it('detects explosions', () => {
    const s = sig('В Белгороде слышны взрывы, сработала ПВО');
    expect(s.threats).toContain('explosion');
    expect(s.isThreatNotice).toBe(true);
    expect(s.regions).toEqual(['BEL']);
  });

  it('does not flag civil aviation news or neutral text', () => {
    const s = sig('Росавиация сообщила о возобновлении рейсов в Сочи. Погода в Москве ясная.');
    expect(s.threats).toEqual([]);
    expect(s.isThreatNotice).toBe(false);
    expect(s.regions).toEqual(expect.arrayContaining(['KDA', 'MOW']));
  });

  it('ignores drills', () => {
    const s = sig('Сегодня в 12:00 пройдёт учебная тревога: проверка системы оповещения БПЛА-опасности.');
    expect(s.isThreatNotice).toBe(false);
  });
});

describe('parseSignals: all clear', () => {
  it('RU: отбой воздушной тревоги', () => {
    const s = sig('Отбой воздушной тревоги в Брянской области');
    expect(s.allClear).toBe(true);
    expect(s.isThreatNotice).toBe(false);
    expect(s.threats).toEqual([]);
    expect(s.regions).toEqual(['BRY']);
  });

  it('RU: угроза миновала / режим снят', () => {
    expect(sig('Угроза атаки БПЛА миновала. Жители Белгорода могут вернуться к обычной жизни.').allClear).toBe(true);
    expect(sig('Режим беспилотной опасности в Курской области снят').allClear).toBe(true);
    expect(sig('Отмена угрозы ракетной опасности в Крыму').allClear).toBe(true);
  });

  it('UK: відбій повітряної тривоги', () => {
    const s = sig('Відбій повітряної тривоги в Бєлгородській області');
    expect(s.allClear).toBe(true);
    expect(s.regions).toEqual(['BEL']);
    expect(s.isThreatNotice).toBe(false);
  });
});

describe('parseSignals: Ukrainian texts', () => {
  it('detects UAV / missile / aviation and regions in UK spellings', () => {
    const s = sig('Група ударних безпілотників курсом на Курщину. Повітряна тривога в Брянській та Бєлгородській областях.');
    expect(s.threats).toEqual(expect.arrayContaining(['air', 'uav']));
    expect(s.regions).toEqual(expect.arrayContaining(['KRS', 'BRY', 'BEL']));
    expect(s.isThreatNotice).toBe(true);
  });

  it('matches frequently mentioned towns in UK spelling', () => {
    expect(detectRegions('Балістична загроза: Новоросійськ, Туапсе, Краснодар')).toEqual(expect.arrayContaining(['KDA']));
    expect(detectRegions('Вибухи у Криму та Севастополі')).toEqual(expect.arrayContaining(['CR', 'SEV']));
    expect(detectRegions('Дрони над Підмосков\'ям та Москвою')).toEqual(expect.arrayContaining(['MOS', 'MOW']));
    expect(detectRegions('Енгельс, Саратов, Таганрог, Липецьк, Тульська, Калузька, Смоленська, Рязань, Ярославль')).toEqual(
      expect.arrayContaining(['SAR', 'ROS', 'LIP', 'TUL', 'KLU', 'SMO', 'RYA', 'YAR']),
    );
  });

  it('UK: movement notices count as live threat notices', () => {
    const s = sig('🛵 БпЛА з акваторії Чорного моря курсом на Одещину. Реактивний БпЛА повз Балту у напрямку Вінниччини.');
    expect(s.threats).toEqual(['uav']);
    expect(s.isThreatNotice).toBe(true);
    expect(s.regions).toEqual([]); // Ukrainian oblasts are not Radar regions
  });

  it('UK: Air Force style report', () => {
    const s = sig('Ворожі ударні БпЛА з напрямку Брянської області рухаються на Київщину. Повітряна тривога. Загроза застосування КАБ.');
    expect(s.threats).toEqual(expect.arrayContaining(['air', 'uav', 'aviation']));
  });
});

describe('detectRegions', () => {
  it('distinguishes Moscow city from Moscow oblast', () => {
    expect(detectRegions('Сбито над Москвой')).toEqual(['MOW']);
    expect(detectRegions('Над Подмосковьем уничтожены 3 БПЛА')).toEqual(['MOS']);
    expect(detectRegions('в Московской области введён режим')).toEqual(['MOS']);
    expect(detectRegions('в Москве и Московской области')).toEqual(expect.arrayContaining(['MOW', 'MOS']));
  });

  it('declined forms of regions and capitals', () => {
    expect(detectRegions('над Белгородской областью')).toEqual(['BEL']);
    expect(detectRegions('в Курске и Курской области')).toEqual(['KRS']);
    expect(detectRegions('над Ростовом-на-Дону')).toEqual(['ROS']);
    expect(detectRegions('Орёл, Орловская область')).toEqual(['ORL']);
    expect(detectRegions('в Туле и Тульской области')).toEqual(['TUL']);
    expect(detectRegions('в Нижнем Новгороде')).toEqual(['NIZ']);
    expect(detectRegions('в Великом Новгороде')).toEqual(['NGR']);
    expect(detectRegions('в Республике Крым и Севастополе')).toEqual(expect.arrayContaining(['CR', 'SEV']));
    expect(detectRegions('в ДНР и ЛНР')).toEqual(['DPR', 'LPR']);
  });

  it('avoids common false positives', () => {
    expect(detectRegions('Владимир Путин провёл совещание')).toEqual([]);
    expect(detectRegions('Президент Владимир Зеленский заявил')).toEqual([]);
    expect(detectRegions('твёрдо заявил, что кома не будет')).toEqual([]);
    expect(detectRegions('Крымск — город в Краснодарском крае')).toEqual(['KDA']);
    expect(detectRegions('Центр Кировограда')).toEqual([]);
    expect(detectRegions('грозный противник')).toEqual([]);
    expect(detectRegions('Шахты затоплены, рабочие эвакуированы')).toEqual([]);
  });

  it('keeps Yamalo-Nenets apart from Nenets', () => {
    expect(detectRegions('Ямало-Ненецкий автономный округ')).toEqual(['YAN']);
    expect(detectRegions('Ненецкий автономный округ')).toEqual(['NEN']);
  });

  it('is case/ё insensitive and deduplicates', () => {
    expect(detectRegions('БЕЛГОРОД белгород Белгород')).toEqual(['BEL']);
    expect(normalizeText('Орёл ЁЖ')).toBe('Орел ЕЖ');
  });
});

describe('parseIntercepts', () => {
  it('parses a MoD-style report with a per-region breakdown', () => {
    const text =
      'В течение прошедшей ночи дежурными средствами ПВО перехвачены и уничтожены 23 украинских беспилотных летательных аппарата самолетного типа: ' +
      '12 – над территорией Брянской области, 6 – над территорией Курской области, 3 – над территорией Белгородской области, 2 – над акваторией Азовского моря.';
    const s = sig(text);
    const by = Object.fromEntries(s.intercepts.map((i) => [i.regionId, i.count]));
    expect(by).toEqual({ BRY: 12, KRS: 6, BEL: 3 });
    expect(s.intercepts.every((i) => i.type === 'uav')).toBe(true);
    expect(s.regions).toEqual(expect.arrayContaining(['BRY', 'KRS', 'BEL']));
    expect(s.isThreatNotice).toBe(false); // night summary, not a live notice
  });

  it('parses the "region – count" form and several types', () => {
    const r = parseIntercepts(
      'Системой ПВО сбиты 5 ракет «Нептун» и уничтожены БПЛА: над Курской областью – 8, над Брянской областью – 4.'.replace(/ё/g, 'е'),
    );
    expect(r).toEqual(expect.arrayContaining([{ regionId: 'KRS', count: 8, type: 'uav' }, { regionId: 'BRY', count: 4, type: 'uav' }]));
  });

  it('parses "N БПЛА над <region>" and ignores clock times', () => {
    const r = parseIntercepts('В 14:05 уничтожено 4 БПЛА над Воронежской областью и 2 БПЛА над Липецкой областью.');
    expect(r).toEqual(expect.arrayContaining([{ regionId: 'VOR', count: 4, type: 'uav' }, { regionId: 'LIP', count: 2, type: 'uav' }]));
    expect(r.find((i) => i.regionId === 'VOR')!.count).toBe(4);
  });

  it('treats a number followed by a list of regions as an unattributed total (real MoD wording)', () => {
    const s = sig(
      'В течение дня в период с 8.00 до 20.00 мск дежурными силами ПВО перехвачены и уничтожены 38 украинских беспилотных летательных средств над территориями ' +
        'Брянской, Белгородской, Курской, Орловской, Пермской, Смоленской, Тверской областей.',
    );
    expect(s.intercepts).toEqual([{ regionId: null, count: 38, type: 'uav' }]);
    expect(s.regions).toEqual(['BRY', 'BEL', 'KRS', 'ORL', 'PER', 'SMO', 'TVE']);
    expect(s.isThreatNotice).toBe(false);
  });

  it('Ukrainian Air Force style', () => {
    const r = parseIntercepts('Протягом ночі збито 17 ворожих БпЛА над Курською областю.');
    expect(r).toEqual([{ regionId: 'KRS', count: 17, type: 'uav' }]);
  });

  it('keeps an unattributed national total as regionId null', () => {
    const r = parseIntercepts('Дежурными средствами ПВО уничтожены 31 беспилотный летательный аппарат самолетного типа.');
    expect(r).toEqual([{ regionId: null, count: 31, type: 'uav' }]);
  });

  it('returns nothing for texts without intercept verbs', () => {
    expect(parseIntercepts('Над Курской областью летают БПЛА – 5 штук')).toEqual([]);
  });
});

describe('telegram / rss parsing', () => {
  it('normalises Telegram handles', async () => {
    const { normalizeTelegramHandle } = await import('./telegram');
    for (const h of ['@mod_russia', 'mod_russia', 't.me/mod_russia', 'https://t.me/s/mod_russia', 'https://t.me/mod_russia/1234?single']) {
      expect(normalizeTelegramHandle(h)).toBe('mod_russia');
    }
    expect(normalizeTelegramHandle('a b')).toBeNull();
    expect(normalizeTelegramHandle('')).toBeNull();
  });

  it('parses the t.me/s HTML widget', async () => {
    const { parseTelegramHtml } = await import('./telegram');
    const html = `
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="mod_russia/100">
        <div class="tgme_widget_message_text js-message_text" dir="auto">Белгородская область:<br/>угроза БПЛА &amp; ракет!<br>Будьте осторожны</div>
        <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/mod_russia/100"><time datetime="2026-10-25T10:30:00+00:00" class="time">13:30</time></a></div>
      </div></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="mod_russia/101">
        <div class="tgme_widget_message_photo_wrap"></div>
        <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date"><time datetime="2026-10-25T10:40:00+00:00"></time></a></div>
      </div></div>`;
    const posts = parseTelegramHtml(html);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ externalId: 'mod_russia/100', url: 'https://t.me/mod_russia/100', postedAt: Date.parse('2026-10-25T10:30:00Z') });
    expect(posts[0]!.text).toBe('Белгородская область:\nугроза БПЛА & ракет!\nБудьте осторожны');
  });

  it('parses RSS 2.0 and Atom', async () => {
    const { parseFeed } = await import('./rss');
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>Отбой тревоги</title><link>https://ex.ru/1</link><guid isPermaLink="false">g-1</guid><pubDate>Sun, 25 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>В <b>Курской</b> области &laquo;отбой&raquo;</p>]]></description></item></channel></rss>`;
    const a = parseFeed(rss, Date.parse('2026-10-25T12:00:00Z'));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ externalId: 'g-1', url: 'https://ex.ru/1', postedAt: Date.parse('2026-10-25T10:00:00Z') });
    expect(a[0]!.text).toContain('Отбой тревоги');
    expect(a[0]!.text).toContain('В Курской области «отбой»');

    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title>Заголовок</title>
      <link rel="alternate" href="https://ex.ru/a"/><updated>2026-10-25T09:00:00Z</updated><summary>Текст записи</summary></entry></feed>`;
    const b = parseFeed(atom);
    expect(b[0]).toMatchObject({ externalId: 'tag:1', url: 'https://ex.ru/a', text: 'Заголовок\nТекст записи' });
  });
});

describe('auto-alerts (ingest)', () => {
  const NOW = Date.now();
  type Mods = { db: typeof import('../../db').db; I: typeof import('./ingest') };
  let m: Mods;
  const source = (over: Record<string, unknown> = {}) => ({
    id: 1, name: 'Губернатор', type: 'telegram', handle: 'gov', lang: 'ru', kind: 'official', side: 'ru', region_id: 'BEL',
    auto_alerts: 1, trust: 0.9, enabled: 1, poll_seconds: 120, last_fetch_at: null, last_error: null, last_post_at: null, created_at: 0, ...over,
  }) as import('./ingest').SourceRow;
  const post = (id: string, text: string, ago: number) => ({ externalId: id, url: null, text, postedAt: NOW - ago });
  const active = () => m.db.prepare('SELECT region_id, type, ended_at, end_reason FROM alerts ORDER BY id').all() as { region_id: string; type: string; ended_at: number | null; end_reason: string | null }[];

  beforeAll(async () => {
    const { vi } = await import('vitest');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    vi.stubEnv('DB_FILE', ':memory:');
    vi.stubEnv('DATA_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'radar-src-')));
    m = { db: (await import('../../db')).db, I: await import('./ingest') };
    m.db.prepare("INSERT INTO sources (id, name, type, handle, created_at) VALUES (1, 'Губернатор', 'telegram', 'gov', 0)").run();
  });

  it('only fresh posts of enabled official auto-alert sources create and close alerts', () => {
    const { I } = m;
    I.ingestPosts(source(), [post('old', 'Угроза атаки БПЛА в Белгородской области', 2 * 3600_000)]);
    expect(active()).toHaveLength(0); // backlog never alerts
    I.ingestPosts(source({ enabled: 0 }), [post('dis', 'Угроза атаки БПЛА в Белгородской области', 60_000)]);
    expect(active()).toHaveLength(0); // disabled
    I.ingestPosts(source({ kind: 'media' }), [post('media', 'Угроза атаки БПЛА в Белгородской области', 60_000)]);
    expect(active()).toHaveLength(0); // not official
    expect(I.ingestPosts(source(), [post('fresh', 'Угроза атаки БПЛА и ракетная опасность. Просьба находиться в укрытиях.', 120_000)])).toBe(1);
    expect(active().map((a) => `${a.region_id}:${a.type}`)).toEqual(['BEL:uav', 'BEL:missile']);
    expect(I.ingestPosts(source(), [post('fresh', 'Угроза атаки БПЛА и ракетная опасность. Просьба находиться в укрытиях.', 120_000)])).toBe(0); // dedupe
    I.ingestPosts(source(), [post('clear', 'Отбой воздушной тревоги', 30_000)]);
    expect(active().every((a) => a.ended_at && a.end_reason === 'allclear')).toBe(true);
  });

  it('unbound sources need 1–3 detected regions', () => {
    const { I } = m;
    const before = active().length;
    I.ingestPosts(source({ region_id: null }), [post('none', 'Угроза атаки БПЛА!', 30_000)]);
    I.ingestPosts(source({ region_id: null }), [post('many', 'Угроза БПЛА в Курской, Брянской, Воронежской и Липецкой областях', 30_000)]);
    expect(active()).toHaveLength(before);
    I.ingestPosts(source({ region_id: null }), [post('two', 'Угроза БПЛА в Курской и Брянской областях', 30_000)]);
    expect(active().slice(before).map((a) => a.region_id).sort()).toEqual(['BRY', 'KRS'].sort());
  });
});
