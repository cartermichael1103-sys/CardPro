"""
Pulls the Players tab from a Google Sheet and writes docs/data/players.json.

Requires two environment variables (set as GitHub Actions secrets):
  GOOGLE_SERVICE_ACCOUNT_JSON  - full JSON key for a Google service account,
                                 as a single-line string
  SHEET_ID                     - the ID from your Google Sheet's URL
                                 (the long string between /d/ and /edit)

The Sheet must be shared with the service account's email address
(found inside the JSON key as "client_email"), with at least Viewer access.

Expected tab name: "Players"
Expected header row (row 1), columns can be in any order:
  rank, player, sport, avg_sale, psa10_avg, sales_per_week, liquidity_score,
  bvs, prospect_grade, rookie_year, rookie_card_year, bowman_1st,
  chrome_available, prizm_available, optic_available, topps_available,
  trend_30day, signal, risk, notes
"""

import json
import os
import sys
from datetime import datetime, timezone

from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
RANGE_NAME = "Players!A1:Z1000"

NUMERIC_FIELDS = {
    "rank", "avg_sale", "psa10_avg", "sales_per_week",
    "liquidity_score", "bvs"
}

# How many past snapshots to keep in history.json (one snapshot per workflow run)
MAX_HISTORY_SNAPSHOTS = 200


def get_service():
    creds_json = os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]
    creds_info = json.loads(creds_json)
    creds = service_account.Credentials.from_service_account_info(
        creds_info, scopes=SCOPES
    )
    return build("sheets", "v4", credentials=creds)


def fetch_rows(service, sheet_id):
    sheet = service.spreadsheets()
    result = sheet.values().get(
        spreadsheetId=sheet_id, range=RANGE_NAME
    ).execute()
    return result.get("values", [])


def rows_to_records(rows):
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]
    records = []
    for row in rows[1:]:
        if not row or not row[0]:
            continue
        record = {}
        for i, key in enumerate(header):
            value = row[i] if i < len(row) else ""
            if key in NUMERIC_FIELDS:
                try:
                    value = float(value) if value != "" else 0
                    if value == int(value):
                        value = int(value)
                except ValueError:
                    value = 0
            record[key] = value
        records.append(record)
    return records


def append_history_snapshot(records, history_path):
    if os.path.exists(history_path):
        with open(history_path) as f:
            history = json.load(f)
    else:
        history = {"snapshots": []}

    snapshot = {
        "date": datetime.now(timezone.utc).isoformat(),
        "players": [
            {
                "player": r.get("player"),
                "avg_sale": r.get("avg_sale"),
                "bvs": r.get("bvs"),
                "signal": r.get("signal"),
            }
            for r in records
        ],
    }
    history["snapshots"].append(snapshot)
    history["snapshots"] = history["snapshots"][-MAX_HISTORY_SNAPSHOTS:]

    with open(history_path, "w") as f:
        json.dump(history, f, indent=2)


def main():
    sheet_id = os.environ["SHEET_ID"]
    service = get_service()
    rows = fetch_rows(service, sheet_id)
    records = rows_to_records(rows)

    data_dir = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
    out_path = os.path.join(data_dir, "players.json")
    with open(out_path, "w") as f:
        json.dump(records, f, indent=2)

    history_path = os.path.join(data_dir, "history.json")
    append_history_snapshot(records, history_path)

    print(f"Wrote {len(records)} players to {out_path}")
    print(f"Appended history snapshot to {history_path}")


if __name__ == "__main__":
    main()
