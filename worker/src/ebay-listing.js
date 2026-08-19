const CATEGORY_TREE_ID_URL = "https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id";
const CATEGORY_SUGGESTIONS_URL = (treeId) =>
  `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions`;
const FULFILLMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/fulfillment_policy";
const PAYMENT_POLICY_URL = "https://api.ebay.com/sell/account/v1/payment_policy";
const RETURN_POLICY_URL = "https://api.ebay.com/sell/account/v1/return_policy";
const INVENTORY_ITEM_URL = (sku) => `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
const OFFER_URL = "https://api.ebay.com/sell/inventory/v1/offer";
const OFFER_BY_ID_URL = (offerId) => `https://api.ebay.com/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
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
    throw new Error(`eBay API ${options.method || "GET"} ${url} -> ${resp.status}: ${text.slice(0, 500)}`);
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

export function buildOfferBody(sku, draft, categoryId, policies, price) {
  const listingPolicies = {
    fulfillmentPolicyId: policies.fulfillmentPolicyId,
    returnPolicyId: policies.returnPolicyId,
  };
  if (policies.paymentPolicyId) listingPolicies.paymentPolicyId = policies.paymentPolicyId;

  return {
    sku,
    marketplaceId: MARKETPLACE_ID,
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId,
    listingDescription: draft.description,
    listingPolicies,
    pricingSummary: { price: { value: String(price), currency: "USD" } },
  };
}

// Creates the Offer but deliberately never calls publishOffer — this is
// the draft state, not visible to buyers, reviewable in Seller Hub.
export async function createOffer(sku, draft, categoryId, policies, price, accessToken, fetchImpl = fetch) {
  const json = await ebayFetch(
    OFFER_URL,
    accessToken,
    { method: "POST", body: JSON.stringify(buildOfferBody(sku, draft, categoryId, policies, price)) },
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
