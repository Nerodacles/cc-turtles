-- lib/lane.lua
-- Direction-grouped traffic control for a shared 1x1 column (the mine
-- entry shaft). Turtles moving the SAME direction flow together as a
-- convoy (they queue vertically, head-ons are impossible); opposite
-- traffic waits for the flow to drain. "service" holds (transfers
-- with couriers) are exclusive. No coordinator: rednet heartbeats
-- with TTL; a crashed user stops beating and frees the lane.
-- Anti-starvation: a waiter older than 30s blocks NEW joiners, so a
-- busy flow can't lock the other direction out forever.

local Swarm = require("swarm")

local Lane = {}

Lane.PROTO = "swarm_lane"
local TTL        = 12   -- seconds without beats before an entry expires
local STARVATION = 30   -- waiters older than this stop new joiners

local using    = {}   -- "lane|id" -> { t, dir }  (inside the column)
local waiting  = {}   -- "lane|id" -> { t, dir, waited }
local current  = nil  -- { lane, dir } we are inside with
local lastBeat = 0

local function key(x, z) return x .. "," .. z end

-- Run in parallel: collects other turtles' lane traffic
function Lane.listener()
    while true do
        local id, msg = rednet.receive(Lane.PROTO)
        if Swarm.ok(msg) and msg.lane then
            if msg.type == "using" then
                using[msg.lane .. "|" .. id] =
                    { t = os.clock(), dir = msg.dir }
            elseif msg.type == "waiting" then
                waiting[msg.lane .. "|" .. id] =
                    { t = os.clock(), dir = msg.dir, waited = msg.waited or 0 }
            elseif msg.type == "left" then
                -- Explicit release: free the lane NOW instead of
                -- waiting out the 12s TTL (matters at every direction
                -- reversal in the shared shaft)
                using[msg.lane .. "|" .. id]   = nil
                waiting[msg.lane .. "|" .. id] = nil
            end
        end
    end
end

-- Scan fresh entries of a lane; prunes long-dead ones while at it
local function scan(tbl, lane, fn)
    local now = os.clock()
    local hit = false
    for k, v in pairs(tbl) do
        if now - v.t > TTL * 10 then
            tbl[k] = nil
        elseif not hit and now - v.t < TTL then
            local l, id = k:match("^(.+)|(%d+)$")
            if l == lane and fn(v, tonumber(id)) then hit = true end
        end
    end
    return hit
end

-- Someone inside whose direction conflicts with ours? (same dir is
-- fine - that's the convoy; "service" conflicts with everything)
local function flowConflict(lane, dir, onlyBelowId, myId)
    return scan(using, lane, function(v, id)
        local conflict = (v.dir ~= dir) or dir == "service"
        if not conflict then return false end
        if onlyBelowId then return id < myId end
        return true
    end)
end

-- A starved opposite waiter we should let through before joining?
-- Yield only to waiters who waited LONGER than us: two mutually
-- starved opposite waiters would otherwise yield to each other
-- forever. Longest wait goes first (exact ties fall through to the
-- claim re-check, which resolves them by computer ID).
local function starvedWaiter(lane, dir, myWaited)
    return scan(waiting, lane, function(v)
        return (v.dir ~= dir or v.dir == "service")
           and (v.waited or 0) > STARVATION
           and (v.waited or 0) > myWaited
    end)
end

-- Broadcast our presence inside the lane. Call periodically while
-- holding (a 4s parallel thread); throttled internally.
function Lane.beat()
    if not current then return end
    if os.clock() - lastBeat >= 4 then
        lastBeat = os.clock()
        Swarm.bcast({ type = "using", lane = current.lane,
                      dir = current.dir }, Lane.PROTO)
    end
end

-- Block until we may use the lane towards `dir` ("down"/"up" group
-- with same-direction traffic; "service" waits for an empty column).
-- Optional abortFn cancels the wait (e.g. a stop command): returns
-- false without acquiring.
function Lane.enter(x, z, dir, abortFn)
    local lane  = key(x, z)
    local myId  = os.getComputerID()
    local since = os.clock()
    local lastWait = -math.huge
    print("[lane] Waiting for the shaft (" .. dir .. ")...")

    while true do
        if abortFn and abortFn() then
            print("[lane] Wait aborted")
            return false
        end
        -- advertise that we are waiting (anti-starvation input)
        if os.clock() - lastWait >= 3 then
            lastWait = os.clock()
            Swarm.bcast({ type = "waiting", lane = lane, dir = dir,
                          waited = os.clock() - since }, Lane.PROTO)
        end

        if not flowConflict(lane, dir)
           and not starvedWaiter(lane, dir, os.clock() - since) then
            -- claim and re-check: opposite simultaneous claimers yield
            -- to the lower ID; same-direction claims coexist (convoy)
            current  = { lane = lane, dir = dir }
            lastBeat = 0
            Lane.beat()
            os.sleep(1 + math.random())
            if not flowConflict(lane, dir, true, myId) then
                print("[lane] Shaft acquired (" .. dir .. ")")
                return true
            end
            current = nil
        end
        os.sleep(2 + math.random() * 2)
    end
end

function Lane.exit()
    if current then
        -- Tell everyone we left so the lane frees immediately
        Swarm.bcast({ type = "left", lane = current.lane }, Lane.PROTO)
        current = nil
    end
end

return Lane
