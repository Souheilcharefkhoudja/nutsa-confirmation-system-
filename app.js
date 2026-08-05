// ============================================================
// NUTSA CONFIRMATION — v2 (full data)
// ============================================================

const CFG = window.NUTSA_CONFIG;
const LS_TOKEN  = "nutsa_wtoken";
const LS_WORKER = "nutsa_worker";
const LS_ORDERS = "nutsa_orders_cache_v2";

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
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function toast(msg, kind) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

const fmtMoney = n => (Number(n) || 0).toLocaleString(CFG.LOCALE) + " DA";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const mins = Math.floor((now - d) / 60000);
    if (mins < 1) return "À l'instant";
    if (mins < 60) return `il y a ${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `il y a ${hrs}h`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `il y a ${days}j`;
    return d.toLocaleDateString(CFG.LOCALE, { day: "numeric", month: "short" });
  } catch { return iso; }
}

// Absolute date + time (e.g. "05/08 · 16:26")
function fmtDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString(CFG.LOCALE, { day: "2-digit", month: "2-digit" });
    const time = d.toLocaleTimeString(CFG.LOCALE, { hour: "2-digit", minute: "2-digit" });
    return `${date} · ${time}`;
  } catch { return iso; }
}

// Full date + time for the detail sheet
function fmtDateTimeLong(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(CFG.LOCALE, { weekday: "short", day: "numeric", month: "long", year: "numeric" }) +
           " à " + d.toLocaleTimeString(CFG.LOCALE, { hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

const safeCls = s => (s || "Pending").replace(/\s+/g, "");

// ============================================================
// API
// ============================================================
async function apiGet(params) {
  const url = new URL(CFG.API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

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
  $$(".screen").forEach(s => {
    s.classList.remove("active");
    s.style.display = "none";
  });
  const t = $("#" + id);
  if (t) { t.classList.add("active"); t.style.display = "block"; }
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
      </div>`;
  }
}

