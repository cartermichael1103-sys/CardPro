# Listing Draft Worker

A small Cloudflare Worker backing the "New Listing" page (`docs/list-card.html`).
Given one or more photos of a card, it:

1. Sends the photo(s) to Claude (Anthropic API) to identify the card (player,
   set, parallel, serial number, autograph, etc.)
2. Returns a draft listing title/description for you to review and paste
   into eBay yourself — it never posts anything to eBay.

(An earlier version also looked up eBay comps to suggest a price, but the
per-card search was unreliable — see git history / `CLAUDE.md` if reviving
that. `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` below aren't used by this
endpoint right now, but are kept since the same Production credentials will
be needed again for the "save as an actual eBay draft listing" feature,
which requires eBay's user-login OAuth flow — a separate, bigger build.)

## One-time setup

### 1. Install dependencies
```bash
cd worker
npm install
```

### 2. Log in to Cloudflare
```bash
npx wrangler login
```
This opens a browser to authorize the CLI against your Cloudflare account
(free tier is fine — Workers has a generous free monthly quota).

### 3. Set secrets
These are stored encrypted in Cloudflare, never in this repo:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
```
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com (this is billed
  pay-per-use; card identification costs a small fraction of a cent to a
  few cents per photo depending on size)
- `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — the same Production App ID /
  Cert ID from https://developer.ebay.com/my/keys you're already using for
  `update-ebay-prices.yml`

### 4. Deploy
```bash
npx wrangler deploy
```
This prints a URL like `https://cardpro-listing-worker.YOUR-SUBDOMAIN.workers.dev`.

### 5. Point the site at your Worker
Open `docs/list-card.js` and set:
```js
const WORKER_URL = "https://cardpro-listing-worker.YOUR-SUBDOMAIN.workers.dev";
```
Commit and push — GitHub Pages will pick it up.

## Important: this endpoint costs you money per request

`/api/draft-listing` is public and unauthenticated — anyone who finds the
URL can call it and spend your Anthropic + eBay API quota. The Worker
limits requests to 4 images of 5MB each to bound cost per call, but that
doesn't stop someone from calling it repeatedly. Recommended: turn on a
[rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/)
for this route in the Cloudflare dashboard (Security → WAF → Rate limiting
rules), e.g. 10 requests/hour per IP, especially before sharing the site
URL widely.

## Local development
```bash
cp .dev.vars.example .dev.vars   # fill in real values, never commit this file
npx wrangler dev
```
Then point `WORKER_URL` in `docs/list-card.js` at `http://localhost:8787`
temporarily while testing locally.

## Files

```
wrangler.toml         Worker config (name, allowed CORS origin)
src/index.js           Routing, CORS, request validation, orchestration
src/card-analysis.js   Builds/parses the Claude vision request
src/draft.js            Builds the listing title/description
```
