// Admin UI — plain ES module, no build step. All external text (market
// questions, API results) goes through textContent, never innerHTML: this
// page can enable live trading, so a crafted market title must not be able
// to run script here.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const TOKEN_KEY = "arb-admin-token";

const $ = (id) => document.getElementById(id);

// h("div", { class: "x", onclick: fn }, "text", childNode, ...)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- formatting ----------
const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const pct = (v, d = 2) => (num(v) == null ? "—" : `${(num(v) * 100).toFixed(d)}%`);
const usd = (v, d = 2) => (num(v) == null ? "—" : `$${num(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const compact = (v) => (num(v) == null ? "—" : `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(num(v))}`);
const cents = (p) => (num(p) == null ? "—" : `${(num(p) * 100).toFixed(1)}¢`);
const shares = (v) => (num(v) == null ? "—" : num(v).toLocaleString("en-US", { maximumFractionDigits: 2 }));
function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s trước`;
  if (s < 3600) return `${Math.floor(s / 60)}m trước`;
  if (s < 86400) return `${Math.floor(s / 3600)}h trước`;
  return new Date(iso).toLocaleString();
}
const time = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function toast(msg, kind = "") {
  const el = h("div", { class: `toast ${kind}` }, msg);
  $("toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- auth + API ----------
let token = sessionStorage.getItem(TOKEN_KEY) || "";

function showLogin(error = "") {
  $("login").classList.remove("hidden");
  $("login-error").textContent = error;
  $("login-username").focus();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401) {
    token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    showLogin("Phiên đăng nhập không hợp lệ hoặc đã hết hạn.");
    throw new Error("unauthorized");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    token = body.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    $("login").classList.add("hidden");
    $("login-password").value = "";
    refresh();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem(TOKEN_KEY);
  showLogin();
});

// ---------- commands ----------
let botOnline = false;

async function sendCommand(type, payload, label) {
  if (!botOnline && !confirm("Bot đang OFFLINE. Lệnh sẽ hết hạn sau 60s nếu bot không lên lại. Vẫn gửi?")) return;
  let id;
  try {
    ({ id } = await api("/api/commands", { method: "POST", body: JSON.stringify({ type, payload }) }));
  } catch (err) {
    toast(`${label}: ${err.message}`, "bad");
    return;
  }
  toast(`${label}: đã gửi, chờ bot xử lý…`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await api("/api/commands?limit=50").catch(() => []);
    const row = rows.find((r) => r.id === id);
    if (row && row.status !== "pending") {
      const result = row.result ? JSON.parse(row.result) : null;
      if (row.status === "done") toast(`${label}: thành công`, "ok");
      else toast(`${label}: thất bại — ${result?.error ?? "unknown"}`, "bad");
      refresh();
      return;
    }
  }
  toast(`${label}: bot chưa phản hồi sau 30s`, "bad");
}

// ---------- bot stop/start (deeper than pause/resume: tears down/rebuilds
// the WebSocket + scan loop entirely) — same commands-queue path as every
// other control action, not a direct OS/pm2 call. See STRATEGY.md. ----------
function renderProcessControl(status) {
  const el = $("process-state");
  const [start, stop, restart] = [$("process-start"), $("process-stop"), $("process-restart")];
  if (!status) {
    el.textContent = "—";
    start.disabled = stop.disabled = restart.disabled = true;
    return;
  }
  const running = Boolean(status.running);
  el.textContent = running
    ? `Đang chạy${status.wsConnected ? " · WS OK" : " · WS đang kết nối lại"} · ${shares(status.tokensSubscribed)} token`
    : "Đã dừng (idle) — chỉ chờ lệnh Start";
  start.disabled = running;
  stop.disabled = !running;
  restart.disabled = !running;
}

$("process-start").addEventListener("click", () => sendCommand("start", {}, "Start"));
$("process-stop").addEventListener("click", () => {
  if (confirm("Dừng hẳn bot? Sẽ ngắt kết nối, không quét/trade cho tới khi Start lại.")) sendCommand("stop", {}, "Stop");
});
$("process-restart").addEventListener("click", async () => {
  await sendCommand("stop", {}, "Restart (stop)");
  await sendCommand("start", {}, "Restart (start)");
});

// ---------- tabs ----------
let activeTab = "dashboard";
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  activeTab = btn.dataset.tab;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b === btn);
  for (const s of document.querySelectorAll(".tab-panel")) s.classList.toggle("hidden", s.id !== `tab-${activeTab}`);
  if (activeTab !== "markets") closeOrderbook();
  if (activeTab === "markets" && !markets.length) loadMarkets();
  refresh();
});

