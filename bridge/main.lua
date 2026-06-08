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

-- Default server (override in /bridge.json -> { url = "wss://host" }).
-- wss:// because the site is served over HTTPS - the browser uses wss
-- too, so the bridge must match (ws:// would be mixed-content).
local URL = "wss://turtles.infra.com.do"
if fs.exists("/bridge.json") then
    local f = fs.open("/bridge.json", "r")
    local c = textutils.unserialize(f.readAll())
    f.close()
    if c and c.url then URL = c.url end
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
    ws.send(textutils.serializeJSON({ type = "hello", role = "bridge", ver = VERSION }))
    print("[bridge] Connected.")
    return ws
end

-- Forward turtle status heartbeats to the server
local function pumpRednet(ws)
    while true do
        local id, msg, proto = rednet.receive()
        -- Forward any status heartbeat for DISPLAY (no key required -
        -- it's read-only telemetry; commands still need the key). This
        -- way the dashboard fills even if the bridge's key differs.
        if proto == Swarm.PROTO_STATUS and type(msg) == "table" and msg.role then
            local ok = pcall(ws.send, textutils.serializeJSON({
                type = "status", id = id, data = msg,
            }))
            if not ok then error("ws send failed", 0) end
        end
    end
end

-- Forward dashboard commands to the swarm (re-signed with the key)
local function pumpWebsocket(ws)
    while true do
        local raw = ws.receive()
        if raw == nil then error("ws closed", 0) end
        local m = textutils.unserializeJSON(raw)
        if type(m) == "table" and m.type == "command" and type(m.payload) == "table" then
            m.payload.k = Swarm.KEY  -- inherit the swarm auth
            rednet.broadcast(m.payload, Swarm.PROTO_CMD)
            print("[bridge] cmd -> swarm: " .. tostring(m.payload.cmd))
            -- 'update' updates the swarm AND the bridge itself (rednet
            -- doesn't deliver our own broadcast, so reboot explicitly;
            -- startup re-downloads our code)
            if m.payload.cmd == "update" then
                print("[bridge] update -> rebooting self...")
                os.sleep(0.5)
                os.reboot()
            end
        end
    end
end

-- Reconnect loop: a dropped socket just retries
while true do
    local ws = connect()
    if ws then
        pcall(parallel.waitForAny,
            function() pumpRednet(ws) end,
            function() pumpWebsocket(ws) end)
        pcall(ws.close)
        print("[bridge] Disconnected - retrying in 3s")
    end
    os.sleep(3)
end
