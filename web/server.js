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
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      // always revalidate the dashboard assets so a deploy is picked
      // up immediately (the dashboard is small; no caching needed)
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
        send(ws, { type: "snapshot", turtles: snap, latest: LATEST, server: LATEST, bridge: bridgeVer });
      }
      return;
    }

    if (ws.role === "bridge" && msg.type === "status" && msg.id != null) {
      turtles.set(msg.id, { data: msg.data, last: Date.now() });
      broadcast(browsers, { type: "status", id: msg.id, data: msg.data });
      return;
    }

    if (ws.role === "browser" && msg.type === "command" && msg.payload) {
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
