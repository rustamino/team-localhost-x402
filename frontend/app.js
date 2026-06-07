// ─── user ID generation ───────────────────────────────────────────────────────

const _ADJ = [
  "tender","jolly","brave","eager","clever","witty","quirky","swift","bold","calm",
  "hopeful","nimble","daring","gentle","keen","lively","merry","noble","proud","vivid",
  "wily","crisp","plucky","spry","zesty","sleek","grand","sunny","deft","fleet",
];
const _ANIMAL = [
  "panda","otter","falcon","tiger","wolf","fox","bear","lynx","crane","bison",
  "gecko","koala","manta","raven","tapir","viper","walrus","yak","zebu","stoat",
  "quail","robin","snail","trout","moose","llama","macaw","hippo","okapi","capybara",
];

function genUserId() {
  const a = _ADJ[Math.floor(Math.random() * _ADJ.length)];
  const b = _ANIMAL[Math.floor(Math.random() * _ANIMAL.length)];
  return `${a}-${b}`;
}

function getOrCreateUserId() {
  let id = localStorage.getItem("x402_user_id");
  if (!id) { id = genUserId(); localStorage.setItem("x402_user_id", id); }
  return id;
}

function getBudget() {
  return parseFloat(localStorage.getItem("x402_budget") || "2.0");
}

function setBudget(v) {
  localStorage.setItem("x402_budget", String(v));
}

// ─── state ────────────────────────────────────────────────────────────────────

const state = {
  jobId:              null,
  selectedOffer:      null,   // { printerName, canStartAt, paymentUrl, priceEur, priceUsdc, ... }
  userId:             getOrCreateUserId(),
  marketplaceWallet:  null,
  txId:               null,
  fundedUsdc:         0,      // known pre-funded balance for current userId (async-updated)
};

const SLICE = { grams: 12.4, minutes: 47 };

// ─── screen routing ───────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

