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
const crypto = require("crypto");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT || "8080", 10);
const STALE_MS = parseInt(process.env.STALE_MS || "20000", 10);
const PUBLIC = path.join(__dirname, "public");
// Command key: browsers must send this to issue commands. Empty = no
// gate (anyone can command). Set CMD_KEY on the deployment.
const CMD_KEY = process.env.CMD_KEY || "";
// Read-only API key. Absent/empty => read API is DISABLED (503).
// Set READ_KEY in the deployment Secret (cc-turtles-readkey).
const READ_KEY = process.env.READ_KEY || "";

// ---- F5: WEBHOOK CONFIG ---------------------------------------------
// WEBHOOK_URL: Discord-compatible HTTPS POST endpoint. Absent = no-op.
// WEBHOOK_STALE_MS: silence before "offline" alert (default 5min).
// WEBHOOK_FUEL_THRESHOLD: absolute fuel below which "fuel critical" fires.
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_STALE_MS = parseInt(process.env.WEBHOOK_STALE_MS || "300000", 10);
const WEBHOOK_FUEL_THRESHOLD = parseInt(process.env.WEBHOOK_FUEL_THRESHOLD || "500", 10);
// Warm-up grace: suppress offline alerts for 90s after process start.
const startTs = Date.now();
const WARMUP_GRACE_MS = 90000;
// Per-turtle webhook state. Never log or broadcast these.
// alerted: offline alert has fired; re-arms when turtle comes back.
// fuelAlerted: fuel-critical alert fired; re-arms when fuel >= threshold+200.
// lastFuel: last known fuel to detect crossing.
const webhookState = new Map(); // id -> { alerted:bool, fuelAlerted:bool, lastFuel:number|null }
// Diamond dedup: "x,y,z" -> timestamp, block within ~3 blocks per 60s.
const diamondSeen = new Map(); // posKey -> ts
const DIAMOND_DEDUP_MS = 60000;
const DIAMOND_DEDUP_RADIUS = 3;
// Site-finished dedup: siteKey -> bool (fire once, reset only on zones reset).
const siteFinishedAlerted = new Set();

function wState(id) {
  let s = webhookState.get(id);
  if (!s) { s = { alerted: false, fuelAlerted: false, lastFuel: null }; webhookState.set(id, s); }
  return s;
}

