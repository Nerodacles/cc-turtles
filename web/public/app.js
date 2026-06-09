// app.js — dashboard client: live WS, turtle list + top-down map.

const ROLE_COLOR = { miner: "#3fb950", courier: "#58a6ff", fueler: "#d29922" };
const STALE_MS = 15000;

const turtles = new Map(); // id -> { data, last }
let lastKnown = {};        // id(str) -> { label, pos, level, role, site, zoneIdx, ts }
const ores = [];           // { n, x, y, z }
let zonesData = {};        // site -> { done:{idx}, claims:{} }
let ws, reconnectT;
let meta = { latest: "?", server: "?", bridge: null };
let watchId = null;        // turtle whose detail panel is open

// F4: stats state — mirrors server-side shape; null until first snapshot/stats msg.
let statsData = null; // { session:{start,ores}, totals, history }

// ore name -> color (drops the minecraft:/_ore already)
const ORE_COLOR = {
  diamond: "#4ee6e6", emerald: "#3fe06b", ancient_debris: "#a8682f",
  debris: "#a8682f", gold: "#f2c14e", nether_gold: "#f2c14e",
  iron: "#d8b89a", copper: "#e0794a", redstone: "#f3534a",
  lapis: "#3b6fe0", coal: "#5b6470", quartz: "#e8e2d8",
};
const oreColor = (n) => ORE_COLOR[n] || "#c0c8d4";

// ---- WebSocket ------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { setConn(true); ws.send(JSON.stringify({ type: "hello", role: "browser" })); };
  ws.onclose = () => { setConn(false); clearTimeout(reconnectT); reconnectT = setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "snapshot") {
      turtles.clear();
      trailBufs.clear();  // reset all trails on reconnect / full snapshot
      for (const t of m.turtles) turtles.set(t.id, { data: t.data, last: Date.now() - (t.age || 0) });
      if (m.lastKnown) lastKnown = m.lastKnown;
      meta = { latest: m.latest, server: m.server, bridge: m.bridge };
      ores.length = 0;
      if (Array.isArray(m.ores)) for (const o of m.ores) ores.push(o);
      needKey = !!m.needKey;
      zonesData = m.zones || {};
      // F4: load stats from snapshot (absent in older server versions — handle gracefully)
      if (m.stats && m.stats.session && m.stats.totals) statsData = m.stats;
      lockUI();
      renderMeta();
      renderZones();
      renderStats();
    } else if (m.type === "zones") {
      if (m.site === "*" || m.z === null) {
        if (m.site === "*") zonesData = {}; else delete zonesData[m.site];
      } else { zonesData[m.site] = m.z; }
      renderZones();
    } else if (m.type === "auth_ok") {
      localStorage.setItem("cmdkey", cmdKey);
      lockUI();
      if (pendingOpen != null) { const id = pendingOpen; pendingOpen = null; openDetail(id); }
    } else if (m.type === "auth_fail") {
      cmdKey = ""; pendingOpen = null; lockUI(); alert("Wrong key.");
    } else if (m.type === "denied") {
      lock(); alert("Command denied — key required.");
    } else if (m.type === "status") {
      turtles.set(m.id, { data: m.data, last: Date.now() });
      // mirror the server's deepest-layer record locally (no extra
      // traffic): keeps the detail "resume Y" fresh between zone ops
      const d = m.data;
      if (d.role === "miner" && d.site && d.slot != null && d.level != null) {
        const k = `${d.site.x},${d.site.y},${d.site.z}`;
        const z = (zonesData[k] ||= { done: {}, claims: {}, prog: {} });
        z.prog ||= {};
        if (z.prog[d.slot] == null || d.level < z.prog[d.slot]) z.prog[d.slot] = d.level;
      }
      // feed trail buffer with every new position
      if (d.pos) trailPush(m.id, d.pos.x, d.pos.z);
      // keep local lastKnown in sync so we have a record if it goes offline
      { const rec = (lastKnown[m.id] ||= {});
        if (d.label) rec.label = d.label;
        if (d.pos)   rec.pos   = d.pos;
        if (d.level != null) rec.level = d.level;
        if (d.site)  rec.site  = d.site;
        if (d.zoneIdx != null) rec.zoneIdx = d.zoneIdx;
        if (d.role)  rec.role  = d.role;
        rec.ts = Date.now(); }
      if (m.id === watchId) updateDetailHeader();
    } else if (m.type === "log") {
      if (m.id !== watchId) return;
      const el = document.getElementById("dLog");
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      if (m.full) el.textContent = (m.lines || []).join("\n");
      else el.textContent += (el.textContent ? "\n" : "") + (m.lines || []).join("\n");
      if (atBottom) el.scrollTop = el.scrollHeight;
      return;
    } else if (m.type === "ores") {
      for (const o of m.ores) ores.push(o);
      if (ores.length > 4000) ores.splice(0, ores.length - 4000);
    } else if (m.type === "gone") {
      turtles.delete(m.id);
      trailClear(m.id);  // discard trail when turtle goes offline
      // keep lastKnown — offline turtle shows its last position in the list
    } else if (m.type === "stats") {
      // F4: server broadcasts updated stats after ore events (~5s debounce)
      if (m.session && m.totals) {
        statsData = { session: m.session, totals: m.totals, history: m.history || [] };
        renderStats();
        return; // stats update doesn't require a full render() cycle
      }
    }
    render();
  };
}
function setConn(ok) {
  const el = document.getElementById("conn");
  el.textContent = ok ? "live" : "offline";
  el.className = "pill " + (ok ? "on" : "off");
}
function renderMeta() {
  const v = document.getElementById("ver");
  if (!v) return;
  const bad = meta.bridge && meta.bridge !== meta.latest;
  v.innerHTML = `latest <b>${esc(meta.latest)}</b>` +
    (meta.bridge ? ` · bridge <span class="${bad ? "vbad" : ""}">${esc(meta.bridge)}</span>` : "");
}
function renderZones() {
  const el = document.getElementById("zones");
  if (!el) return;
  let done = 0, active = 0;
  for (const z of Object.values(zonesData)) {
    if (z && z.done) done += Object.keys(z.done).length;
    if (z && z.claims) active += Object.keys(z.claims).length;
  }
  el.textContent = `${done} zones done · ${active} active`;
}
// ---- command key (gates the buttons; saved in localStorage) --------
let cmdKey = localStorage.getItem("cmdkey") || "";
let needKey = true;

