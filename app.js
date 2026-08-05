// ============================================================
// NUTSA CONFIRMATION — APP LOGIC
// Talks to the existing Apps Script backend:
//   GET  ?action=worker_login&worker=N&pin=XXXX
//   GET  ?action=worker_orders&wtoken=XXX
//   POST ?action=worker_update_status  {wtoken,order_num,status}
//   POST ?action=worker_update_order   {wtoken,order_num,...fields}
// ============================================================

const CFG = window.NUTSA_CONFIG;
const LS_TOKEN  = "nutsa_wtoken";
const LS_WORKER = "nutsa_worker";
const LS_ORDERS = "nutsa_orders_cache";

const state = {
  token: null,
  worker: null,
  orders: [],
  filter: "all",
  search: "",
  currentOrder: null,
  refreshTimer: null,
};

// ============================================================
// UTIL
// ============================================================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function fmtMoney(n) {
  return (Number(n) || 0).toLocaleString(CFG.LOCALE) + " DA";
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(CFG.LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function safeStatusClass(s) {
  return (s || "Pending").replace(/\s+/g, "");
}

// GET request — Apps Script requires JSONP-style params
async function apiGet(params) {
  const url = new URL(CFG.API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// POST — Apps Script accepts text/plain to avoid preflight
async function apiPost(body) {
  const res = await fetch(CFG.API_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ============================================================
// SCREENS
// ============================================================
function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $("#" + id).classList.add("active");
}

// ============================================================
// AUTO-LOGIN
// ============================================================
async function autoLogin() {
  try {
    const res = await apiGet({ action: "worker_login", worker: CFG.WORKER, pin: CFG.PIN });
    if (!res.ok) throw new Error(res.error || "Login failed");
    state.token = res.token;
    state.worker = res.worker;
    localStorage.setItem(LS_TOKEN, res.token);
    localStorage.setItem(LS_WORKER, String(res.worker));
    enterDashboard();
  } catch (err) {
    document.body.innerHTML = `
      <div style="padding:40px 24px;font-family:system-ui;text-align:center;max-width:500px;margin:60px auto;background:white;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.1)">
        <div style="font-size:48px">🔒</div>
        <h2 style="color:#C62828">Connexion échouée</h2>
        <p style="color:#555">${err.message}</p>
        <p style="color:#888;font-size:13px">Vérifiez <code>WORKER</code> et <code>PIN</code> dans <code>config.js</code>.</p>
      </div>`;
  }
}

// ============================================================
// DASHBOARD
// ============================================================
function enterDashboard() {
  showScreen("dashboard-screen");
  $("#agent-num").textContent = state.worker;
  $("#agent-badge").textContent = "A" + state.worker;

  const today = new Date();
  $("#header-date").textContent = today.toLocaleDateString(CFG.LOCALE, {
    weekday: "long", day: "numeric", month: "long"
  });

  initDashboardEvents();

  // Show cached orders instantly if we have any
  try {
    const cached = JSON.parse(localStorage.getItem(LS_ORDERS) || "null");
    if (cached && Array.isArray(cached.orders) && cached.worker === state.worker) {
      state.orders = cached.orders;
      updateStats();
      renderOrders();
    }
  } catch(e) {}

  loadOrders();

  if (CFG.AUTO_REFRESH_SECONDS > 0) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(loadOrders, CFG.AUTO_REFRESH_SECONDS * 1000);
  }
}

function initDashboardEvents() {
  if (initDashboardEvents._done) return;
  initDashboardEvents._done = true;

  $("#refresh-btn").addEventListener("click", async () => {
    $("#refresh-btn").classList.add("spinning");
    await loadOrders();
    setTimeout(() => $("#refresh-btn").classList.remove("spinning"), 500);
  });

  $$(".chip").forEach(c => c.addEventListener("click", () => {
    $$(".chip").forEach(x => x.classList.remove("chip-active"));
    c.classList.add("chip-active");
    state.filter = c.dataset.filter;
    renderOrders();
  }));

  $("#search-input").addEventListener("input", e => {
    state.search = e.target.value.trim().toLowerCase();
    renderOrders();
  });

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#order-sheet").addEventListener("click", e => {
    if (e.target.id === "order-sheet") closeSheet();
  });
}

async function loadOrders() {
  try {
    const res = await apiGet({ action: "worker_orders", wtoken: state.token });
    if (!res.ok) {
      if (String(res.error || "").toLowerCase().includes("unauthorized")) {
        toast("Reconnexion…", "error");
        localStorage.removeItem(LS_TOKEN);
        return autoLogin();
      }
      throw new Error(res.error || "load failed");
    }
    state.orders = res.orders || [];
    try { localStorage.setItem(LS_ORDERS, JSON.stringify({ worker: state.worker, orders: state.orders })); } catch(e) {}
    updateStats();
    renderOrders();
  } catch (err) {
    toast("Erreur de chargement", "error");
    console.error(err);
  }
}

function updateStats() {
  const c = { Pending: 0, Confirmed: 0, Cancelled: 0 };
  state.orders.forEach(o => {
    const s = o.status || "Pending";
    if (s === "Confirmed" || s === "Livré") c.Confirmed++;
    else if (s === "Cancelled") c.Cancelled++;
    else c.Pending++;
  });
  $("#stat-pending").textContent = c.Pending;
  $("#stat-confirmed").textContent = c.Confirmed;
  $("#stat-cancelled").textContent = c.Cancelled;
}

function renderOrders() {
  const list = $("#orders-list");
  let items = state.orders.slice();

  if (state.filter !== "all") {
    items = items.filter(o => {
      const s = o.status || "Pending";
      if (state.filter === "Pending") return s === "Pending" || s === "";
      return s === state.filter;
    });
  }

  if (state.search) {
    const q = state.search;
    items = items.filter(o =>
      (o.name || "").toLowerCase().includes(q) ||
      (o.phone || "").toLowerCase().includes(q) ||
      (o.order || "").toLowerCase().includes(q) ||
      (o.commune || "").toLowerCase().includes(q)
    );
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <span class="icon">📭</span>
      Aucune commande à afficher
    </div>`;
    return;
  }

  list.innerHTML = items.map(o => {
    const status = o.status || "Pending";
    const cls = safeStatusClass(status);
    return `
      <article class="order-card status-${cls}" data-order="${escapeAttr(o.order)}">
        <div class="order-head">
          <div>
            <p class="order-ref">${escapeHtml(o.order)}</p>
            <p class="order-name">${escapeHtml(o.name || "—")}</p>
          </div>
          <div class="order-total">${fmtMoney(o.total)}</div>
        </div>
        <div class="order-meta">
          <span>📍 ${escapeHtml(o.commune || "?")}, ${escapeHtml(o.wilaya || "?")}</span>
          <span>📱 ${escapeHtml(o.phone || "")}</span>
        </div>
        <div class="order-product">${escapeHtml(o.product || "")}</div>
        <span class="order-badge badge-${cls}">${statusLabel(status)}</span>
      </article>
    `;
  }).join("");

  $$(".order-card").forEach(card => {
    card.addEventListener("click", () => openOrder(card.dataset.order));
  });
}

function statusLabel(s) {
  return {
    "Pending":   "En attente",
    "Confirmed": "Confirmée",
    "Cancelled": "Annulée",
    "Livré":     "Livrée",
    "No Answer": "Sans réponse",
    "Callback":  "Rappeler",
  }[s] || s;
}

// ============================================================
// ORDER DETAIL SHEET
// ============================================================
function openOrder(orderNum) {
  const o = state.orders.find(x => x.order === orderNum);
  if (!o) return;
  state.currentOrder = o;

  const telNum = (o.phone || "").replace(/[^\d+]/g, "");
  const body = $("#sheet-body");
  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-ref">${escapeHtml(o.order)}</div>
      <div class="detail-name">${escapeHtml(o.name || "Client")}</div>
      <div class="detail-total">${fmtMoney(o.total)}</div>
    </div>

    <a class="call-btn" href="tel:${escapeAttr(telNum)}">
      <div class="call-icon">📞</div>
      <div>
        <div>Appeler le client</div>
        <div class="call-num">${escapeHtml(o.phone || "")}</div>
      </div>
    </a>

    <div class="detail-section">
      <div class="detail-label">Livraison</div>
      <div class="detail-value">📍 ${escapeHtml(o.commune || "?")}, ${escapeHtml(o.wilaya || "?")}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">Produit · Quantité: ${o.qty || 1}</div>
      <div class="detail-value">${escapeHtml(o.product || "")}</div>
    </div>

    ${o.tracking ? `
      <div class="detail-section">
        <div class="detail-label">Tracking Anderson</div>
        <div class="detail-value" style="font-family:monospace">${escapeHtml(o.tracking)}</div>
      </div>` : ""}

    <div class="detail-section">
      <div class="detail-label">Statut actuel</div>
      <div class="detail-value">
        <span class="order-badge badge-${safeStatusClass(o.status)}">${statusLabel(o.status || "Pending")}</span>
      </div>
    </div>

    <div class="action-grid">
      <button class="action-btn action-confirm" data-status="Confirmed">
        <span class="icon">✅</span>
        Confirmer et envoyer à Anderson
      </button>
      <button class="action-btn action-cancel" data-status="Cancelled">
        <span class="icon">❌</span>
        Annuler
      </button>
      <button class="action-btn action-noanswer" data-status="No Answer">
        <span class="icon">📵</span>
        Sans réponse
      </button>
      <button class="action-btn action-callback" data-status="Callback">
        <span class="icon">🔁</span>
        Rappeler plus tard
      </button>
    </div>
  `;

  body.querySelectorAll(".action-btn").forEach(btn => {
    btn.addEventListener("click", () => updateStatus(o.order, btn.dataset.status));
  });

  $("#order-sheet").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  $("#order-sheet").classList.remove("open");
  document.body.style.overflow = "";
  state.currentOrder = null;
}

async function updateStatus(orderNum, newStatus) {
  const btns = $$("#sheet-body .action-btn");
  btns.forEach(b => b.disabled = true);
  const isConfirm = newStatus === "Confirmed";

  try {
    const res = await apiPost({
      action: "worker_update_status",
      wtoken: state.token,
      order_num: orderNum,
      status: newStatus,
    });
    if (!res.ok) throw new Error(res.error || "update failed");

    // Update local state
    const o = state.orders.find(x => x.order === orderNum);
    if (o) o.status = newStatus;

    const msg = isConfirm
      ? (res.sent_to_anderson ? "✅ Confirmé et envoyé à Anderson" : "✅ Confirmé (Anderson: erreur)")
      : "✅ " + statusLabel(newStatus);
    toast(msg, "success");

    closeSheet();
    updateStats();
    renderOrders();
  } catch (err) {
    toast("❌ " + err.message, "error");
    btns.forEach(b => b.disabled = false);
  }
}

// ============================================================
// ESCAPE HELPERS
// ============================================================
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ============================================================
// BOOT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  if (!CFG.API_URL || CFG.API_URL.includes("PASTE_YOUR")) {
    document.body.innerHTML = `
      <div style="padding:40px 24px;font-family:system-ui;text-align:center;max-width:500px;margin:60px auto;background:white;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.1)">
        <div style="font-size:48px">⚙️</div>
        <h2 style="color:#C62828">Configuration requise</h2>
        <p style="color:#555;line-height:1.6">Ouvrez <code>config.js</code> et collez l'URL de votre Web App Apps Script dans <code>API_URL</code>.</p>
      </div>`;
    return;
  }

  // Resume cached session or auto-login
  const token = localStorage.getItem(LS_TOKEN);
  const worker = localStorage.getItem(LS_WORKER);
  if (token && worker) {
    state.token = token;
    state.worker = Number(worker);
    enterDashboard();
  } else {
    autoLogin();
  }
});
