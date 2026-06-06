// ─── state ───────────────────────────────────────────────────────────────────

const state = {
  jobId:           null,
  selectedOffer:   null,   // { printerName, canStartAt, paymentUrl, priceEur, priceUsdc }
  sessionAddr:     null,
  sessionSk:       null,   // Uint8Array — TODO: generate via algosdk
  refundAddress:   null,
  txId:            null,
  manualMode:      false,
  orderTtlEnd:     null,   // Date
  wsClient:        null,
};

// Slicer output. Hardcoded until POST /api/jobs + the slicer container are wired;
// these values are sent to the real backend /api/offers so printers can quote.
const SLICE = { grams: 12.4, minutes: 47 };

// ─── screen routing ───────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});

// ─── screen 1 — input ────────────────────────────────────────────────────────

const searchText = document.getElementById("search-text");
const dropZone   = document.getElementById("drop-zone");
const fileInput  = document.getElementById("file-input");
const instruction = document.getElementById("instruction");
const btnFind    = document.getElementById("btn-find");

let uploadedFile = null;

function updateFindBtn() {
  btnFind.disabled = !searchText.value.trim() && !uploadedFile;
}

searchText.addEventListener("input", () => {
  if (searchText.value.trim()) {
    dropZone.classList.remove("has-file");
    uploadedFile = null;
  }
  updateFindBtn();
});

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith(".stl")) setFile(f);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});

function setFile(f) {
  uploadedFile = f;
  searchText.value = "";
  dropZone.classList.add("has-file");
  dropZone.innerHTML = `<span class="drop-icon">📄</span>${f.name}  (${(f.size/1024/1024).toFixed(1)} MB)`;
  updateFindBtn();
}

btnFind.addEventListener("click", async () => {
  const instr = instruction.value.trim();
  if (uploadedFile) {
    await startWithFile(uploadedFile, instr);
  } else {
    await startWithSearch(searchText.value.trim(), instr);
  }
});

// ─── screen 1 → 2: model search ──────────────────────────────────────────────

async function startWithSearch(query, instr) {
  showScreen("s-search");
  document.getElementById("search-heading").textContent = `Results for "${query}"`;
  const list = document.getElementById("model-list");
  list.innerHTML = `<div style="color:var(--text2);font-size:.9rem">Searching…</div>`;

  // TODO: replace with real API call
  // const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  // const { results } = await res.json();
  const results = mockSearchResults(query);

  list.innerHTML = "";
  results.forEach(m => {
    const card = document.createElement("div");
    card.className = "model-card";
    card.innerHTML = `
      <div class="model-thumb">${m.emoji || "📦"}</div>
      <div class="model-info">
        <div class="model-name">${m.name}</div>
        <div class="model-meta">${m.source} · ★${m.rating} · FDM · ${m.size}</div>
      </div>
      <button class="btn btn-outline">Select</button>
    `;
    card.querySelector(".btn").addEventListener("click", () => {
      state.jobId = null;  // will be set after POST /api/jobs with model URL
      startProcessing({ name: m.name, modelUrl: m.url, instruction: instr });
    });
    list.appendChild(card);
  });
}

// ─── screen 1 → 3: direct file upload ────────────────────────────────────────

async function startWithFile(file, instr) {
  startProcessing({ name: file.name, file, instruction: instr });
}

// ─── screen 3: processing ────────────────────────────────────────────────────

async function startProcessing({ name, file, modelUrl, instruction }) {
  showScreen("s-processing");
  document.getElementById("step-slicing-sub").textContent = name;
  state.jobId = state.jobId || ("j_" + Math.random().toString(36).slice(2, 10));

  // animate slicing bar
  const bar = document.getElementById("slicing-bar");
  let pct = 0;
  const fakeSlicing = setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 92);
    bar.style.width = pct + "%";
  }, 200);

  // TODO: POST /api/jobs with file or modelUrl
  // const form = new FormData();
  // if (file) form.append("file", file);
  // else      form.append("model_url", modelUrl);
  // const res  = await fetch("/api/jobs", { method: "POST", body: form });
  // const data = await res.json();
  // state.jobId = data.job_id;

  // simulate slicing delay
  await sleep(2200);
  clearInterval(fakeSlicing);
  bar.style.width = "100%";

  // transition step 1 → step 2
  const stepSlicing = document.getElementById("step-slicing");
  stepSlicing.classList.replace("active", "done");
  stepSlicing.querySelector(".step-icon").textContent = "✓";
  stepSlicing.querySelector(".step-text").childNodes[0].textContent = "Slicing complete · 12.4 g · 47 min";

  const stepQuotes = document.getElementById("step-quotes");
  stepQuotes.classList.replace("pending", "active");
  stepQuotes.querySelector(".step-icon").textContent = "⟳";
  document.getElementById("step-quotes-sub").textContent = "Contacting printer servers…";

  // Real call: collect quotes from all registered printer servers
  let data;
  try {
    data = await requestOffers(instruction);
  } catch (err) {
    console.error("failed to load offers from backend:", err);
    data = {
      offers: [],
      selectedIndex: null,
      reasoning: "Could not reach the marketplace backend.",
      printerErrors: [{ url: location.origin, error: err.message }],
    };
  }

  const okCount  = data.offers.length;
  const errCount = (data.printerErrors || []).length;
  const total    = okCount + errCount;
  const allFailed = total > 0 && okCount === 0;

  stepQuotes.classList.replace("active", "done");
  stepQuotes.querySelector(".step-icon").textContent = allFailed ? "✗" : "✓";
  document.getElementById("step-quotes-sub").textContent =
    total === 0
      ? "No printers configured"
      : `${okCount} / ${total} printer${total !== 1 ? "s" : ""} responded`;

  showOffersScreen(data);
}

