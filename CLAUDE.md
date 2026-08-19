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
  `update-ebay-prices.yml` (eBay Browse API → `docs/data/ebay_asking_prices.json`).
  Production API access for this eBay account required an MAD
  (Marketplace Account Deletion) exemption submitted in the eBay dev
  portal (Alerts & Notifications → exemption reason "I do not persist
  eBay data") before the Production keyset would activate — already
  done as of 2026-08-19, both secrets confirmed working end-to-end.

## New Listing draft tool (worker/)

- `docs/list-card.html` calls a **Cloudflare Worker** (`worker/`), not
  GitHub Actions — this is a live backend, unlike everything else in
  this repo which is static + manual-trigger pipelines.
- Its secrets (`ANTHROPIC_API_KEY`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`)
  live in Cloudflare (`wrangler secret put`), separate from the GitHub
  Actions secrets — they are NOT shared even though two of the names
  match. Don't assume the Worker is configured just because GitHub
  Actions secrets exist.
- `docs/list-card.js` has a `WORKER_URL` constant that must be manually
  set to the deployed `*.workers.dev` URL after running `wrangler deploy`
  — check whether this still says `REPLACE_WITH_YOUR_WORKER_URL` before
  assuming the feature is live.
- As of 2026-08-19, this tool does NOT do eBay comps/pricing — that was
  tried (`worker/src/comps.js`, now deleted) but the per-card search
  was too unreliable (real listing titles don't reliably contain
  year+brand+parallel together, so it often returned zero results even
  with a broadened fallback query). The user explicitly chose to drop
  it rather than fix it further, in favor of speed: the tool now only
  does card ID + title/description. See git history before this date
  if reviving comps.
- The Worker never calls eBay's listing-creation APIs — it only
  generates a draft (title/description) for the user to copy and
  publish manually. Don't add auto-publish without the user explicitly
  asking for it; it was deliberately scoped out due to the risk of a
  bad AI-identified detail going live as a real listing. The user has
  since asked about actually saving to their eBay account as a draft
  (not published) — this is a distinct, much bigger feature requiring
  eBay's user-login OAuth flow, refresh token storage, and probably
  Cloudflare R2 for image hosting (eBay's Inventory API needs image
  URLs, not raw uploads). Scope this out explicitly with the user
  before building — don't assume "save as draft" means auto-publish,
  and don't assume it's a small addition to the current Worker.

## Gotchas

- Always trigger workflows via **Run workflow** (Actions tab), never
  **Re-run jobs** on an old run — a re-run reuses the original run's
  base commit, which can be behind `main` and cause a rejected push.
- Claude's GitHub App token cannot trigger `workflow_dispatch` runs
  (403) — ask the user to click **Run workflow** manually.
- The eBay data in `ebay_asking_prices.json` / the site's eBay section
  is **active-listing asking price**, not sold price — keep that
  distinction explicit anywhere it's surfaced.
