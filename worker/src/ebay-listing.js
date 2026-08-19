const CATEGORY_TREE_ID_URL = "https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id";
const CATEGORY_SUGGESTIONS_URL = (treeId) =>
  `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`;
const FULFILLMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/fulfillment_policy";
const PAYMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/payment_policy";
const RETURN_POLICY_URL = "https://api.ebay.com/sell/account/v1/return_policy";
const INVENTORY_ITEM_URL = (sku) => `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
const OFFER_URL = "https://api.ebay.com/sell/inventory/v1/offer";
const OFFER_BY_ID_URL = (offerId) => `https://api.ebay.com/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
const OFFER_PUBLISH_URL = (offerId) => `https://api.ebay.com/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish/`;
const INVENTORY_ITEMS_LIST_URL = "https://api.ebay.com/sell/inventory/v1/inventory_item";
const LOCATION_URL = "https://api.ebay.com/sell/inventory/v1/location";
const LOCATION_BY_KEY_URL = (key) => `https://api.ebay.com/sell/inventory/v1/location/${encodeURIComponent(key)}`;
const DEFAULT_LOCATION_KEY = "cardpro-default-location";
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

// Real gotcha hit live: createOffer/updateOffer succeed without a
// merchantLocationKey, but publishOffer's fuller validation rejects the
// offer with a classic-API-style error ("No <Item.Country> exists") once
// there's no location to derive a country from. eBay's Inventory Location
// API is a separate, API-only concept from anything in classic Seller
// Hub — confirmed live via /api/offer-status diagnostics that a real
// account can have zero locations registered here with no obvious way to
// fix it from eBay's own site, which is why this tool now offers to
// create one itself (see createMerchantLocation() below) rather than
// just pointing the user at Seller Hub.
export async function getMerchantLocation(accessToken, fetchImpl = fetch) {
  const json = await ebayFetch(`${LOCATION_URL}?limit=1`, accessToken, {}, fetchImpl);
  return json.locations?.[0] ?? null;
}

export async function getMerchantLocationKey(accessToken, fetchImpl = fetch) {
  const location = await getMerchantLocation(accessToken, fetchImpl);
  if (!location?.merchantLocationKey) {
    throw new Error(
      "No eBay inventory location found — set one up under Shipping Location on My eBay Drafts " +
      "before publishing a listing."
    );
  }
  return location.merchantLocationKey;
}

