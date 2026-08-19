const CATEGORY_TREE_ID_URL = "https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id";
const CATEGORY_SUGGESTIONS_URL = (treeId) =>
  `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`;
const FULFILLMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/fulfillment_policy";
const PAYMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/payment_policy";
const RETURN_POLICY_URL = "https://api.ebay.com/sell/account/v1/return_policy";
const INVENTORY_ITEM_URL = (sku) => `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
const OFFER_URL = "https://api.ebay.com/sell/inventory/v1/offer";
const OFFER_BY_ID_URL = (offerId) => `https://api.ebay.com/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
const INVENTORY_ITEMS_LIST_URL = "https://api.ebay.com/sell/inventory/v1/inventory_item";
const MARKETPLACE_ID = "EBAY_US";

async function ebayFetch(url, accessToken, options = {}, fetchImpl = fetch) {
  const resp = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
      ...(options.headers || {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`eBay API ${options.method || "GET"} ${url} -> ${resp.status}: ${text.slice(0, 500)}`);
    err.status = resp.status;
    throw err;
  }

  if (resp.status === 204) return null;
  return resp.json();
}

export async function getCategoryId(searchQuery, accessToken, fetchImpl = fetch) {
  const treeJson = await ebayFetch(
    `${CATEGORY_TREE_ID_URL}?marketplace_id=${MARKETPLACE_ID}`,
    accessToken,
    {},
    fetchImpl
  );
  const treeId = treeJson.categoryTreeId;

  const suggestJson = await ebayFetch(
    `${CATEGORY_SUGGESTIONS_URL(treeId)}?q=${encodeURIComponent(searchQuery)}`,
    accessToken,
    {},
    fetchImpl
  );

  const suggestions = suggestJson.categorySuggestions || [];
  if (suggestions.length === 0) {
    throw new Error(`No eBay category suggestions found for "${searchQuery}"`);
  }
  return suggestions[0].category.categoryId;
}

// Fetches the seller's existing business policies and returns the first of
// each type. eBay's Inventory API requires these to already exist in the
// seller's account (Seller Hub -> Account -> Business Policies) — this
// tool cannot create them.
export async function getBusinessPolicies(accessToken, fetchImpl = fetch) {
  const [fulfillment, payment, returns] = await Promise.all([
    ebayFetch(`${FULFILLMENT_POLICY_URL}?marketplace_id=${MARKETPLACE_ID}`, accessToken, {}, fetchImpl),
    ebayFetch(`${PAYMENT_POLICY_URL}?marketplace_id=${MARKETPLACE_ID}`, accessToken, {}, fetchImpl),
    ebayFetch(`${RETURN_POLICY_URL}?marketplace_id=${MARKETPLACE_ID}`, accessToken, {}, fetchImpl),
  ]);

  const fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
  const returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;
  // Payment policies aren't used on marketplaces under eBay Managed
  // Payments (US included) — omit if none exist rather than fail.
  const paymentPolicyId = payment.paymentPolicies?.[0]?.paymentPolicyId;

  if (!fulfillmentPolicyId || !returnPolicyId) {
    throw new Error(
      "Missing eBay Business Policies — set up shipping (fulfillment) and return policies at " +
      "Seller Hub -> Account -> Business Policies before saving a draft."
    );
  }

  return { fulfillmentPolicyId, returnPolicyId, paymentPolicyId };
}

// R2 doesn't give a stable public URL from a binding alone — the bucket
// must have public access enabled (r2.dev subdomain or custom domain),
// and that base URL is passed in via env.R2_PUBLIC_BASE_URL.
export async function uploadImagesToR2(images, bucket, publicBaseUrl) {
  const urls = [];
  for (const img of images) {
    const ext = img.media_type.split("/")[1] || "jpg";
    const key = `${crypto.randomUUID()}.${ext}`;
    const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
    await bucket.put(key, bytes, { httpMetadata: { contentType: img.media_type } });
    urls.push(`${publicBaseUrl.replace(/\/$/, "")}/${key}`);
  }
  return urls;
}

