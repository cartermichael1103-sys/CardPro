let players = [];
let sortKey = "rank";
let sortDir = 1;

let ebayPlayers = [];
let ebaySortKey = "avg_asking_price";
let ebaySortDir = -1;

async function loadData() {
  const res = await fetch("data/players.json?_=" + Date.now());
  players = await res.json();

  try {
    const head = await fetch("data/players.json", { method: "HEAD" });
    const lastMod = head.headers.get("last-modified");
    if (lastMod) {
      document.getElementById("last-updated").textContent =
        "Last updated: " + new Date(lastMod).toLocaleString();
    }
  } catch (e) { /* not critical */ }

  render();
  loadEbayData();
}

async function loadEbayData() {
  try {
    const res = await fetch("data/ebay_asking_prices.json?_=" + Date.now());
    if (!res.ok) return;
    const payload = await res.json();
    ebayPlayers = payload.players || [];

    if (payload.generated_at) {
      document.getElementById("ebay-last-updated").textContent =
        "Last updated: " + new Date(payload.generated_at).toLocaleString();
    }
    if (payload.note) {
      document.getElementById("ebay-disclaimer").title = payload.note;
    }

    renderEbay();
  } catch (e) { /* eBay data not generated yet */ }
}

function trendClass(trend) {
  return "trend-" + (trend || "flat");
}

function signalClass(signal) {
  return "signal-" + (signal || "").toLowerCase();
}

function render() {
  const search = document.getElementById("search").value.toLowerCase();
  const sportFilter = document.getElementById("sport-filter").value;
  const signalFilter = document.getElementById("signal-filter").value;

  let rows = players.filter(p => {
    const matchesSearch = p.player.toLowerCase().includes(search);
    const matchesSport = sportFilter === "all" || p.sport === sportFilter;
    const matchesSignal = signalFilter === "all" || p.signal === signalFilter;
    return matchesSearch && matchesSport && matchesSignal;
  });

  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  const tbody = document.getElementById("player-rows");
  tbody.innerHTML = rows.map(p => `
    <tr>
      <td>${p.rank}</td>
      <td>${p.player}</td>
      <td>${p.sport}</td>
      <td>$${p.avg_sale}</td>
      <td>${p.bvs}</td>
      <td class="${trendClass(p.trend_30day)}"></td>
      <td class="${signalClass(p.signal)}">${p.signal}</td>
      <td>${p.risk}</td>
      <td>${p.notes || ""}</td>
    </tr>
  `).join("");
}

function renderEbay() {
  let rows = [...ebayPlayers];

  rows.sort((a, b) => {
    const av = a[ebaySortKey], bv = b[ebaySortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * ebaySortDir;
    return String(av).localeCompare(String(bv)) * ebaySortDir;
  });

  const tbody = document.getElementById("ebay-rows");
  tbody.innerHTML = rows.map(p => `
    <tr>
      <td>${p.player}</td>
      <td>${p.sport}</td>
      <td>${p.avg_asking_price != null ? "$" + p.avg_asking_price : "—"}</td>
      <td>${p.min_asking_price != null ? "$" + p.min_asking_price : "—"}</td>
      <td>${p.max_asking_price != null ? "$" + p.max_asking_price : "—"}</td>
      <td>${p.listing_count}</td>
    </tr>
  `).join("");
}

document.getElementById("search").addEventListener("input", render);
document.getElementById("sport-filter").addEventListener("change", render);
document.getElementById("signal-filter").addEventListener("change", render);

document.querySelectorAll("#player-table th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    render();
  });
});

document.querySelectorAll("#ebay-table th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (ebaySortKey === key) ebaySortDir *= -1;
    else { ebaySortKey = key; ebaySortDir = 1; }
    renderEbay();
  });
});

loadData();