// Creates (or, called again, replaces) the seller's one shipping-from
// location under a fixed key — this tool only ever needs one. Response
// is 204 with no body on success per eBay's docs (ebayFetch already
// returns null for 204). NOT yet verified against the live API — same
// caveat as other endpoints added this build without a way to test
// against the real API first.
export async function createMerchantLocation(address, accessToken, fetchImpl = fetch) {
  const body = {
    location: {
      address: {
        addressLine1: address.addressLine1,
        ...(address.addressLine2 ? { addressLine2: address.addressLine2 } : {}),
        city: address.city,
        stateOrProvince: address.stateOrProvince,
        postalCode: address.postalCode,
        country: address.country,
      },
    },
    locationTypes: ["WAREHOUSE"],
    merchantLocationStatus: "ENABLED",
    name: address.name || "Default shipping location",
  };
  await ebayFetch(
    LOCATION_BY_KEY_URL(DEFAULT_LOCATION_KEY),
    accessToken,
    { method: "POST", body: JSON.stringify(body) },
    fetchImpl
  );
  return DEFAULT_LOCATION_KEY;
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

// availability.shipToLocationAvailability.quantity lives on the inventory
// item (separate from the offer's own availableQuantity/pricingSummary).
// Confirmed live: eBay accepts a Fixed Price offer without it but rejects
// publishOffer for an Auction with "shipToLocationAvailability quantity
// insufficient to create auction listings" — set it unconditionally so
// both formats work rather than special-casing by format.
export function buildInventoryItemBody(card, draft, imageUrls) {
  return {
    condition: card.is_graded ? "USED_EXCELLENT" : "USED_GOOD",
    availability: { shipToLocationAvailability: { quantity: 1 } },
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
  // Real gotcha hit live: eBay does NOT omit `availability` on items
  // created before this field existed — it returns it explicitly with
  // `quantity: 0`. A `currentItem.availability || default` check is
  // truthy on that object and never backfills, so the 0 sticks around
  // forever and publish keeps failing with the same "insufficient
  // quantity" error. Check the actual quantity value, not just presence
  // of the object.
  const currentQty = currentItem.availability?.shipToLocationAvailability?.quantity;
  const availability = currentQty >= 1
    ? currentItem.availability
    : { shipToLocationAvailability: { quantity: 1 } };

  const body = {
    condition: currentItem.condition,
    availability,
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
//                     buy outright. Real gotcha hit live: there is no
//                     `pricingSummary.buyItNowPrice` field — eBay silently
//                     ignores it (no error, just never persists), which
//                     is worse than a rejection because it looks like it
//                     saved fine. The Inventory API reuses the same
//                     `pricingSummary.price` field FIXED_PRICE offers use
//                     as the "buy it now" amount on an auction, alongside
//                     `auctionStartPrice` for the bid floor — confirmed
//                     by the live error text itself when a payment policy
//                     with immediate-payment-required rejected a BIN-less
//                     auction: "...must specify a Buy It Now price",
//                     citing parameter "FIXED_PRICE", i.e. the same price
//                     field FIXED_PRICE format populates.
//   bestOffer       - FIXED_PRICE only. Optional { enabled, minimumPrice }.
//                     Best Offer is a Fixed-Price-only eBay feature —
//                     there is no such thing as Best Offer on an auction,
//                     so this is intentionally ignored when format is
//                     AUCTION rather than something we need to block.
//                     listingPolicies.bestOfferTerms field names are also
//                     unverified live — same caveat as buyItNowPrice.
export function buildOfferBody(sku, draft, categoryId, policies, price, format = "FIXED_PRICE", options = {}, merchantLocationKey) {
  const listingPolicies = {
    fulfillmentPolicyId: policies.fulfillmentPolicyId,
    returnPolicyId: policies.returnPolicyId,
  };
  if (policies.paymentPolicyId) listingPolicies.paymentPolicyId = policies.paymentPolicyId;

  const body = {
    sku,
    marketplaceId: MARKETPLACE_ID,
    format,
    categoryId,
    listingDescription: draft.description,
    listingPolicies,
  };
  // Required for publishOffer to resolve a country — see
  // getMerchantLocationKey()'s comment above. Optional here (rather than
  // always required) so callers that only need e.g. price validation
  // don't have to fetch a location first.
  if (merchantLocationKey) body.merchantLocationKey = merchantLocationKey;

  if (format === "AUCTION") {
    // Confirmed live: eBay rejects availableQuantity on auction offers
    // ("availableQuantity is not applicable for auction offer") — an
    // auction is inherently a single item, unlike fixed-price stock.
    body.pricingSummary = { auctionStartPrice: { value: String(price), currency: "USD" } };
    body.listingDuration = "DAYS_7";
    if (options.buyItNowPrice) {
      body.pricingSummary.price = { value: String(options.buyItNowPrice), currency: "USD" };
    }
  } else {
    body.availableQuantity = 1;
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
export async function createOffer(sku, draft, categoryId, policies, price, format = "FIXED_PRICE", options = {}, merchantLocationKey, accessToken, fetchImpl = fetch) {
  const json = await ebayFetch(
    OFFER_URL,
    accessToken,
    { method: "POST", body: JSON.stringify(buildOfferBody(sku, draft, categoryId, policies, price, format, options, merchantLocationKey)) },
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

export async function updateOffer(offerId, sku, draft, categoryId, policies, price, format, options = {}, merchantLocationKey, accessToken, fetchImpl = fetch) {
  await ebayFetch(
    OFFER_BY_ID_URL(offerId),
    accessToken,
    { method: "PUT", body: JSON.stringify(buildOfferBody(sku, draft, categoryId, policies, price, format, options, merchantLocationKey)) },
    fetchImpl
  );
}

export async function deleteOffer(offerId, accessToken, fetchImpl = fetch) {
  await ebayFetch(OFFER_BY_ID_URL(offerId), accessToken, { method: "DELETE" }, fetchImpl);
}

// Makes the offer live and visible to buyers — the one irreversible step
// this tool otherwise deliberately avoids calling. POST with no body per
// eBay's docs; response carries the resulting classic listingId. NOT
// verified against the live API yet (like several other endpoints added
// this build) — treat eBay's exact error shape here as a likely
// debugging-round candidate the first time this is actually used.
export async function publishOffer(offerId, accessToken, fetchImpl = fetch) {
  const json = await ebayFetch(OFFER_PUBLISH_URL(offerId), accessToken, { method: "POST" }, fetchImpl);
  return json.listingId;
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