export function buildInventoryItemBody(card, draft, imageUrls) {
  return {
    condition: card.is_graded ? "USED_EXCELLENT" : "USED_GOOD",
    product: {
      title: draft.title,
      description: draft.description,
      imageUrls,
      aspects: Object.fromEntries(
        Object.entries({
          Player: card.player,
          Sport: card.sport,
          Season: card.year,
          Manufacturer: card.brand,
          Parallel: card.parallel,
        }).filter(([, v]) => v)
          .map(([k, v]) => [k, [v]])
      ),
    },
  };
}

export async function createInventoryItem(sku, card, draft, imageUrls, accessToken, fetchImpl = fetch) {
  await ebayFetch(
    INVENTORY_ITEM_URL(sku),
    accessToken,
    { method: "PUT", body: JSON.stringify(buildInventoryItemBody(card, draft, imageUrls)) },
    fetchImpl
  );
}

export async function getInventoryItem(sku, accessToken, fetchImpl = fetch) {
  return ebayFetch(INVENTORY_ITEM_URL(sku), accessToken, {}, fetchImpl);
}

// createOrReplaceInventoryItem is an upsert, so editing is the same call
// as creating — but an edit only has title/description/photo order to
// change, not a fresh card identification, so this merges onto the
// currently-stored item (preserving condition and aspects) rather than
// rebuilding from a card object.
export async function updateInventoryItemFields(sku, currentItem, updates, accessToken, fetchImpl = fetch) {
  const body = {
    condition: currentItem.condition,
    product: {
      ...currentItem.product,
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.imageUrls !== undefined ? { imageUrls: updates.imageUrls } : {}),
    },
  };
  await ebayFetch(INVENTORY_ITEM_URL(sku), accessToken, { method: "PUT", body: JSON.stringify(body) }, fetchImpl);
}

export async function deleteInventoryItem(sku, accessToken, fetchImpl = fetch) {
  await ebayFetch(INVENTORY_ITEM_URL(sku), accessToken, { method: "DELETE" }, fetchImpl);
}

// format: "FIXED_PRICE" (default) or "AUCTION". Auction support in the
// modern Inventory API is less battle-tested than fixed price in this
// codebase — expect this to possibly need a debugging round the same way
// the rest of this integration did, if eBay rejects the shape.
//
// options:
//   buyItNowPrice   - AUCTION only. Optional. Lets buyers skip bidding and
//                     buy outright. Field name (pricingSummary.buyItNowPrice)
//                     is my best-confidence guess from eBay's schema, NOT
//                     verified live yet — flag as a likely debugging spot.
//   bestOffer       - FIXED_PRICE only. Optional { enabled, minimumPrice }.
//                     Best Offer is a Fixed-Price-only eBay feature —
//                     there is no such thing as Best Offer on an auction,
//                     so this is intentionally ignored when format is
//                     AUCTION rather than something we need to block.
//                     listingPolicies.bestOfferTerms field names are also
//                     unverified live — same caveat as buyItNowPrice.
export function buildOfferBody(sku, draft, categoryId, policies, price, format = "FIXED_PRICE", options = {}) {
  const listingPolicies = {
    fulfillmentPolicyId: policies.fulfillmentPolicyId,
    returnPolicyId: policies.returnPolicyId,
  };
  if (policies.paymentPolicyId) listingPolicies.paymentPolicyId = policies.paymentPolicyId;

  const body = {
    sku,
    marketplaceId: MARKETPLACE_ID,
    format,
    availableQuantity: 1,
    categoryId,
    listingDescription: draft.description,
    listingPolicies,
  };

  if (format === "AUCTION") {
    body.pricingSummary = { auctionStartPrice: { value: String(price), currency: "USD" } };
    body.listingDuration = "DAYS_7";
    if (options.buyItNowPrice) {
      body.pricingSummary.buyItNowPrice = { value: String(options.buyItNowPrice), currency: "USD" };
    }
  } else {
    body.pricingSummary = { price: { value: String(price), currency: "USD" } };
    if (options.bestOffer?.enabled) {
      body.listingPolicies.bestOfferTerms = { bestOfferEnabled: true };
      if (options.bestOffer.minimumPrice) {
        body.listingPolicies.bestOfferTerms.autoDeclinePrice = {
          value: String(options.bestOffer.minimumPrice),
          currency: "USD",
        };
      }
    }
  }

  return body;
}

