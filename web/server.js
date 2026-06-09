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
// WEBHOOK_STALE_MS: silence before "offline" alert (default 10min).
// WEBHOOK_FUEL_THRESHOLD: absolute fuel below which "fuel critical" fires.
// STUCK_MS: how long a miner must be motionless (phase=mining) before alert (default 8min).
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_STALE_MS = parseInt(process.env.WEBHOOK_STALE_MS || "600000", 10);
const WEBHOOK_FUEL_THRESHOLD = parseInt(process.env.WEBHOOK_FUEL_THRESHOLD || "500", 10);
const STUCK_MS = parseInt(process.env.STUCK_MS || "480000", 10);
// WORLD_SLEEP_MS: if no heartbeat from any turtle for this long (AND/OR bridge
// disconnected), the world is "asleep" — all Discord alerts are suppressed.
// Default 180s (< the 600s offline + 480s stuck thresholds, so sleep is detected
// before those would fire). NaN-guarded and floored at 1000ms.
const _wsmRaw = parseInt(process.env.WORLD_SLEEP_MS || "180000", 10);
const WORLD_SLEEP_MS = Number.isNaN(_wsmRaw) || _wsmRaw < 1000 ? 180000 : _wsmRaw;
// Warm-up grace: suppress offline/stuck/swarm-idle alerts for 90s after process start
// AND for 90s after the world wakes from sleep.
const startTs = Date.now();
const WARMUP_GRACE_MS = 90000;
// Per-turtle webhook state. Never log or broadcast these.
// alerted:      offline alert has fired; re-arms when turtle comes back.
// fuelAlerted:  fuel-critical alert fired; re-arms when fuel >= threshold+200.
// stranded:     0-fuel alert fired; re-arms when fuel > 0.
// lastFuel:     last known fuel to detect crossing.
// stuckAlerted: stuck-miner alert fired; re-arms when pos/level changes or phase leaves mining.
// stuckPos:     { x, z, level, ts } — baseline for stuck detection; updated on movement.
const webhookState = new Map();
// id -> { alerted:bool, fuelAlerted:bool, stranded:bool, lastFuel:number|null,
//         stuckAlerted:bool, stuckPos:{x,z,level,ts}|null }

// ---- WORLD-SLEEP TRACKING -------------------------------------------
// bridgeConnected: true while ≥1 bridge WS client is connected.
// lastHeartbeatTs: timestamp of the most recent status heartbeat from any turtle.
//   Starts at Date.now() so the warm-up grace applies; updated on every heartbeat.
// lastWakeTs: set to Date.now() on each asleep→awake edge so the wake grace window
//   uses the same inGrace formula already used for the boot grace.
// worldAsleep(): returns true when no bridge is connected OR the whole fleet has been
//   silent for WORLD_SLEEP_MS.  A single offline turtle while others heartbeat is NOT
//   asleep — lastHeartbeatTs tracks the MAX over all turtles, so one active turtle
//   keeps the swarm "awake" and the offline turtle's alert still fires normally.
let bridgeConnected = false;
let lastHeartbeatTs = Date.now();
let lastWakeTs = 0; // 0 = no wake edge yet; set on first bridge connect too
function worldAsleep() {
  return !bridgeConnected || (Date.now() - lastHeartbeatTs > WORLD_SLEEP_MS);
}