// ─── screen 4: offers ─────────────────────────────────────────────────────────

function showOffersScreen(data) {
  showScreen("s-offers");
  document.getElementById("offers-meta").textContent = "12.4 g · 47 min · model.stl";

  const list = document.getElementById("offer-list");
  list.innerHTML = "";

  if (!data.offers.length) {
    document.getElementById("btn-pay-offer").disabled = true;

    const errors = data.printerErrors || [];
    let errHtml = "";
    if (errors.length) {
      errHtml =
        `<div style="margin-top:.8rem;font-size:.82rem;color:var(--err,#e55)">` +
        `<strong>Connection errors (${errors.length}):</strong>` +
        `<ul style="margin:.4rem 0 0;padding-left:1.2rem;word-break:break-all">` +
        errors.map(e =>
          `<li><code>${escHtml(e.url)}</code><br>${escHtml(e.error)}</li>`
        ).join("") +
        `</ul></div>`;
    }

    list.innerHTML =
      `<div style="font-size:.9rem;line-height:1.5">` +
      `<span style="color:var(--text2)">No printers responded.</span><br>` +
      `Check that the printer servers are running and that the backend's ` +
      `<code>PRINTERS</code> env var lists them.` +
      (data.reasoning ? `<br><br><em>${escHtml(data.reasoning)}</em>` : "") +
      errHtml +
      `</div>`;
    return;
  }

  data.offers.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = "card" + (i === data.selectedIndex ? " highlighted" : "");
    card.dataset.index = i;
    card.innerHTML = `
      ${i === data.selectedIndex ? '<div class="card-badge">⭐ Agent\'s pick</div>' : ""}
      <div class="card-title">${o.printerName}</div>
      <div class="card-sub">${o.city} · starts ${o.canStartHuman}</div>
      <div class="card-price">
        <span class="eur">€${o.priceEur}</span>
        <span class="usdc">${o.priceUsdc} USDC</span>
      </div>
    `;
    card.addEventListener("click", () => selectOffer(i, data.offers, card));
    list.appendChild(card);
  });

  if (data.selectedIndex !== null) {
    selectOffer(data.selectedIndex, data.offers,
      list.children[data.selectedIndex]);

    const reasoning = document.getElementById("agent-reasoning");
    reasoning.textContent = data.reasoning;
    reasoning.style.display = "";
  } else {
    document.getElementById("agent-clarify").style.display = "";
    document.getElementById("agent-reason").textContent = data.reasoning;
    document.getElementById("clarify-row").style.display = "flex";
    document.getElementById("btn-pay-offer").disabled = true;
  }
}

function selectOffer(index, offers, cardEl) {
  document.querySelectorAll("#offer-list .card").forEach(c => {
    c.classList.toggle("highlighted", c === cardEl);
  });
  state.selectedOffer = offers[index];
  document.getElementById("btn-pay-offer").disabled = false;
  document.getElementById("btn-pay-offer").textContent =
    `Pay ${state.selectedOffer.printerName} →`;
}

document.getElementById("btn-pay-offer").addEventListener("click", () => {
  if (state.selectedOffer) showAuthorizeScreen(state.selectedOffer);
});

document.getElementById("btn-clarify").addEventListener("click", () => {
  showScreen("s-input");
});

