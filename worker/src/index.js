import { analyzeCard } from "./card-analysis.js";
import { buildDraft } from "./draft.js";
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, getApplicationToken } from "./ebay-oauth.js";
import {
  getCategoryId,
  getBusinessPolicies,
  getMerchantLocationKey,
  uploadImagesToR2,
  createInventoryItem,
  createOffer,
  getOffer,
  listDrafts,
  getInventoryItem,
  updateInventoryItemFields,
  updateOffer,
  deleteDraft,
  publishOffer,
} from "./ebay-listing.js";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB per image, bounds cost per request
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const REFRESH_TOKEN_KEY = "ebay_refresh_token";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  const redirectBase = env.SITE_BASE_URL + "/list-card.html";

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

// Best Offer only applies to FIXED_PRICE; Buy It Now price only applies
// to AUCTION — pulling out just the relevant one keeps buildOfferBody's
// options object clean regardless of what the client sends.
function buildOfferOptionsFromRequest(body, format) {
  if (format === "AUCTION") {
    return body.buyItNowPrice ? { buyItNowPrice: Number(body.buyItNowPrice) } : {};
  }
  if (body.bestOfferEnabled) {
    return {
      bestOffer: {
        enabled: true,
        minimumPrice: body.bestOfferMinimumPrice ? Number(body.bestOfferMinimumPrice) : undefined,
      },
    };
  }
  return {};
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
  const format = body.format === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
  const offerOptions = buildOfferOptionsFromRequest(body, format);

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
    // Taxonomy API (category lookup) needs an application token, not a
    // user token — category data isn't user-specific, and the user
    // token's scopes (sell.inventory, sell.account.readonly) don't cover it.
    const appToken = await getApplicationToken({
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });

    const imageUrls = await uploadImagesToR2(body.images, env.CARD_IMAGES, env.R2_PUBLIC_BASE_URL);
    const categoryId = await getCategoryId(body.draft.title, appToken);
    const policies = await getBusinessPolicies(accessToken);
    // Best-effort: only actually required by eBay at publish time (see
    // getMerchantLocationKey()'s comment), so a seller with no location
    // configured yet can still save/review a draft — it just won't
    // publish until they set one up and re-save.
    const merchantLocationKey = await getMerchantLocationKey(accessToken).catch(() => undefined);

    const sku = crypto.randomUUID();
    await createInventoryItem(sku, body.card, body.draft, imageUrls, accessToken);
    const offerId = await createOffer(sku, body.draft, categoryId, policies, price, format, offerOptions, merchantLocationKey, accessToken);

    return jsonResponse(
      {
        offerId,
        sku,
        message: "Draft offer created on eBay — NOT published. Use the offer ID to check its status, or find it in Seller Hub (location varies by account).",
      },
      200,
      origin
    );
  } catch (e) {
    return jsonResponse({ error: "Saving eBay draft failed: " + e.message }, 502, origin);
  }
}

async function handleOfferStatus(request, env, origin) {
  const url = new URL(request.url);
  const offerId = url.searchParams.get("offerId");
  if (!offerId) {
    return jsonResponse({ error: "?offerId= is required" }, 400, origin);
  }

  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });
    const offer = await getOffer(offerId, accessToken);
    return jsonResponse(
      {
        offerId: offer.offerId,
        sku: offer.sku,
        status: offer.status,
        listingId: offer.listing?.listingId ?? null,
        price: offer.pricingSummary?.price ?? null,
        note: offer.status === "PUBLISHED"
          ? "This offer is PUBLISHED — either you published it yourself via My eBay Drafts, or something published it outside this tool. Investigate if you didn't do this."
          : "Not published — draft only, still safe.",
      },
      200,
      origin
    );
  } catch (e) {
    return jsonResponse({ error: "Fetching offer status failed: " + e.message }, 502, origin);
  }
}

async function handleListDrafts(env, origin) {
  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });
    const drafts = await listDrafts(accessToken);
    return jsonResponse({ drafts }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "Listing drafts failed: " + e.message }, 502, origin);
  }
}

async function handleUpdateDraft(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const { sku, offerId, title, description, imageUrls, format } = body;
  if (!sku || !offerId) {
    return jsonResponse({ error: "`sku` and `offerId` are required" }, 400, origin);
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return jsonResponse({ error: "A positive `price` is required" }, 400, origin);
  }
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return jsonResponse({ error: "`imageUrls` must be a non-empty array" }, 400, origin);
  }

  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });

    const [currentItem, currentOffer] = await Promise.all([
      getInventoryItem(sku, accessToken),
      getOffer(offerId, accessToken),
    ]);

    await updateInventoryItemFields(sku, currentItem, { title, description, imageUrls }, accessToken);

    const policies = await getBusinessPolicies(accessToken);
    const chosenFormat = format || currentOffer.format || "FIXED_PRICE";
    const offerOptions = buildOfferOptionsFromRequest(body, chosenFormat);
    // Keep it if the offer already has one; otherwise best-effort fetch,
    // so editing an old draft (created before this field existed) picks
    // it up automatically — see getMerchantLocationKey()'s comment.
    const merchantLocationKey = currentOffer.merchantLocationKey
      || (await getMerchantLocationKey(accessToken).catch(() => undefined));
    await updateOffer(
      offerId,
      sku,
      { description },
      currentOffer.categoryId,
      policies,
      price,
      chosenFormat,
      offerOptions,
      merchantLocationKey,
      accessToken
    );

    return jsonResponse({ message: "Draft updated." }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "Updating draft failed: " + e.message }, 502, origin);
  }
}

// Makes a draft live/binding immediately — the frontend must have already
// shown a strong confirmation before ever hitting this endpoint, since
// there's no undo once eBay accepts the publish call.
async function handlePublishDraft(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
  }

  const { offerId } = body;
  if (!offerId) {
    return jsonResponse({ error: "`offerId` is required" }, 400, origin);
  }

  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });
    const listingId = await publishOffer(offerId, accessToken);
    return jsonResponse({ message: "Offer published — it is now live on eBay.", listingId }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "Publishing offer failed: " + e.message }, 502, origin);
  }
}

async function handleDeleteDraft(request, env, origin) {
  const url = new URL(request.url);
  const sku = url.searchParams.get("sku");
  const offerId = url.searchParams.get("offerId");
  if (!sku) {
    return jsonResponse({ error: "?sku= is required" }, 400, origin);
  }

  const refreshToken = await env.EBAY_TOKENS.get(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    return jsonResponse({ error: "Not connected to eBay" }, 401, origin);
  }

  try {
    const accessToken = await refreshAccessToken({
      refreshToken,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    });
    await deleteDraft(sku, offerId, accessToken);
    return jsonResponse({ message: "Draft deleted." }, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "Deleting draft failed: " + e.message }, 502, origin);
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
      if (url.pathname === "/api/offer-status" && request.method === "GET") {
        return await handleOfferStatus(request, env, origin);
      }
      if (url.pathname === "/api/drafts" && request.method === "GET") {
        return await handleListDrafts(env, origin);
      }
      if (url.pathname === "/api/draft" && request.method === "PUT") {
        return await handleUpdateDraft(request, env, origin);
      }
      if (url.pathname === "/api/draft" && request.method === "DELETE") {
        return await handleDeleteDraft(request, env, origin);
      }
      if (url.pathname === "/api/publish-draft" && request.method === "POST") {
        return await handlePublishDraft(request, env, origin);
      }
    } catch (e) {
      return jsonResponse({ error: "Unexpected server error: " + e.message }, 500, origin);
    }

    return jsonResponse({ error: "Not found" }, 404, origin);
  },
};
