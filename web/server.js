// server.js
// CC:Tweaked turtle swarm dashboard server.
//   - serves the static dashboard (public/)
//   - one WebSocket endpoint for everyone; clients announce a role:
//       { type:"hello", role:"bridge" }   the in-game CC bridge computer
//       { type:"hello", role:"browser" }  a dashboard tab
//   - bridge -> server:  { type:"status", id, data }   (turtle heartbeat)
//   - browser -> server: { type:"command", payload }   (start/stop/...)
//   The server keeps the latest status per turtle, fans it out to all
//   browsers, and forwards browser commands to every bridge.
//
// Env: PORT (default 8080), STALE_MS (drop a turtle after this silence).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const STALE_MS = parseInt(process.env.STALE_MS || "20000", 10);
const PUBLIC = path.join(__dirname, "public");
// Command key: browsers must send this to issue commands. Empty = no
// gate (anyone can command). Set CMD_KEY on the deployment.
const CMD_KEY = process.env.CMD_KEY || "";

// ---- LATEST version: read the single global lib/version.lua ---------
// (the no-build pod clones the repo, so this file is right here)
function readVersion() {
  try {
    const f = fs.readFileSync(path.join(__dirname, "..", "lib", "version.lua"), "utf8");
    const m = f.match(/return\s*"([^"]+)"/);
    return m ? m[1] : "?";
  } catch { return "?"; }
}
const LATEST = readVersion();
let bridgeVer = null;

// ---- latest known state, keyed by turtle id -------------------------
const turtles = new Map(); // id -> { data, last }
const ores = [];           // discovered ores: { n, x, y, z } (capped FIFO)
const ORE_CAP = 4000;
const logs = new Map();     // id -> [recent log lines] (per turtle)
const LOG_CAP = 300;

// ---- ZONE REGISTRY (authoritative, persisted to the PVC) ------------
// Per site "x,y,z": { done:{idx:1}, claims:{minerId:{idx,ts}} }. Miners
// request the lowest free spiral index; it survives crashes/home/restart.
const DATA = process.env.DATA_DIR || "/data";
const ZONES_FILE = path.join(DATA, "zones.json");
const CLAIM_TTL = parseInt(process.env.CLAIM_TTL_MS || "1800000", 10); // 30m
let zones = {};
try { zones = JSON.parse(fs.readFileSync(ZONES_FILE, "utf8")); } catch { zones = {}; }
let saveT = null;
function saveZones() { // debounced write
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ZONES_FILE, JSON.stringify(zones)); }
    catch (e) { console.error("[zones] save failed:", e.message); }
  }, 500);
}
function siteKey(s) { return `${s.x},${s.y},${s.z}`; }
function allocZone(site, miner) {
  const k = siteKey(site);
  const z = (zones[k] ||= { done: {}, claims: {} });
  const now = Date.now();
  // resume an existing live claim for this miner
  const mine = z.claims[miner];
  if (mine && now - mine.ts < CLAIM_TTL) { mine.ts = now; saveZones(); return mine.idx; }
  // prune stale claims
  for (const [m, c] of Object.entries(z.claims)) if (now - c.ts >= CLAIM_TTL) delete z.claims[m];
  const taken = new Set(Object.values(z.claims).map((c) => c.idx));
  let idx = 0;
  while (z.done[idx] || taken.has(idx)) idx++;
  z.claims[miner] = { idx, ts: now };
  saveZones();
  return idx;
}
function doneZone(site, miner, idx) {
  const z = zones[siteKey(site)]; if (!z) return;
  z.done[idx] = 1;
  if (z.claims[miner] && z.claims[miner].idx === idx) delete z.claims[miner];
  saveZones();
}
function touchClaim(site, miner, idx) { // renew from heartbeat
  if (!site || idx == null) return;
  const z = (zones[siteKey(site)] ||= { done: {}, claims: {} });
  z.claims[miner] = { idx, ts: Date.now() };
  saveZones();
}

// ---- static file server --------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // zone registry view / reset (reset frees a site to mine again)
  if (urlPath === "/api/zones") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(zones, null, 2));
  }
  if (urlPath.startsWith("/api/zones/reset") && req.method === "POST") {
    const site = decodeURIComponent((req.url.split("?site=")[1] || "").trim());
    if (site && zones[site]) { delete zones[site]; saveZones(); }
    else { zones = {}; saveZones(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  // debug: current state (is the bridge forwarding turtle status?)
  if (urlPath === "/api/state") {
    const now = Date.now();
    const out = { latest: LATEST, server: LATEST, bridge: bridgeVer,
                  bridges: bridges.size, browsers: browsers.size, turtles: [] };
    for (const [id, t] of turtles) out.turtles.push({ id, label: t.data.label, role: t.data.role, age: now - t.last });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out, null, 2));
  }
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    // Cloudflare caches .js/.css by extension and ignores our headers,
    // so cache-bust: inject ?v=LATEST into the asset URLs of the HTML
    // (CF doesn't cache HTML). A version bump = new URL = fresh assets.
    if (file.endsWith("index.html")) {
      buf = Buffer.from(buf.toString()
        .replace('href="style.css"', `href="style.css?v=${LATEST}"`)
        .replace('src="app.js"', `src="app.js?v=${LATEST}"`));
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(buf);
  });
});

