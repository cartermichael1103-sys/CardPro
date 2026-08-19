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
- As of 2026-08-19, the Worker CAN save a real (unpublished) eBay Offer
  to the user's account via `/api/save-draft` — built after the user
  explicitly confirmed they wanted this, not just copy-paste drafts.
  It still never calls eBay's `publishOffer` — that stays a manual
  step in Seller Hub. Don't add auto-publish without the user
  explicitly asking for it again; the risk (bad AI-identified detail
  going live as a real, binding listing) is why publish was kept out
  even when the rest of the pipeline was built.
- This eBay-write feature needs three additional pieces beyond the
  original card-ID tool, all provisioned in the user's own accounts
  (not mine): a KV namespace (`EBAY_TOKENS`, stores the refresh token
  + short-lived OAuth CSRF state), an R2 bucket (`CARD_IMAGES`, hosts
  photos publicly since eBay's Inventory API needs image URLs, not
  raw uploads), and an eBay RuName (OAuth redirect registration under
  "User Tokens (eBay Sign-in)" in the dev portal). `wrangler.toml` has
  placeholder values (`REPLACE_WITH_...`) for the KV id, R2 public
  URL, and RuName until the user provisions and fills these in —
  check for those placeholders before assuming this feature is live,
  same as the `WORKER_URL` check below.
- `getBusinessPolicies()` in `ebay-listing.js` requires the seller
  account to already have fulfillment + return policies configured
  (Seller Hub → Account → Business Policies) — this tool can't create
  those, and `/api/save-draft` will fail with a clear error if they're
  missing.
- I built the eBay OAuth/Inventory/Offer integration from training
  knowledge of eBay's Sell APIs, without being able to test it against
  the real API before the user tries it live (unlike the Browse API
  work, which got debugged against real responses). Expect a
  debugging round once real eBay error messages come back — likely
  candidates: category-specific `condition` enum values (I used
  `USED_GOOD`/`USED_EXCELLENT` as a guess, trading cards may need a
  different category-specific condition ID), and payment policy
  requirements varying by marketplace.
- `/api/save-draft` is a public, unauthenticated endpoint that can
  create real (if unpublished) objects in the user's eBay account —
  worse than just an API-cost risk. `worker/README.md` recommends
  Cloudflare rate limiting / Access; check whether the user has set
  that up before treating this as a low-risk public deployment.
- Real gotcha hit and fixed live: `get_default_category_tree_id` is a
  top-level Taxonomy API resource, NOT nested under `/category_tree/`
  (unlike `get_category_suggestions`, which is) — an extra path
  segment caused a 404 where eBay parsed the operation name itself as
  the tree ID. Also: Taxonomy API calls need an **application** token
  (client_credentials), not the user OAuth token — the user token's
  scopes don't cover it, confirmed via a live 403.
- Real gotcha: eBay's Inventory API (SKU-based offers, what this tool
  uses) does NOT reliably show up anywhere in eBay's own Seller Hub
  website — confirmed live, user couldn't find a created draft
  anywhere on ebay.com. This isn't a bug or something fixable from
  our side; it's how eBay's platform works (their own docs/community
  confirm: API-created drafts aren't editable/visible via the website
  until published). This is why `docs/my-drafts.html` /
  `GET /api/drafts` exist — they read drafts back from the API
  directly since eBay's site can't show them. Commercial cross-listing
  tools (Vendoo, List Perfectly, etc.) work around this exact same gap
  the same way — this isn't a workaround for a broken approach, it's
  the standard architecture for this problem.
- As of the same date, `docs/my-drafts.html` also supports editing
  (title/description/price/format) and deleting drafts, plus
  reordering photos — via `PUT /api/draft` and `DELETE /api/draft`.
  Editing preserves the original `condition`/`aspects` on the
  inventory item (merges partial updates rather than replacing
  wholesale) and re-fetches business policies fresh each time in case
  they changed. AUCTION format support (`listingDuration: "DAYS_7"`,
  `auctionStartPrice` instead of `price`) is untested against the live
  API — flag this as another likely debugging-round candidate if the
  user tries switching a draft to Auction.
- A real routing bug was caught before shipping (not by the user):
  the `/api/drafts` handler was written but never wired into the
  Worker's route table, so it 404'd. Caught by an integration test
  that hit the actual route rather than just unit-testing the handler
  function in isolation — worth remembering when adding future routes
  here, since this class of bug won't show up in a function-level test.
- As of the same date, both the create flow (`list-card.html`) and
  edit flow (`my-drafts.html`) support Auction format with an optional
  Buy It Now price, and Fixed Price format with optional Best Offer +
  a minimum auto-decline price. Best Offer is structurally Fixed-Price-
  only on eBay's platform (auctions can't have it) — the code enforces
  this by construction (`buildOfferBody` only reads `bestOffer` when
  format isn't AUCTION) rather than needing a separate guard. The
  exact field names used (`pricingSummary.buyItNowPrice`,
  `listingPolicies.bestOfferTerms.{bestOfferEnabled,autoDeclinePrice}`)
  are my best-confidence guess from eBay's schema, NOT yet verified
  against the live API — treat as a likely next debugging-round
  candidate, same pattern as the category-tree URL and token-type bugs
  that were real live-API surprises earlier in this integration.

## Gotchas

- Always trigger workflows via **Run workflow** (Actions tab), never
  **Re-run jobs** on an old run — a re-run reuses the original run's
  base commit, which can be behind `main` and cause a rejected push.
- Claude's GitHub App token cannot trigger `workflow_dispatch` runs
  (403) — ask the user to click **Run workflow** manually.
- The eBay data in `ebay_asking_prices.json` / the site's eBay section
  is **active-listing asking price**, not sold price — keep that
  distinction explicit anywhere it's surfaced.