// ---------- status / header ----------
let lastStatus = null;

function renderHeader({ status, online }) {
  botOnline = online;
  lastStatus = status;
  $("online-pill").className = `pill ${online ? "online" : "offline"}`;
  $("online-text").textContent = online ? "Online" : status ? `Offline · ${ago(status.heartbeat)}` : "Chưa chạy";
  const badge = $("mode-badge");
  if (!status) {
    badge.className = "badge";
    badge.textContent = "—";
  } else if (status.running === false) {
    badge.className = "badge paused";
    badge.textContent = "STOPPED";
  } else if (status.paused) {
    badge.className = "badge paused";
    badge.textContent = "PAUSED";
  } else if (status.enableTrading) {
    badge.className = "badge live";
    badge.textContent = "LIVE";
  } else {
    badge.className = "badge dry";
    badge.textContent = "DRY-RUN";
  }
  $("offline-banner").classList.toggle("hidden", online);
}

// ---------- dashboard ----------
let settingsDirty = false;
for (const id of ["set-min", "set-exec", "set-size"]) $(id).addEventListener("input", () => (settingsDirty = true));

function card(label, value, sub, valueClass = "") {
  return h("div", { class: "card" }, h("div", { class: "label" }, label), h("div", { class: `value ${valueClass}` }, value), sub ? h("div", { class: "sub" }, sub) : null);
}

function renderDashboard(summary, { status }) {
  const o = summary.opportunities;
  const t = summary.trades;
  const p = summary.openPositions;
  const filledCount = t.byStatus.filled ?? 0;
  const failedCount = Object.entries(t.byStatus).filter(([k]) => k !== "filled").reduce((s, [, n]) => s + n, 0);

  $("cards").replaceChildren(
    card("Cơ hội đã ghi", shares(o.total), `${shares(o.sizeable ?? 0)} đủ size để trade`),
    card("Net margin trung bình", pct(o.avgMargin), o.lastTs ? `gần nhất ${ago(o.lastTs)}` : "chưa có"),
    card("Lãi giả định", usd(o.hypotheticalProfit), "nếu trade hết cơ hội đủ size", "pos"),
    card("Lệnh thật đã khớp", shares(filledCount), `${failedCount} lỗi/unwind`),
    card("Lãi kỳ vọng (lệnh thật)", usd(t.filledExpectedProfit), `vốn đã dùng ${usd(t.filledCost)}`, "pos"),
    card("Vị thế đang mở", shares(p.count), `khoá ${usd(p.lockedCapital)} → nhận ${usd(p.expectedPayout)}`),
    card("Thanh khoản market (median)", compact(o.medianLiquidity), `trung bình ${compact(o.avgLiquidity)}`),
    card("Orderbook updates", status ? shares(status.bookUpdates) : "—", status ? `${shares(status.marketsLoaded)} markets · WS ${status.wsConnected ? "OK" : "DOWN"}` : "")
  );

  const reasons = Object.entries(o.byReason);
  $("by-reason").replaceChildren(
    ...(reasons.length ? reasons.map(([r, n]) => h("span", { class: `badge ${r === "executed" ? "ok" : ""}` }, `${r}: ${n}`)) : [h("span", { class: "muted" }, "Chưa có dữ liệu")])
  );

  const s = status ?? {};
  const info = [
    ["Wallet", s.walletAddress ?? "—"],
    ["Khởi động", s.startedAt ? `${time(s.startedAt)} (${ago(s.startedAt)})` : "—"],
    ["Heartbeat", s.heartbeat ? ago(s.heartbeat) : "—"],
    ["Redeem", s.redeemConfigured ? "Đã cấu hình" : "Chưa cấu hình địa chỉ contract"],
  ];
  $("bot-info").replaceChildren(...info.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));

  // controls
  const live = Boolean(s.enableTrading);
  $("trading-state").textContent = status ? (live ? "LIVE — đặt lệnh tiền thật" : "DRY-RUN — chỉ ghi log") : "—";
  const tt = $("toggle-trading");
  tt.textContent = live ? "Tắt trading thật" : "Bật trading thật";
  tt.className = `btn ${live ? "success" : "danger"}`;
  tt.disabled = !status;

  $("pause-state").textContent = status ? (s.paused ? "Tạm dừng (vẫn quét & ghi log)" : "Đang hoạt động") : "—";
  const tp = $("toggle-pause");
  tp.textContent = s.paused ? "Tiếp tục" : "Tạm dừng";
  tp.disabled = !status;

  if (status && !settingsDirty) {
    $("set-min").value = +(s.minProfitMargin * 100).toFixed(4);
    $("set-exec").value = +(s.executeMarginThreshold * 100).toFixed(4);
    $("set-size").value = s.maxOrderSizeUsdc;
  }
}

