// Set this to your deployed Cloudflare Worker URL (same one list-card.js uses).
const WORKER_URL = "https://cardpro-listing-worker.cartermichael1103.workers.dev";

let draftsBySku = {};
let editingSku = null;

function isConfigured() {
  return WORKER_URL && !WORKER_URL.startsWith("REPLACE_WITH");
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.style.color = isError ? "var(--sell)" : "var(--muted)";
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function viewCardHTML(draft) {
  const thumb = draft.imageUrls && draft.imageUrls[0]
    ? `<img class="preview-thumb" src="${draft.imageUrls[0]}">`
    : `<div class="preview-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:0.7rem">No photo</div>`;

  const price = draft.price ? `$${draft.price.value}` : "No price set";
  const statusClass = draft.status === "PUBLISHED" ? "signal-sell" : "signal-buy";
  const description = (draft.description || "").slice(0, 200);
  const canEdit = Boolean(draft.offerId); // editing needs an offer to attach price/format to

  return `
    <div class="board-row" style="grid-template-columns: 90px 1fr; align-items: start; cursor: default;">
      ${thumb}
      <div>
        <div class="cell-player" style="margin-bottom: 4px">${escapeHtml(draft.title) || "(no title)"}</div>
        <div style="font-size: 0.82rem; color: var(--muted); margin-bottom: 6px">${escapeHtml(description)}${(draft.description || "").length > 200 ? "…" : ""}</div>
        <span class="signal-chip ${statusClass}">${draft.status}</span>
        <span style="margin-left: 10px; font-family: 'SF Mono', monospace">${price}</span>
        <span style="margin-left: 10px; color: var(--muted); font-size: 0.75rem">${draft.format || ""}</span>
        <span style="margin-left: 10px; color: var(--muted); font-size: 0.75rem">SKU: ${draft.sku}</span>
        <div style="margin-top: 8px">
          ${canEdit ? `<button type="button" class="copy-btn edit-btn" data-sku="${draft.sku}">Edit</button>` : ""}
          <button type="button" class="copy-btn delete-btn" data-sku="${draft.sku}" data-offer="${draft.offerId || ""}" style="background: var(--sell); margin-left: 8px">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function editCardHTML(draft) {
  const photoRow = (draft.imageUrls || []).map((url, i) => `
    <div style="display:inline-block; text-align:center; margin-right: 8px">
      <img class="preview-thumb" src="${url}">
      <div style="margin-top: 4px">
        <button type="button" class="copy-btn photo-up" data-sku="${draft.sku}" data-idx="${i}" ${i === 0 ? "disabled" : ""} style="padding: 2px 8px">↑</button>
        <button type="button" class="copy-btn photo-down" data-sku="${draft.sku}" data-idx="${i}" ${i === draft.imageUrls.length - 1 ? "disabled" : ""} style="padding: 2px 8px">↓</button>
      </div>
    </div>
  `).join("");

  const price = draft.price ? draft.price.value : "";

  return `
    <div class="board-row" style="grid-template-columns: 1fr; align-items: start; cursor: default;">
      <label>Photos (first shown is the listing's main photo)</label>
      <div style="margin: 8px 0">${photoRow}</div>

      <label>Title</label>
      <input type="text" class="draft-input edit-title" value="${escapeHtml(draft.title)}">

      <label style="margin-top: 8px; display: block">Description</label>
      <textarea class="draft-input edit-description" rows="6">${escapeHtml(draft.description)}</textarea>

      <div style="display: flex; gap: 16px; margin-top: 8px; flex-wrap: wrap">
        <div>
          <label>Price (USD)</label>
          <input type="number" class="draft-input edit-price" min="0.01" step="0.01" value="${price}" style="max-width: 140px">
        </div>
        <div>
          <label>Listing type</label>
          <select class="draft-input edit-format" style="max-width: 160px">
            <option value="FIXED_PRICE" ${draft.format === "FIXED_PRICE" ? "selected" : ""}>Buy It Now</option>
            <option value="AUCTION" ${draft.format === "AUCTION" ? "selected" : ""}>Auction</option>
          </select>
        </div>
      </div>

      <div style="margin-top: 12px">
        <button type="button" class="copy-btn save-edit-btn" data-sku="${draft.sku}">Save</button>
        <button type="button" class="copy-btn cancel-edit-btn" data-sku="${draft.sku}" style="margin-left: 8px">Cancel</button>
      </div>
      <p class="edit-status updated" data-sku="${draft.sku}"></p>
    </div>
  `;
}

function render() {
  const grid = document.getElementById("drafts-grid");
  const drafts = Object.values(draftsBySku);
  grid.innerHTML = drafts
    .map((d) => (d.sku === editingSku ? editCardHTML(d) : viewCardHTML(d)))
    .join("");
  attachRowHandlers();
}

function attachRowHandlers() {
  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => { editingSku = btn.dataset.sku; render(); });
  });
  document.querySelectorAll(".cancel-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => { editingSku = null; render(); });
  });
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleDelete(btn.dataset.sku, btn.dataset.offer));
  });
  document.querySelectorAll(".save-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleSaveEdit(btn.dataset.sku));
  });
  document.querySelectorAll(".photo-up").forEach((btn) => {
    btn.addEventListener("click", () => movePhoto(btn.dataset.sku, Number(btn.dataset.idx), -1));
  });
  document.querySelectorAll(".photo-down").forEach((btn) => {
    btn.addEventListener("click", () => movePhoto(btn.dataset.sku, Number(btn.dataset.idx), 1));
  });
}

function movePhoto(sku, idx, direction) {
  const draft = draftsBySku[sku];
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= draft.imageUrls.length) return;
  const urls = [...draft.imageUrls];
  [urls[idx], urls[newIdx]] = [urls[newIdx], urls[idx]];
  draft.imageUrls = urls;
  render();
}

async function handleSaveEdit(sku) {
  const draft = draftsBySku[sku];
  const row = document.querySelector(`.save-edit-btn[data-sku="${sku}"]`).closest(".board-row");
  const title = row.querySelector(".edit-title").value;
  const description = row.querySelector(".edit-description").value;
  const price = parseFloat(row.querySelector(".edit-price").value);
  const format = row.querySelector(".edit-format").value;
  const statusEl = row.querySelector(".edit-status");

  if (!Number.isFinite(price) || price <= 0) {
    statusEl.textContent = "Enter a valid price.";
    statusEl.style.color = "var(--sell)";
    return;
  }

  statusEl.style.color = "var(--muted)";
  statusEl.textContent = "Saving…";

  try {
    const res = await fetch(`${WORKER_URL}/api/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku, offerId: draft.offerId, title, description,
        imageUrls: draft.imageUrls, price, format,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      statusEl.textContent = "Error: " + (json.error || res.statusText);
      statusEl.style.color = "var(--sell)";
      return;
    }
    Object.assign(draft, { title, description, price: { value: String(price), currency: "USD" }, format });
    editingSku = null;
    render();
    setStatus("Draft updated.");
  } catch (e) {
    statusEl.textContent = "Request failed: " + e.message;
    statusEl.style.color = "var(--sell)";
  }
}

async function handleDelete(sku, offerId) {
  if (!confirm("Delete this draft from your eBay account? This can't be undone.")) return;

  try {
    const res = await fetch(`${WORKER_URL}/api/draft?sku=${encodeURIComponent(sku)}&offerId=${encodeURIComponent(offerId)}`, {
      method: "DELETE",
    });
    const json = await res.json();
    if (!res.ok) {
      setStatus("Error deleting: " + (json.error || res.statusText), true);
      return;
    }
    delete draftsBySku[sku];
    render();
    setStatus("Draft deleted.");
  } catch (e) {
    setStatus("Delete request failed: " + e.message, true);
  }
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

    if (json.drafts.length === 0) {
      setStatus("No drafts found yet — save one from the New Listing page.");
      return;
    }

    draftsBySku = Object.fromEntries(json.drafts.map((d) => [d.sku, d]));
    document.getElementById("drafts-grid").style.display = "block";
    render();
    setStatus(`${json.drafts.length} draft${json.drafts.length === 1 ? "" : "s"}.`);
  } catch (e) {
    setStatus("Request failed: " + e.message, true);
  }
}

loadDrafts();