function lockUI() {
  const locked = needKey && !cmdKey;
  document.getElementById("cmds").hidden = locked;
  document.getElementById("unlockBtn").hidden = !locked;
  // detail command section follows the same gate (log stays visible)
  const dc = document.getElementById("dcmds");
  if (dc) dc.hidden = locked;
}
function unlock() {
  const k = prompt("Command key:");
  if (k == null || k === "") return;
  cmdKey = k;
  // validate against the server; saved only if accepted
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "auth", key: k }));
}
function lock() {
  cmdKey = "";
  localStorage.removeItem("cmdkey");
  if (watchId != null) closeDetail();  // the log needs the key too
  lockUI();
}
document.getElementById("unlockBtn").addEventListener("click", unlock);
document.getElementById("lockBtn").addEventListener("click", lock);
document.getElementById("resetZonesBtn").addEventListener("click", () => {
  if (confirm("Mark ALL zones as unmined? Miners will re-mine them.")) {
    zonesData = {}; renderZones();
    sendCmd({ cmd: "reset_zones" });
  }
});

function sendCmd(payload) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "command", key: cmdKey, payload }));
}

// ---- per-turtle detail panel ---------------------------------------
function updateDetailHeader() {
  const t = turtles.get(watchId);
  const d = t && t.data;
  let extra = "";
  if (d && d.role === "miner") {
    if (d.level != null) extra += ` · Y${d.level}`;
    // deepest layer the server has stored for this zone (the resume point)
    const z = d.site && zonesData[`${d.site.x},${d.site.y},${d.site.z}`];
    const deep = z && z.prog && d.slot != null ? z.prog[d.slot] : null;
    if (deep != null) extra += ` · resume Y${deep}`;
  }
  document.getElementById("dName").textContent =
    (d && d.label || ("#" + watchId)) + (d ? ` · ${d.role || "?"} · ${d.phase || "?"}${extra}` : "");
}
let pendingOpen = null;
function openDetail(id) {
  if (needKey && !cmdKey) { pendingOpen = id; unlock(); return; }  // key first
  watchId = id;
  document.getElementById("detail").hidden = false;
  document.getElementById("dLog").textContent = "loading…";
  updateDetailHeader();
  renderList();  // highlight the selected card
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "watch", id, key: cmdKey }));
}
function closeDetail() {
  watchId = null;
  document.getElementById("detail").hidden = true;
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "watch", id: null }));
}
document.getElementById("dClose").addEventListener("click", closeDetail);
// click a card -> open its detail (event delegation: cards are re-rendered)
document.getElementById("list").addEventListener("click", (e) => {
  const card = e.target.closest(".card[data-id]");
  if (card) openDetail(+card.dataset.id);
});
// targeted commands (pause/resume/home/update for this turtle)
document.querySelectorAll(".dcmds button[data-tcmd]").forEach((b) =>
  b.addEventListener("click", () => { if (watchId != null) sendCmd({ cmd: b.dataset.tcmd, id: watchId }); })
);

// ---- commands -------------------------------------------------------
// 'update' disables its button until every live turtle reports the
// latest version (or a 2-min fallback window elapses).
let updatingUntil = 0;
function allAtLatest() {
  const now = Date.now();
  let any = false, ok = true;
  for (const t of turtles.values()) {
    if (now - t.last > STALE_MS || t.data.ver == null) continue;
    any = true;
    if (t.data.ver !== meta.latest) ok = false;
  }
  return any && ok;
}
function refreshUpdateBtn() {
  const btn = document.querySelector('.cmds button[data-cmd="update"]');
  if (!btn) return;
  const busy = Date.now() < updatingUntil && !allAtLatest();
  btn.disabled = busy;
  btn.textContent = busy ? "⟳ updating…" : "⟳ update";
  if (!busy) updatingUntil = 0;
}
document.querySelectorAll(".cmds button[data-cmd]").forEach((b) =>
  b.addEventListener("click", () => {
    sendCmd({ cmd: b.dataset.cmd });
    if (b.dataset.cmd === "update") { updatingUntil = Date.now() + 120000; refreshUpdateBtn(); }
  })
);
const dlg = document.getElementById("entryDlg");
document.getElementById("entryBtn").addEventListener("click", () => dlg.showModal());
dlg.addEventListener("close", () => {
  if (dlg.returnValue !== "ok") return;
  const x = +document.getElementById("ex").value;
  const y = +document.getElementById("ey").value;
  const z = +document.getElementById("ez").value;
  if ([x, y, z].some(Number.isNaN)) return;
  sendCmd({ cmd: "mine_at", pos: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } });
});

