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
      for (const t of m.turtles) turtles.set(t.id, { data: t.data, last: Date.now() - (t.age || 0) });
      if (m.lastKnown) lastKnown = m.lastKnown;
      meta = { latest: m.latest, server: m.server, bridge: m.bridge };
      ores.length = 0;
      if (Array.isArray(m.ores)) for (const o of m.ores) ores.push(o);
      needKey = !!m.needKey;
      zonesData = m.zones || {};
      lockUI();
      renderMeta();
      renderZones();
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
      // keep lastKnown — offline turtle shows its last position in the list
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

function fit() {
  // Size the backing store to the canvas's OWN CSS box (dpr-aware).
  // Called every render: a no-op when unchanged, but if the layout
  // shifted after the first paint (header wrap, flex settle, resize)
  // it re-syncs - otherwise a too-tall buffer leaves an unclearable
  // strip at the bottom that accumulates draws as you pan.
  const w = Math.round(cv.clientWidth * devicePixelRatio);
  const h = Math.round(cv.clientHeight * devicePixelRatio);
  if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
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

  // grid
  ctx.strokeStyle = "#1a212c"; ctx.lineWidth = 1;
  const step = 16 * view.scale;
  if (step > 6) {
    for (let gx = (X(cx) % step + w) % step; gx < w; gx += step) line(gx, 0, gx, h);
    for (let gy = (Y(cz) % step + h) % step; gy < h; gy += step) line(0, gy, w, gy);
  }

  // ZONES — every zone the server has on record (done / claimed / mined),
  // drawn at its real spiral position so they persist on the map even when
  // no turtle is live. Zones with a live miner = bright; old ones = faint.
  const liveZone = new Set();   // "siteKey:idx" currently being mined
  for (const [, t] of turtles) {
    const d = t.data;
    if (d.role === "miner" && d.site && d.slot != null)
      liveZone.add(`${d.site.x},${d.site.y},${d.site.z}:${d.slot}`);
  }
  const half = (ZONE_SPREAD / 2 - 1) * view.scale;  // small gap between cells
  for (const [sk, zr] of Object.entries(zonesData)) {
    if (!zr) continue;
    const idxs = new Set();
    for (const k of Object.keys(zr.done || {})) idxs.add(+k);
    for (const c of Object.values(zr.claims || {})) idxs.add(c.idx);
    for (const k of Object.keys(zr.prog || {})) idxs.add(+k);
    for (const idx of idxs) {
      const p = zonePos(sk, idx);
      const zx = X(p.x) - half, zy = Y(p.z) - half;
      if (zx < -half * 2 || zx > w || zy < -half * 2 || zy > h) continue;
      const live = liveZone.has(`${sk}:${idx}`);
      const done = !!(zr.done && zr.done[idx]);
      // current = bright green; done (old) = faint green; touched but not
      // done (abandoned/partial) = faint grey
      const col = live ? "63,185,80" : done ? "63,185,80" : "139,151,167";
      ctx.fillStyle   = `rgba(${col},${live ? 0.14 : 0.05})`;
      ctx.strokeStyle = `rgba(${col},${live ? 0.85 : 0.22})`;
      ctx.lineWidth = live ? 1.5 : 1;
      ctx.fillRect(zx, zy, half * 2, half * 2);
      ctx.strokeRect(zx, zy, half * 2, half * 2);
      // label only when zoomed in enough to read it
      if (view.scale >= 1.4) {
        ctx.fillStyle = `rgba(${col},${live ? 0.9 : 0.4})`;
        ctx.font = "9px ui-monospace, monospace";
        const tag = "z" + idx + (done ? " ✓" : "") +
          (zr.prog && zr.prog[idx] != null ? " Y" + zr.prog[idx] : "");
        ctx.fillText(tag, zx + 3, zy + 11);
      }
    }
  }

  // discovered ores (under the turtles)
  for (const o of ores) {
    const ox = X(o.x), oy = Y(o.z);
    if (ox < -4 || ox > w + 4 || oy < -4 || oy > h + 4) continue;
    ctx.fillStyle = oreColor(o.n);
    ctx.fillRect(ox - 1.5, oy - 1.5, 3, 3);
  }

  // offline turtles (lastKnown, not live) — dim markers so you can find them
  ctx.globalAlpha = 0.28;
  for (const [sid, r] of Object.entries(lastKnown)) {
    if (turtles.has(+sid) || !r.pos) continue;
    const px = X(r.pos.x), py = Y(r.pos.z);
    if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
    ctx.fillStyle = roleColor(r.role);
    ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fill();
    ctx.fillStyle = "#8b97a7"; ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`${esc(r.label || ("#" + sid))} †`, px + 7, py + 4);
  }
  ctx.globalAlpha = 1;

  // turtles
  const now = Date.now();
  for (const [id, t] of pts) {
    const d = t.data, p = d.pos;
    const px = X(p.x), py = Y(p.z);
    const stale = now - t.last > STALE_MS;
    const c = roleColor(d.role);
    // (zone rectangles are drawn as a persistent layer above, from the
    // server's zone records — no longer per-live-turtle here)
    ctx.globalAlpha = stale ? 0.4 : 1;
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    ctx.fillStyle = "#0b0e13"; ctx.beginPath(); ctx.arc(px, py, 2, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#aeb9c7"; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${d.label || ("#" + id)} y${p.y}`, px + 8, py + 4);
  }
  function line(a, b, c2, d2) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d2); ctx.stroke(); }
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

function render() { renderList(); renderMap(); renderLegend(); refreshUpdateBtn(); }

fit(); lockUI(); connect();
setInterval(render, 1000); // refresh stale fades + ages
