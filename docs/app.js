let players = [];
let sortKey = "rank";
let sortDir = 1;

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

document.getElementById("search").addEventListener("input", render);
document.getElementById("sport-filter").addEventListener("change", render);
document.getElementById("signal-filter").addEventListener("change", render);

document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir *= -1;
    else { sortKey = key; sortDir = 1; }
    render();
  });
});

loadData();