// onWakeEdge: called when the world transitions from asleep to awake.
// (a) Sets lastWakeTs so the periodic inGrace check gives a fresh 90s window.
// (b) Re-arms all per-turtle alert flags and swarm-level flags so no backlog
//     storm fires immediately — a turtle that is STILL broken after the 90s
//     grace will then alert correctly on the next periodic pass.
function onWakeEdge() {
  lastWakeTs = Date.now();
  console.log("[sleep] world woke — grace window started, alert flags re-armed");
  // Re-arm per-turtle flags: clear alerted/fuelAlerted/stranded/stuckAlerted.
  // Also null stuckPos so the stuck clock gets a fresh baseline on the first
  // post-wake heartbeat — without this, a sleep longer than STUCK_MS would
  // leave stuckPos.ts in the past and false-fire "stuck" after the grace expires
  // for a turtle that was mining normally before the player logged off.
  for (const [, s] of webhookState) {
    s.alerted = false;
    s.fuelAlerted = false;
    s.stranded = false;
    s.stuckAlerted = false;
    s.stuckPos = null;
  }
  // Re-arm swarm-level flags.
  swarmIdleAlerted = false;
  // siteFinishedAlerted is intentionally NOT cleared here — a site that finished
  // during the live session before sleep should not re-alert on every wake.
  // Broadcast the awake state to browsers.
  broadcast(browsers, { type: "meta", latest: LATEST, server: LATEST, bridge: bridgeVer, asleep: false });
}

// Rare-ore dedup: posKey -> ts; fires for diamond, ancient_debris, emerald.
const RARE_ORES = new Set(["diamond", "ancient_debris", "emerald"]);
const rareSeen = new Map(); // posKey -> ts
const RARE_DEDUP_MS = 60000;
const RARE_DEDUP_RADIUS = 3;
// Site-finished dedup: siteKey -> bool (fire once, reset only on zones reset).
const siteFinishedAlerted = new Set();
// Swarm-idle tracking: have we ever seen a mining phase since boot?
let swarmEverMined = false;
// swarmIdleAlerted: true while 0 miners mining (alert fired); re-arms when any miner resumes.
let swarmIdleAlerted = false;

function wState(id) {
  let s = webhookState.get(id);
  if (!s) {
    s = { alerted: false, fuelAlerted: false, stranded: false, lastFuel: null,
          stuckAlerted: false, stuckPos: null };
    webhookState.set(id, s);
  }
  return s;
}

// sendWebhook: POST { content: text } to WEBHOOK_URL. Never throws, never logs the URL.
// Belt-and-suspenders: also silences while world is asleep. The real suppression is
// at the decision level (guards below), but this ensures nothing leaks through
// a future callsite that forgets to check worldAsleep() first.
function sendWebhook(text) {
  if (!WEBHOOK_URL) return;
  if (worldAsleep()) return;
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
// LATEST is mutable — the periodic remote poll updates it at runtime without
// restarting the pod.  Bootstrap from the local file cloned into the image.
let LATEST = readVersion();

// ---- REMOTE VERSION POLL --------------------------------------------
// Refreshes LATEST from GitHub raw every VERSION_POLL_MS (default 30 min).
// Uses the same regex as readVersion() so local and remote parses agree.
// One poll fires ~30s after boot so a pod that started before a push catches
// up quickly.  The flag _versionPollActive prevents overlapping fetches.
let bridgeVer = null; // declared here so pollVersion() closes over it without a TDZ risk
const _vpmRaw = parseInt(process.env.VERSION_POLL_MS || "1800000", 10);
const VERSION_POLL_MS = Number.isNaN(_vpmRaw) || _vpmRaw < 1000 ? 1800000 : _vpmRaw;
const VERSION_URL = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/lib/version.lua";
let _versionPollActive = false;

async function pollVersion() {
  if (_versionPollActive) return; // guard against overlap
  _versionPollActive = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000); // 10s hard timeout
  try {
    const res = await fetch(VERSION_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = text.match(/return\s*"([^"]+)"/);
    if (!m) throw new Error("version string not found in remote file");
    const remote = m[1];
    if (remote !== LATEST) {
      console.log(`[version] latest ${LATEST} -> ${remote}`);
      LATEST = remote;
      // Push the new version to all open browser tabs — no page reload needed.
      broadcast(browsers, { type: "meta", latest: LATEST, server: LATEST, bridge: bridgeVer, asleep: worldAsleep() });
    }
  } catch (err) {
    // Network error, timeout, parse failure: keep existing LATEST, try again next interval.
    console.warn("[version] remote poll failed:", err.message);
  } finally {
    clearTimeout(timer);
    _versionPollActive = false;
  }
}