// ---- list -----------------------------------------------------------
function fmtFuel(f) {
  if (f === "unlimited") return "∞";
  f = +f || 0;
  if (f >= 1000) return (f / 1000).toFixed(f >= 100000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return "" + f;
}
function roleColor(r) { return ROLE_COLOR[r] || "#8b97a7"; }

function fmtAgo(ts, now) {
  if (!ts) return "unknown";
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}
function offlineCardHtml(id, now) {
  const r = lastKnown[id] || {};
  const c = roleColor(r.role);
  const ago = fmtAgo(r.ts, now);
  const posStr = r.pos ? `X${r.pos.x} Y${r.pos.y} Z${r.pos.z}` : "pos unknown";
  const layer = r.level != null ? ` · Y${r.level}` : "";
  const zone  = r.zoneIdx != null ? ` · zone ${r.zoneIdx}` : "";
  return `<div class="card stale ${+id === watchId ? "sel" : ""}" data-id="${id}">
    <span class="dot" style="background:${c};opacity:0.5"></span>
    <div>
      <span class="name" style="color:var(--dim)">${esc(r.label || ("#" + id))}</span>
      <div class="sub">#${id} · offline · ${ago}${zone}${layer}</div>
      <div class="sub" style="font-size:11px;color:#5a6472">${posStr}</div>
    </div>
    <div class="right" style="font-size:11px;color:var(--dim)">◌</div>
  </div>`;
}
function cardHtml(id, now) {
  const t = turtles.get(id), d = t.data;
  const stale = now - t.last > STALE_MS;
  const c = roleColor(d.role);
  const slot = d.role === "miner" && d.slot != null ? " · zone " + d.slot : "";
  // current mining layer (the server persists the deepest per zone)
  const layer = d.role === "miner" && d.level != null ? " · Y" + d.level : "";
  const inv = d.inv || 0;
  const ver = d.ver
    ? `<span class="ver ${d.ver !== meta.latest ? "vbad" : ""}">${esc(d.ver)}</span>` : "";
  return `<div class="card ${stale ? "stale" : ""} ${id === watchId ? "sel" : ""}" data-id="${id}">
    <span class="dot" style="background:${c}"></span>
    <div>
      <span class="name">${esc(d.label || id)}</span>
      <div class="sub">#${id} · ${esc(d.phase || "?")}${slot}${layer} ${ver}</div>
      <div class="bar"><i style="width:${inv}%;background:${c}"></i></div>
    </div>
    <div class="right">⛽ ${fmtFuel(d.fuel)}<br>📦 ${inv}%</div>
  </div>`;
}
function renderList() {
  const now = Date.now();
  const ids = [...turtles.keys()];
  const offlineIds = Object.keys(lastKnown).map(Number)
    .filter(id => !turtles.has(id))
    .sort((a, b) => (lastKnown[b]?.ts || 0) - (lastKnown[a]?.ts || 0));
  const liveCount = ids.length, offCount = offlineIds.length;
  document.getElementById("count").textContent =
    liveCount + " live" + (offCount ? ` · ${offCount} offline` : "");
  const groups = { miner: [], courier: [], fueler: [], other: [] };
  for (const id of ids) (groups[turtles.get(id).data.role] || groups.other).push(id);
  const titles = { miner: "⛏ Miners", courier: "📦 Couriers", fueler: "⛽ Fuelers", other: "• Other" };
  let html = "";
  for (const role of ["miner", "courier", "fueler", "other"]) {
    const g = groups[role];
    if (!g.length) continue;
    g.sort((a, b) => a - b);
    html += `<div class="group" style="color:${roleColor(role)}">${titles[role]} · ${g.length}</div>`;
    html += g.map((id) => cardHtml(id, now)).join("");
  }
  if (offlineIds.length) {
    html += `<div class="group" style="color:var(--dim)">◌ Offline · ${offlineIds.length}</div>`;
    html += offlineIds.map(id => offlineCardHtml(id, now)).join("");
  }
  document.getElementById("list").innerHTML =
    (html || `<div class="card"><div class="sub">no turtles reporting…</div></div>`);
}
function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// ---- map ------------------------------------------------------------
const cv = document.getElementById("map");
const ctx = cv.getContext("2d");
let view = { ox: 0, oz: 0, scale: 2, drag: null };

// Zone geometry — mirror of the miner's chebyshev spiral so the server's
// persisted zone records (which only store the spiral idx) can be drawn at
// their real X/Z. Must match miner/main.lua: ZONE_SPREAD + gridOffset.
const ZONE_SPREAD = 16;
function gridOffset(k) {
  if (k === 0) return [0, 0];
  let r = 1, count = 1;
  while (k >= count + 8 * r) { count += 8 * r; r += 1; }
  const i = k - count;
  const cells = [];
  for (let x = -r; x <= r; x++)
    for (let z = -r; z <= r; z++)
      if (Math.max(Math.abs(x), Math.abs(z)) === r) cells.push([x, z]);
  return cells[i];  // i-th ring cell
}
// site is "x,y,z"; idx is the spiral slot. idx+1 because cell (0,0) is the
// shared junction, not a mineable zone (matches setZone in the miner).
function zonePos(siteKey, idx) {
  const [sx, , sz] = siteKey.split(",").map(Number);
  const [gx, gz] = gridOffset(idx + 1);
  return { x: sx + gx * ZONE_SPREAD, z: sz + gz * ZONE_SPREAD };
}

// ---- client-side turtle trail buffer (ring buffer, no server traffic) ----
// Keyed by turtle id (number). Stores last TRAIL_LEN {x,z} world positions.
// Updated whenever a status message brings a new pos. Cleared when turtle goes
// offline (gone message) or drops from turtles map during stale eviction.
const TRAIL_LEN = 30;
const trailBufs = new Map(); // id -> { buf: Array<{x,z}|null>, head: number, len: number }

function trailPush(id, x, z) {
  let t = trailBufs.get(id);
  if (!t) { t = { buf: new Array(TRAIL_LEN).fill(null), head: 0, len: 0 }; trailBufs.set(id, t); }
  // Only push if position actually changed to avoid bloating with stationary pings
  const prev = t.buf[(t.head + TRAIL_LEN - 1) % TRAIL_LEN];
  if (prev && prev.x === x && prev.z === z) return;
  t.buf[t.head] = { x, z };
  t.head = (t.head + 1) % TRAIL_LEN;
  if (t.len < TRAIL_LEN) t.len++;
}
function trailClear(id) { trailBufs.delete(id); }
// Prune trails for turtles that no longer exist in either live or lastKnown
function trailPrune() {
  for (const id of trailBufs.keys()) {
    // lastKnown is an object (string keys); coerce explicitly so this
    // survives a future refactor that keeps the Map key as a number.
    if (!turtles.has(id) && !lastKnown[String(id)]) trailBufs.delete(id);
  }
}

function fit() {
  // Size the backing store to the canvas's OWN CSS box (dpr-aware).
  // Called every render: a no-op when unchanged, but if the layout
  // shifted after the first paint (header wrap, flex settle, resize)
  // it re-syncs - otherwise a too-tall buffer leaves an unclearable
  // strip at the bottom that accumulates draws as you pan.
  const w = Math.round(cv.clientWidth * devicePixelRatio);
  const h = Math.round(cv.clientHeight * devicePixelRatio);
  if (w && h && (cv.width !== w || cv.height !== h)) {
    cv.width = w; cv.height = h;
    // Resizing the backing store invalidates any CanvasPattern made from
    // ctx (e.g. on a DPR change when the window moves between displays);
    // drop the hatch cache so it is rebuilt against the fresh context.
    _hatchCache = null;
  }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", renderMap);

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  view.scale = Math.max(0.2, Math.min(20, view.scale * f));
  renderMap();
}, { passive: false });
cv.addEventListener("mousedown", (e) => view.drag = { x: e.clientX, y: e.clientY, ox: view.ox, oz: view.oz });
window.addEventListener("mouseup", () => view.drag = null);
window.addEventListener("mousemove", (e) => {
  if (!view.drag) return;
  view.ox = view.drag.ox + (e.clientX - view.drag.x);
  view.oz = view.drag.oz + (e.clientY - view.drag.y);
  renderMap();
});

