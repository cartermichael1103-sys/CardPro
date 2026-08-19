// Set this to your deployed Cloudflare Worker URL after running
// `wrangler deploy` from the worker/ directory (see worker/README.md).
const WORKER_URL = "https://cardpro-listing-worker.cartermichael1103.workers.dev";

let selectedImages = []; // [{ data: base64, media_type }]
let lastIdentifiedCard = null;

function isConfigured() {
  return WORKER_URL && !WORKER_URL.startsWith("REPLACE_WITH");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result; // data:<mime>;base64,<data>
      const commaIdx = result.indexOf(",");
      resolve(result.slice(commaIdx + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleFileChange(e) {
  const files = Array.from(e.target.files || []);
  const previewRow = document.getElementById("preview-row");
  previewRow.innerHTML = "";
  selectedImages = [];

  for (const file of files.slice(0, 4)) {
    const data = await fileToBase64(file);
    selectedImages.push({ data, media_type: file.type });

    const img = document.createElement("img");
    img.src = `data:${file.type};base64,${data}`;
    img.className = "preview-thumb";
    previewRow.appendChild(img);
  }

  document.getElementById("analyze-btn").disabled = selectedImages.length === 0;
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.style.color = isError ? "var(--sell)" : "var(--muted)";
}

function fieldRow(label, value) {
  return `<div class="modal-stat"><div class="modal-stat-label">${label}</div><div class="modal-stat-value">${value ?? "—"}</div></div>`;
}

function renderResult(payload) {
  const card = payload.identified;
  const draft = payload.draft;
  lastIdentifiedCard = card;

  document.getElementById("result-panel").hidden = false;

  const confidenceNote = card.uncertain_fields && card.uncertain_fields.length
    ? `AI confidence: ${card.confidence}. Uncertain about: ${card.uncertain_fields.join(", ")} — verify these against the physical card.`
    : `AI confidence: ${card.confidence}. Verify against the physical card before listing.`;
  document.getElementById("confidence-note").textContent = confidenceNote;

  document.getElementById("card-fields").innerHTML = [
    fieldRow("Player", card.player),
    fieldRow("Sport", card.sport),
    fieldRow("Year", card.year),
    fieldRow("Brand/Set", card.brand),
    fieldRow("Parallel", card.parallel),
    fieldRow("Card #", card.card_number),
    fieldRow("Rookie", card.is_rookie ? "Yes" : "No"),
    fieldRow("Serial #", card.serial_number),
    fieldRow("Autograph", card.is_autograph ? "Yes" : "No"),
    fieldRow("Graded", card.is_graded ? `${card.grading_company || ""} ${card.grade || ""}`.trim() : "No (raw)"),
  ].join("");

  document.getElementById("draft-photos").innerHTML = selectedImages
    .map((img) => `<img class="preview-thumb" src="data:${img.media_type};base64,${img.data}">`)
    .join("");

  document.getElementById("draft-title").value = draft.title;
  document.getElementById("draft-description").value = draft.description;

  document.getElementById("save-ebay-draft-btn").disabled = false;
  document.getElementById("save-draft-status").textContent = "";
}

async function handleAnalyze() {
  if (!isConfigured()) {
    document.getElementById("worker-not-configured").hidden = false;
    setStatus("Backend not configured — see message above.", true);
    return;
  }

  document.getElementById("analyze-btn").disabled = true;
  setStatus("Identifying card — this can take 10-20 seconds...");

  try {
    const res = await fetch(`${WORKER_URL}/api/draft-listing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: selectedImages }),
    });

    const payload = await res.json();

    if (!res.ok) {
      setStatus("Error: " + (payload.error || res.statusText), true);
      return;
    }

    renderResult(payload);
    setStatus("Done. Review everything below before listing — AI-identified details can be wrong.");
  } catch (e) {
    setStatus("Request failed: " + e.message, true);
  } finally {
    document.getElementById("analyze-btn").disabled = false;
  }
}

async function refreshEbayStatus() {
  const statusText = document.getElementById("ebay-status-text");
  const connectBtn = document.getElementById("ebay-connect-btn");

  if (!isConfigured()) {
    statusText.textContent = "";
    connectBtn.hidden = true;
    return;
  }

  try {
    const res = await fetch(`${WORKER_URL}/api/ebay-status`);
    const json = await res.json();
    if (json.connected) {
      statusText.textContent = "eBay account connected ✓";
      connectBtn.hidden = true;
    } else {
      statusText.textContent = "Not connected to eBay — connect to save drafts directly to your account.";
      connectBtn.hidden = false;
    }
  } catch (e) {
    statusText.textContent = "Could not check eBay connection status: " + e.message;
    connectBtn.hidden = false;
  }
}

function handleEbayOAuthRedirectParams() {
  const params = new URLSearchParams(window.location.search);
  const statusText = document.getElementById("ebay-status-text");

  if (params.get("ebay_connected") === "1") {
    statusText.textContent = "eBay account connected ✓";
  } else if (params.get("ebay_error")) {
    statusText.textContent = "eBay connection failed: " + params.get("ebay_error");
    statusText.style.color = "var(--sell)";
  }

  if (params.has("ebay_connected") || params.has("ebay_error")) {
    params.delete("ebay_connected");
    params.delete("ebay_error");
    const newSearch = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (newSearch ? `?${newSearch}` : ""));
  }
}

async function handleSaveEbayDraft() {
  const priceInput = document.getElementById("draft-price-input");
  const price = parseFloat(priceInput.value);
  const statusEl = document.getElementById("save-draft-status");

  if (!Number.isFinite(price) || price <= 0) {
    statusEl.textContent = "Enter a price before saving.";
    statusEl.style.color = "var(--sell)";
    return;
  }
  if (!lastIdentifiedCard) {
    statusEl.textContent = "Identify a card first.";
    statusEl.style.color = "var(--sell)";
    return;
  }

  const format = document.getElementById("draft-format-input").value;
  const extra = {};
  if (format === "AUCTION") {
    const binVal = document.getElementById("draft-bin-price").value;
    if (binVal) extra.buyItNowPrice = parseFloat(binVal);
  } else {
    const bestOfferEnabled = document.getElementById("draft-best-offer-enabled").checked;
    extra.bestOfferEnabled = bestOfferEnabled;
    if (bestOfferEnabled) {
      const minVal = document.getElementById("draft-best-offer-min").value;
      if (minVal) extra.bestOfferMinimumPrice = parseFloat(minVal);
    }
  }

  const saveBtn = document.getElementById("save-ebay-draft-btn");
  saveBtn.disabled = true;
  statusEl.style.color = "var(--muted)";
  statusEl.textContent = "Saving draft to eBay — this can take several seconds...";

  try {
    const res = await fetch(`${WORKER_URL}/api/save-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: selectedImages,
        card: lastIdentifiedCard,
        draft: {
          title: document.getElementById("draft-title").value,
          description: document.getElementById("draft-description").value,
        },
        price,
        format,
        ...extra,
      }),
    });
    const json = await res.json();

    if (!res.ok) {
      statusEl.textContent = "Error: " + (json.error || res.statusText);
      statusEl.style.color = "var(--sell)";
      return;
    }

    statusEl.textContent = json.message + ` (offer ${json.offerId})`;
    statusEl.style.color = "var(--accent)";
  } catch (e) {
    statusEl.textContent = "Request failed: " + e.message;
    statusEl.style.color = "var(--sell)";
  } finally {
    saveBtn.disabled = false;
  }
}