// First poll 30s after boot (catches a push that landed while the pod was starting),
// then on the regular VERSION_POLL_MS interval.
setTimeout(() => {
  pollVersion();
  setInterval(pollVersion, VERSION_POLL_MS);
}, 30000);

// ---- latest known state, keyed by turtle id -------------------------
const turtles = new Map(); // id -> { data, last }
const ores = [];           // discovered ores: { n, x, y, z } (capped FIFO)
const ORE_CAP = 4000;
const logs = new Map();     // id -> [recent log lines] (per turtle)
const LOG_CAP = 300;
const hazards = [];         // { hazard, pos, minerId, ts } (capped FIFO)
const HAZARD_CAP = 200;
// Hazard Discord dedup: key -> ts. Key = "<hazard>:<8-block-snap-x>,<8-block-snap-z>".
// Suppresses repeat alerts for the same hazard type within ~8 blocks / 60s.
const hazardSeen = new Map();
const HAZARD_DEDUP_MS = 60000;
const HAZARD_DEDUP_RADIUS = 8;

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
// SLEEP GATE: skip (and don't set the alerted flag) while the world is asleep.
function checkSiteFinished(sk) {
  if (!WEBHOOK_URL) return;
  if (worldAsleep()) return; // don't set siteFinishedAlerted while asleep
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

// F5: rare-ore dedup helper — snap position to 3-block grid for dedup.
function rareDedupKey(x, y, z) {
  return `${Math.round(x / RARE_DEDUP_RADIUS)},${Math.round(y / RARE_DEDUP_RADIUS)},${Math.round(z / RARE_DEDUP_RADIUS)}`;
}

// F3: hazard dedup helper — snap to 8-block grid (X/Z only; depth matters less for hazard dedup).
function hazardDedupKey(hazardType, x, z) {
  return `${hazardType}:${Math.round(x / HAZARD_DEDUP_RADIUS)},${Math.round(z / HAZARD_DEDUP_RADIUS)}`;
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
      hazards,
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
        // Wake-edge: if we were asleep and a bridge just connected, start the
        // wake grace window and re-arm all per-turtle/swarm alert flags so
        // the sleep gap doesn't create a backlog storm.
        if (!bridgeConnected) {
          bridgeConnected = true;
          const wasAsleep = Date.now() - lastHeartbeatTs > WORLD_SLEEP_MS;
          if (wasAsleep) onWakeEdge();
        }
      } else {
        browsers.add(ws);
        // send the full current snapshot to the new tab (includes stats for F4)
        const now = Date.now();
        const snap = [];
        for (const [id, t] of turtles) snap.push({ id, data: t.data, age: now - t.last });
        send(ws, { type: "snapshot", turtles: snap, ores, needKey: !!CMD_KEY,
                   zones, lastKnown, latest: LATEST, server: LATEST, bridge: bridgeVer,
                   stats: { session: stats.session, totals: stats.totals, history: stats.history },
                   hazards, asleep: worldAsleep() });
      }
      return;
    }

    if (ws.role === "bridge" && msg.type === "status" && msg.id != null) {
      // WORLD-SLEEP: update the global last-heartbeat timestamp.
      // This is the MAX over all turtles — one active turtle keeps the swarm awake,
      // so a single offline turtle with other turtles still heartbeating is NOT asleep.
      const nowHb = Date.now();
      const wasSleepingBeforeHb = worldAsleep(); // capture BEFORE updating lastHeartbeatTs
      lastHeartbeatTs = nowHb;
      // Heartbeat-driven wake edge: if the world was asleep and this heartbeat woke it.
      if (wasSleepingBeforeHb) onWakeEdge();

      // SECURITY: strip the swarm shared secret out of the heartbeat before it
      // is ever stored, broadcast to browsers, or exposed via /api/*. The k is
      // only used to authenticate rednet on the in-game side; it must never
      // reach a web client (same reason ores/log are pulled out below).
      delete msg.data.k;

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
          // F5: rare-ore alert (diamond / ancient_debris / emerald) — dedup by position ~3 blocks per 60s
          // SLEEP GATE: skip alert evaluation (and flag-setting) while world is asleep.
          if (WEBHOOK_URL && RARE_ORES.has(o.n) && !worldAsleep()) {
            const rk = rareDedupKey(o.x, o.y, o.z) + ":" + o.n; // per-ore dedup key
            const last = rareSeen.get(rk) || 0;
            const now2 = Date.now();
            if (now2 - last > RARE_DEDUP_MS) {
              rareSeen.set(rk, now2);
              sendWebhook(`🟢 Rare find: ${o.n} at X${o.x} Y${o.y} Z${o.z}`);
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
      if (msg.data.role === "miner") lastMinerTs = nowHb;
      turtles.set(msg.id, { data: msg.data, last: nowHb });
      // persist last known label/pos/level so a restart doesn't lose
      // where a turtle was (e.g. to locate a lost/silent turtle)
      { const d = msg.data, rec = (lastKnown[msg.id] ||= {});
        if (d.label) rec.label = d.label;
        if (d.pos)   rec.pos   = d.pos;
        if (d.level != null) rec.level = d.level;
        if (d.site)  rec.site  = d.site;
        if (d.zoneIdx != null) rec.zoneIdx = d.zoneIdx;
        if (d.role)  rec.role  = d.role;
        rec.ts = nowHb;
        saveTurtles(); }
      // F5: fuel alerts (stranded @ 0 pre-empts fuel-critical)
      // SLEEP GATE: while asleep, skip decision-level evaluation so no flags are
      // falsely set (which would suppress real alerts after wake).
      if (WEBHOOK_URL && msg.data.fuel != null && typeof msg.data.fuel === "number" && !worldAsleep()) {
        const ws2 = wState(msg.id);
        const fuel = msg.data.fuel;
        const label = msg.data.label || ("#" + msg.id);
        if (fuel === 0) {
          // STRANDED: fire once; suppress generic fuel-critical for the same turtle.
          if (!ws2.stranded) {
            ws2.stranded = true;
            ws2.fuelAlerted = true; // pre-empt generic alert so it doesn't double-fire
            const levelStr = msg.data.level != null ? ` (Y${msg.data.level})` : "";
            sendWebhook(`🔴 STRANDED: ${label} at 0 fuel${levelStr} — awaiting rescue.`);
          }
        } else {
          // Re-arm stranded when fuel > 0
          if (ws2.stranded) ws2.stranded = false;
          // Generic fuel-critical (only if not stranded)
          if (!ws2.fuelAlerted && fuel < WEBHOOK_FUEL_THRESHOLD) {
            ws2.fuelAlerted = true;
            const levelStr = msg.data.level != null ? ` (Y${msg.data.level})` : "";
            sendWebhook(`⚠️ Fuel critical: ${label} has ${fuel} fuel (threshold: ${WEBHOOK_FUEL_THRESHOLD})${levelStr}.`);
          } else if (ws2.fuelAlerted && fuel >= WEBHOOK_FUEL_THRESHOLD + 200) {
            // Re-arm: turtle has been refueled
            ws2.fuelAlerted = false;
          }
        }
        ws2.lastFuel = fuel;
      }
      // Re-arm offline alert when turtle comes back online (always — not gated by sleep,
      // since this is a re-arm, not a fire, and must happen regardless of sleep state).
      wState(msg.id).alerted = false;
      // F5: stuck-miner position tracking — update baseline when pos/level/phase changes
      if (WEBHOOK_URL && msg.data.role === "miner") {
        const ws3 = wState(msg.id);
        const cx = msg.data.pos ? msg.data.pos.x : null;
        const cz = msg.data.pos ? msg.data.pos.z : null;
        const clevel = msg.data.level != null ? msg.data.level : null;
        const cphase = msg.data.phase || null;
        const sp = ws3.stuckPos;
        // moved is true if no baseline yet OR pos/level changed — handles first heartbeat too
        const moved = !sp || sp.x !== cx || sp.z !== cz || sp.level !== clevel;
        const inMiningPhase = cphase === "mining";
        if (!inMiningPhase) {
          // Left mining — re-arm stuck alert and reset baseline
          if (ws3.stuckAlerted) ws3.stuckAlerted = false;
          ws3.stuckPos = null;
        } else if (moved) {
          // Still mining, but moved (or first heartbeat in mining) — re-arm and set baseline
          // SLEEP GATE: don't set stuckAlerted=false while asleep; stuckPos update is safe
          // (preserving baseline), but the re-arm is handled by onWakeEdge() instead.
          if (!worldAsleep()) ws3.stuckAlerted = false;
          ws3.stuckPos = { x: cx, z: cz, level: clevel, ts: nowHb };
        }
        // else: phase=mining, position unchanged — baseline holds, stuck clock keeps running
        // Swarm-idle tracking: mark that at least one miner has been mining since boot
        if (inMiningPhase) {
          swarmEverMined = true;
          // If idle alert was armed, re-arm it now that mining resumed (always safe — re-arm only)
          if (swarmIdleAlerted) swarmIdleAlerted = false;
        }
      }
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

    // F3: hazard broadcast from bridge. Bridge forwards the miner's rednet
    // "swarm_hazard" message as:
    //   { type:"hazard", id:<computerID>, data:{ type:"hazard", hazard:<str>, pos:{x,y,z}, miner:<id>, k:<key> } }
    if (ws.role === "bridge" && msg.type === "hazard" && msg.data && msg.data.hazard) {
      const d = msg.data;
      const h = { hazard: d.hazard, pos: d.pos, minerId: msg.id, ts: Date.now() };
      hazards.push(h);
      if (hazards.length > HAZARD_CAP) hazards.shift();
      broadcast(browsers, { type: "hazards", hazards: [h] });
      // Discord alert — dedup by type + 8-block XZ snap, 60s window
      // SLEEP GATE: skip evaluation (and flag-setting) while world is asleep.
      if (WEBHOOK_URL && d.pos && !worldAsleep()) {
        const dk = hazardDedupKey(d.hazard, d.pos.x, d.pos.z);
        const lastSeen = hazardSeen.get(dk) || 0;
        const now = Date.now();
        if (now - lastSeen > HAZARD_DEDUP_MS) {
          hazardSeen.set(dk, now);
          sendWebhook(`🔴 Hazard: ${d.hazard} at X${d.pos.x} Y${d.pos.y} Z${d.pos.z} (miner ${msg.id})`);
        }
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

  ws.on("close", () => {
    browsers.delete(ws);
    bridges.delete(ws);
    // Update bridgeConnected: false only when the last bridge disconnects.
    if (ws.role === "bridge" && bridges.size === 0) {
      bridgeConnected = false;
      // No wake-edge on disconnect — the world is going to sleep, not waking.
      // The asleep state will be detected by worldAsleep() on the next alert check.
      broadcast(browsers, { type: "meta", latest: LATEST, server: LATEST, bridge: bridgeVer, asleep: true });
    }
  });
  ws.on("error", () => {
    browsers.delete(ws);
    bridges.delete(ws);
    if (ws.role === "bridge" && bridges.size === 0) {
      bridgeConnected = false;
      broadcast(browsers, { type: "meta", latest: LATEST, server: LATEST, bridge: bridgeVer, asleep: true });
    }
  });
});

// ---- prune stale turtles + tell browsers + F5 offline/stuck/swarm-idle alerts -------
setInterval(() => {
  const now = Date.now();
  // inGrace is true for 90s after process boot OR after a world-wake edge.
  // lastWakeTs=0 means "no wake yet"; Math.max(startTs, 0) = startTs, correct.
  const inGrace = now - Math.max(startTs, lastWakeTs) < WARMUP_GRACE_MS;
  // 1. Evict turtles that haven't heartbeated within STALE_MS.
  for (const [id, t] of turtles) {
    if (now - t.last > STALE_MS) {
      turtles.delete(id);
      broadcast(browsers, { type: "gone", id });
    }
  }

  // SLEEP GATE (periodic): while the world is asleep, skip ALL alert evaluation.
  // Do NOT set any alerted/stuckAlerted/swarmIdleAlerted flags during sleep —
  // those would suppress real alerts after wake.
  if (WEBHOOK_URL && !inGrace && !worldAsleep()) {
    // 2. F5: Offline alerts — scanned from lastKnown so the WEBHOOK_STALE_MS
    //    threshold is independent of STALE_MS (which is usually much shorter).
    //    Fires once per offline event; re-armed when the turtle sends a heartbeat.
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
      sendWebhook(`🔴 Turtle ${label} has gone offline (no heartbeat for ${Math.round(silentMs / 60000)}m).`);
    }

    // 3. F5: Stuck-miner alerts — live miner (heartbeating) in phase=mining whose
    //    position (x,z) and level (Y) have not changed for STUCK_MS.
    for (const [id, t] of turtles) {
      if (t.data.role !== "miner") continue;
      if (t.data.phase !== "mining") continue;
      const ws3 = wState(id);
      if (ws3.stuckAlerted) continue;
      const sp = ws3.stuckPos;
      if (!sp) continue;
      if (now - sp.ts < STUCK_MS) continue;
      ws3.stuckAlerted = true;
      const label = t.data.label || ("#" + id);
      const px = sp.x != null ? ` X${sp.x}` : "";
      const pz = sp.z != null ? ` Z${sp.z}` : "";
      const py = sp.level != null ? ` Y${sp.level}` : "";
      const minStr = Math.round(STUCK_MS / 60000);
      sendWebhook(`🔴 Miner ${label} stuck at${px}${py}${pz} (no progress ${minStr}m, still 'mining').`);
    }

    // 4. F5: Swarm-idle alert — transitions from ≥1 miner actively mining to 0.
    //    Only fires if we previously observed at least one mining phase since boot.
    if (swarmEverMined) {
      let anyMining = false;
      for (const [, t] of turtles) {
        if (t.data.role === "miner" && t.data.phase === "mining") { anyMining = true; break; }
      }
      // Are there any LIVE miners at all? Check the turtles map only — lastKnown
      // is persistent (survives restarts) and would keep anyMinerKnown true even
      // when every miner has gone offline, causing swarm-idle to co-fire with the
      // offline alerts. "Idle" means live miners present but none mining; a dead
      // swarm is covered by offline alerts, not swarm-idle.
      let anyMinerKnown = false;
      for (const [, t] of turtles) {
        if (t.data.role === "miner") { anyMinerKnown = true; break; }
      }
      if (anyMinerKnown && !anyMining && !swarmIdleAlerted) {
        swarmIdleAlerted = true;
        sendWebhook("🟢 Swarm idle — no miner is actively mining.");
      }
    }
  }

  // 5. Prune old rare-ore dedup entries, hazard dedup entries, and webhookState for evicted turtles
  if (WEBHOOK_URL) {
    for (const [k, ts] of rareSeen) {
      if (now - ts > RARE_DEDUP_MS * 2) rareSeen.delete(k);
    }
    for (const [k, ts] of hazardSeen) {
      if (now - ts > HAZARD_DEDUP_MS * 2) hazardSeen.delete(k);
    }
    // Prune webhookState for turtles no longer in lastKnown (fully gone)
    for (const [id] of webhookState) {
      if (!lastKnown[id] && !turtles.has(id)) webhookState.delete(id);
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
