-- bridge/main.lua
-- Rednet <-> WebSocket bridge for the web dashboard. Runs on a CC
-- computer (or turtle) with a wireless modem AND http enabled, placed
-- in rednet range of the swarm (next to a GPS repeater is ideal).
--   rednet swarm_status  --> WebSocket  (turtle heartbeats to the web)
--   WebSocket command    --> rednet swarm_cmd  (dashboard buttons)
-- Commands are re-signed with the swarm key, so the web inherits the
-- same auth as the pocket.

package.path = package.path .. ";/lib/?.lua"
local Swarm = require("swarm")
local VERSION = require("version")

-- Default server (override in /bridge.json -> { url = "wss://host", key = "secret" }).
-- wss:// because the site is served over HTTPS - the browser uses wss
-- too, so the bridge must match (ws:// would be mixed-content).
local URL        = "wss://turtles.infra.com.do"
local BRIDGE_KEY = nil  -- WS bridge↔server auth; nil = open/legacy mode.
                        -- NOTE: this is SEPARATE from Swarm.KEY (the rednet
                        -- swarm secret). BRIDGE_KEY authenticates the bridge
                        -- connection to the web server; Swarm.KEY authenticates
                        -- turtle↔turtle rednet messages. Never mix the two.
if fs.exists("/bridge.json") then
    local f = fs.open("/bridge.json", "r")
    local c = textutils.unserialize(f.readAll())
    f.close()
    if c and c.url then URL = c.url end
    if c and c.key then BRIDGE_KEY = c.key end
end

-- Open the wireless modem
for _, side in ipairs({ "top", "bottom", "left", "right", "front", "back" }) do
    if peripheral.getType(side) == "modem" and peripheral.call(side, "isWireless") then
        rednet.open(side)
    end
end

local function connect()
    print("[bridge] Connecting to " .. URL .. " ...")
    local ws, err = http.websocket(URL)
    if not ws then
        print("[bridge] Connect failed: " .. tostring(err))
        return nil
    end
    -- Include key only when configured; nil fields are omitted by
    -- serializeJSON so the legacy (open) server path is preserved.
    ws.send(textutils.serializeJSON({ type = "hello", role = "bridge",
                                      ver = VERSION, key = BRIDGE_KEY }))
    print("[bridge] Connected.")
    return ws
end

-- Forward turtle status heartbeats to the server (filter to the status
-- protocol so we don't wake on every lane/site beat). No key required:
-- it's read-only telemetry; commands and zones still need the key.
local function pumpRednet(ws)
    while true do
        local id, msg = rednet.receive(Swarm.PROTO_STATUS)
        if type(msg) == "table" and msg.role then
            local ok = pcall(ws.send, textutils.serializeJSON({
                type = "status", id = id, data = msg,
            }))
            if not ok then error("ws send failed", 0) end
        end
    end
end

-- Forward miner zone RPCs (rednet swarm_zone -> server) and relay the
-- server's grant back to the requesting miner. KEYED: a wrong-key zone
-- message is dropped so nobody can grief the zone registry.
local function pumpZones(ws)
    while true do
        local id, msg = rednet.receive("swarm_zone")
        if Swarm.ok(msg) and msg.site then
            local ok = pcall(ws.send, textutils.serializeJSON({
                type = "zone", op = msg.op, site = msg.site, miner = id, idx = msg.idx,
            }))
            if not ok then error("ws send failed", 0) end
        end
    end
end

-- F3: Forward hazard broadcasts to the dashboard.
-- KEYED: validate before forwarding so a rogue turtle can't flood the
-- dashboard with fake hazard data. Separate pump = separate protocol
-- receive so pumpRednet's status filter doesn't swallow swarm_hazard.
local function pumpHazards(ws)
    while true do
        local id, msg = rednet.receive("swarm_hazard")
        if Swarm.ok(msg) and msg.hazard then
            local ok = pcall(ws.send, textutils.serializeJSON({
                type = "hazard", id = id, data = msg,
            }))
            if not ok then error("ws send failed", 0) end
        end
    end
end

-- Forward dashboard commands + relay server zone grants
local function pumpWebsocket(ws)
    while true do
        local raw = ws.receive()
        if raw == nil then error("ws closed", 0) end
        local m = textutils.unserializeJSON(raw)
        if type(m) == "table" and m.type == "command" and type(m.payload) == "table" then
            m.payload.k = Swarm.KEY  -- inherit the swarm auth
            rednet.broadcast(m.payload, Swarm.PROTO_CMD)
            print("[bridge] cmd -> swarm: " .. tostring(m.payload.cmd))
            if m.payload.cmd == "update" then
                print("[bridge] update -> rebooting self...")
                os.sleep(0.5)
                os.reboot()
            end
        elseif type(m) == "table" and m.type == "zone_grant" and m.miner ~= nil then
            -- keyed so the miner trusts the grant; level = resume layer
            Swarm.to(m.miner, { type = "grant", idx = m.idx, level = m.level }, "swarm_zone")
        end
    end
end

-- Reconnect loop: a dropped socket just retries
while true do
    local ws = connect()
    if ws then
        pcall(parallel.waitForAny,
            function() pumpRednet(ws) end,
            function() pumpZones(ws) end,
            function() pumpWebsocket(ws) end,
            function() pumpHazards(ws) end)
        pcall(ws.close)
        print("[bridge] Disconnected - retrying in 3s")
    end
    os.sleep(3)
end