$("toggle-trading").addEventListener("click", () => {
  const live = Boolean(lastStatus?.enableTrading);
  if (live) {
    if (confirm("Tắt trading thật? Bot quay về DRY-RUN.")) sendCommand("set_config", { enableTrading: false }, "Tắt trading");
    return;
  }
  const typed = prompt(
    `BẬT GIAO DỊCH TIỀN THẬT với tối đa ${usd(lastStatus?.maxOrderSizeUsdc)} / lệnh.\nBot sẽ kiểm tra số dư/allowance trước khi bật.\nGõ ENABLE để xác nhận:`
  );
  if (typed === "ENABLE") sendCommand("set_config", { enableTrading: true }, "Bật trading");
  else if (typed !== null) toast("Không gõ đúng ENABLE — đã huỷ.", "bad");
});

$("toggle-pause").addEventListener("click", () => {
  const paused = Boolean(lastStatus?.paused);
  sendCommand(paused ? "resume" : "pause", {}, paused ? "Tiếp tục" : "Tạm dừng");
});

$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const minProfitMargin = Number($("set-min").value) / 100;
  const executeMarginThreshold = Number($("set-exec").value) / 100;
  const maxOrderSizeUsdc = Number($("set-size").value);
  if (executeMarginThreshold < minProfitMargin && !confirm("Ngưỡng thực thi thấp hơn ngưỡng ghi log — mọi cơ hội được ghi đều sẽ được trade. Tiếp tục?")) return;
  settingsDirty = false;
  sendCommand("set_config", { minProfitMargin, executeMarginThreshold, maxOrderSizeUsdc }, "Lưu cấu hình");
});

// ---------- tables ----------
function table(el, headers, rows, empty) {
  const thead = h("thead", {}, h("tr", {}, headers.map(([label, cls]) => h("th", { class: cls }, label))));
  const tbody = h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { class: "empty", colspan: headers.length }, empty)));
  el.replaceChildren(thead, tbody);
}

const REASON_BADGE = { executed: "ok", "dry-run": "dry", paused: "paused" };

function renderOpportunities(rows) {
  table(
    $("opp-table"),
    [["Thời gian"], ["Market"], ["YES", "num"], ["NO", "num"], ["Net margin", "num"], ["Shares", "num"], ["Lãi kỳ vọng", "num"], ["Thanh khoản", "num"], ["Lý do"]],
    rows.map((r) =>
      h(
        "tr",
        {},
        h("td", { title: time(r.ts) }, ago(r.ts)),
        h("td", { class: "q" }, r.question),
        h("td", { class: "num" }, cents(r.yes_ask)),
        h("td", { class: "num" }, cents(r.no_ask)),
        h("td", { class: "num pos" }, pct(r.margin)),
        h("td", { class: "num" }, shares(r.shares)),
        h("td", { class: "num" }, usd(r.expected_profit)),
        h("td", { class: "num" }, compact(r.liquidity)),
        h("td", {}, h("span", { class: `badge ${REASON_BADGE[r.reason] ?? ""}` }, r.reason))
      )
    ),
    "Chưa có cơ hội nào được ghi."
  );
}

const TRADE_BADGE = { filled: "ok", both_failed: "", partial_unwound: "paused", partial_unwind_failed: "bad" };