// sendWebhook: POST { content: text } to WEBHOOK_URL. Never throws, never logs the URL.
function sendWebhook(text) {
  if (!WEBHOOK_URL) return;
  try {
    const body = JSON.stringify({ content: text });
    const url = new URL(WEBHOOK_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => { res.resume(); });
    req.on("error", () => {});
    req.setTimeout(8000, () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch (_) {}
}

// ---- F4: STATS CONFIG + STATE ----------------------------------------
// IDLE_SESSION_GAP_MS: if no miner heartbeat for this long, close session.
const IDLE_SESSION_GAP_MS = parseInt(process.env.IDLE_SESSION_GAP_MS || "1800000", 10);
const STATS_FILE = path.join(process.env.DATA_DIR || "/data", "stats.json");
const STATS_HISTORY_CAP = 90; // max daily history entries

// Stats object shape:
// { session: { start: ISO, ores: {oreName:count} },
//   totals: {oreName:count},
//   history: [ { day:"YYYY-MM-DD", ores:{...} } ] }
let stats = { session: { start: new Date().toISOString(), ores: {} }, totals: {}, history: [] };
// Load from PVC — tolerate missing or corrupt file.
try {
  const raw = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  // Validate shape; fall back to fresh on any missing key.
  if (raw && raw.session && typeof raw.session.start === "string" &&
      typeof raw.session.ores === "object" && raw.session.ores !== null &&
      typeof raw.totals === "object" && raw.totals !== null &&
      Array.isArray(raw.history)) {
    stats = raw;
  }
} catch { /* file missing or corrupt — start fresh, never crash */ }

let statsWriteT = null;
function saveStats() { // debounced write (mirrors saveZones pattern)
  if (statsWriteT) return;
  statsWriteT = setTimeout(() => {
    statsWriteT = null;
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
    } catch (e) { console.error("[stats] save failed:", e.message); }
  }, 500);
}

// Broadcast stats to browsers — debounced ~5s so a burst of ores doesn't spam.
let statsBcastT = null;
function broadcastStats() {
  if (statsBcastT) return;
  statsBcastT = setTimeout(() => {
    statsBcastT = null;
    broadcast(browsers, { type: "stats", session: stats.session, totals: stats.totals, history: stats.history });
  }, 5000);
}

// Tally one ore event into session + totals + today's history bucket.
function tallyOre(oreName) {
  stats.session.ores[oreName] = (stats.session.ores[oreName] || 0) + 1;
  stats.totals[oreName] = (stats.totals[oreName] || 0) + 1;
  const today = dayStamp();
  let bucket = stats.history.find((h) => h.day === today);
  if (!bucket) {
    bucket = { day: today, ores: {} };
    stats.history.push(bucket);
    if (stats.history.length > STATS_HISTORY_CAP)
      stats.history.splice(0, stats.history.length - STATS_HISTORY_CAP);
  }
  bucket.ores[oreName] = (bucket.ores[oreName] || 0) + 1;
}

// Session idle tracking: track last miner heartbeat timestamp.
let lastMinerTs = Date.now(); // initialise to now so grace window applies on boot
function maybeRollSession() {
  if (Date.now() - lastMinerTs > IDLE_SESSION_GAP_MS) {
    stats.session = { start: new Date().toISOString(), ores: {} };
    lastMinerTs = Date.now();
    saveStats(); // persist new session start so a restart doesn't reload the old one
    console.log("[stats] new session (idle gap elapsed)");
  }
}
// Check idle every minute.
setInterval(() => { maybeRollSession(); }, 60000);

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
const TURTLES_FILE = path.join(DATA, "turtles.json");
const CLAIM_TTL = parseInt(process.env.CLAIM_TTL_MS || "1800000", 10); // 30m

// ---- PERSISTENT LOGS: one file per day on the PVC, auto-pruned -------
// Turtle log lines (already streamed live to watchers) are also appended
// to /data/logs/YYYY-MM-DD.log so they survive a pod restart. Files older
// than LOG_RETAIN_DAYS are deleted, so the PVC never fills up.
const LOG_DIR = path.join(DATA, "logs");
const LOG_RETAIN_DAYS = parseInt(process.env.LOG_RETAIN_DAYS || "7", 10);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { console.error("[logs] mkdir:", e.message); }
const dayStamp = (d = new Date()) => d.toISOString().slice(0, 10); // YYYY-MM-DD
let logBuf = []; // pending lines, flushed to the day file every few seconds
function appendLog(id, label, lines) {
  const ts = new Date().toISOString();
  const tag = label || ("#" + id);
  for (const ln of lines) logBuf.push(`${ts} [${tag}] ${ln}`);
}
setInterval(() => {
  if (!logBuf.length) return;
  const file = path.join(LOG_DIR, dayStamp() + ".log");
  const data = logBuf.join("\n") + "\n";
  logBuf = [];
  fs.appendFile(file, data, (e) => { if (e) console.error("[logs] append:", e.message); });
}, 3000);
function pruneLogs() { // delete day-files older than the retention window
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return;
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 86400000;
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (!isNaN(t) && t < cutoff) fs.unlink(path.join(LOG_DIR, f), () => {});
    }
  });
}
setInterval(pruneLogs, 6 * 3600 * 1000); // every 6h
pruneLogs(); // and once on boot
let zones = {};
try { zones = JSON.parse(fs.readFileSync(ZONES_FILE, "utf8")); } catch { zones = {}; }
// lastKnown: persisted label/pos/level per turtle so a pod restart doesn't
// lose the last known position of every turtle (e.g. to find a lost turtle).
let lastKnown = {};
try { lastKnown = JSON.parse(fs.readFileSync(TURTLES_FILE, "utf8")); } catch { lastKnown = {}; }
let saveT = null;
function saveZones() { // debounced write
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(ZONES_FILE, JSON.stringify(zones)); }
    catch (e) { console.error("[zones] save failed:", e.message); }
  }, 500);
}
let saveTurtlesT = null;
function saveTurtles() { // debounced write
  if (saveTurtlesT) return;
  saveTurtlesT = setTimeout(() => {
    saveTurtlesT = null;
    try { fs.writeFileSync(TURTLES_FILE, JSON.stringify(lastKnown)); }
    catch (e) { console.error("[turtles] save failed:", e.message); }
  }, 2000);
}
function siteKey(s) { return `${s.x},${s.y},${s.z}`; }
// every zone record has { done, claims, prog }. prog[idx] = deepest Y
// mined for that index (lower = deeper), so a wiped/replaced miner that
// re-takes the idx resumes the layer instead of re-mining from the top.
function zoneRec(k) {
  const z = (zones[k] ||= { done: {}, claims: {}, prog: {} });
  z.done ||= {}; z.claims ||= {}; z.prog ||= {}; // heal old PVC records
  return z;
}
function allocZone(site, miner) {
  const k = siteKey(site);
  const z = zoneRec(k);
  const now = Date.now();
  // resume an existing live claim for this miner (but never resume onto
  // a zone that's already done - a stale heartbeat could have parked the
  // claim on a finished idx; fall through to a fresh alloc instead)
  const mine = z.claims[miner];
  if (mine && now - mine.ts < CLAIM_TTL && !z.done[mine.idx]) { mine.ts = now; saveZones(); return mine.idx; }
  if (mine && z.done[mine.idx]) delete z.claims[miner];
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
  // F5: check if this site is now fully finished (no live claims, all known indices done)
  checkSiteFinished(siteKey(site));
}
function touchClaim(site, miner, idx, level) { // renew from heartbeat
  if (!site || idx == null) return;
  const z = zoneRec(siteKey(site));
  // record the deepest layer for this idx (lower Y = deeper). Done even
  // for finished zones - it's the historical depth, harmless.
  if (level != null && (z.prog[idx] == null || level < z.prog[idx])) z.prog[idx] = level;
  // ignore a stale heartbeat still reporting a finished zone - otherwise
  // it would resurrect the claim onto a done idx and desync the taken set
  if (z.done[idx]) { saveZones(); return; }
  z.claims[miner] = { idx, ts: Date.now() };
  saveZones();
}

