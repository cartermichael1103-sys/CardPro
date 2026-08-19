const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const MARKETPLACE_ID = "EBAY_US";
const PAGE_LIMIT = 50;

export async function getEbayToken(clientId, clientSecret, fetchImpl = fetch) {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBay token error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  return json.access_token;
}

// Builds a search query tailored to the SPECIFIC card identified, unlike
// the site's general asking-price index (pull_ebay_prices.py) which always
// excludes numbered/auto/graded to approximate a generic raw-card baseline.
// Here we want comps for exactly what the user actually has.
export function buildQuery(card) {
  const terms = [card.player, card.year, card.brand, card.parallel].filter(Boolean);
  terms.push("card");

  if (card.is_autograph) {
    terms.push("auto");
  } else {
    terms.push("-auto", "-autograph", "-signed");
  }

  if (card.serial_number) {
    // e.g. "23/99" -> search for the print run size, "/99"
    const runSize = card.serial_number.split("/")[1];
    if (runSize) terms.push(`/${runSize}`);
  } else {
    terms.push("-numbered");
  }

  if (card.is_graded && card.grading_company) {
    terms.push(card.grading_company);
    if (card.grade) terms.push(card.grade);
  } else {
    terms.push("-psa", "-bgs", "-sgc", "-csg", "-graded");
  }

  return terms.join(" ");
}

export async function fetchComps(card, token, fetchImpl = fetch) {
  const query = buildQuery(card);
  const buyingOptions = card.is_graded ? "FIXED_PRICE|AUCTION" : "FIXED_PRICE";
  const params = new URLSearchParams({
    q: query,
    filter: `buyingOptions:{${buyingOptions}}`,
    limit: String(PAGE_LIMIT),
  });

  const resp = await fetchImpl(`${SEARCH_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`eBay search error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  return { listings: json.itemSummaries || [], query };
}

function median(sortedNums) {
  const n = sortedNums.length;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

export function summarizeComps(listings) {
  const prices = listings
    .filter((item) => item.price && item.price.currency === "USD")
    .map((item) => parseFloat(item.price.value))
    .filter((v) => !Number.isNaN(v));

  if (prices.length === 0) {
    return {
      listing_count: 0,
      avg_asking_price: null,
      median_asking_price: null,
      min_asking_price: null,
      max_asking_price: null,
    };
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    listing_count: prices.length,
    avg_asking_price: round2(prices.reduce((a, b) => a + b, 0) / prices.length),
    median_asking_price: round2(median(sorted)),
    min_asking_price: round2(sorted[0]),
    max_asking_price: round2(sorted[sorted.length - 1]),
  };
}
