"""
Pulls active, Buy-It-Now eBay listings for each player in players_list.py
and writes per-player asking-price stats to docs/data/ebay_asking_prices.json.

IMPORTANT: this is ACTIVE LISTING ASKING PRICE data, not sold/transacted
price data. eBay's Browse API (available to any registered developer)
only exposes current listings — historical sold prices require eBay's
Marketplace Insights API, which needs separate business-level approval.
Asking prices tend to run higher than actual sale prices since sellers
list optimistically, so treat this as a directional signal, not a
substitute for real comps.

Filtering approach (best-effort, keyword-based — not exact classification):
  - Only Buy It Now listings (buyingOptions: FIXED_PRICE), no auctions
  - Query excludes common signals for autographed, numbered, and graded
    cards, to approximate "raw, non-numbered, non-auto" listings

Requires two environment variables (set as GitHub Actions secrets):
  EBAY_CLIENT_ID      - your eBay developer app's Client ID
  EBAY_CLIENT_SECRET  - your eBay developer app's Client Secret
"""

import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests

from players_list import PLAYERS

TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"
MARKETPLACE_ID = "EBAY_US"
PAGE_LIMIT = 50

EXCLUDE_TERMS = [
    "-auto", "-autograph", "-signed", "-numbered", "-relic", "-patch",
    "-psa", "-bgs", "-sgc", "-csg", "-graded", "-1/1", "-rc", "-rookie",
]


def get_access_token(client_id, client_secret):
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    resp = requests.post(
        TOKEN_URL,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope",
        },
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def build_query(player_name):
    terms = [player_name, "card"] + EXCLUDE_TERMS
    return " ".join(terms)


def fetch_listings(token, player_name):
    query = build_query(player_name)
    params = {
        "q": query,
        "filter": "buyingOptions:{FIXED_PRICE}",
        "limit": str(PAGE_LIMIT),
    }
    url = f"{SEARCH_URL}?{urlencode(params)}"
    resp = requests.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
        },
    )
    resp.raise_for_status()
    return resp.json().get("itemSummaries", [])


def summarize(listings):
    prices = []
    for item in listings:
        price = item.get("price", {})
        if price.get("currency") != "USD":
            continue
        try:
            prices.append(float(price["value"]))
        except (KeyError, ValueError, TypeError):
            continue

    if not prices:
        return {"listing_count": 0, "avg_asking_price": None, "min_asking_price": None, "max_asking_price": None}

    return {
        "listing_count": len(prices),
        "avg_asking_price": round(sum(prices) / len(prices), 2),
        "min_asking_price": round(min(prices), 2),
        "max_asking_price": round(max(prices), 2),
    }


def main():
    client_id = os.environ["EBAY_CLIENT_ID"]
    client_secret = os.environ["EBAY_CLIENT_SECRET"]
    token = get_access_token(client_id, client_secret)

    results = []
    for entry in PLAYERS:
        player_name, sport = entry["player"], entry["sport"]
        try:
            listings = fetch_listings(token, player_name)
        except requests.HTTPError as e:
            print(f"Skipping {player_name}: {e}", file=sys.stderr)
            continue

        stats = summarize(listings)
        results.append({"player": player_name, "sport": sport, **stats})
        time.sleep(0.2)  # stay well under eBay's rate limits

    out_path = os.path.join(
        os.path.dirname(__file__), "..", "docs", "data", "ebay_asking_prices.json"
    )
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            "Active Buy-It-Now listing asking prices from eBay Browse API, "
            "filtered by keyword to approximate raw/non-numbered/non-auto/"
            "non-graded cards. NOT sold/transacted prices."
        ),
        "players": results,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote asking-price stats for {len(results)} players to {out_path}")


if __name__ == "__main__":
    main()
