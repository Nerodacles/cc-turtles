-- lib/swarm.lua
-- Shared swarm plumbing: the status heartbeat and the
-- request -> offer -> assign -> ready negotiation used for courier
-- pickups and fuel deliveries.

local Swarm = {}

Swarm.PROTO_STATUS = "swarm_status"
Swarm.PROTO_CMD    = "swarm_cmd"

-- ============================================================
-- SHARED SECRET: every swarm message carries it; messages without
-- the right key are ignored - other players' turtles/pockets can't
-- command ours, steal pickups or drain fuelers. Override the default
-- by creating /secret.json -> { key = "your-own-key" } on EVERY
-- device (turtles + pocket).
-- ============================================================
Swarm.KEY = "swarm-default-key"
if fs.exists("/secret.json") then
    local f = fs.open("/secret.json", "r")
    local s = textutils.unserialize(f.readAll())
    f.close()
    if s and s.key then Swarm.KEY = s.key end
end

-- Broadcast / send with the key attached
function Swarm.bcast(payload, proto)
    payload.k = Swarm.KEY
    rednet.broadcast(payload, proto)
end

function Swarm.to(id, payload, proto)
    payload.k = Swarm.KEY
    rednet.send(id, payload, proto)
end

-- Valid swarm message? (table + correct key)
function Swarm.ok(msg)
    return type(msg) == "table" and msg.k == Swarm.KEY
end

-- Adopt a new key (rekey command): persists and applies immediately
function Swarm.setKey(k)
    Swarm.KEY = k
    local f = fs.open("/secret.json", "w")
    f.write(textutils.serialize({ key = k }))
    f.close()
end

-- Broadcast a status table every `interval` seconds. `info` is a
-- function returning the table; pos is filled in automatically.
function Swarm.heartbeat(interval, info)
    while true do
        local x, y, z = gps.locate(1)
        local msg = info()
        msg.pos = x and { x = x, y = y, z = z } or nil
        Swarm.bcast(msg, Swarm.PROTO_STATUS)
        os.sleep(interval)
    end
end

-- CLIENT side: broadcast a request at `pos`, collect offers for 3s,
-- assign the closest provider and wait for its `readyType` message.
-- opts: readyType (e.g. "arrived"/"delivered"), onReady(providerId),
--       abortFn(), timeout (default 300s).
function Swarm.requestService(proto, pos, opts)
    Swarm.bcast({ type = "request", pos = pos }, proto)

    local best, bestDist = nil, math.huge
    local deadline = os.clock() + 3
    while os.clock() < deadline do
        local id, msg = rednet.receive(proto, 0.5)
        if id and Swarm.ok(msg) and msg.type == "offer" and msg.pos then
            local d = math.abs(msg.pos.x - pos.x) + math.abs(msg.pos.y - pos.y)
                    + math.abs(msg.pos.z - pos.z)
            if d < bestDist then best, bestDist = id, d end
        end
    end

    if not best then
        print("[swarm] No providers for " .. proto)
        return false
    end

    print("[swarm] Assigned #" .. best .. " (dist " .. bestDist .. ")")
    Swarm.to(best, { type = "assign", pos = pos }, proto)

    local timeout = os.clock() + (opts.timeout or 300)
    while os.clock() < timeout do
        if opts.abortFn and opts.abortFn() then break end
        local id, msg = rednet.receive(proto, 1)
        if id == best and Swarm.ok(msg) and msg.type == opts.readyType then
            if opts.onReady then opts.onReady(best) end
            return true
        end
    end

    print("[swarm] Provider #" .. best .. " never delivered")
    return false
end

-- PROVIDER side: serve requests forever. canServe(reqPos) returns our
-- current position when we can take the job (nil refuses silently).
-- run(clientId, pos) performs the actual delivery.
function Swarm.serve(proto, canServe, run)
    while true do
        local id, msg = rednet.receive(proto)
        if Swarm.ok(msg) and msg.type == "request" and msg.pos then
            local cur = canServe(msg.pos)
            if cur then
                Swarm.to(id, { type = "offer",
                               fuel = turtle.getFuelLevel(),
                               pos  = cur }, proto)
                -- The client assigns the closest offer within seconds.
                -- Short wait: requests queued while we were delivering
                -- are stale - their clients moved on - so don't stall
                -- long on each before reaching the live ones.
                local deadline = os.clock() + 5
                while os.clock() < deadline do
                    local aid, amsg = rednet.receive(proto, 1)
                    if aid == id and Swarm.ok(amsg) and amsg.type == "assign" then
                        run(id, amsg.pos)
                        break
                    end
                end
            end
        end
    end
end

return Swarm