// ---- websocket hub --------------------------------------------------
const wss = new WebSocketServer({ server });
const browsers = new Set();
const bridges = new Set();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(set, obj) {
  const s = JSON.stringify(obj);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(s);
}

wss.on("connection", (ws) => {
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "hello") {
      ws.role = msg.role === "bridge" ? "bridge" : "browser";
      if (ws.role === "bridge") {
        bridges.add(ws);
        if (msg.ver) bridgeVer = msg.ver;
      } else {
        browsers.add(ws);
        // send the full current snapshot to the new tab
        const now = Date.now();
        const snap = [];
        for (const [id, t] of turtles) snap.push({ id, data: t.data, age: now - t.last });
        send(ws, { type: "snapshot", turtles: snap, ores, needKey: !!CMD_KEY,
                   zones, latest: LATEST, server: LATEST, bridge: bridgeVer });
      }
      return;
    }

    if (ws.role === "bridge" && msg.type === "status" && msg.id != null) {
      // pull discovered ores out of the heartbeat into the shared map
      const newOres = Array.isArray(msg.data.ores) ? msg.data.ores : null;
      if (newOres) {
        delete msg.data.ores;
        for (const o of newOres) {
          ores.push(o);
          if (ores.length > ORE_CAP) ores.shift();
        }
        broadcast(browsers, { type: "ores", ores: newOres });
      }
      // pull log lines out of the heartbeat into the per-turtle log
      const newLog = Array.isArray(msg.data.log) ? msg.data.log : null;
      if (newLog) {
        delete msg.data.log;
        let arr = logs.get(msg.id); if (!arr) { arr = []; logs.set(msg.id, arr); }
        for (const ln of newLog) { arr.push(ln); if (arr.length > LOG_CAP) arr.shift(); }
        // stream only to browsers watching this turtle
        for (const b of browsers) if (b.watching === msg.id) send(b, { type: "log", id: msg.id, lines: newLog });
      }
      // renew this miner's zone claim from its heartbeat
      if (msg.data.role === "miner" && msg.data.site && msg.data.zoneIdx != null)
        touchClaim(msg.data.site, msg.id, msg.data.zoneIdx);
      turtles.set(msg.id, { data: msg.data, last: Date.now() });
      broadcast(browsers, { type: "status", id: msg.id, data: msg.data });
      return;
    }

    // ZONE allocation RPC (miner -> bridge -> here). Respond to the
    // bridge, which relays the grant back to the requesting miner.
    if (ws.role === "bridge" && msg.type === "zone" && msg.site && msg.miner != null) {
      if (msg.op === "done") {
        doneZone(msg.site, msg.miner, msg.idx);
        broadcast(browsers, { type: "zones", site: siteKey(msg.site), z: zones[siteKey(msg.site)] });
      } else { // request
        const idx = allocZone(msg.site, msg.miner);
        send(ws, { type: "zone_grant", miner: msg.miner, idx });
        broadcast(browsers, { type: "zones", site: siteKey(msg.site), z: zones[siteKey(msg.site)] });
      }
      return;
    }

    // A browser watches one turtle's log: send the stored log, then
    // stream live appends for that id only. Requires the command key
    // (the log is only visible to authorized users).
    if (ws.role === "browser" && msg.type === "watch") {
      if (CMD_KEY && msg.key !== CMD_KEY) { ws.watching = null; return; }
      ws.watching = msg.id;
      if (msg.id != null) send(ws, { type: "log", id: msg.id, full: true, lines: logs.get(msg.id) || [] });
      return;
    }

    // Validate a command key (lets the dashboard unlock the buttons)
    if (ws.role === "browser" && msg.type === "auth") {
      send(ws, { type: CMD_KEY && msg.key !== CMD_KEY ? "auth_fail" : "auth_ok" });
      return;
    }

    if (ws.role === "browser" && msg.type === "command" && msg.payload) {
      if (CMD_KEY && msg.key !== CMD_KEY) { send(ws, { type: "denied" }); return; }
      // reset_zones is a SERVER action (free a site to be mined again),
      // not a turtle command - handle it here, don't forward to bridges
      if (msg.payload.cmd === "reset_zones") {
        const s = msg.payload.site;
        if (s && zones[s]) delete zones[s]; else zones = {};
        saveZones();
        broadcast(browsers, { type: "zones", site: s || "*", z: null });
        return;
      }
      // forward to every bridge; bridges add the swarm key + rebroadcast
      broadcast(bridges, { type: "command", payload: msg.payload });
      return;
    }
  });

  ws.on("close", () => { browsers.delete(ws); bridges.delete(ws); });
  ws.on("error", () => { browsers.delete(ws); bridges.delete(ws); });
});

// ---- prune stale turtles + tell browsers ----------------------------
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of turtles) {
    if (now - t.last > STALE_MS) {
      turtles.delete(id);
      broadcast(browsers, { type: "gone", id });
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`[dashboard] http + ws on :${PORT}`);
});