// Creates the Offer but deliberately never calls publishOffer — this is
// the draft state, not visible to buyers. NOTE: unlike classic listings,
// these unpublished offers don't reliably show up anywhere in eBay's own
// Seller Hub UI — see listInventoryItems()/listOffersForSku() below,
// which back this tool's own drafts list instead.
export async function createOffer(sku, draft, categoryId, policies, price, format = "FIXED_PRICE", options = {}, accessToken, fetchImpl = fetch) {
  const json = await ebayFetch(
    OFFER_URL,
    accessToken,
    { method: "POST", body: JSON.stringify(buildOfferBody(sku, draft, categoryId, policies, price, format, options)) },
    fetchImpl
  );
  return json.offerId;
}

// Reads back the offer as eBay actually has it stored — used to verify
// what got created without relying on Seller Hub's UI, which doesn't
// always surface Inventory API-created offers the same way it does
// classic listings.
export async function getOffer(offerId, accessToken, fetchImpl = fetch) {
  return ebayFetch(OFFER_BY_ID_URL(offerId), accessToken, {}, fetchImpl);
}

export async function updateOffer(offerId, sku, draft, categoryId, policies, price, format, options = {}, accessToken, fetchImpl = fetch) {
  await ebayFetch(
    OFFER_BY_ID_URL(offerId),
    accessToken,
    { method: "PUT", body: JSON.stringify(buildOfferBody(sku, draft, categoryId, policies, price, format, options)) },
    fetchImpl
  );
}

export async function deleteOffer(offerId, accessToken, fetchImpl = fetch) {
  await ebayFetch(OFFER_BY_ID_URL(offerId), accessToken, { method: "DELETE" }, fetchImpl);
}

// Deletes both halves of a draft. Offer must go first — eBay won't let you
// delete an inventory item that a live offer still references.
export async function deleteDraft(sku, offerId, accessToken, fetchImpl = fetch) {
  if (offerId) {
    await deleteOffer(offerId, accessToken, fetchImpl);
  }
  await deleteInventoryItem(sku, accessToken, fetchImpl);
}

export async function listInventoryItems(accessToken, limit = 25, fetchImpl = fetch) {
  const json = await ebayFetch(
    `${INVENTORY_ITEMS_LIST_URL}?limit=${limit}`,
    accessToken,
    {},
    fetchImpl
  );
  return json.inventoryItems || [];
}

// eBay returns a 404 (not an empty list) when an inventory item has no
// offer at all — e.g. one where createOffer never completed. That's a
// legitimate state for a draft to be in, not a real failure, so it's
// treated the same as "no offers found" rather than thrown.
export async function listOffersForSku(sku, accessToken, fetchImpl = fetch) {
  try {
    const json = await ebayFetch(
      `${OFFER_URL}?sku=${encodeURIComponent(sku)}`,
      accessToken,
      {},
      fetchImpl
    );
    return json.offers || [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

// Combines inventory items (title/description/photos live here) with
// their offers (price/status live here) into one flat list this tool's
// own drafts page can render, since eBay's UI won't show these.
export async function listDrafts(accessToken, fetchImpl = fetch) {
  const items = await listInventoryItems(accessToken, 25, fetchImpl);

  const drafts = [];
  for (const item of items) {
    const offers = await listOffersForSku(item.sku, accessToken, fetchImpl);
    const offer = offers[0];
    drafts.push({
      sku: item.sku,
      title: item.product?.title ?? null,
      description: item.product?.description ?? null,
      imageUrls: item.product?.imageUrls ?? [],
      offerId: offer?.offerId ?? null,
      status: offer?.status ?? "NO_OFFER",
      format: offer?.format ?? "FIXED_PRICE",
      price: offer?.pricingSummary?.price ?? offer?.pricingSummary?.auctionStartPrice ?? null,
    });
  }
  return drafts;
}
