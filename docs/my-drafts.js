// Set this to your deployed Cloudflare Worker URL (same one list-card.js uses).
const WORKER_URL = "https://cardpro-listing-worker.cartermichael1103.workers.dev";

function isConfigured() {
  return WORKER_URL && !WORKER_URL.startsWith("REPLACE_WITH");
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.style.color = isError ? "var(--sell)" : "var(--muted)";
}

function draftCardHTML(draft) {
  const thumb = draft.imageUrls && draft.imageUrls[0]
    ? `<img class="preview-thumb" src="${draft.imageUrls[0]}">`
    : `<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem">No photo</div>`;

  const price = draft.price ? `$${draft.price.value}` : "No price set";
  const statusClass = draft.status === "PUBLISHED" ? "signal-sell" : "signal-buy";
  const description = (draft.description || "").slice(0, 200);

  return `
    <div class="board-row" style="grid-template-columns: 90px 1fr; align-items: start; cursor: default;">
      ${thumb}
      <div>
        <div class="cell-player" style="margin-bottom: 4px">${draft.title || "(no title)"}</div>
        <div style="font-size: 0.82rem; color: var(--muted); margin-bottom: 6px">${description}${(draft.description || "").length > 200 ? "…" : ""}</div>
        <span class="signal-chip ${statusClass}">${draft.status}</span>
        <span style="margin-left: 10px; font-family: 'SF Mono', monospace">${price}</span>
        <span style="margin-left: 10px; color: var(--muted); font-size: 0.75rem">SKU: ${draft.sku}</span>
      </div>
    </div>
  `;
}

async function loadDrafts() {
  if (!isConfigured()) {
    document.getElementById("worker-not-configured").hidden = false;
    setStatus("Backend not configured.", true);
    return;
  }

  try {
    const res = await fetch(`${WORKER_URL}/api/drafts`);
    const json = await res.json();

    if (!res.ok) {
      if (res.status === 401) {
        setStatus("Not connected to eBay — go to New Listing and click Connect to eBay first.", true);
      } else {
        setStatus("Error: " + (json.error || res.statusText), true);
      }
      return;
    }

    const grid = document.getElementById("drafts-grid");
    if (json.drafts.length === 0) {
      setStatus("No drafts found yet — save one from the New Listing page.");
      return;
    }

    grid.style.display = "block";
    grid.innerHTML = json.drafts.map(draftCardHTML).join("");
    setStatus(`${json.drafts.length} draft${json.drafts.length === 1 ? "" : "s"}.`);
  } catch (e) {
    setStatus("Request failed: " + e.message, true);
  }
}

loadDrafts();
