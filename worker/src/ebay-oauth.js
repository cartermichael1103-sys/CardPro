const AUTHORIZE_URL = "https://auth.ebay.com/oauth2/authorize";
const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";

// Scopes needed to create (but never publish) inventory items/offers, and
// to look up the seller's existing business policies.
export const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
].join(" ");

export function buildAuthorizeUrl({ clientId, ruName, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ruName,
    response_type: "code",
    scope: USER_SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuthHeader(clientId, clientSecret) {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

export async function exchangeCodeForTokens({ code, clientId, clientSecret, ruName }, fetchImpl = fetch) {
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBay token exchange error ${resp.status}: ${text.slice(0, 400)}`);
  }

  return resp.json(); // { access_token, refresh_token, expires_in, refresh_token_expires_in, ... }
}

// Application-level token (client credentials grant) — no user login
// involved. The Taxonomy API (category lookup) requires this rather than
// a user token, since category data isn't user-specific.
export async function getApplicationToken({ clientId, clientSecret }, fetchImpl = fetch) {
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBay application token error ${resp.status}: ${text.slice(0, 400)}`);
  }

  const json = await resp.json();
  return json.access_token;
}

export async function refreshAccessToken({ refreshToken, clientId, clientSecret }, fetchImpl = fetch) {
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: USER_SCOPES,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBay token refresh error ${resp.status}: ${text.slice(0, 400)}`);
  }

  const json = await resp.json();
  return json.access_token;
}