// Deterministic per-chunk brightness/hue tint from chunk coordinates.
// Same chunk XZ → same value every frame; cheap bit-mix, no flicker.
function chunkHash(cx, cz) {
  let h = (cx * 374761393 + cz * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 0xffffffff; // [0,1)
}

// Draw a subtle hatching pattern for partial/abandoned zones.
// Drawn into an offscreen canvas that's reused (cached by cell size).
let _hatchCache = null, _hatchSize = 0;
function getHatchPattern(cellPx) {
  const sz = Math.max(4, Math.round(cellPx));
  if (_hatchCache && _hatchSize === sz) return _hatchCache;
  const oc = document.createElement("canvas"); oc.width = sz; oc.height = sz;
  const ox = oc.getContext("2d");
  ox.clearRect(0, 0, sz, sz);
  ox.strokeStyle = "rgba(139,151,167,0.25)"; ox.lineWidth = 0.8;
  ox.beginPath(); ox.moveTo(0, sz); ox.lineTo(sz, 0); ox.stroke();
  _hatchCache = ctx.createPattern(oc, "repeat");
  _hatchSize = sz;
  return _hatchCache;
}

// Update the HTML scale bar overlay to reflect the current view scale.
function updateScaleBar(scale) {
  const el = document.getElementById("scalebarLine");
  const lb = document.getElementById("scalebarLabel");
  if (!el || !lb) return;
  // Pick a "nice" number of blocks whose pixel width fits 40-120px
  const candidates = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  let blocks = candidates[0];
  for (const c of candidates) { if (c * scale <= 120) blocks = c; else break; }
  const px = Math.round(blocks * scale);
  el.style.width = px + "px";
  lb.textContent = blocks >= 1000 ? (blocks / 1000) + "k blk" : blocks + " blk";
}

let autoCenter = true;
function renderMap() {
  fit();  // keep the backing store matched to the display box every frame
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const pts = [...turtles.entries()].filter(([, t]) => t.data.pos);
  if (autoCenter && pts.length) {
    let sx = 0, sz = 0;
    for (const [, t] of pts) { sx += t.data.pos.x; sz += t.data.pos.z; }
    view.cx = sx / pts.length; view.cz = sz / pts.length; autoCenter = false;
  }
  const cx = view.cx || 0, cz = view.cz || 0;
  const X = (x) => w / 2 + view.ox + (x - cx) * view.scale;
  const Y = (z) => h / 2 + view.oz + (z - cz) * view.scale;
  // Inverse: screen → world
  const Xw = (sx) => cx + (sx - w / 2 - view.ox) / view.scale;
  const Yw = (sy) => cz + (sy - h / 2 - view.oz) / view.scale;

  function line(a, b, c2, d2) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d2); ctx.stroke(); }

  // ---- 1. TERRAIN BACKGROUND: per-chunk tint -------------------------
  // Terrain tint stays anchored to true Minecraft chunk boundaries (multiples
  // of 16) regardless of zone-lattice phase — it is pure visual texture.
  const step = 16 * view.scale; // pixels per one ZONE_SPREAD / one chunk
  if (step >= 3) {
    // World coords of visible corners → chunk range to paint
    const cx0 = Math.floor(Xw(0) / 16) - 1, cx1 = Math.floor(Xw(w) / 16) + 1;
    const cz0 = Math.floor(Yw(0) / 16) - 1, cz1 = Math.floor(Yw(h) / 16) + 1;
    for (let chx = cx0; chx <= cx1; chx++) {
      for (let chz = cz0; chz <= cz1; chz++) {
        const rv = chunkHash(chx, chz);
        // Slight brightness variation: base dark ground colour ± tiny shift
        // Range: ~#0f1318 to ~#14191f (very subtle, avoids mud)
        const lum = Math.round(10 + rv * 6);          // 10-16
        const hueShift = rv < 0.5 ? 0 : (rv < 0.75 ? 1 : -1); // tiny warm/cool flicker
        const r = lum + hueShift, g = lum, b = lum + 4;
        const sx = X(chx * 16), sy = Y(chz * 16);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        // +1 overlap to avoid hairline seams at chunk boundaries
        ctx.fillRect(sx, sy, step + 1, step + 1);
      }
    }
  } else {
    // Too zoomed out for per-chunk tinting — single ground colour
    ctx.fillStyle = "#0f1318";
    ctx.fillRect(0, 0, w, h);
  }

  // ---- 2. ZONE-LATTICE GRID + COORDINATE LABELS ----------------------
  // The grid is anchored to the zone-room lattice of the "anchor site" so
  // that every mined-zone tile fills exactly one grid cell.
  //
  // Zone centers for a site (sx, sz) land at sx + gx*16, sz + gz*16 (integer
  // gx/gz from gridOffset). The cell boundaries that frame each zone are
  // therefore at sx ± 8 + n*16, i.e. the lattice phase is (sx - 8) in X and
  // (sz - 8) in Z.  We call these phX / phZ.
  //
  // Anchor-site selection: prefer the site that currently has live mining;
  // fall back to the site with the most recorded zones; fall back to the first
  // site key.  A single active site is the overwhelmingly common case and this
  // degenerates to "anchor to that site".  Zones from a *different* site with a
  // different (sx mod 16, sz mod 16) phase will not be cell-aligned to this
  // grid — that is accepted and noted in the zone-grid-phase memory.
  let phX = 0, phZ = 0;
  {
    // Build a quick map: siteKey -> zone count
    const siteCounts = {};
    for (const [sk, zr] of Object.entries(zonesData)) {
      if (!zr) continue;
      const n = Object.keys(zr.done || {}).length +
                Object.keys(zr.claims || {}).length +
                Object.keys(zr.prog || {}).length;
      siteCounts[sk] = (siteCounts[sk] || 0) + n;
    }
    // Find anchor: live-miner site first, else most zones, else first
    let anchorKey = null;
    for (const [, t] of turtles) {
      const d = t.data;
      if (d.role === "miner" && d.site) {
        anchorKey = `${d.site.x},${d.site.y},${d.site.z}`;
        break;
      }
    }
    if (!anchorKey) {
      let best = -1;
      for (const [sk, n] of Object.entries(siteCounts)) {
        if (n > best) { best = n; anchorKey = sk; }
      }
    }
    if (!anchorKey) {
      const keys = Object.keys(zonesData);
      if (keys.length) anchorKey = keys[0];
    }
    if (anchorKey) {
      const [asx, , asz] = anchorKey.split(",").map(Number);
      // Grid lines at asx - 8 + n*16: phase offset from 0-anchored grid
      phX = asx - ZONE_SPREAD / 2;
      phZ = asz - ZONE_SPREAD / 2;
    }
    // If no site data at all, phX/phZ stay 0 and grid is chunk-aligned (fine).
  }

  if (step > 6) {
    // Determine label frequency: every cell when zoomed in, every N cells out
    const labelEvery = step >= 60 ? 1 : step >= 20 ? 4 : step >= 8 ? 16 : 64;

    // Grid lines anchored to zone-lattice phase (phX, phZ).
    // Starting screen position: find the first grid line >= left/top edge.
    // X(phX) is the screen position of the phase origin; (X(phX) % step) gives
    // the fractional offset, and we walk from there.
    ctx.strokeStyle = "#1e2530"; ctx.lineWidth = 0.8;
    for (let gx = (X(phX) % step + w * 2) % step; gx < w + step; gx += step) {
      // True world X of this grid line: invert screen pos back to world, snap to lattice
      const worldX = Math.round((Xw(gx) - phX) / 16) * 16 + phX;
      if (worldX === 0) continue; // world-axis drawn separately below
      line(gx, 0, gx, h);
    }
    for (let gy = (Y(phZ) % step + h * 2) % step; gy < h + step; gy += step) {
      const worldZ = Math.round((Yw(gy) - phZ) / 16) * 16 + phZ;
      if (worldZ === 0) continue;
      line(0, gy, w, gy);
    }

    // Axis highlights (X=0 and Z=0 world lines — not necessarily on the lattice)
    const axisX = X(0), axisZ = Y(0);
    ctx.strokeStyle = "rgba(63,185,80,0.25)"; ctx.lineWidth = 1.5;
    if (axisX >= 0 && axisX <= w) line(axisX, 0, axisX, h);
    ctx.strokeStyle = "rgba(88,166,255,0.2)"; ctx.lineWidth = 1.5;
    if (axisZ >= 0 && axisZ <= h) line(0, axisZ, w, axisZ);

    // Coordinate labels on major grid lines (real world values)
    if (step * labelEvery >= 16) {
      ctx.font = "9px ui-monospace, monospace";
      ctx.textBaseline = "top";
      // X labels along top edge
      for (let gx = (X(phX) % (step * labelEvery) + w * 4) % (step * labelEvery); gx < w; gx += step * labelEvery) {
        const worldX = Math.round((Xw(gx) - phX) / 16 / labelEvery) * 16 * labelEvery + phX;
        if (gx < 2 || gx > w - 2) continue;
        ctx.fillStyle = "rgba(11,14,19,0.75)";
        ctx.fillRect(gx + 2, 2, 34, 12);
        ctx.fillStyle = worldX === 0 ? "rgba(63,185,80,0.9)" : "rgba(139,151,167,0.7)";
        ctx.fillText("X" + Math.round(worldX), gx + 3, 3);
      }
      // Z labels along left edge
      ctx.textBaseline = "middle";
      for (let gy = (Y(phZ) % (step * labelEvery) + h * 4) % (step * labelEvery); gy < h; gy += step * labelEvery) {
        const worldZ = Math.round((Yw(gy) - phZ) / 16 / labelEvery) * 16 * labelEvery + phZ;
        if (gy < 8 || gy > h - 8) continue;
        ctx.fillStyle = "rgba(11,14,19,0.75)";
        ctx.fillRect(2, gy - 6, 34, 12);
        ctx.fillStyle = worldZ === 0 ? "rgba(88,166,255,0.9)" : "rgba(139,151,167,0.7)";
        ctx.fillText("Z" + Math.round(worldZ), 3, gy);
      }
      ctx.textBaseline = "alphabetic";
    }
  }

  // ---- 3. ZONES -------------------------------------------------------
  // Every zone the server has on record (done / claimed / mined), drawn at its
  // real spiral position. States: live (active miner) / done / partial (prog only).
  const liveZone = new Set();   // "siteKey:idx" currently being mined
  for (const [, t] of turtles) {
    const d = t.data;
    if (d.role === "miner" && d.site && d.slot != null)
      liveZone.add(`${d.site.x},${d.site.y},${d.site.z}:${d.slot}`);
  }
  // cellPx: zone tile fills exactly one lattice cell (ZONE_SPREAD blocks wide).
  // A 1px seam is subtracted in device-independent pixels so adjacent filled
  // zones look like distinct cells rather than one solid block at high zoom.
  const cellPx = ZONE_SPREAD * view.scale - 1;

  // Animated pulse phase for live zones (cheap: uses Date.now, stable per frame)
  const pulseT = (Date.now() % 2000) / 2000; // 0-1 cycling ~2s
  const pulseMag = 0.5 + 0.5 * Math.sin(pulseT * Math.PI * 2); // 0-1

  for (const [sk, zr] of Object.entries(zonesData)) {
    if (!zr) continue;
    const idxs = new Set();
    for (const k of Object.keys(zr.done || {})) idxs.add(+k);
    for (const c of Object.values(zr.claims || {})) idxs.add(c.idx);
    for (const k of Object.keys(zr.prog || {})) idxs.add(+k);
    for (const idx of idxs) {
      const p = zonePos(sk, idx);
      const half = cellPx / 2;
      const zx = X(p.x) - half, zy = Y(p.z) - half;
      if (zx + cellPx < 0 || zx > w || zy + cellPx < 0 || zy > h) continue;

      const live = liveZone.has(`${sk}:${idx}`);
      const done = !!(zr.done && zr.done[idx]);
      const partial = !done && !live && zr.prog && zr.prog[idx] != null;

      if (live) {
        // Bright dug-out fill + animated glow outline
        ctx.fillStyle = "rgba(63,185,80,0.18)";
        ctx.fillRect(zx, zy, cellPx, cellPx);
        // Glow: soft outer shadow via compositing trick (shadowBlur on stroke)
        const glowA = 0.55 + pulseMag * 0.35;
        ctx.shadowColor = "rgba(63,185,80,0.6)";
        ctx.shadowBlur = 8 + pulseMag * 6;
        ctx.strokeStyle = `rgba(63,185,80,${glowA})`;
        ctx.lineWidth = 1.8;
        ctx.strokeRect(zx, zy, cellPx, cellPx);
        ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      } else if (done) {
        // Clean dug-out dark fill, subtle green outline
        ctx.fillStyle = "rgba(30,50,35,0.55)";
        ctx.fillRect(zx, zy, cellPx, cellPx);
        ctx.strokeStyle = "rgba(63,185,80,0.28)";
        ctx.lineWidth = 1;
        ctx.strokeRect(zx, zy, cellPx, cellPx);
      } else if (partial) {
        // Hatched / abandoned
        ctx.fillStyle = "rgba(20,24,32,0.45)";
        ctx.fillRect(zx, zy, cellPx, cellPx);
        if (cellPx >= 4) {
          const pat = getHatchPattern(cellPx);
          if (pat) {
            ctx.save();
            ctx.beginPath(); ctx.rect(zx, zy, cellPx, cellPx); ctx.clip();
            ctx.fillStyle = pat;
            ctx.fillRect(zx, zy, cellPx, cellPx);
            ctx.restore();
          }
        }
        ctx.strokeStyle = "rgba(139,151,167,0.3)";
        ctx.lineWidth = 1;
        ctx.strokeRect(zx, zy, cellPx, cellPx);
      } else {
        // claimed but no prog yet — faint placeholder
        ctx.fillStyle = "rgba(139,151,167,0.04)";
        ctx.fillRect(zx, zy, cellPx, cellPx);
        ctx.strokeStyle = "rgba(139,151,167,0.18)";
        ctx.lineWidth = 1;
        ctx.strokeRect(zx, zy, cellPx, cellPx);
      }

      // Zone label when zoomed in enough
      if (view.scale >= 1.4 && cellPx >= 14) {
        const col = live ? "63,185,80" : done ? "63,185,80" : "139,151,167";
        const alpha = live ? 0.95 : done ? 0.55 : 0.4;
        ctx.font = "9px ui-monospace, monospace";
        ctx.textBaseline = "top";
        const tag = "z" + idx + (done ? " ✓" : "") +
          (zr.prog && zr.prog[idx] != null ? " Y" + zr.prog[idx] : "");
        // halo behind text
        ctx.fillStyle = "rgba(8,11,16,0.7)";
        ctx.fillText(tag, zx + 2, zy + 10);
        ctx.fillStyle = `rgba(${col},${alpha})`;
        ctx.fillText(tag, zx + 3, zy + 11);
        ctx.textBaseline = "alphabetic";
      }
    }
  }

  // ---- 4. ORES: soft radial glow dots --------------------------------
  // Each ore is a radial-gradient circle that reads like a heatmap blob.
  // createRadialGradient needs absolute screen coords, so we build per-dot.
  // With the FIFO cap at 4000 and viewport culling this stays fast.
  const oreR = Math.max(2.5, Math.min(7, view.scale * 1.4));
  for (const o of ores) {
    const ox = X(o.x), oy = Y(o.z);
    if (ox < -oreR * 2 || ox > w + oreR * 2 || oy < -oreR * 2 || oy > h + oreR * 2) continue;
    const col = oreColor(o.n);
    // Build a gradient centered at (ox, oy)
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, oreR * 2);
    // Parse colour to rgba (oreColor returns hex strings like "#4ee6e6")
    g.addColorStop(0,   hexToRgba(col, 0.92));
    g.addColorStop(0.4, hexToRgba(col, 0.55));
    g.addColorStop(1,   hexToRgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(ox, oy, oreR * 2, 0, Math.PI * 2); ctx.fill();
  }

  // ---- 5. OFFLINE TURTLES (lastKnown dagger markers) -----------------
  ctx.font = "10px ui-monospace, monospace";
  for (const [sid, r] of Object.entries(lastKnown)) {
    if (turtles.has(+sid) || !r.pos) continue;
    const px = X(r.pos.x), py = Y(r.pos.z);
    if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
    const c = roleColor(r.role);
    // Dim shadow under dot
    ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 4;
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#8b97a7";
    // Text halo
    ctx.fillStyle = "rgba(8,11,16,0.7)";
    ctx.fillText(`${r.label || ("#" + sid)} †`, px + 6, py + 5);
    ctx.fillStyle = "rgba(139,151,167,0.6)";
    ctx.fillText(`${r.label || ("#" + sid)} †`, px + 7, py + 4);
    ctx.globalAlpha = 1;
  }

  // ---- 6. TURTLE TRAILS (client-side ring buffer, = recent dig path) ----
  // Each line segment is slightly thicker and more opaque than before so
  // it reads clearly as "where this miner has been digging".
  for (const [id, t] of pts) {
    const trail = trailBufs.get(id);
    if (!trail || trail.len < 2) continue;
    const c = roleColor(t.data.role);
    // Draw oldest→newest as a fading polyline
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Walk the ring buffer in chronological order
    let prevPx = null, prevPy = null;
    for (let i = 0; i < trail.len; i++) {
      const bufIdx = (trail.head - trail.len + i + TRAIL_LEN) % TRAIL_LEN;
      const pt = trail.buf[bufIdx];
      if (!pt) continue;
      const px = X(pt.x), py = Y(pt.z);
      if (prevPx != null) {
        // Fade from ~0 at oldest to 0.6 at newest (was 0.45) — more visible dig path
        const alpha = (i / trail.len) * 0.6;
        ctx.strokeStyle = hexToRgba(c, alpha);
        ctx.beginPath(); ctx.moveTo(prevPx, prevPy); ctx.lineTo(px, py); ctx.stroke();
      }
      prevPx = px; prevPy = py;
    }
    ctx.lineWidth = 1; // reset
  }

  // ---- 6b. ASSIGNMENT LINKS: faint connector from each live miner to its zone center ----
  // A miner may be outside its zone tile (shaft transit or vein chase) — the line
  // makes the assignment unambiguous even when the dot is far from the box.
  // Only drawn for miners that report both d.site and d.slot.
  // Culled when both endpoints are off-screen.
  {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.setLineDash([3, 4]);
    for (const [id, t] of pts) {
      const d = t.data;
      if (d.role !== "miner" || !d.site || d.slot == null) continue;
      const p = d.pos;
      const px = X(p.x), py = Y(p.z);
      const sk = `${d.site.x},${d.site.y},${d.site.z}`;
      const zp = zonePos(sk, d.slot);
      const zx = X(zp.x), zy = Y(zp.z);
      // Cull: skip if both endpoints are outside the viewport (with margin)
      const margin = 20;
      const turtleOff = px < -margin || px > w + margin || py < -margin || py > h + margin;
      const zoneOff   = zx < -margin || zx > w + margin || zy < -margin || zy > h + margin;
      if (turtleOff && zoneOff) continue;
      const c = roleColor(d.role);
      ctx.strokeStyle = hexToRgba(c, 0.22);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(zx, zy); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ---- 7. LIVE TURTLES -----------------------------------------------
  const now = Date.now();
  const SHAFT_RADIUS = ZONE_SPREAD / 2; // blocks; within this XZ distance from site center = shaft transit
  for (const [id, t] of pts) {
    const d = t.data, p = d.pos;
    const px = X(p.x), py = Y(p.z);
    const stale = now - t.last > STALE_MS;
    const c = roleColor(d.role);

    // Determine if this miner is in the shared shaft (XZ near site center)
    let inShaft = false;
    if (d.role === "miner" && d.site) {
      const dx = Math.abs(p.x - d.site.x);
      const dz = Math.abs(p.z - d.site.z);
      inShaft = dx <= SHAFT_RADIUS && dz <= SHAFT_RADIUS;
    }

    ctx.globalAlpha = stale ? 0.4 : 1;

    if (inShaft) {
      // Shaft-transit marker: hollow ring (no filled dot) so the center cluster
      // reads as "in the shaft," not "out of bounds."
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 6;
      // Outer hollow ring
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
      // Second inner dashed ring to suggest vertical motion
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = hexToRgba(c, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0; ctx.shadowColor = "transparent";
      ctx.lineWidth = 1;
    } else {
      // Normal filled dot
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowColor = "transparent";

      // Dark inner pupil
      ctx.fillStyle = "#080b10";
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
    }

    ctx.globalAlpha = 1;

    // Label with text halo for legibility.
    // Shaft-transiting miners get a "(shaft)" suffix so the center cluster reads clearly.
    const suffix = inShaft ? " (shaft)" : "";
    const label = `${d.label || ("#" + id)} y${p.y}${suffix}`;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = stale ? 0.4 : 1;
    ctx.fillStyle = "rgba(8,11,16,0.8)";
    ctx.fillText(label, px + 9, py + 1);
    ctx.fillStyle = stale ? "#6b7686" : (inShaft ? hexToRgba(c, 0.75) : "#c8d3df");
    ctx.fillText(label, px + 8, py);
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  }

  // ---- 8. ORIGIN MARKER (0,0) ----------------------------------------
  const ox0 = X(0), oz0 = Y(0);
  if (ox0 > -10 && ox0 < w + 10 && oz0 > -10 && oz0 < h + 10) {
    ctx.globalAlpha = 0.7;
    // Cross hairs
    ctx.strokeStyle = "#3fb950"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox0 - 5, oz0); ctx.lineTo(ox0 + 5, oz0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox0, oz0 - 5); ctx.lineTo(ox0, oz0 + 5); ctx.stroke();
    // Small ring
    ctx.strokeStyle = "#3fb950"; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(ox0, oz0, 4, 0, Math.PI * 2); ctx.stroke();
    // Label
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(8,11,16,0.7)"; ctx.fillText("0,0", ox0 + 6, oz0 + 2);
    ctx.fillStyle = "rgba(63,185,80,0.8)"; ctx.fillText("0,0", ox0 + 7, oz0 + 3);
    ctx.textBaseline = "alphabetic";
    ctx.globalAlpha = 1;
  }

  // ---- 9. MAP LEGEND (bottom-left corner of canvas) -----------------
  // Small key so the visual annotations are self-explaining without opening docs.
  {
    const lx = 8, ly = h - 8;
    ctx.save();
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = "alphabetic";

    const items = [
      { col: "rgba(139,151,167,0.55)", text: "-- -  assignment to zone" },
      { col: "rgba(63,185,80,0.55)",   text: "trail = recent dig path" },
      { col: "rgba(139,151,167,0.55)", text: "○  shaft transit" },
    ];
    const lineH = 13;
    for (let i = 0; i < items.length; i++) {
      const iy = ly - (items.length - 1 - i) * lineH;
      ctx.fillStyle = "rgba(8,11,16,0.65)";
      ctx.fillRect(lx - 1, iy - 10, 168, 12);
      ctx.fillStyle = items[i].col;
      ctx.fillText(items[i].text, lx, iy);
    }
    ctx.restore();
  }

  // Update HTML overlay (scale bar)
  updateScaleBar(view.scale);
}

// Hex colour (#rrggbb or #rgb) -> "rgba(r,g,b,a)"
function hexToRgba(hex, a) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---- F4: Stats panel --------------------------------------------------
function renderStats() {
  const tbody = document.getElementById("statsBody");
  const sessionLabel = document.getElementById("statsSession");
  if (!tbody) return;
  if (!statsData) {
    tbody.innerHTML = '<tr><td colspan="4" class="statsDim">no ore data yet</td></tr>';
    if (sessionLabel) sessionLabel.textContent = "";
    return;
  }
  const { session, totals } = statsData;
  // Session start label: relative time
  if (sessionLabel && session.start) {
    const elapsed = Date.now() - new Date(session.start).getTime();
    const h = Math.floor(elapsed / 3600000);
    const m2 = Math.floor((elapsed % 3600000) / 60000);
    sessionLabel.textContent = h > 0 ? `(${h}h ${m2}m)` : `(${m2}m)`;
  }
  // Build sorted rows: session ores first, then totals-only entries
  const allNames = new Set([...Object.keys(session.ores || {}), ...Object.keys(totals || {})]);
  if (!allNames.size) {
    tbody.innerHTML = '<tr><td colspan="4" class="statsDim">no ore data yet</td></tr>';
    return;
  }
  // Sort by session count desc, then total count desc
  const sorted = [...allNames].sort((a, b) => {
    const ds = (session.ores[b] || 0) - (session.ores[a] || 0);
    if (ds !== 0) return ds;
    return (totals[b] || 0) - (totals[a] || 0);
  });
  // Max session count for bar width scaling
  const maxSess = Math.max(1, ...sorted.map((n) => session.ores[n] || 0));
  // Session duration in hours for rate
  const sessionElapsedH = Math.max(1 / 60, (Date.now() - new Date(session.start).getTime()) / 3600000);
  let html = "";
  for (const name of sorted) {
    const sess = session.ores[name] || 0;
    const tot = totals[name] || 0;
    const rateH = sess > 0 ? (sess / sessionElapsedH).toFixed(1) : "—";
    const barW = Math.max(3, Math.round((sess / maxSess) * 48));
    const col = oreColor(name);
    html += `<tr>
      <td><span class="statsOreBar" style="width:${barW}px;background:${col}"></span><span class="statsOreName">${esc(name)}</span></td>
      <td>${sess || "—"}</td>
      <td>${rateH}</td>
      <td>${tot || "—"}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

function renderLegend() {
  const el = document.getElementById("legend");
  if (!el) return;
  if (!ores.length) { el.innerHTML = ""; return; }
  const counts = {};
  for (const o of ores) counts[o.n] = (counts[o.n] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  el.innerHTML = rows.map(([n, c]) =>
    `<div class="row"><span class="sw" style="background:${oreColor(n)}"></span>` +
    `<span class="n">${esc(n)}</span><span class="c">${c}</span></div>`).join("") +
    `<div class="row tot"><span class="n">found</span><span class="c">${ores.length}</span></div>`;
}

function render() { trailPrune(); renderList(); renderMap(); renderLegend(); renderStats(); refreshUpdateBtn(); }

fit(); lockUI(); connect();
setInterval(render, 1000); // refresh stale fades + ages