document.getElementById("btn-manual").addEventListener("click", () => {
  state.manualMode = true;
  document.getElementById("clarify-row").style.display = "none";
  document.getElementById("agent-clarify").style.display = "none";
  document.getElementById("btn-pay-offer").disabled = false;
  document.getElementById("btn-pay-offer").textContent = "Pay selected offer →";
  // TODO: make all cards clickable to select
});

// ─── screen 5: authorize ─────────────────────────────────────────────────────

function showAuthorizeScreen(offer) {
  showScreen("s-authorize");

  document.getElementById("auth-printer-name").textContent = offer.printerName;
  document.getElementById("auth-price-eur").textContent    = "€" + offer.priceEur;
  document.getElementById("auth-price-usdc").textContent   = offer.priceUsdc + " USDC";

  const avmAddress = offer.avmAddress;
  const microUsdc  = offer.microUsdc;
  const assetId    = offer.assetId;
  const arc26      = `algorand://${avmAddress}?amount=${microUsdc}&asset=${assetId}`;

  document.getElementById("session-addr-display").textContent = avmAddress;

  // render QR — toCanvas uses native browser Canvas API, no Node.js deps
  QRCode.toCanvas(
    document.getElementById("qr-canvas"),
    arc26,
    { width: 200, margin: 2, color: { dark: "#000000", light: "#ffffff" } },
  ).catch(err => { console.error("QR render failed:", err); });

  // Pera deeplink — <a href> works more reliably than window.open on Android
  const peraHref = `perawallet://transfer?${new URLSearchParams({
    asset:  String(assetId),
    to:     avmAddress,
    amount: String(microUsdc),
  })}`;
  document.getElementById("btn-open-pera").href = peraHref;

  // copy address
  document.getElementById("btn-copy-addr").onclick = () => {
    navigator.clipboard.writeText(avmAddress);
    document.getElementById("btn-copy-addr").textContent = "✓";
    setTimeout(() => document.getElementById("btn-copy-addr").textContent = "copy", 1500);
  };

  const statusEl = document.getElementById("auth-status");
  const payBtn   = document.getElementById("btn-confirm-pay");

  payBtn.disabled = false;
  payBtn.textContent = "Pay now";
  statusEl.textContent = "";

  payBtn.onclick = async () => {
    payBtn.disabled = true;
    payBtn.textContent = "Paying…";
    statusEl.textContent = "";

    try {
      const res = await fetch("/api/pay", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({ payment_url: offer.paymentUrl, job_id: state.jobId }),
      });
      const data = await res.json();
      if (!res.ok) {
        statusEl.style.color = "var(--error, #e55)";
        statusEl.textContent = data.detail || "Payment failed";
        payBtn.disabled = false;
        payBtn.textContent = "Retry";
        return;
      }
      state.txId = data.tx_id || null;
      startPayingScreen(data);
    } catch (err) {
      statusEl.style.color = "var(--error, #e55)";
      statusEl.textContent = "Network error — try again";
      payBtn.disabled = false;
      payBtn.textContent = "Retry";
    }
  };
}

// ─── screen 6: paying ────────────────────────────────────────────────────────

async function startPayingScreen(payResult = {}) {
  showScreen("s-paying");

  const txId = payResult.tx_id || state.txId || null;

  setPayStep("pay-step-submit", "done", txId ? `Submitted → ${txId.slice(0, 12)}…` : "Submitted");
  setPayStep("pay-step-confirm", "done", null);
  setPayStep("pay-step-verify",  "done", null);
  setPayStep("pay-step-done",    "done", null);

  await sleep(600);
  showTrackingScreen();
}

function setPayStep(id, status, subText) {
  const el = document.getElementById(id);
  el.classList.remove("active", "pending", "done");
  el.classList.add(status);
  const icon = el.querySelector(".step-icon");
  icon.textContent = status === "done" ? "✓" : status === "active" ? "⟳" : "○";
  if (subText) {
    let sub = el.querySelector(".sub");
    if (!sub) { sub = document.createElement("div"); sub.className = "sub"; el.querySelector(".step-text").appendChild(sub); }
    sub.textContent = subText;
  }
}

// ─── screen 7: tracking ──────────────────────────────────────────────────────

function showTrackingScreen() {
  showScreen("s-tracking");

  const offer = state.selectedOffer;
  document.getElementById("tracking-printer").textContent = offer.printerName;
  document.getElementById("tracking-file").textContent    = "model.stl";

  const txLink = document.getElementById("tracking-tx");
  txLink.textContent = state.txId ? state.txId.slice(0, 16) + "…" : "—";
  txLink.href = `https://testnet.algoexplorer.io/tx/${state.txId}`;

  document.getElementById("tracking-location").innerHTML =
    `${offer.city}<br><span style="color:var(--text2);font-size:.8rem">${offer.coords}</span>`;
  document.getElementById("tracking-maps-link").href =
    `https://maps.google.com/?q=${offer.coords}`;

  // TODO: subscribe to /ws/client/{job_id} for real progress + temps
  simulateProgress();
}

