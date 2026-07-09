let players = [];
let sortKey = "rank";
let sortDir = 1;

let ebayPlayers = [];
let ebaySortKey = "avg_asking_price";
let ebaySortDir = -1;

let history = { snapshots: [] };
let currentView = "table";

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
  renderBoard();
  loadEbayData();
  loadHistory();
}

async function loadHistory() {
  try {
    const res = await fetch("data/history.json?_=" + Date.now());
    if (!res.ok) return;
    history = await res.json();
  } catch (e) { /* history not generated yet */ }
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

function filteredPlayers() {
  const search = document.getElementById("search").value.toLowerCase();
  const sportFilter = document.getElementById("sport-filter").value;
  const signalFilter = document.getElementById("signal-filter").value;

  return players.filter(p => {
    const matchesSearch = p.player.toLowerCase().includes(search);
    const matchesSport = sportFilter === "all" || p.sport === sportFilter;
    const matchesSignal = signalFilter === "all" || p.signal === signalFilter;
    return matchesSearch && matchesSport && matchesSignal;
  });
}

function render() {
  let rows = filteredPlayers();

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

function trendArrow(trend) {
  return { up_strong: "↑↑", up: "↑", flat: "→", down: "↓" }[trend] || "→";
}

function renderBoard() {
  let rows = filteredPlayers();
  rows.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

  const container = document.getElementById("board-rows");
  container.innerHTML = rows.map(p => `
    <div class="board-row ${signalClass(p.signal)}" data-player="${p.player.replace(/"/g, "&quot;")}">
      <span class="cell-player">${p.player}</span>
      <span class="cell-sport">${p.sport}</span>
      <span>$${p.avg_sale}</span>
      <span>${p.bvs}</span>
      <span class="${trendClass(p.trend_30day)}">${trendArrow(p.trend_30day)}</span>
      <span class="signal-chip ${signalClass(p.signal)}">${p.signal}</span>
    </div>
  `).join("");

  container.querySelectorAll(".board-row").forEach(row => {
    row.addEventListener("click", () => openModal(row.dataset.player));
  });
}

function playerHistorySeries(playerName) {
  return history.snapshots
    .map(s => {
      const entry = (s.players || []).find(p => p.player === playerName);
      return entry ? { date: s.date, avg_sale: entry.avg_sale, bvs: entry.bvs, signal: entry.signal } : null;
    })
    .filter(Boolean);
}

function buildChartSVG(series) {
  const width = 560, height = 160, padX = 30, padY = 16;

  if (series.length === 0) {
    return `<div class="chart-empty">No history yet — check back after future data pulls.</div>`;
  }
  if (series.length === 1) {
    return `<div class="chart-empty">Only one data point so far ($${series[0].avg_sale}). The trend line fills in after future updates.</div>`;
  }

  const values = series.map(s => s.avg_sale);
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;

  const points = series.map((s, i) => {
    const x = padX + (i / (series.length - 1)) * (width - padX * 2);
    const y = height - padY - ((s.avg_sale - min) / range) * (height - padY * 2);
    return { x, y, value: s.avg_sale };
  });

  const isUp = series[series.length - 1].avg_sale >= series[0].avg_sale;
  const lineColor = isUp ? "#4ade80" : "#f87171";
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const dots = points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${lineColor}" />`).join("");
  const firstDate = new Date(series[0].date).toLocaleDateString();
  const lastDate = new Date(series[series.length - 1].date).toLocaleDateString();

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
      <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2" />
      ${dots}
      <text x="${padX}" y="${height - 2}" class="chart-axis-label">${firstDate}</text>
      <text x="${width - padX}" y="${height - 2}" class="chart-axis-label" text-anchor="end">${lastDate}</text>
      <text x="${padX}" y="12" class="chart-axis-label">$${max}</text>
      <text x="${padX}" y="${height - padY - 2}" class="chart-axis-label">$${min}</text>
    </svg>
  `;
}

function openModal(playerName) {
  const p = players.find(x => x.player === playerName);
  if (!p) return;

  const series = playerHistorySeries(playerName);

  document.getElementById("modal-content").innerHTML = `
    <h2 class="modal-title">${p.player}</h2>
    <p class="modal-subtitle">${p.sport} &middot; ${p.prospect_grade || ""}</p>
    <div class="modal-stats">
      <div class="modal-stat"><div class="modal-stat-label">Avg Sale</div><div class="modal-stat-value">$${p.avg_sale}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">BVS</div><div class="modal-stat-value">${p.bvs}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Signal</div><div class="modal-stat-value ${signalClass(p.signal)}">${p.signal}</div></div>
      <div class="modal-stat"><div class="modal-stat-label">Risk</div><div class="modal-stat-value">${p.risk}</div></div>
    </div>
    <div class="chart-wrap">${buildChartSVG(series)}</div>
    ${p.notes ? `<p class="modal-subtitle" style="margin-top:16px">${p.notes}</p>` : ""}
  `;

  document.getElementById("player-modal").hidden = false;
}

function closeModal() {
  document.getElementById("player-modal").hidden = true;
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

function renderCurrentView() {
  render();
  renderBoard();
}

document.getElementById("search").addEventListener("input", renderCurrentView);
document.getElementById("sport-filter").addEventListener("change", renderCurrentView);
document.getElementById("signal-filter").addEventListener("change", renderCurrentView);

function setView(view) {
  currentView = view;
  document.getElementById("table-view").hidden = view !== "table";
  document.getElementById("board-view").hidden = view !== "board";
  document.getElementById("view-table-btn").classList.toggle("active", view === "table");
  document.getElementById("view-board-btn").classList.toggle("active", view === "board");
  document.getElementById("view-table-btn").setAttribute("aria-selected", view === "table");
  document.getElementById("view-board-btn").setAttribute("aria-selected", view === "board");
}

document.getElementById("view-table-btn").addEventListener("click", () => setView("table"));
document.getElementById("view-board-btn").addEventListener("click", () => setView("board"));

document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("player-modal").addEventListener("click", (e) => {
  if (e.target.id === "player-modal") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

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
