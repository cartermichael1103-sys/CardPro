// Set this to your deployed Cloudflare Worker URL after running
// `wrangler deploy` from the worker/ directory (see worker/README.md).
const WORKER_URL = "https://cardpro-listing-worker.cartermichael1103.workers.dev";

let selectedImages = []; // [{ data: base64, media_type }]

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
  const comps = payload.comps;
  const draft = payload.draft;

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

  if (comps.error) {
    document.getElementById("comps-summary").textContent = "Comp lookup failed: " + comps.error;
  } else if (comps.listing_count === 0) {
    document.getElementById("comps-summary").textContent = "No comparable active listings found, even with a broadened search.";
  } else {
    const broadenedNote = comps.broadened
      ? " (no exact match for the specific year/brand/parallel, so this is a broader player-level search — treat it as a rougher signal.)"
      : "";
    document.getElementById("comps-summary").textContent =
      `${comps.listing_count} comparable active listings — ` +
      `avg $${comps.avg_asking_price}, median $${comps.median_asking_price}, ` +
      `range $${comps.min_asking_price}–$${comps.max_asking_price}.${broadenedNote} ${comps.note}`;
  }

  document.getElementById("draft-photos").innerHTML = selectedImages
    .map((img) => `<img class="preview-thumb" src="data:${img.media_type};base64,${img.data}">`)
    .join("");

  document.getElementById("draft-title").value = draft.title;
  document.getElementById("draft-description").value = draft.description;
  document.getElementById("draft-price").textContent =
    draft.suggested_price != null ? `$${draft.suggested_price} (${draft.price_basis})` : "No comps available";
}

async function handleAnalyze() {
  if (!isConfigured()) {
    document.getElementById("worker-not-configured").hidden = false;
    setStatus("Backend not configured — see message above.", true);
    return;
  }

  document.getElementById("analyze-btn").disabled = true;
  setStatus("Analyzing photo(s) and fetching comps — this can take 10-20 seconds...");

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
document.querySelectorAll(".copy-btn").forEach((btn) => btn.addEventListener("click", handleCopyClick));

if (!isConfigured()) {
  document.getElementById("worker-not-configured").hidden = false;
}