function simulateProgress() {
  let pct = 0;
  const startTime = Date.now();
  const totalMs = 30000; // demo: 30 s

  const interval = setInterval(() => {
    pct = Math.min(100, (Date.now() - startTime) / totalMs * 100);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const etaSec  = Math.max(0, Math.floor((totalMs - (Date.now() - startTime)) / 1000));

    document.getElementById("tracking-pct").textContent  = Math.floor(pct) + "%";
    document.getElementById("tracking-bar").style.width  = pct + "%";
    document.getElementById("tracking-elapsed").textContent = `${elapsed}s elapsed`;
    document.getElementById("tracking-eta").textContent  = etaSec > 0 ? `~${etaSec}s remaining` : "finishing…";

    // fake temps
    document.getElementById("temp-hotend").textContent = "215° / 215° ✓";
    document.getElementById("temp-hotend").className   = "temp-ok";
    document.getElementById("temp-bed").textContent    = "60° / 60° ✓";
    document.getElementById("temp-bed").className      = "temp-ok";

    if (pct >= 100) {
      clearInterval(interval);
      showDoneScreen();
    }
  }, 500);
}

// ─── screen 8: done ───────────────────────────────────────────────────────────

function showDoneScreen() {
  showScreen("s-done");
  const offer = state.selectedOffer;
  document.getElementById("done-filename").textContent = "model.stl";
  document.getElementById("done-location").textContent = `${offer.printerName}\n${offer.city}`;

  // TODO: trigger session wallet cleanup — sweep remaining balance to refund address
}

document.getElementById("btn-new-order").addEventListener("click", () => {
  Object.assign(state, { jobId: null, selectedOffer: null, sessionAddr: null,
    sessionSk: null, txId: null, orderTtlEnd: null });
  sessionStorage.clear();
  showScreen("s-input");
});

// ─── mock data ────────────────────────────────────────────────────────────────

function mockSearchResults(query) {
  return [
    { name: "3DBenchy",         source: "printables.com", rating: "4.9", size: "4.2 MB", emoji: "⛵", url: "https://printables.com/model/3030" },
    { name: "Benchy Speed Boat",source: "cults3d.com",    rating: "4.5", size: "3.1 MB", emoji: "🚢", url: "https://cults3d.com/en/3d-model/benchy" },
    { name: "Mini Benchy",      source: "printables.com", rating: "4.3", size: "2.0 MB", emoji: "🛥",  url: "https://printables.com/model/benchy-mini" },
  ];
}

// ─── real offers (POST /api/offers) ───────────────────────────────────────────

async function requestOffers(instruction) {
  const res = await fetch("/api/offers", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id:      state.jobId,
      grams:       SLICE.grams,
      minutes:     SLICE.minutes,
      gcode_url:   `${location.origin}/files/${state.jobId}.gcode`,
      instruction: instruction || null,
    }),
  });
  if (!res.ok) throw new Error(`/api/offers HTTP ${res.status}`);
  const data = await res.json();
  return {
    offers:        (data.offers || []).map(mapOffer),
    selectedIndex: data.selected_index ?? null,
    reasoning:     data.reasoning || "",
    printerErrors: data.printer_errors || [],   // [{url, error}] for unreachable printers
  };
}

function mapOffer(o) {
  const loc = o.location || {};
  const pr  = o.payment_required || {};
  return {
    printerName:   o.name,
    city:          loc.city || "",
    coords:        (loc.lat != null && loc.lon != null) ? `${loc.lat},${loc.lon}` : "",
    canStartHuman: humanizeStart(o.can_start_at),
    priceEur:      o.price_eur ?? "—",
    priceUsdc:     o.price_usdc,
    paymentUrl:    o.payment_url,
    avmAddress:    pr.address || "",
    microUsdc:     pr.amount  || Math.round(parseFloat(o.price_usdc) * 1_000_000),
    assetId:       pr.asset   || 10458941,
  };
}

function humanizeStart(iso) {
  if (!iso) return "soon";
  const t = new Date(iso);
  if (isNaN(t)) return iso;
  const diffMin = Math.round((t - Date.now()) / 60000);
  if (diffMin <= 0) return "now";
  if (diffMin < 60) return `in ${diffMin}m`;
  const h = Math.floor(diffMin / 60), m = diffMin % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
