// app.js — dashboard client: live WS, turtle list + top-down map.

const ROLE_COLOR = { miner: "#3fb950", courier: "#58a6ff", fueler: "#d29922" };
const STALE_MS = 15000;

const turtles = new Map(); // id -> { data, last }
let ws, reconnectT;

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
    } else if (m.type === "status") {
      turtles.set(m.id, { data: m.data, last: Date.now() });
    } else if (m.type === "gone") {
      turtles.delete(m.id);
    }
    render();
  };
}
function setConn(ok) {
  const el = document.getElementById("conn");
  el.textContent = ok ? "live" : "offline";
  el.className = "pill " + (ok ? "on" : "off");
}
function sendCmd(payload) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "command", payload }));
}

// ---- commands -------------------------------------------------------
document.querySelectorAll(".cmds button[data-cmd]").forEach((b) =>
  b.addEventListener("click", () => sendCmd({ cmd: b.dataset.cmd }))
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

function renderList() {
  const now = Date.now();
  const ids = [...turtles.keys()].sort((a, b) => a - b);
  document.getElementById("count").textContent = ids.length + " turtles";
  const html = ids.map((id) => {
    const t = turtles.get(id), d = t.data;
    const stale = now - t.last > STALE_MS;
    const c = roleColor(d.role);
    const slot = d.role === "miner" && d.slot != null ? " · zone " + d.slot : "";
    const inv = d.inv || 0;
    return `<div class="card ${stale ? "stale" : ""}">
      <span class="dot" style="background:${c}"></span>
      <div>
        <span class="name">${esc(d.label || id)}</span>
        <span class="role-tag" style="background:${c}22;color:${c}">${(d.role || "?")[0].toUpperCase()}</span>
        <div class="sub">#${id} · ${esc(d.phase || "?")}${slot}</div>
        <div class="bar"><i style="width:${inv}%;background:${c}"></i></div>
      </div>
      <div class="right">⛽ ${fmtFuel(d.fuel)}<br>📦 ${inv}%</div>
    </div>`;
  }).join("");
  document.getElementById("list").innerHTML = html || `<div class="card"><div class="sub">no turtles reporting…</div></div>`;
}
function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

// ---- map ------------------------------------------------------------
const cv = document.getElementById("map");
const ctx = cv.getContext("2d");
let view = { ox: 0, oz: 0, scale: 2, drag: null };

function fit() {
  const r = cv.parentElement.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", () => { fit(); renderMap(); });

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
  const w = cv.clientWidth, h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const pts = [...turtles.values()].filter((t) => t.data.pos);
  if (autoCenter && pts.length) {
    let sx = 0, sz = 0;
    for (const t of pts) { sx += t.data.pos.x; sz += t.data.pos.z; }
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

  // turtles
  const now = Date.now();
  for (const t of pts) {
    const d = t.data, p = d.pos;
    const px = X(p.x), py = Y(p.z);
    const stale = now - t.last > STALE_MS;
    const c = roleColor(d.role);
    // zone marker for miners
    if (d.role === "miner" && d.claim) {
      ctx.strokeStyle = c + "55"; ctx.lineWidth = 1;
      const half = 5.5 * view.scale;
      ctx.strokeRect(X(d.claim.x) - half, Y(d.claim.z) - half, half * 2, half * 2);
    }
    ctx.globalAlpha = stale ? 0.4 : 1;
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
    ctx.fillStyle = "#0b0e13"; ctx.beginPath(); ctx.arc(px, py, 2, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#aeb9c7"; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${d.label || ("#" + 0)} y${p.y}`, px + 8, py + 4);
  }
  function line(a, b, c2, d2) { ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d2); ctx.stroke(); }
}

function render() { renderList(); renderMap(); }

fit(); connect();
setInterval(render, 1000); // refresh stale fades + ages