function renderTrades(rows) {
  table(
    $("trade-table"),
    [["Thời gian"], ["Market"], ["Shares", "num"], ["Vốn", "num"], ["Margin", "num"], ["Trạng thái"], ["Chi tiết"]],
    rows.map((r) =>
      h(
        "tr",
        {},
        h("td", { title: time(r.ts) }, ago(r.ts)),
        h("td", { class: "q" }, r.question),
        h("td", { class: "num" }, shares(r.shares)),
        h("td", { class: "num" }, usd(r.yes_spend + r.no_spend)),
        h("td", { class: "num" }, pct(r.margin)),
        h("td", {}, h("span", { class: `badge ${TRADE_BADGE[r.status] ?? ""}` }, r.status)),
        h("td", {}, r.detail ? h("details", {}, h("summary", {}, "xem"), h("pre", {}, JSON.stringify(JSON.parse(r.detail), null, 2))) : "—")
      )
    ),
    "Chưa có lệnh thật nào."
  );
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;

function renderPositions(rows) {
  const redeemReady = Boolean(lastStatus?.redeemConfigured);
  $("redeem-hint").classList.toggle("hidden", redeemReady);
  table(
    $("position-table"),
    [["Market"], ["Shares", "num"], ["Vốn khoá", "num"], ["Nhận về", "num"], ["Lãi", "num"], ["Mở lúc"], ["Trạng thái"], [""]],
    rows.map((r) => {
      const redeemed = Boolean(r.redeemed_at);
      const status = redeemed
        ? TX_RE.test(r.redeem_tx ?? "")
          ? h("a", { href: `https://polygonscan.com/tx/${r.redeem_tx}`, target: "_blank", rel: "noopener noreferrer" }, "Đã redeem ↗")
          : "Đã redeem"
        : h("span", { class: "badge" }, "Đang mở");
      const action = redeemed
        ? null
        : h(
            "button",
            {
              class: "btn small",
              disabled: !redeemReady,
              title: redeemReady ? "Chỉ redeem khi market đã resolve" : "Chưa cấu hình địa chỉ contract",
              onclick: () => {
                if (confirm(`Redeem "${r.question}"?\nChỉ làm khi market ĐÃ resolve — giao dịch on-chain, tốn POL.`)) {
                  sendCommand("redeem", { conditionId: r.condition_id, negRisk: Boolean(r.neg_risk) }, "Redeem");
                }
              },
            },
            "Redeem"
          );
      return h(
        "tr",
        {},
        h("td", { class: "q" }, r.question),
        h("td", { class: "num" }, shares(r.shares)),
        h("td", { class: "num" }, usd(r.cost)),
        h("td", { class: "num" }, usd(r.shares)),
        h("td", { class: "num pos" }, usd(r.shares - r.cost)),
        h("td", { title: time(r.opened_at) }, ago(r.opened_at)),
        h("td", {}, status),
        h("td", {}, action)
      );
    }),
    "Chưa có vị thế nào."
  );
}

function renderCommands(rows) {
  table(
    $("command-table"),
    [["#"], ["Thời gian"], ["Lệnh"], ["Tham số"], ["Trạng thái"], ["Kết quả"]],
    rows.map((r) =>
      h(
        "tr",
        {},
        h("td", {}, r.id),
        h("td", { title: time(r.created_at) }, ago(r.created_at)),
        h("td", {}, r.type),
        h("td", {}, h("code", {}, r.payload)),
        h("td", {}, h("span", { class: `badge ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "paused"}` }, r.status)),
        h("td", { class: "q" }, r.result ?? "")
      )
    ),
    "Chưa gửi lệnh nào."
  );
}

// ---------- refresh loop ----------
let refreshing = false;
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const st = await api("/api/status");
    renderHeader(st);
    if (activeTab === "dashboard") {
      renderDashboard(await api("/api/summary"), st);
      renderProcessControl(st.status);
    }
    if (activeTab === "opportunities") {
      const reason = $("opp-reason").value;
      renderOpportunities(await api(`/api/opportunities?limit=300${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`));
    }
    if (activeTab === "trades") renderTrades(await api("/api/trades?limit=300"));
    if (activeTab === "positions") renderPositions(await api("/api/positions"));
    if (activeTab === "commands") renderCommands(await api("/api/commands?limit=100"));
  } catch (err) {
    if (err.message !== "unauthorized") console.error(err);
  } finally {
    refreshing = false;
  }
}
$("opp-reason").addEventListener("change", refresh);
setInterval(refresh, 5000);