// F5: site finished — fire when all known spiral indices (0..maxIdx) are done
// and there are no live claims remaining.
function checkSiteFinished(sk) {
  if (!WEBHOOK_URL) return;
  if (siteFinishedAlerted.has(sk)) return;
  const zr = zones[sk];
  if (!zr) return;
  // Must have at least one done zone.
  const doneKeys = Object.keys(zr.done || {});
  if (!doneKeys.length) return;
  // Prune stale claims (same logic as allocZone) so a crashed miner that never
  // sent "done" doesn't hold the site-finished alert back for the full CLAIM_TTL.
  const now = Date.now();
  if (zr.claims) {
    for (const [m, c] of Object.entries(zr.claims)) {
      if (now - c.ts >= CLAIM_TTL) delete zr.claims[m];
    }
  }
  // Any live (non-stale) claims? Then not finished.
  if (Object.keys(zr.claims || {}).length > 0) return;
  // Are all indices 0..max done?
  const maxIdx = Math.max(...doneKeys.map(Number));
  for (let i = 0; i <= maxIdx; i++) {
    if (!zr.done[i]) return; // gap — not all done
  }
  siteFinishedAlerted.add(sk);
  sendWebhook(`Site ${sk} finished — all ${maxIdx + 1} zones mined.`);
}