document.querySelectorAll("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});

// ─── screen 1 — main / wallet card ───────────────────────────────────────────

const userIdInput   = document.getElementById("user-id-input");
const budgetInput   = document.getElementById("budget-input");
const mainQrCanvas  = document.getElementById("main-qr-canvas");
const btnMainPera   = document.getElementById("btn-main-pera");
const btnMainCopy   = document.getElementById("btn-main-copy");
const btnRegenId    = document.getElementById("btn-regen-id");

userIdInput.value   = state.userId;
budgetInput.value   = getBudget().toFixed(2);

async function initWalletCard() {
  try {
    const res = await fetch("/api/info");
    if (!res.ok) return;
    const data = await res.json();
    state.marketplaceWallet = data.marketplace_wallet;
    updateMainQr();
  } catch { /* offline — QR stays blank */ }

  // Non-blocking: check if current ID already has funded balance
  fetchFundedBalance(state.userId);
}

async function fetchFundedBalance(userId) {
  try {
    const res = await fetch(`/api/balance/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (state.userId === userId) {          // still the same ID
      state.fundedUsdc = data.available_usdc || 0;
    }
  } catch { /* ignore */ }
}

// ── modal ────────────────────────────────────────────────────────────────────

const modalOverlay = document.getElementById("modal-overlay");
let _modalConfirmFn = null;
let _modalCancelFn  = null;

function showModal({ oldId, balance, onConfirm, onCancel }) {
  document.getElementById("modal-old-id").textContent  = oldId;
  document.getElementById("modal-balance").textContent = balance.toFixed(4);
  _modalConfirmFn = onConfirm;
  _modalCancelFn  = onCancel;
  modalOverlay.style.display = "flex";
}

function hideModal() {
  modalOverlay.style.display = "none";
  _modalConfirmFn = null;
  _modalCancelFn  = null;
}

document.getElementById("modal-confirm").addEventListener("click", () => {
  hideModal(); _modalConfirmFn?.();
});
document.getElementById("modal-cancel").addEventListener("click", () => {
  hideModal(); _modalCancelFn?.();
});
modalOverlay.addEventListener("click", e => {
  if (e.target === modalOverlay) { hideModal(); _modalCancelFn?.(); }
});

// ── ID change logic ───────────────────────────────────────────────────────────

function sanitizeId(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
}

function applyUserId(newId) {
  state.userId      = newId;
  state.fundedUsdc  = 0;
  localStorage.setItem("x402_user_id", newId);
  userIdInput.value = newId;
  updateMainQr();
  fetchFundedBalance(newId);
}

function tryChangeUserId(newId, onCancelled) {
  if (!newId || newId === state.userId) return;
  if (state.fundedUsdc > 0) {
    showModal({
      oldId:     state.userId,
      balance:   state.fundedUsdc,
      onConfirm: () => applyUserId(newId),
      onCancel:  () => {
        userIdInput.value = state.userId;  // revert input
        onCancelled?.();
      },
    });
  } else {
    applyUserId(newId);
  }
}

// Input: blur or Enter commits the edit
userIdInput.addEventListener("keydown", e => {
  if (e.key === "Enter")  { userIdInput.blur(); }
  if (e.key === "Escape") { userIdInput.value = state.userId; userIdInput.blur(); }
});
userIdInput.addEventListener("blur", () => {
  const newId = sanitizeId(userIdInput.value);
  if (!newId) { userIdInput.value = state.userId; return; }
  tryChangeUserId(newId, null);
});

function updateMainQr() {
  const wallet = state.marketplaceWallet;
  if (!wallet) return;

  const budget = getBudget();
  const microUsdc = Math.ceil(budget * 1_000_000);
  const noteB64   = btoa(state.userId);
  const arc26     = `algorand://${wallet}?amount=${microUsdc}&asset=10458941&note=${encodeURIComponent(noteB64)}`;
  const peraHref  = "perawallet://transfer?" + new URLSearchParams({
    asset: "10458941", to: wallet,
    amount: String(microUsdc), note: noteB64,
  }).toString();

  btnMainPera.href = peraHref;

  btnMainCopy.onclick = () => {
    navigator.clipboard.writeText(wallet);
    btnMainCopy.textContent = "✓ Copied";
    setTimeout(() => { btnMainCopy.textContent = "Copy address"; }, 1500);
  };

  QRCode.toCanvas(mainQrCanvas, arc26, {
    width: 100, margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  }).catch(() => {});
}

btnRegenId.addEventListener("click", () => {
  tryChangeUserId(genUserId(), null);
});

budgetInput.addEventListener("change", () => {
  const v = Math.max(0.1, parseFloat(budgetInput.value) || 2.0);
  budgetInput.value = v.toFixed(2);
  setBudget(v);
  updateMainQr();
});

initWalletCard();

// ─── screen 1 — model input ───────────────────────────────────────────────────

const searchText  = document.getElementById("search-text");
const dropZone    = document.getElementById("drop-zone");
const fileInput   = document.getElementById("file-input");
const instruction = document.getElementById("instruction");
const btnFind     = document.getElementById("btn-find");

let uploadedFile = null;

function updateFindBtn() {
  btnFind.disabled = !searchText.value.trim() && !uploadedFile;
}

searchText.addEventListener("input", () => {
  if (searchText.value.trim()) { dropZone.classList.remove("has-file"); uploadedFile = null; }
  updateFindBtn();
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f && f.name.endsWith(".stl")) setFile(f);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function setFile(f) {
  uploadedFile = f;
  searchText.value = "";
  dropZone.classList.add("has-file");
  dropZone.innerHTML = `<span class="drop-icon">📄</span>${f.name}  (${(f.size/1024/1024).toFixed(1)} MB)`;
  updateFindBtn();
}

btnFind.addEventListener("click", async () => {
  const instr = instruction.value.trim();
  if (uploadedFile) await startWithFile(uploadedFile, instr);
  else              await startWithSearch(searchText.value.trim(), instr);
});

// ─── screen 1 → 2: model search ──────────────────────────────────────────────

async function startWithSearch(query, instr) {
  showScreen("s-search");
  document.getElementById("search-heading").textContent = `Results for "${query}"`;
  const list = document.getElementById("model-list");
  list.innerHTML = `<div style="color:var(--text2);font-size:.9rem">Searching…</div>`;

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
      state.jobId = null;
      startProcessing({ name: m.name, modelUrl: m.url, instruction: instr });
    });
    list.appendChild(card);
  });
}

async function startWithFile(file, instr) {
  startProcessing({ name: file.name, file, instruction: instr });
}

// ─── screen 3: processing ────────────────────────────────────────────────────

