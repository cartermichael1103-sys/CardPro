# CardPro / Sports Card Break Value Index

Static site (GitHub Pages, served from `/docs`) tracking sports card
break-value data. See `README.md` for full setup/architecture.

## GitHub repo secrets already configured (as of 2026-07-09)

These are set in Settings → Secrets and variables → Actions. Their
values are not readable via API by anyone, including Claude — don't
re-ask the user to create them, and don't attempt to fetch their
values. Just trigger the relevant workflow.

- `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` — used by `update-data.yml`
  (Google Sheet → `docs/data/players.json`)
- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` — used by
  `update-ebay-prices.yml` (eBay Browse API → `docs/data/ebay_asking_prices.json`)

## Gotchas

- Always trigger workflows via **Run workflow** (Actions tab), never
  **Re-run jobs** on an old run — a re-run reuses the original run's
  base commit, which can be behind `main` and cause a rejected push.
- Claude's GitHub App token cannot trigger `workflow_dispatch` runs
  (403) — ask the user to click **Run workflow** manually.
- The eBay data is **active-listing asking price**, not sold price —
  keep that distinction explicit anywhere it's surfaced.