// ============================================================
// DASHBOARD
// ============================================================
function enterDashboard() {
  showScreen("dashboard-screen");
  $("#agent-badge").textContent = "A" + state.worker;
  $("#header-date").textContent = new Date().toLocaleDateString(CFG.LOCALE, {
    weekday: "long", day: "numeric", month: "long"
  });

  initDashboardEvents();

  // Instant paint from cache
  try {
    const cached = JSON.parse(localStorage.getItem(LS_ORDERS) || "null");
    if (cached && Array.isArray(cached.orders)) {
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
    setFilter(c.dataset.filter);
  }));

  $$(".stat[data-jump]").forEach(s => s.addEventListener("click", () => {
    setFilter(s.dataset.jump);
    window.scrollTo({ top: 0, behavior: "smooth" });
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

function setFilter(f) {
  state.filter = f;
  $$(".chip").forEach(c => c.classList.toggle("chip-active", c.dataset.filter === f));
  renderOrders();
}

async function loadOrders() {
  try {
    const res = await apiGet({ action: "worker_orders", wtoken: state.token });
    if (!res.ok) {
      if (String(res.error || "").toLowerCase().includes("unauthorized")) {
        localStorage.removeItem(LS_TOKEN);
        return autoLogin();
      }
      throw new Error(res.error || "load failed");
    }
    state.orders = res.orders || [];
    try { localStorage.setItem(LS_ORDERS, JSON.stringify({ orders: state.orders })); } catch(e) {}
    updateStats();
    renderOrders();
  } catch (err) {
    toast("Erreur de chargement", "error");
    console.error(err);
  }
}

function updateStats() {
  const c = { Pending: 0, Confirmed: 0, Cancelled: 0, "No Answer": 0, Callback: 0, "Livré": 0 };
  state.orders.forEach(o => {
    const s = o.status || "Pending";
    if (c[s] !== undefined) c[s]++;
    else if (s === "") c.Pending++;
  });
  $("#stat-pending").textContent   = c.Pending;
  $("#stat-callback").textContent  = c.Callback;
  $("#stat-noans").textContent     = c["No Answer"];
  $("#stat-confirmed").textContent = c.Confirmed;
  $("#stat-livre").textContent     = c["Livré"];
  $("#stat-cancelled").textContent = c.Cancelled;
  $("#total-pill").textContent     = state.orders.length;
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
      (o.commune || "").toLowerCase().includes(q) ||
      (o.wilaya || "").toLowerCase().includes(q) ||
      (o.tracking || "").toLowerCase().includes(q)
    );
  }

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><span class="icon">📭</span>Aucune commande</div>`;
    return;
  }

  list.innerHTML = items.map(orderCardHTML).join("");
  $$(".order-card").forEach(card => {
    card.addEventListener("click", () => openOrder(card.dataset.order));
  });
}

function orderCardHTML(o) {
  const status = o.status || "Pending";
  const cls = safeCls(status);
  const dsClass = deliveryStateClass(o.delivery_state);
  const dsLabel = deliveryStateLabel(o.delivery_state);
  const sourceTag = extraSource(o.extra);

  return `
    <article class="order-card status-${cls}" data-order="${esc(o.order)}">
      <div class="card-top">
        <div class="card-top-left">
          <span class="order-ref">${esc(o.order)}</span>
          ${sourceTag ? `<span class="source-tag src-${sourceTag.cls}">${sourceTag.label}</span>` : ""}
          ${o.sent_ok ? `<span class="sent-tag" title="Envoyé à Anderson">✅</span>` : ""}
        </div>
        <span class="date-tag" title="${esc(fmtDateTimeLong(o.date))}">
          🕒 ${esc(fmtDateTime(o.date))}
          <span class="date-rel">· ${esc(fmtDate(o.date))}</span>
        </span>
      </div>

      <div class="order-head">
        <div>
          <p class="order-name">${esc(o.name || "—")}</p>
          <p class="order-phone">📱 ${esc(o.phone || "")}</p>
        </div>
        <div class="order-total">${fmtMoney(o.total)}</div>
      </div>

      <div class="order-meta">
        <span>📍 ${esc(o.commune || "?")}${o.wilaya ? ", " + esc(o.wilaya) : ""}</span>
        ${o.qty ? `<span>📦 ×${o.qty}</span>` : ""}
      </div>

      <div class="order-product">${esc(o.product || "")}</div>

      <div class="card-bottom">
        <span class="order-badge badge-${cls}">${statusLabel(status)}</span>
        ${dsLabel ? `<span class="ds-badge ds-${dsClass}">🚚 ${esc(dsLabel)}</span>` : ""}
        ${o.tracking ? `<span class="track-tag">🔖 ${esc(o.tracking)}</span>` : ""}
      </div>
    </article>
  `;
}

function extraSource(extra) {
  if (!extra) return null;
  const s = String(extra).toUpperCase();
  if (s.includes("WEBSITE-SHOPIFY")) return { label: "Shopify",  cls: "shopify" };
  if (s.includes("WEBSITE"))         return { label: "Web",      cls: "web" };
  if (s.includes("INSTAGRAM"))       return { label: "IG",       cls: "ig" };
  if (s.includes("VIP"))             return { label: "VIP",      cls: "vip" };
  if (s.includes("MERIEM"))          return { label: "Meriem",   cls: "meriem" };
  if (s.includes("WORKER"))          return { label: "Manuel",   cls: "manual" };
  if (s.includes("AUTO-FIXED"))      return null;
  return null;
}

function statusLabel(s) {
  return {
    "Pending":   "En attente",
    "Confirmed": "Confirmée",
    "Cancelled": "Annulée",
    "Livré":     "Livrée",
    "No Answer": "Sans réponse",
    "Callback":  "Rappeler",
    "Split":     "Divisée",
  }[s] || s;
}

function deliveryStateClass(ds) {
  if (!ds) return "";
  const s = String(ds).toLowerCase();
  if (/livr[ée]|delivered|livred/.test(s))               return "delivered";
  if (/retour|returned/.test(s))                          return "returned";
  if (/annul|cancel/.test(s))                             return "cancelled";
  if (/echec|échec|failed|absent|injoignable/.test(s))    return "failed";
  if (/transit|shipped|route|cours/.test(s))              return "transit";
  if (/centre|hub|depot|dépôt|wilaya|accepted/.test(s))   return "hub";
  if (/prep|preparation|pending|attente|received/.test(s))return "pending";
  return "unknown";
}

function deliveryStateLabel(ds) {
  if (!ds) return "";
  return String(ds).replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// ============================================================
// ORDER DETAIL SHEET
// ============================================================
function openOrder(orderNum) {
  const o = state.orders.find(x => x.order === orderNum);
  if (!o) return;
  state.currentOrder = o;

  const telNum = (o.phone || "").replace(/[^\d+]/g, "");
  const cls = safeCls(o.status || "Pending");
  const dsClass = deliveryStateClass(o.delivery_state);
  const dsLabel = deliveryStateLabel(o.delivery_state);
  const sourceTag = extraSource(o.extra);

  $("#sheet-body").innerHTML = `
    <div class="detail-header">
      <div class="detail-ref">
        ${esc(o.order)}
        ${sourceTag ? `<span class="source-tag src-${sourceTag.cls}">${sourceTag.label}</span>` : ""}
        ${o.sent_ok ? `<span class="sent-tag">✅ Anderson</span>` : ""}
      </div>
      <div class="detail-name">${esc(o.name || "Client")}</div>
      <div class="detail-total">${fmtMoney(o.total)}</div>
      <div class="detail-badges">
        <span class="order-badge badge-${cls}">${statusLabel(o.status || "Pending")}</span>
        ${dsLabel ? `<span class="ds-badge ds-${dsClass}">🚚 ${esc(dsLabel)}</span>` : ""}
      </div>
    </div>

    <a class="call-btn" href="tel:${esc(telNum)}">
      <div class="call-icon">📞</div>
      <div>
        <div>Appeler le client</div>
        <div class="call-num">${esc(o.phone || "")}</div>
      </div>
    </a>

    <div class="detail-grid">
      <div class="detail-cell">
        <div class="detail-label">Wilaya</div>
        <div class="detail-value">${esc(o.wilaya || "—")}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-label">Commune</div>
        <div class="detail-value">${esc(o.commune || "—")}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-label">Quantité</div>
        <div class="detail-value">${o.qty || 1}</div>
      </div>
      <div class="detail-cell">
        <div class="detail-label">Date &amp; heure</div>
        <div class="detail-value">${esc(fmtDateTimeLong(o.date))}</div>
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-label">Produit</div>
      <div class="detail-value">${esc(o.product || "")}</div>
    </div>

    ${o.tracking ? `
      <div class="detail-section">
        <div class="detail-label">Tracking Anderson</div>
        <div class="detail-value" style="font-family:'JetBrains Mono',monospace;font-size:13px;">
          ${esc(o.tracking)}
        </div>
      </div>` : ""}

    ${o.extra ? `
      <div class="detail-section">
        <div class="detail-label">Notes / Source</div>
        <div class="detail-value" style="font-size:13px;color:var(--ink-soft)">${esc(o.extra)}</div>
      </div>` : ""}

    <div class="action-grid">
      <button class="action-btn action-confirm" data-status="Confirmed">
        <span class="icon">✅</span>
        Confirmer et envoyer à Anderson
      </button>
      <button class="action-btn action-cancel" data-status="Cancelled">
        <span class="icon">❌</span>Annuler
      </button>
      <button class="action-btn action-noanswer" data-status="No Answer">
        <span class="icon">📵</span>Sans réponse
      </button>
      <button class="action-btn action-callback" data-status="Callback">
        <span class="icon">🔁</span>Rappeler plus tard
      </button>
    </div>
  `;

  $$("#sheet-body .action-btn").forEach(btn => {
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

    const o = state.orders.find(x => x.order === orderNum);
    if (o) o.status = newStatus;

    toast(isConfirm
      ? (res.sent_to_anderson ? "✅ Confirmé + envoyé à Anderson" : "✅ Confirmé (Anderson: erreur)")
      : "✅ " + statusLabel(newStatus), "success");

    closeSheet();
    updateStats();
    renderOrders();
  } catch (err) {
    toast("❌ " + err.message, "error");
    btns.forEach(b => b.disabled = false);
  }
}

// ============================================================
// ESCAPE
// ============================================================
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// ============================================================
// BOOT
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  if (!CFG.API_URL || CFG.API_URL.includes("PASTE_YOUR")) {
    document.body.innerHTML = `<div style="padding:40px;text-align:center;font-family:system-ui">
      <h2>⚙️ Configuration requise</h2>
      <p>Ouvrez <code>config.js</code> et collez l'URL Apps Script.</p></div>`;
    return;
  }
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

// Safety net
setTimeout(() => {
  const splash = document.getElementById("splash-screen");
  if (splash && splash.classList.contains("active")) {
    const t = localStorage.getItem(LS_TOKEN), w = localStorage.getItem(LS_WORKER);
    if (t && w) { state.token = t; state.worker = Number(w); enterDashboard(); }
    else { autoLogin(); }
  }
}, 10000);