// F5: diamond dedup helper — snap position to 3-block grid for dedup.
function diamondDedupKey(x, y, z) {
  return `${Math.round(x / DIAMOND_DEDUP_RADIUS)},${Math.round(y / DIAMOND_DEDUP_RADIUS)},${Math.round(z / DIAMOND_DEDUP_RADIUS)}`;
}

// ---- static file server --------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---- read-only API auth helper --------------------------------------
// Returns true if the request carries a valid READ_KEY.
// Accepts: Authorization: Bearer <token>  OR  ?key=<token>
// Uses crypto.timingSafeEqual to prevent timing oracle attacks.
function checkReadKey(req) {
  if (!READ_KEY) return false; // disabled when key not configured
  const expected = Buffer.from(READ_KEY, "utf8");
  function safeCompare(supplied) {
    if (!supplied) return false;
    const s = Buffer.from(supplied, "utf8");
    if (s.length !== expected.length) return false;
    return crypto.timingSafeEqual(s, expected);
  }
  const q = new URLSearchParams((req.url || "").split("?")[1] || "");
  if (safeCompare(q.get("key"))) return true;
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ") && safeCompare(auth.slice(7))) return true;
  return false;
}
// Build the full turtle list used by /api/state and /api/turtles
function turtleList() {
  const now = Date.now();
  const out = [];
  for (const [id, t] of turtles) out.push({ id, ...t.data, age: now - t.last });
  return out;
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  // GET /api/health — unauthenticated; for liveness probes.
  if (urlPath === "/api/health") {
    if (req.method !== "GET") { res.writeHead(405); return res.end("method not allowed"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: LATEST }));
  }

  // GET /api/state — full state snapshot; requires READ_KEY.
  // NOTE: zone reset is intentionally NOT an HTTP endpoint - it is a
  // key-gated WebSocket command (reset_zones) so it can't be triggered
  // unauthenticated.
  if (urlPath === "/api/state") {
    if (req.method !== "GET") { res.writeHead(405); return res.end("method not allowed"); }
    if (!READ_KEY) { res.writeHead(503); return res.end("read API disabled"); }
    if (!checkReadKey(req)) { res.writeHead(401); return res.end("unauthorized"); }
    const out = {
      version: LATEST,
      turtles: turtleList(),
      ores,
      zones,
      bridge: bridgeVer,
      bridges: bridges.size,
      browsers: browsers.size,
      lastKnown,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out, null, 2));
  }

  // GET /api/turtles — turtle list only; requires READ_KEY.
  if (urlPath === "/api/turtles") {
    if (req.method !== "GET") { res.writeHead(405); return res.end("method not allowed"); }
    if (!READ_KEY) { res.writeHead(503); return res.end("read API disabled"); }
    if (!checkReadKey(req)) { res.writeHead(401); return res.end("unauthorized"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(turtleList(), null, 2));
  }

  // GET /api/stats — F4 ore/yield stats; requires READ_KEY.
  if (urlPath === "/api/stats") {
    if (req.method !== "GET") { res.writeHead(405); return res.end("method not allowed"); }
    if (!READ_KEY) { res.writeHead(503); return res.end("read API disabled"); }
    if (!checkReadKey(req)) { res.writeHead(401); return res.end("unauthorized"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(stats, null, 2));
  }

  // Persisted logs. Key-gated (same CMD_KEY as the live log watch).
  //   /api/logs            -> JSON list of available day-files + sizes
  //   /api/logs?day=DATE   -> the raw text of that day's log
  if (urlPath === "/api/logs") {
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");
    if (CMD_KEY && q.get("key") !== CMD_KEY) { res.writeHead(401); return res.end("key required"); }
    const day = q.get("day");
    if (day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { res.writeHead(400); return res.end("bad day"); }
      return fs.readFile(path.join(LOG_DIR, day + ".log"), (err, buf) => {
        if (err) { res.writeHead(404); return res.end("no log for " + day); }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buf);
      });
    }
    return fs.readdir(LOG_DIR, (err, files) => {
      const days = (err ? [] : files)
        .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.log$/))
        .filter(Boolean)
        .map((m) => {
          let size = 0; try { size = fs.statSync(path.join(LOG_DIR, m[0])).size; } catch {}
          return { day: m[1], bytes: size };
        })
        .sort((a, b) => b.day.localeCompare(a.day));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ retainDays: LOG_RETAIN_DAYS, days }, null, 2));
    });
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
        // send the full current snapshot to the new tab (includes stats for F4)
        const now = Date.now();
        const snap = [];
        for (const [id, t] of turtles) snap.push({ id, data: t.data, age: now - t.last });
        send(ws, { type: "snapshot", turtles: snap, ores, needKey: !!CMD_KEY,
                   zones, lastKnown, latest: LATEST, server: LATEST, bridge: bridgeVer,
                   stats: { session: stats.session, totals: stats.totals, history: stats.history } });
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
          // F4: tally ore into stats
          tallyOre(o.n);
          broadcastStats();
          saveStats();
          // F5: diamond alert — dedup by position within ~3 blocks per 60s
          if (WEBHOOK_URL && o.n === "diamond") {
            const dk = diamondDedupKey(o.x, o.y, o.z);
            const last = diamondSeen.get(dk) || 0;
            const now2 = Date.now();
            if (now2 - last > DIAMOND_DEDUP_MS) {
              diamondSeen.set(dk, now2);
              sendWebhook(`Diamond found at X${o.x} Y${o.y} Z${o.z}!`);
            }
          }
        }
        broadcast(browsers, { type: "ores", ores: newOres });
      }
      // pull log lines out of the heartbeat into the per-turtle log
      const newLog = Array.isArray(msg.data.log) ? msg.data.log : null;
      if (newLog) {
        delete msg.data.log;
        let arr = logs.get(msg.id); if (!arr) { arr = []; logs.set(msg.id, arr); }
        for (const ln of newLog) { arr.push(ln); if (arr.length > LOG_CAP) arr.shift(); }
        appendLog(msg.id, msg.data.label, newLog); // persist to the daily file
        // stream only to browsers watching this turtle
        for (const b of browsers) if (b.watching === msg.id) send(b, { type: "log", id: msg.id, lines: newLog });
      }
      // renew this miner's zone claim + record its mined layer
      if (msg.data.role === "miner" && msg.data.site && msg.data.zoneIdx != null)
        touchClaim(msg.data.site, msg.id, msg.data.zoneIdx, msg.data.level);
      // F4: update last miner heartbeat ts for session-idle tracking
      if (msg.data.role === "miner") lastMinerTs = Date.now();
      turtles.set(msg.id, { data: msg.data, last: Date.now() });
      // persist last known label/pos/level so a restart doesn't lose
      // where a turtle was (e.g. to locate a lost/silent turtle)
      { const d = msg.data, rec = (lastKnown[msg.id] ||= {});
        if (d.label) rec.label = d.label;
        if (d.pos)   rec.pos   = d.pos;
        if (d.level != null) rec.level = d.level;
        if (d.site)  rec.site  = d.site;
        if (d.zoneIdx != null) rec.zoneIdx = d.zoneIdx;
        if (d.role)  rec.role  = d.role;
        rec.ts = Date.now();
        saveTurtles(); }
      // F5: fuel-critical alert
      if (WEBHOOK_URL && msg.data.fuel != null && typeof msg.data.fuel === "number") {
        const ws2 = wState(msg.id);
        const fuel = msg.data.fuel;
        if (!ws2.fuelAlerted && fuel < WEBHOOK_FUEL_THRESHOLD) {
          ws2.fuelAlerted = true;
          ws2.lastFuel = fuel;
          const label = msg.data.label || ("#" + msg.id);
          sendWebhook(`Fuel critical: ${label} has ${fuel} fuel (threshold: ${WEBHOOK_FUEL_THRESHOLD}).`);
        } else if (ws2.fuelAlerted && fuel >= WEBHOOK_FUEL_THRESHOLD + 200) {
          // Re-arm: turtle has been refueled
          ws2.fuelAlerted = false;
        }
        ws2.lastFuel = fuel;
      }
      // Re-arm offline alert when turtle comes back online
      wState(msg.id).alerted = false;
      broadcast(browsers, { type: "status", id: msg.id, data: msg.data });
      return;
    }

    // ZONE allocation RPC (miner -> bridge -> here). Respond to the
    // bridge, which relays the grant back to the requesting miner.
    if (ws.role === "bridge" && msg.type === "zone" && msg.site && msg.miner != null) {
      if (msg.op === "done") {
        doneZone(msg.site, msg.miner, msg.idx);
      } else { // "request" (first) or "next" (mark idx done, then alloc) - atomic
        if (msg.op === "next" && msg.idx != null) doneZone(msg.site, msg.miner, msg.idx);
        const idx = allocZone(msg.site, msg.miner);
        // hand back the deepest known layer so the miner can resume it
        const zr = zones[siteKey(msg.site)];
        const level = zr && zr.prog ? zr.prog[idx] : null;
        send(ws, { type: "zone_grant", miner: msg.miner, idx, level: level == null ? null : level });
      }
      broadcast(browsers, { type: "zones", site: siteKey(msg.site), z: zones[siteKey(msg.site)] });
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
      // not a turtle command - handle it here, don't forward to bridges.
      // NOTE: intentionally does NOT touch stats — they are orthogonal.
      if (msg.payload.cmd === "reset_zones") {
        const s = msg.payload.site;
        if (s && zones[s]) delete zones[s]; else zones = {};
        // Reset site-finished dedup so alerts can fire again on the new run.
        if (s) siteFinishedAlerted.delete(s); else siteFinishedAlerted.clear();
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

// ---- prune stale turtles + tell browsers + F5 offline alerts -------
setInterval(() => {
  const now = Date.now();
  const inGrace = now - startTs < WARMUP_GRACE_MS;
  // 1. Evict turtles that haven't heartbeated within STALE_MS.
  for (const [id, t] of turtles) {
    if (now - t.last > STALE_MS) {
      turtles.delete(id);
      broadcast(browsers, { type: "gone", id });
    }
  }
  // 2. F5: Offline alerts — scanned from lastKnown so the WEBHOOK_STALE_MS
  //    threshold is independent of STALE_MS (which is usually much shorter).
  //    Fires once per offline event; re-armed when the turtle sends a heartbeat.
  if (WEBHOOK_URL && !inGrace) {
    for (const [id, rec] of Object.entries(lastKnown)) {
      // Only alert for turtles that are currently offline (not in turtles map)
      if (turtles.has(+id)) continue;
      if (!rec.ts) continue;
      const silentMs = now - rec.ts;
      if (silentMs < WEBHOOK_STALE_MS) continue;
      const ws2 = wState(+id);
      if (ws2.alerted) continue;
      ws2.alerted = true;
      const label = rec.label || ("#" + id);
      sendWebhook(`Turtle ${label} has gone offline (no heartbeat for ${Math.round(silentMs / 60000)}m).`);
    }
  }
  // 3. Prune old diamond dedup entries
  if (WEBHOOK_URL) {
    for (const [k, ts] of diamondSeen) {
      if (now - ts > DIAMOND_DEDUP_MS * 2) diamondSeen.delete(k);
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`[dashboard] http + ws on :${PORT}`);
});

// Flush any buffered log lines synchronously on shutdown (K8s sends
// SIGTERM before killing the pod) so the last few seconds aren't lost.
function flushAndExit() {
  if (logBuf.length) {
    try { fs.appendFileSync(path.join(LOG_DIR, dayStamp() + ".log"), logBuf.join("\n") + "\n"); }
    catch (e) { console.error("[logs] final flush:", e.message); }
    logBuf = [];
  }
  process.exit(0);
}
process.on("SIGTERM", flushAndExit);
process.on("SIGINT", flushAndExit);
