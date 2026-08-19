# Listing Draft Worker

A small Cloudflare Worker backing the "New Listing" page (`docs/list-card.html`).
Given one or more photos of a card, it:

1. Sends the photo(s) to Claude (Anthropic API) to identify the card (player,
   set, parallel, serial number, autograph, etc.)
2. Returns a draft listing title/description for you to review and paste
   into eBay yourself.
3. **Optionally**, once you connect your eBay account, can save that draft
   directly to eBay as a real (but **unpublished**) Offer. eBay's own
   website generally won't show you these — see `docs/my-drafts.html` /
   `GET /api/drafts` below. From that page you can also **Publish** a
   draft when you're ready to make it live — that calls eBay's publish
   API directly and is gated behind an explicit confirmation step in the
   UI, since it's irreversible from this tool once eBay accepts it.

(An earlier version also looked up eBay comps to suggest a price, but the
per-card search was unreliable — see git history / `CLAUDE.md` if reviving
that. There's no auto-pricing now — you type in the price yourself when
saving a draft.)

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
(free tier is fine).

### 3. Set secrets
These are stored encrypted in Cloudflare, never in this repo:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
```
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com
- `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — the same Production App ID /
  Cert ID from https://developer.ebay.com/my/keys you're already using

### 4. Create a KV namespace (stores your eBay connection)
```bash
npx wrangler kv namespace create EBAY_TOKENS
```
This prints an `id`. Open `wrangler.toml` and paste it in:
```toml
[[kv_namespaces]]
binding = "EBAY_TOKENS"
id = "PASTE_THE_ID_HERE"
```

### 5. Create an R2 bucket (hosts card photos so eBay can see them)
eBay's listing API needs a public image URL, not a raw upload, so photos
get copied here first.
```bash
npx wrangler r2 bucket create cardpro-card-images
```
Then enable public access so eBay can fetch the images:
1. Cloudflare dashboard → R2 → `cardpro-card-images` → Settings
2. Under **Public access**, enable the `r2.dev` subdomain
3. Copy the public URL it gives you (looks like `https://pub-xxxxxxxx.r2.dev`)
4. Paste it into `wrangler.toml`:
```toml
R2_PUBLIC_BASE_URL = "https://pub-xxxxxxxx.r2.dev"
```

### 6. Register an OAuth redirect (RuName) with eBay
This is what lets you click "Connect to eBay" and grant this tool access
to create (but not publish) listings under your account.

1. Go to https://developer.ebay.com/my/keys
2. Find the **User Tokens (eBay Sign-in)** tab
3. Set up (or find) your **RuName** — give it:
   - **Auth Accepted URL**: `https://YOUR-WORKER-URL/oauth/callback`
   - **Auth Declined URL**: same URL is fine, or anywhere you like
   - (You'll only know the real Worker URL after step 8's first deploy —
     it's fine to deploy once, get the URL, then come back and set this)
4. Copy the **RuName** value (looks like `YourApp-YourApp-SBX-abc123-de456789`)
   and paste it into `wrangler.toml`:
```toml
EBAY_RUNAME = "YourApp-YourApp-PRD-xxxxxxxxx-xxxxxxxx"
```

### 7. Confirm you have eBay Business Policies set up
eBay's API requires your seller account to already have shipping
(fulfillment) and return policies before it will let any tool create an
offer — this tool cannot create these for you.

Check: Seller Hub → Account → Business Policies. If you don't have at
least one shipping policy and one return policy, create them there first.

### 8. Deploy
```bash
npx wrangler deploy
```
This prints your Worker's URL, e.g.
`https://cardpro-listing-worker.YOUR-SUBDOMAIN.workers.dev`. If you hadn't
set the RuName's Accept URL yet (step 6), go back and set it now using
this real URL + `/oauth/callback`.

### 9. Point the site at your Worker
Open `docs/list-card.js` and set:
```js
const WORKER_URL = "https://cardpro-listing-worker.YOUR-SUBDOMAIN.workers.dev";
```
Commit and push — GitHub Pages will pick it up.

### 10. Connect your eBay account
Open the New Listing page on your live site and click **Connect to eBay**.
You'll be sent to eBay's sign-in/consent screen, then redirected back.

## Important: this Worker is public and can write to your eBay account

`/api/draft-listing`, `/api/save-draft`, `/api/draft`, and
`/api/publish-draft` are all public and unauthenticated — anyone who finds
the URL can call them. `/api/draft-listing` just costs you Anthropic API
quota. `/api/save-draft`/`/api/draft` are more serious: once you've
connected your eBay account, **anyone who finds the Worker URL could
trigger draft-offer creation, editing, or deletion under your eBay
account**. `/api/publish-draft` is the most serious of all — it can make
any existing draft (by `offerId`, which isn't a secret) a real, live,
binding listing with no confirmation on the server side; the confirmation
step lives only in `docs/my-drafts.js`'s UI, which does nothing to stop a
direct request to the Worker URL. Strongly recommended before leaving this
live for any length of time:

- Turn on a [rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/)
  in the Cloudflare dashboard (Security → WAF → Rate limiting rules) on
  both API routes, e.g. 10 requests/hour per IP
- Consider [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  in front of `/api/save-draft` specifically if you want real authentication,
  since CORS/origin checks alone don't stop direct requests to the Worker URL

## Local development
```bash
cp .dev.vars.example .dev.vars   # fill in real values, never commit this file
npx wrangler dev
```
Then point `WORKER_URL` in `docs/list-card.js` at `http://localhost:8787`
temporarily while testing locally. Note the OAuth callback needs a
publicly reachable URL from eBay's side, so full login-flow testing has to
happen against the real deployed Worker, not `wrangler dev`.

## Files

```
wrangler.toml          Worker config (vars, KV binding, R2 binding)
src/index.js            Routing, CORS, request validation, orchestration
src/card-analysis.js    Builds/parses the Claude vision request
src/draft.js             Builds the listing title/description
src/ebay-oauth.js        OAuth authorize URL, code exchange, token refresh
src/ebay-listing.js      Category lookup, business policies, R2 image
                          upload, inventory item + offer creation
```