// ---------- markets (straight from Polymarket's public, CORS-open API) ----------
let markets = [];

async function loadMarkets() {
  $("market-count").textContent = "Đang tải…";
  try {
    const pages = await Promise.all(
      [0, 100, 200, 300, 400].map((offset) =>
        fetch(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100&offset=${offset}`).then((r) => (r.ok ? r.json() : []))
      )
    );
    markets = pages.flat().filter((m) => m.clobTokenIds && m.enableOrderBook !== false);
    renderMarketList();
  } catch (err) {
    $("market-count").textContent = `Lỗi tải market: ${err.message}`;
  }
}

function parseJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function renderMarketList() {
  const q = $("market-search").value.trim().toLowerCase();
  const shown = markets.filter((m) => !q || String(m.question).toLowerCase().includes(q)).slice(0, 120);
  $("market-count").textContent = `${shown.length} / ${markets.length} market (top 500 theo volume 24h)`;
  $("market-grid").replaceChildren(
    ...shown.map((m) => {
      const [yes, no] = parseJsonArray(m.outcomePrices);
      return h(
        "button",
        { class: "market-card", onclick: () => openOrderbook(m) },
        h("img", { src: m.icon || m.image || "favicon.svg", alt: "", loading: "lazy" }),
        h(
          "div",
          {},
          h("div", { class: "mq" }, m.question),
          h(
            "div",
            { class: "meta" },
            h("span", { class: "price-chip yes" }, `Yes ${cents(yes)}`),
            h("span", { class: "price-chip no" }, `No ${cents(no)}`),
            h("span", {}, `Vol 24h ${compact(m.volume24hr)}`),
            h("span", {}, `Liq ${compact(m.liquidityNum)}`)
          )
        )
      );
    })
  );
}
$("market-search").addEventListener("input", renderMarketList);
$("market-refresh").addEventListener("click", loadMarkets);

// ---------- live orderbook ----------
let ob = null; // { market, yes, no, ws, books: Map<token, {bids: Map, asks: Map}>, ping, raf }

function emptyBook() {
  return { bids: new Map(), asks: new Map() };
}

function setLevels(side, levels) {
  side.clear();
  for (const l of levels ?? []) if (Number(l.size) > 0) side.set(String(l.price), Number(l.size));
}

function applyEvent(ev) {
  if (!ob) return;
  if (ev.event_type === "book") {
    const b = ob.books.get(ev.asset_id);
    if (!b) return;
    setLevels(b.bids, ev.bids ?? ev.buys);
    setLevels(b.asks, ev.asks ?? ev.sells);
  } else if (ev.event_type === "price_change") {
    // Newer payloads carry asset_id per change in `price_changes`; older ones
    // put asset_id on the event and the list in `changes`.
    const changes = ev.price_changes ?? (ev.changes ?? []).map((c) => ({ ...c, asset_id: ev.asset_id }));
    for (const c of changes) {
      const b = ob.books.get(c.asset_id);
      if (!b) continue;
      const side = c.side === "BUY" ? b.bids : b.asks;
      if (Number(c.size) > 0) side.set(String(c.price), Number(c.size));
      else side.delete(String(c.price));
    }
  } else {
    return;
  }
  scheduleRender();
}

function scheduleRender() {
  if (!ob || ob.raf) return;
  ob.raf = requestAnimationFrame(() => {
    if (!ob) return;
    ob.raf = 0;
    renderOrderbook();
  });
}

function bestAsk(b) {
  let best = null;
  for (const p of b.asks.keys()) if (best === null || Number(p) < best) best = Number(p);
  return best;
}
function bestBid(b) {
  let best = null;
  for (const p of b.bids.keys()) if (best === null || Number(p) > best) best = Number(p);
  return best;
}

function renderBook(el, book) {
  const LEVELS = 12;
  const asks = [...book.asks].map(([p, s]) => [Number(p), s]).sort((a, b) => a[0] - b[0]).slice(0, LEVELS).reverse();
  const bids = [...book.bids].map(([p, s]) => [Number(p), s]).sort((a, b) => b[0] - a[0]).slice(0, LEVELS);
  const max = Math.max(1, ...asks.map((l) => l[1]), ...bids.map((l) => l[1]));
  const row = (cls, [p, s]) => {
    const bar = h("div", { class: "bar" });
    bar.style.width = `${(s / max) * 100}%`;
    return h("div", { class: `book-row ${cls}` }, bar, h("span", {}, cents(p)), h("span", {}, shares(s)), h("span", {}, usd(p * s)));
  };
  const ba = bestAsk(book);
  const bb = bestBid(book);
  el.replaceChildren(
    h("div", { class: "book-row book-head" }, h("span", {}, "Giá"), h("span", {}, "Shares"), h("span", {}, "Tổng")),
    ...(asks.length ? asks.map((l) => row("ask", l)) : [h("div", { class: "empty" }, "Không có lệnh bán")]),
    h("div", { class: "book-spread" }, `Spread ${ba != null && bb != null ? cents(ba - bb) : "—"}`),
    ...(bids.length ? bids.map((l) => row("bid", l)) : [h("div", { class: "empty" }, "Không có lệnh mua")])
  );
}

function renderOrderbook() {
  const yesBook = ob.books.get(ob.yes);
  const noBook = ob.books.get(ob.no);
  renderBook($("ob-yes"), yesBook);
  renderBook($("ob-no"), noBook);
  const ya = bestAsk(yesBook);
  const na = bestAsk(noBook);
  const sum = ya != null && na != null ? ya + na : null;
  const raw = sum != null ? 1 - sum : null;
  $("ob-summary").replaceChildren(
    card("Best ask YES", cents(ya)),
    card("Best ask NO", cents(na)),
    card("YES + NO", sum != null ? cents(sum) : "—", "< 100¢ là có chênh lệch"),
    card("Raw margin (trước phí)", pct(raw), raw != null && raw > 0 ? "Có cơ hội — bot sẽ trừ phí thật trước khi quyết định" : "Không có chênh lệch", raw != null && raw > 0 ? "pos" : "neg")
  );
}

async function openOrderbook(m) {
  closeOrderbook();
  const [yes, no] = parseJsonArray(m.clobTokenIds);
  if (!yes || !no) return toast("Market này không có token YES/NO.", "bad");

  ob = { market: m, yes, no, books: new Map([[yes, emptyBook()], [no, emptyBook()]]), ws: null, ping: 0, raf: 0 };
  $("market-list-view").classList.add("hidden");
  $("orderbook-view").classList.remove("hidden");
  $("ob-title").textContent = m.question;
  $("ob-sub").textContent = `Vol 24h ${compact(m.volume24hr)} · Thanh khoản ${compact(m.liquidityNum)} · ${m.negRisk ? "neg-risk" : "standard"} · kết thúc ${m.endDate ? new Date(m.endDate).toLocaleDateString() : "—"}`;
  $("ob-icon").src = m.icon || m.image || "favicon.svg";
  renderOrderbook();

  // REST snapshot first so the book isn't empty while the socket connects.
  const current = ob;
  await Promise.all(
    [yes, no].map(async (tokenId) => {
      const r = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`).catch(() => null);
      if (!r?.ok || ob !== current) return;
      const snap = await r.json();
      applyEvent({ event_type: "book", asset_id: tokenId, bids: snap.bids, asks: snap.asks });
    })
  );
  if (ob !== current) return;

  const ws = new WebSocket(WS_URL);
  ob.ws = ws;
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "market", assets_ids: [yes, no] }));
    current.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("PING"), 10_000);
  });
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || !e.data.startsWith("{") && !e.data.startsWith("[")) return; // PONG etc.
    try {
      const data = JSON.parse(e.data);
      for (const ev of Array.isArray(data) ? data : [data]) applyEvent(ev);
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.addEventListener("close", () => {
    if (ob === current) toast("Mất kết nối orderbook — mở lại market để kết nối lại.", "bad");
  });
}

function closeOrderbook() {
  if (!ob) return;
  const old = ob;
  ob = null;
  clearInterval(old.ping);
  if (old.raf) cancelAnimationFrame(old.raf);
  old.ws?.close();
  $("orderbook-view").classList.add("hidden");
  $("market-list-view").classList.remove("hidden");
}
$("ob-back").addEventListener("click", closeOrderbook);

// ---------- boot ----------
if (token) refresh();
else showLogin();
