const REFRESH_INTERVAL = 15_000;

async function loadPrinters() {
  const grid  = document.getElementById("printer-grid");
  const label = document.getElementById("last-updated");

  let printers;
  try {
    const res = await fetch("/api/printers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    printers = await res.json();
  } catch (err) {
    grid.innerHTML = `<div class="loading-msg" style="color:var(--err)">
      Failed to load: ${err.message}
    </div>`;
    return;
  }

  label.textContent = "Updated " + new Date().toLocaleTimeString();

  document.getElementById("stat-total").textContent    = printers.length;
  document.getElementById("stat-online").textContent   = printers.filter(p => p.status !== "offline").length;
  document.getElementById("stat-printing").textContent = printers.filter(p => p.status === "printing").length;

  grid.innerHTML = "";
  if (!printers.length) {
    grid.innerHTML = `<div class="loading-msg">No printers registered yet.</div>`;
    return;
  }

  printers.forEach(p => grid.appendChild(buildCard(p)));
}

function buildCard(p) {
  // p fields: printer_id, name, status, location, rate_per_gram_eur, rate_per_minute_eur,
  //           capabilities, last_seen_ago_s
  const card = document.createElement("div");
  card.className = "printer-card";

  const dotClass = p.status === "printing" ? "printing"
                 : p.status === "online"   ? "online"
                 : "offline";

  const statusLabel = { online: "idle", printing: "printing", offline: "offline" }[p.status] ?? p.status;

  const lastSeen = p.last_seen_ago_s != null
    ? p.last_seen_ago_s < 60
      ? `${p.last_seen_ago_s}s ago`
      : `${Math.floor(p.last_seen_ago_s / 60)}m ago`
    : "never";

  const caps = (p.capabilities?.materials ?? [])
    .map(m => `<span class="cap-tag">${m}</span>`)
    .join("");

  card.innerHTML = `
    <div class="printer-card-header">
      <div>
        <div class="printer-card-name">${escHtml(p.name ?? p.printer_id)}</div>
        <div class="printer-card-id">${escHtml(p.printer_id)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span style="font-size:.75rem;color:var(--text2)">${statusLabel}</span>
        <div class="status-dot ${dotClass}"></div>
      </div>
    </div>

    <div class="printer-info-rows">
      <div class="printer-rate-row">
        <span class="key">Location</span>
        <span class="value">${escHtml(p.location?.city ?? "—")}</span>
      </div>
      <div class="printer-rate-row">
        <span class="key">Coordinates</span>
        <span class="value">${formatCoords(p.location)}</span>
      </div>
      <div class="printer-rate-row">
        <span class="key">Rate per gram</span>
        <span class="value">€${p.rate_per_gram_eur ?? "—"} / g</span>
      </div>
      <div class="printer-rate-row">
        <span class="key">Rate per minute</span>
        <span class="value">€${p.rate_per_minute_eur ?? "—"} / min</span>
      </div>
      ${p.capabilities?.max_volume_cm3 ? `
      <div class="printer-rate-row">
        <span class="key">Max volume</span>
        <span class="value">${p.capabilities.max_volume_cm3} cm³</span>
      </div>` : ""}
    </div>

    ${caps ? `<div class="printer-caps">${caps}</div>` : ""}

    <div class="printer-last-seen">Last seen: ${lastSeen}</div>
  `;

  return card;
}

function formatCoords(loc) {
  if (!loc?.lat || !loc?.lon) return "—";
  return `${loc.lat.toFixed(4)}° N, ${loc.lon.toFixed(4)}° E`;
}

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("btn-refresh").addEventListener("click", loadPrinters);
loadPrinters();
setInterval(loadPrinters, REFRESH_INTERVAL);
