import { analyzeCard } from "./card-analysis.js";
import { buildDraft } from "./draft.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./ebay-oauth.js";
import {
  getCategoryId,
  getBusinessPolicies,
  uploadImagesToR2,
  createInventoryItem,
  createOffer,
} from "./ebay-listing.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB per image, bounds cost per request
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const REFRESH_TOKEN_KEY = "ebay_refresh_token";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return "At least one image is required";
  }
  if (images.length > MAX_IMAGES) {
    return `Too many images (max ${MAX_IMAGES})`;
  }
  for (const img of images) {
    if (!img || typeof img.data !== "string" || !ALLOWED_MEDIA_TYPES.has(img.media_type)) {
      return "Each image needs base64 `data` and a supported `media_type` (image/jpeg, image/png, image/webp)";
    }
    // base64 is ~4/3 the size of the original bytes
    const approxBytes = (img.data.length * 3) / 4;
    if (approxBytes > MAX_IMAGE_BYTES) {
      return "Image too large (max 5MB each)";
    }
  }
  return null;
}

async function handleDraftListing(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const validationError = validateImages(body.images);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400, origin);
  }

  let card;
  try {
    card = await analyzeCard(body.images, env.ANTHROPIC_API_KEY);
  } catch (e) {
    return jsonResponse({ error: "Card identification failed: " + e.message }, 502, origin);
  }

  const draft = buildDraft(card);

  return jsonResponse({ identified: card, draft }, 200, origin);
}

async function handleOAuthStart(env, origin) {
  const state = crypto.randomUUID();
  await env.EBAY_TOKENS.put(`oauth_state:${state}`, "1", { expirationTtl: 300 });

  const url = buildAuthorizeUrl({
    clientId: env.EBAY_CLIENT_ID,
    ruName: env.EBAY_RUNAME,
    state,
  });

  return Response.redirect(url, 302);
}

async function handleOAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const redirectBase = env.ALLOWED_ORIGIN + "/list-card.html";

  if (!code || !state) {
    return Response.redirect(`${redirectBase}?ebay_error=missing_code_or_state`, 302);
  }

  const stateKey = `oauth_state:${state}`;
  const stateValid = await env.EBAY_TOKENS.get(stateKey);
  if (!stateValid) {
    return Response.redirect(`${redirectBase}?ebay_error=invalid_state`, 302);
  }
  await env.EBAY_TOKENS.delete(stateKey);

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
      ruName: env.EBAY_RUNAME,
    });
    await env.EBAY_TOKENS.put(REFRESH_TOKEN_KEY, tokens.refresh_token);
    return Response.redirect(`${redirectBase}?ebay_connected=1`, 302);
  } catch (e) {
    return Response.redirect(`${redirectBase}?ebay_error=${encodeURIComponent(e.message.slice(0, 200))}`, 302);
  }
}

async function handleEbayStatus(env, origin) {
  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  return jsonResponse({ connected: Boolean(refreshToken) }, 200, origin);
}

async function handleSaveDraft(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const validationError = validateImages(body.images);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400, origin);
  }
  if (!body.card || !body.draft) {
    return jsonResponse({ error: "`card` and `draft` are required" }, 400, origin);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return jsonResponse({ error: "A positive `price` is required" }, 400, origin);
  }

  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay — click Connect to eBay first" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });

    const imageUrls = await uploadImagesToR2(body.images, env.CARD_IMAGES, env.R2_PUBLIC_BASE_URL);
    const categoryId = await getCategoryId(body.draft.title, accessToken);
    const policies = await getBusinessPolicies(accessToken);

    const sku = crypto.randomUUID();
    await createInventoryItem(sku, body.card, body.draft, imageUrls, accessToken);
    const offerId = await createOffer(sku, body.draft, categoryId, policies, price, accessToken);

    return jsonResponse(
      {
        offerId,
        sku,
        message: "Draft offer created on eBay — NOT published. Review and publish it yourself from Seller Hub > Listings > Drafts.",
      },
      200,
      origin
    );
  } catch (e) {
    return jsonResponse({ error: "Saving eBay draft failed: " + e.message }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/draft-listing" && request.method === "POST") {
        return await handleDraftListing(request, env, origin);
      }
      if (url.pathname === "/oauth/start" && request.method === "GET") {
        return await handleOAuthStart(env, origin);
      }
      if (url.pathname === "/oauth/callback" && request.method === "GET") {
        return await handleOAuthCallback(request, env);
      }
      if (url.pathname === "/api/ebay-status" && request.method === "GET") {
        return await handleEbayStatus(env, origin);
      }
      if (url.pathname === "/api/save-draft" && request.method === "POST") {
        return await handleSaveDraft(request, env, origin);
      }
    } catch (e) {
      return jsonResponse({ error: "Unexpected server error: " + e.message }, 500, origin);
    }

    return jsonResponse({ error: "Not found" }, 404, origin);
  },
};