async function startProcessing({ name, file, modelUrl, instruction }) {
  showScreen("s-processing");
  document.getElementById("step-slicing-sub").textContent = name;
  state.jobId = state.jobId || ("j_" + Math.random().toString(36).slice(2, 10));

  const bar = document.getElementById("slicing-bar");
  let pct = 0;
  const fakeSlicing = setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 92);
    bar.style.width = pct + "%";
  }, 200);

  await sleep(2200);
  clearInterval(fakeSlicing);
  bar.style.width = "100%";

  const stepSlicing = document.getElementById("step-slicing");
  stepSlicing.classList.replace("active", "done");
  stepSlicing.querySelector(".step-icon").textContent = "✓";
  stepSlicing.querySelector(".step-text").childNodes[0].textContent = "Slicing complete · 12.4 g · 47 min";

  const stepQuotes = document.getElementById("step-quotes");
  stepQuotes.classList.replace("pending", "active");
  stepQuotes.querySelector(".step-icon").textContent = "⟳";
  document.getElementById("step-quotes-sub").textContent = "Contacting printer servers…";

  let data;
  try {
    data = await requestOffers(instruction);
  } catch (err) {
    data = {
      offers: [], selectedIndex: null,
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

// ─── screen 4: offers ────────────────────────────────────────────────────────

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
        errors.map(e => `<li><code>${escHtml(e.url)}</code><br>${escHtml(e.error)}</li>`).join("") +
        `</ul></div>`;
    }
    list.innerHTML =
      `<div style="font-size:.9rem;line-height:1.5">` +
      `<span style="color:var(--text2)">No printers responded.</span><br>` +
      `Check that the printer servers are running and that the backend's ` +
      `<code>PRINTERS</code> env var lists them.` +
      (data.reasoning ? `<br><br><em>${escHtml(data.reasoning)}</em>` : "") +
      errHtml + `</div>`;
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
    selectOffer(data.selectedIndex, data.offers, list.children[data.selectedIndex]);
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
  if (state.selectedOffer) showBalanceScreen(state.selectedOffer);
});

document.getElementById("btn-clarify").addEventListener("click", () => showScreen("s-input"));
document.getElementById("btn-manual").addEventListener("click", () => {
  state.manualMode = true;
  document.getElementById("clarify-row").style.display = "none";
  document.getElementById("agent-clarify").style.display = "none";
  document.getElementById("btn-pay-offer").disabled = false;
  document.getElementById("btn-pay-offer").textContent = "Pay selected offer →";
});

// ─── screen 5: balance check & submit ────────────────────────────────────────

function showBalanceScreen(offer) {
  showScreen("s-balance");

  document.getElementById("bal-printer-name").textContent = offer.printerName;
  document.getElementById("bal-printer-sub").textContent  = `${offer.city} · starts ${offer.canStartHuman}`;
  document.getElementById("bal-price-eur").textContent    = "€" + offer.priceEur;
  document.getElementById("bal-price-usdc").textContent   = offer.priceUsdc + " USDC";
  document.getElementById("bal-user-id").textContent      = state.userId;
  document.getElementById("bal-job-price").textContent    = offer.priceUsdc + " USDC";
  document.getElementById("bal-available").textContent    = "checking…";

  // reset steps
  setBalStep("bal-step-check",   "active",  "");
  setBalStep("bal-step-submit",  "pending", "");
  setBalStep("bal-step-forward", "pending", "");
  document.getElementById("bal-fund-hint").style.display = "none";

  pollBalance(offer);
}

function setBalStep(id, status, sub) {
  const el = document.getElementById(id);
  el.classList.remove("active", "pending", "done", "error");
  el.classList.add(status);
  const icon = el.querySelector(".step-icon");
  icon.textContent =
    status === "done"   ? "✓" :
    status === "error"  ? "✗" :
    status === "active" ? "⟳" : "○";
  const subEl = el.querySelector(".sub");
  if (subEl) subEl.textContent = sub || "";
}

