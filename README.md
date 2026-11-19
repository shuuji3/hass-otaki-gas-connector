# 🔥 hass-otaki-gas-connector

**hass-otaki-gas-connector** scrapes gas usage and billing data from "マイ大多喜ガス" (https://www.re-gp.jp/otakigas/) and syncs it into SQLite, for later use with Home Assistant.

the portal is a stateful ASP.NET WebForms app, so the script performs a real login (viewstate + `__AntiXsrfToken`) and reads the rendered pages.

## requirements

- node.js (v22+ for the built-in `node:sqlite`)
- pnpm
- a マイ大多喜ガス account. the site is only available **07:00–02:00 JST** (!).

## setup

```sh
pnpm install
cp .env.example .env   # then fill ID / PASSWORD
```

create your `.env`:

```
ID=your-login-id
PASSWORD=your-password
# DB_PATH=data.db      # optional
```

## usage

```sh
pnpm sync        # login, scrape, upsert into data.db
pnpm typecheck   # tsc --noEmit
```

the run is idempotent: rows are inserted with `INSERT OR IGNORE` keyed on the billing month, so re-running never overwrites data already stored.

execution example:
```
db: /path/to/data.db
billing grid: 13 rows -> 13 inserted, 0 skipped
```

## data source

| page | granularity | fields |
| --- | --- | --- |
| `GasBilledAmount` | monthly | 請求番号, 請求年月, 検針年月日, ご使用量, ご使用日数, 請求金額, 支払状況, … |

## schema

```sql
CREATE TABLE IF NOT EXISTS gas_usage (
  seikyu_ym    TEXT PRIMARY KEY,  -- 検針年月 / 請求年月 as YYYYMM
  usage_m3     REAL,              -- ご使用量 (m3)
  usage_days   INTEGER,           -- ご使用日数
  amount_yen   INTEGER,           -- 請求金額 (円)
  reading_date TEXT,              -- 検針年月日 (ISO), from billing grid
  billing_no   TEXT,              -- 請求番号, from billing grid
  customer_no  TEXT,              -- お客様番号
  kind_code    TEXT,              -- ご利用種類
  kind_name    TEXT,              -- ご利用種類名称
  paid_status  TEXT,              -- お支払状況
  fetched_at   TEXT NOT NULL      -- ISO timestamp
);
```

## notes / troubleshooting

- `login failed` — outside the 07:00–02:00 JST window, or wrong `ID`/`PASSWORD`.
- the site uses Shift_JIS for its CSV export (not used here) and full-width units (`ｍ３`); HTML parsing handles this.
- credentials are read only from `.env` and never written to the DB.