function handleCopyClick(e) {
  const targetId = e.target.dataset.target;
  const el = document.getElementById(targetId);
  navigator.clipboard.writeText(el.value).then(() => {
    const original = e.target.textContent;
    e.target.textContent = "Copied!";
    setTimeout(() => { e.target.textContent = original; }, 1500);
  });
}

document.getElementById("photo-input").addEventListener("change", handleFileChange);
document.getElementById("analyze-btn").addEventListener("click", handleAnalyze);
document.querySelectorAll(".copy-btn[data-target]").forEach((btn) => btn.addEventListener("click", handleCopyClick));
document.getElementById("ebay-connect-btn").addEventListener("click", () => {
  window.location.href = `${WORKER_URL}/oauth/start`;
});
document.getElementById("save-ebay-draft-btn").addEventListener("click", handleSaveEbayDraft);
document.getElementById("draft-format-input").addEventListener("change", (e) => {
  const isAuction = e.target.value === "AUCTION";
  document.getElementById("auction-fields").style.display = isAuction ? "block" : "none";
  document.getElementById("fixedprice-fields").style.display = isAuction ? "none" : "block";
});

if (!isConfigured()) {
  document.getElementById("worker-not-configured").hidden = false;
} else {
  handleEbayOAuthRedirectParams();
  refreshEbayStatus();
}