async function pollBalance(offer) {
  const priceUsdc = parseFloat(offer.priceUsdc);
  const maxWaitMs = 15 * 60 * 1000; // 15 min
  const startTime = Date.now();

  // confirm we're still on the balance screen before proceeding
  function onBalScreen() {
    return document.getElementById("s-balance").classList.contains("active");
  }

  while (onBalScreen() && Date.now() - startTime < maxWaitMs) {
    let bal;
    try {
      const res = await fetch(`/api/balance/${encodeURIComponent(state.userId)}`);
      bal = await res.json();
    } catch {
      await sleep(5000);
      continue;
    }

    const avail = bal.available_usdc ?? 0;
    document.getElementById("bal-available").textContent = avail.toFixed(6) + " USDC";

    if (avail >= priceUsdc) {
      // Sufficient — submit to printer
      setBalStep("bal-step-check",  "done",   "Balance sufficient");
      setBalStep("bal-step-submit", "active", "");
      document.getElementById("bal-fund-hint").style.display = "none";

      let checkoutId;
      try {
        const res = await fetch("/api/submit-print", {
          method:  "POST",
          headers: { "content-type": "application/json" },
          body:    JSON.stringify({
            payment_url: offer.paymentUrl,
            job_id:      state.jobId,
            price_usdc:  offer.priceUsdc,
            user_id:     state.userId,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Submit failed");
        checkoutId = data.checkout_id;
      } catch (err) {
        setBalStep("bal-step-submit", "error", err.message);
        return;
      }

      setBalStep("bal-step-submit",  "done",   "");
      setBalStep("bal-step-forward", "active", "Waiting for printer confirmation…");

      // Poll until forwarded
      await pollForwardStatus(checkoutId);
      return;
    } else {
      // Not enough — show how much more is needed
      const need = Math.max(0, priceUsdc - avail).toFixed(6);
      setBalStep("bal-step-check", "active", `${avail.toFixed(4)} / ${priceUsdc} USDC`);
      document.getElementById("bal-fund-msg").textContent =
        `Need ${need} more USDC — scan the QR on the home screen to top up.`;
      document.getElementById("bal-fund-hint").style.display = "";
    }

    await sleep(5000);
  }

  if (onBalScreen()) {
    setBalStep("bal-step-check", "error", "Timed out — go back and try again");
  }
}

async function pollForwardStatus(checkoutId) {
  for (let i = 0; i < 60; i++) {  // up to 5 min
    await sleep(5000);
    if (!document.getElementById("s-balance").classList.contains("active")) return;

    let data;
    try {
      const res = await fetch(`/api/checkout/${checkoutId}`);
      data = await res.json();
    } catch { continue; }

    if (data.status === "forwarded") {
      state.txId = data.printer_tx_id || data.user_tx_id || null;
      setBalStep("bal-step-forward", "done", "");
      await sleep(600);
      showTrackingScreen();
      return;
    }
    if (data.status === "error") {
      setBalStep("bal-step-forward", "error", data.error || "Printer payment failed");
      return;
    }
  }
  setBalStep("bal-step-forward", "error", "Printer timed out — please try again");
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

  simulateProgress();
}

function simulateProgress() {
  let pct = 0;
  const startTime = Date.now();
  const totalMs = 30000;

  const interval = setInterval(() => {
    pct = Math.min(100, (Date.now() - startTime) / totalMs * 100);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const etaSec  = Math.max(0, Math.floor((totalMs - (Date.now() - startTime)) / 1000));

    document.getElementById("tracking-pct").textContent  = Math.floor(pct) + "%";
    document.getElementById("tracking-bar").style.width  = pct + "%";
    document.getElementById("tracking-elapsed").textContent = `${elapsed}s elapsed`;
    document.getElementById("tracking-eta").textContent  = etaSec > 0 ? `~${etaSec}s remaining` : "finishing…";

    document.getElementById("temp-hotend").textContent = "215° / 215° ✓";
    document.getElementById("temp-hotend").className   = "temp-ok";
    document.getElementById("temp-bed").textContent    = "60° / 60° ✓";
    document.getElementById("temp-bed").className      = "temp-ok";

    if (pct >= 100) { clearInterval(interval); showDoneScreen(); }
  }, 500);
}

// ─── screen 8: done ──────────────────────────────────────────────────────────

function showDoneScreen() {
  showScreen("s-done");
  const offer = state.selectedOffer;
  document.getElementById("done-filename").textContent = "model.stl";
  document.getElementById("done-location").textContent = `${offer.printerName}\n${offer.city}`;
}

document.getElementById("btn-new-order").addEventListener("click", () => {
  Object.assign(state, { jobId: null, selectedOffer: null, txId: null });
  showScreen("s-input");
});

// ─── real offers (POST /api/offers) ───────────────────────────────────────────

async function requestOffers(instruction) {
  const res = await fetch("/api/offers", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job_id:      state.jobId,
      grams:       SLICE.grams,
      minutes:     SLICE.minutes,
      gcode_url:   `${location.origin}/files/benchy.gcode`,
      instruction: instruction || null,
    }),
  });
  if (!res.ok) throw new Error(`/api/offers HTTP ${res.status}`);
  const data = await res.json();
  return {
    offers:        (data.offers || []).map(mapOffer),
    selectedIndex: data.selected_index ?? null,
    reasoning:     data.reasoning || "",
    printerErrors: data.printer_errors || [],
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

// ─── mock data ────────────────────────────────────────────────────────────────

function mockSearchResults(query) {
  return [
    { name: "3DBenchy",          source: "printables.com", rating: "4.9", size: "4.2 MB", emoji: "⛵", url: "https://printables.com/model/3030" },
    { name: "Benchy Speed Boat", source: "cults3d.com",    rating: "4.5", size: "3.1 MB", emoji: "🚢", url: "https://cults3d.com/en/3d-model/benchy" },
    { name: "Mini Benchy",       source: "printables.com", rating: "4.3", size: "2.0 MB", emoji: "🛥",  url: "https://printables.com/model/benchy-mini" },
  ];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
