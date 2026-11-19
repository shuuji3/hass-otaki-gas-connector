import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const BASE = 'https://www.re-gp.jp/otakigas';
const ACCOUNT_URL = `${BASE}/Account/`;
const BILLED_URL = `${BASE}/GasBilledAmount`;

/** one row per 検針年月 (billing month), from the billing list grid. */
type GasRow = {
  seikyuYm: string;
  usageM3: number | null;
  usageDays: number | null;
  amountYen: number | null;
  readingDate: string | null;
  billingNo: string | null;
  customerNo: string | null;
  kindCode: string | null;
  kindName: string | null;
  paidStatus: string | null;
};

const loadEnv = (path: string): Record<string, string> => {
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return env;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
};

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

const cellsOf = (rowHtml: string): string[] =>
  [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => stripTags(m[1]));

const hiddenValue = (html: string, name: string): string => {
  const re = new RegExp(`name="${name}"[^>]*value="([^"]*)"`);
  const m = html.match(re);
  return m ? m[1] : '';
};

/** "2026/11" or "202611" -> "202611" */
const toYyyyMm = (s: string): string => s.replace(/\D/g, '').slice(0, 6);

/** "2026/11/18" -> "2026-11-18" */
const toIsoDate = (s: string): string => {
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) {
    return s;
  }
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
};

const toNumber = (s: string): number | null => {
  const t = s.replace(/[^0-9.-]/g, '');
  if (t === '' || t === '-') {
    return null;
  }
  return Number(t);
};

class Client {
  #cookies = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie !== '') {
      headers.set('cookie', cookie);
    }
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '') {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
    return res;
  }

  async get(url: string): Promise<Response> {
    return this.request(url);
  }

  async postForm(url: string, form: URLSearchParams): Promise<Response> {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }
}

const login = async (client: Client, id: string, password: string): Promise<void> => {
  const res = await client.get(ACCOUNT_URL);
  const html = await res.text();
  const form = new URLSearchParams({
    __EVENTTARGET: 'ctl00$MainContent$btnLogin',
    __EVENTARGUMENT: '',
    __VIEWSTATE: hiddenValue(html, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: hiddenValue(html, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION: hiddenValue(html, '__EVENTVALIDATION'),
    'ctl00$MainContent$txtLoginId': id,
    'ctl00$MainContent$txtPassword': password,
  });
  const posted = await client.postForm(ACCOUNT_URL, form);
  const location = posted.headers.get('location') ?? '';
  if (posted.status !== 302 || !location.includes('GasMenu')) {
    throw new Error(
      `login failed (status ${posted.status}). available from 07:00-02:00 JST; check ID/PASSWORD.`,
    );
  }
  // follow so the session settles before hitting the data pages.
  await client.get(new URL(location, ACCOUNT_URL).href);
};

/** parse the billing list grid (請求番号, 検針年月日, 支払状況 included). */
const parseBillingGrid = (html: string): GasRow[] => {
  const table = html.match(
    /<table[^>]*id="MainContent_gvBilledAmount"[^>]*>([\s\S]*?)<\/table>/,
  );
  if (!table) {
    throw new Error('billing grid not found (session expired?)');
  }
  const rows: GasRow[] = [];
  for (const m of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = cellsOf(m[1]);
    if (c.length !== 13 || !/^\d+$/.test(c[0])) {
      continue;
    }
    rows.push({
      seikyuYm: toYyyyMm(c[2]),
      usageM3: toNumber(c[8]),
      usageDays: toNumber(c[9]),
      amountYen: toNumber(c[10]),
      readingDate: c[7] === '' ? null : toIsoDate(c[7]),
      billingNo: c[3] === '' ? null : c[3],
      customerNo: c[0],
      kindCode: c[1],
      kindName: c[4],
      paidStatus: c[11] === '' ? null : c[11],
    });
  }
  return rows;
};

const openDb = (path: string): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS gas_usage (
      seikyu_ym    TEXT PRIMARY KEY,
      usage_m3     REAL,
      usage_days   INTEGER,
      amount_yen   INTEGER,
      reading_date TEXT,
      billing_no   TEXT,
      customer_no  TEXT,
      kind_code    TEXT,
      kind_name    TEXT,
      paid_status  TEXT,
      fetched_at   TEXT NOT NULL
    );
  `);
  return db;
};

/** insert rows; existing months are never overwritten. */
const save = (db: DatabaseSync, rows: GasRow[]): { inserted: number; skipped: number } => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO gas_usage
      (seikyu_ym, usage_m3, usage_days, amount_yen, reading_date, billing_no,
       customer_no, kind_code, kind_name, paid_status, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fetchedAt = new Date().toISOString();
  let inserted = 0;
  for (const r of rows) {
    const result = insert.run(
      r.seikyuYm,
      r.usageM3,
      r.usageDays,
      r.amountYen,
      r.readingDate,
      r.billingNo,
      r.customerNo,
      r.kindCode,
      r.kindName,
      r.paidStatus,
      fetchedAt,
    );
    inserted += Number(result.changes);
  }
  return { inserted, skipped: rows.length - inserted };
};

const main = async (): Promise<void> => {
  const env = loadEnv(new URL('./.env', import.meta.url).pathname);
  const id = env.ID ?? '';
  const password = env.PASSWORD ?? '';
  if (id === '' || password === '') {
    throw new Error('ID/PASSWORD missing. copy .env.example to .env and fill them in.');
  }
  const dbPath = env.DB_PATH ?? new URL('./data.db', import.meta.url).pathname;

  const client = new Client();
  await login(client, id, password);

  const billedHtml = await (await client.get(BILLED_URL)).text();
  const rows = parseBillingGrid(billedHtml);

  const db = openDb(dbPath);
  const { inserted, skipped } = save(db, rows);
  db.close();

  console.log(`db: ${dbPath}`);
  console.log(`billing grid: ${rows.length} rows -> ${inserted} inserted, ${skipped} skipped`);
};

await main();
