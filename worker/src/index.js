import { analyzeCard } from "./card-analysis.js";
import { getEbayToken, fetchComps, summarizeComps } from "./comps.js";
import { buildDraft } from "./draft.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB per image, bounds cost per request
const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  let comps = { listing_count: 0, avg_asking_price: null, median_asking_price: null, min_asking_price: null, max_asking_price: null };
  let compsQuery = null;
  let compsBroadened = false;
  if (card.player) {
    try {
      const token = await getEbayToken(env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET);
      const { listings, query, broadened } = await fetchComps(card, token);
      comps = summarizeComps(listings);
      compsQuery = query;
      compsBroadened = broadened;
    } catch (e) {
      // Comps are best-effort — still return the card ID + a draft without pricing
      comps.error = "Comp lookup failed: " + e.message;
    }
  }

  const draft = buildDraft(card, comps);

  return jsonResponse(
    {
      identified: card,
      comps: {
        ...comps,
        query: compsQuery,
        broadened: compsBroadened,
        note: "eBay active Buy-It-Now asking prices, not sold/transacted prices.",
      },
      draft,
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/draft-listing" && request.method === "POST") {
      try {
        return await handleDraftListing(request, env, origin);
      } catch (e) {
        return jsonResponse({ error: "Unexpected server error: " + e.message }, 500, origin);
      }
    }

    return jsonResponse({ error: "Not found" }, 404, origin);
  },
};
