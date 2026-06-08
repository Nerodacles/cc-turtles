-- miner/main.lua
-- Mining Turtle: flies to the shared dig site (set from the pocket),
-- queues for the SINGLE shared shaft (lib/lane.lua), descends, tunnels
-- to its negotiated zone and mines stacked 3-high rooms there.
-- REQUIRES a GPS cluster.

package.path = package.path .. ";/lib/?.lua"
local Utils = require("utils")
local Fuel  = require("fuel")
local Nav   = require("nav")
local Swarm = require("swarm")
local Trail = require("trail")
local Lane  = require("lane")
local VERSION = require("version")
local Log   = require("log")
Log.init()  -- tee print() so the dashboard can show this turtle's log

-- ============================================================
-- CONFIG
-- ============================================================
local MINING_Y         = 30   -- Y of the FIRST room (turtle mid-layer)
local MIN_Y            = -50  -- deepest room (top of the diamond band;
                              -- still above the always-lava aquifer -55..-63)
local LEVEL_STEP       = 3    -- room height (3), contiguous: stacked
                              -- levels leave NO floor between them
local ROOM_RINGS       = 5    -- room is (2*RINGS+1)^2 -> 11x11
local ZONE_SPREAD      = 16   -- blocks between room centers below
-- ALL miners enter AND exit through ONE shared 1x1 shaft at the
-- site's exact x/z, splitting into their zones at the bottom.
-- lib/lane.lua serializes the column: one turtle inside at a time.
local VEIN_MAX_DEPTH   = 16
local CALL_COURIER_PCT = 80
local COURIER_COOLDOWN = 60
local STATUS_INTERVAL  = 5
-- A level that yields ZERO blocks in this many real steps is already
-- mined (manual vein-mine / old shafts / giant cavern): skip it.
-- High threshold on purpose: a half-cave room still digs SOMETHING
-- within 60 steps, so partial overlaps are never skipped.
local EMPTY_CHECK_STEPS = 60

local PROTO_CMD     = "swarm_cmd"
local PROTO_COURIER = "swarm_courier"
local PROTO_SITE    = "swarm_site"

local HOME_FILE = "/home.json"

-- ============================================================
-- STATE (persisted to /state.json)
-- ============================================================
local state = {
    phase  = "goto",
    site   = nil,   -- shared entry point (from the pocket)
    slot   = nil,   -- my index among the miners at this site
    shaft  = nil,   -- {x,z} my shaft column at the entry zone
    center = nil,   -- {x,z} my room zone center below
    topY   = nil,   -- surface Y at the shaft
    depth  = 0,     -- blocks below topY (shaft + stacked levels)
    mined  = {},
    room   = { px = 0, pz = 0, facing = 0 },
}

local stopFlag, pauseFlag, updateFlag = false, false, false
local currentPhase   = "boot"
local lastCourierTry = -COURIER_COOLDOWN
local lastFuelTry    = -COURIER_COOLDOWN

-- Discovered-ore buffer: each found ore's world position (dead-reckoned
-- from the zone center + room offset + depth, so no GPS cost per block).
-- Flushed into the status heartbeat for the dashboard's live ore map.
local oreBuffer = {}
local function noteOre(name)
    if #oreBuffer >= 60 then return end
    oreBuffer[#oreBuffer + 1] = {
        n = (name:gsub("minecraft:", ""):gsub("_ore", "")),
        x = (state.center and state.center.x or 0) + state.room.px,
        y = (state.topY or MINING_Y) - state.depth,
        z = (state.center and state.center.z or 0) + state.room.pz,
    }
end

-- Dead-reckoned absolute position (same math as noteOre). GPS dies
-- underground, so the heartbeat falls back to this to keep the miner
-- on the dashboard map while it's actually mining.
local function deadPos()
    if not state.center then return nil end
    local r = state.room or {}
    return {
        x = state.center.x + (r.px or 0),
        y = (state.topY or MINING_Y) - (state.depth or 0),
        z = state.center.z + (r.pz or 0),
    }
end

-- Home persists across missions
local home = Utils.readJSON(HOME_FILE)

-- ============================================================
-- HELPERS
-- ============================================================
local function targetDepth()
    return math.max(0, (state.topY or MINING_Y) - MINING_Y)
end

local function returnCost()
    local tunnel = 0
    if state.shaft and state.center then
        tunnel = math.abs(state.center.x - state.shaft.x)
               + math.abs(state.center.z - state.shaft.z)
    end
    local fly = 0
    if home and state.site then
        -- terrain-hugging flight: roughly the horizontal distance
        -- plus a margin for obstacle hops
        fly = math.abs(home.x - state.site.x) + math.abs(home.z - state.site.z) + 60
    end
    return (state.depth or 0) + tunnel + fly
         + math.abs(state.room.px) + math.abs(state.room.pz)
end

local function fuelLow()
    return turtle.getFuelLevel() <= returnCost() + Utils.SAFETY_MARGIN
end

local function topUpFuel()
    local comfort = returnCost() + Utils.SAFETY_MARGIN * 10
    if turtle.getFuelLevel() < comfort then
        Fuel.refuel(comfort)
    end
end

local function waitWhilePaused()
    while pauseFlag and not stopFlag do os.sleep(0.5) end
end

-- Orient can fail when boxed in (neighboring turtles at the junction,
-- protected-only sides). A raw error would kill the mission thread:
-- retry with RANDOM backoff - two mutually-blocked orienters on a
-- fixed interval would spin in lockstep forever.
local function orientPatiently()
    while not pcall(Nav.orient) do
        print("[nav] Cannot orient (boxed in?) - retrying...")
        os.sleep(2 + math.random() * 4)
    end
end

-- Orient ONLY when facing is actually unknown (fresh boot / failed
-- resume re-orient). After a normal flight+descent the facing has
-- been tracked the whole way - orienting again at the crowded shaft
-- bottom just spins against convoy neighbors for nothing.
local function ensureOriented()
    if Nav.facing == nil then orientPatiently() end
end

-- Miners carry filler, so Nav flights can seal+cross lava (service
-- turtles leave this nil and wait/abort at lava instead)
Nav.sealFn = Utils.seal

-- Guarded dig fns so Nav can dig during flights (never protected/lava)
Nav.digFns = {
    fwd = function()
        local ok, b = turtle.inspect()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            Utils.record(state, b.name)
            turtle.dig()
        end
    end,
    up = function()
        local ok, b = turtle.inspectUp()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            Utils.record(state, b.name)
            turtle.digUp()
        end
    end,
    down = function()
        local ok, b = turtle.inspectDown()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            Utils.record(state, b.name)
            turtle.digDown()
        end
    end,
}

-- ============================================================
-- SLOT GRID: k-th cell of a chebyshev spiral around the site.
-- Room centers = site + cell * ZONE_SPREAD (no overlap below).
-- ============================================================
local function gridOffset(k)
    if k == 0 then return 0, 0 end
    local r, count = 1, 1
    while k >= count + 8 * r do
        count = count + 8 * r
        r = r + 1
    end
    local i = k - count
    local cells = {}
    for x = -r, r do
        for z = -r, r do
            if math.max(math.abs(x), math.abs(z)) == r then
                cells[#cells + 1] = { x, z }
            end
        end
    end
    return cells[i + 1][1], cells[i + 1][2]
end

-- ============================================================
-- SLOT NEGOTIATION: announce on swarm_site, collect peers for 3s.
-- Miners that already own a slot reply with it; the rest resolve
-- by computer ID order. No central coordinator.
-- ============================================================
local function negotiateSlot()
    currentPhase = "negotiating"
    local myId = os.getComputerID()

    while true do
        local taken = {}
        local peers = { [myId] = true }

        -- The updater staggers miners by SECONDS: a single announce
        -- at t=0 is missed by late starters (who then think they are
        -- alone and grab slot 0 too). Announce repeatedly, and extend
        -- the window when a new simultaneous starter shows up.
        local started  = os.clock()
        local deadline = started + 6
        local lastSay  = -math.huge
        while os.clock() < deadline do
            if os.clock() - lastSay >= 1 then
                lastSay = os.clock()
                Swarm.bcast({ type = "here" }, PROTO_SITE)
            end
            local id, msg = rednet.receive(PROTO_SITE, 0.5)
            if id and Swarm.ok(msg) then
                if msg.type == "here" then
                    if msg.slot then
                        taken[msg.slot] = true
                    elseif not peers[id] then
                        peers[id] = true  -- new starter: let it see us too
                        deadline = math.min(os.clock() + 3, started + 15)
                    end
                elseif msg.type == "claim" and msg.slot then
                    -- Someone mid-claim while we are still collecting:
                    -- without this, their claim (sent BEFORE our verify
                    -- starts listening) is dropped and we'd take the
                    -- same slot - the duplicate-zone interleave hole
                    taken[msg.slot] = true
                end
            end
        end

        local ids = {}
        for id in pairs(peers) do ids[#ids + 1] = id end
        table.sort(ids)
        local rank = 0
        for i, id in ipairs(ids) do
            if id == myId then rank = i - 1; break end
        end

        -- Take the rank-th free slot
        local slot, free = 0, 0
        while true do
            if not taken[slot] then
                if free == rank then break end
                free = free + 1
            end
            slot = slot + 1
        end

        -- CLAIM + VERIFY: if another miner claims the same slot in
        -- the same instant, the lower ID keeps it, we renegotiate
        Swarm.bcast({ type = "claim", slot = slot }, PROTO_SITE)
        local contested = false
        local vDeadline = os.clock() + 2
        while os.clock() < vDeadline do
            local id, msg = rednet.receive(PROTO_SITE, 0.5)
            if id and Swarm.ok(msg) then
                if msg.type == "claim" and msg.slot == slot and id < myId then
                    contested = true
                elseif msg.slot then
                    taken[msg.slot] = true
                end
            end
        end

        if not contested then
            print("[site] Local slot " .. slot)
            return slot
        end
        print("[site] Slot " .. slot .. " contested - renegotiating...")
        os.sleep(math.random() * 2)
    end
end

-- Compute and persist the shaft + zone center for a zone index.
-- idx+1: cell (0,0) is the shared junction every tunnel radiates from,
-- so no room sits on the hub.
local function setZone(idx)
    state.slot   = idx
    local gx, gz = gridOffset(idx + 1)
    state.shaft  = { x = state.site.x, z = state.site.z }
    state.center = { x = state.site.x + gx * ZONE_SPREAD,
                     z = state.site.z + gz * ZONE_SPREAD }
    Utils.saveState(state)
    print("[zone] idx " .. idx .. " | zone " .. state.center.x ..
          "," .. state.center.z)
end

-- Ask the SERVER (via the bridge) for the next free zone index - it is
-- authoritative and persisted, so done zones are never re-mined. Pass
-- doneIdx to ATOMICALLY mark that zone done first (op "next") - a
-- separate done+request would race and resume the just-finished zone.
-- Falls back to decentralized local negotiation if no server answers.
-- Returns the server-granted idx, or nil if no server/bridge answers.
local function acquireZone(doneIdx)
    currentPhase = "zoning"
    Swarm.bcast({ op = doneIdx and "next" or "request",
                  site = state.site, idx = doneIdx }, "swarm_zone")
    local deadline = os.clock() + 4
    while os.clock() < deadline do
        local _, m = rednet.receive("swarm_zone", 0.5)
        if Swarm.ok(m) and m.type == "grant" and m.idx ~= nil then
            print("[zone] Server granted idx " .. m.idx)
            return m.idx
        end
    end
    return nil
end

-- Answer slot queries/claims (latecomers and claim-verifiers learn
-- taken slots) and SITE queries (newly added miners that never heard
-- an 'm' learn the entry point from the swarm)
local function siteListener()
    while true do
        local id, msg = rednet.receive(PROTO_SITE)
        if Swarm.ok(msg) then
            if msg.type == "site_query" then
                local s = Utils.readJSON("/site.json")
                if s then
                    Swarm.to(id, { type = "site", pos = s }, PROTO_SITE)
                end
            elseif state.slot and (msg.type == "here" or msg.type == "claim") then
                Swarm.to(id, { type = "here", slot = state.slot }, PROTO_SITE)
            end
        end
    end
end

-- ============================================================
-- PARALLEL THREADS: command listener + status heartbeat
-- ============================================================
local function listener()
    while true do
        local _, msg = rednet.receive(PROTO_CMD)
        -- Keyed commands only: other players' pockets are ignored.
        -- A command with msg.id targets ONE turtle; without it, all.
        if Swarm.ok(msg) and (not msg.id or msg.id == os.getComputerID()) then
            if msg.cmd == "mine_at" and msg.pos then
                -- New entry point: applies to the NEXT mission (floored:
                -- pocket fixes are the player's float position)
                Utils.writeJSON("/site.json", {
                    x = math.floor(msg.pos.x),
                    y = math.floor(msg.pos.y),
                    z = math.floor(msg.pos.z),
                })
                print("[cmd] Entry point updated (applies next mission)")
            elseif msg.cmd == "stop" then
                print("[cmd] stop received")
                stopFlag = true
            elseif msg.cmd == "pause" then
                print("[cmd] paused")
                pauseFlag = true
            elseif msg.cmd == "resume" then
                print("[cmd] resumed")
                pauseFlag = false
            elseif msg.cmd == "update" then
                print("[cmd] update queued - rebooting at next safe point")
                updateFlag = true
            elseif msg.cmd == "rekey" and msg.newKey then
                -- Key rotation (signed with the CURRENT key)
                Swarm.setKey(msg.newKey)
                print("[cmd] Swarm key updated")
            end
        end
    end
end

local function updateCheckpoint()
    if updateFlag then
        print("[update] Safe checkpoint - rebooting to update...")
        os.reboot()
    end
end

local function statusLoop()
    Swarm.heartbeat(STATUS_INTERVAL, function()
        local ob = oreBuffer; oreBuffer = {}  -- flush discovered ores
        return {
            role  = "miner",
            label = os.getComputerLabel() or ("miner-" .. os.getComputerID()),
            phase = currentPhase,
            fuel  = turtle.getFuelLevel(),
            inv   = Utils.invPercent(),
            claim = state.center,  -- my zone, for the dashboard
            slot  = state.slot,
            site  = state.site,    -- for the server's zone-claim renewal
            zoneIdx = state.slot,
            pos   = deadPos(),     -- GPS overrides this above ground

            ver   = VERSION,
            ores  = (#ob > 0) and ob or nil,
            log   = Log.flush(),
        }
    end)
end

-- Piggyback the lane heartbeat on the status cycle (every 5s)
local function laneBeats()
    while true do
        Lane.beat()
        os.sleep(4)
    end
end

-- ============================================================
-- VEIN MINING (unchanged: 6-dir recursive, exact backtrack)
-- ============================================================
local function backtrack()
    local tries = 0
    while not turtle.back() do
        tries = tries + 1
        if tries > 5 then
            -- Something behind us: turn and walk it (Utils.forward is
            -- guarded: digs gravel, WAITS on turtles/protected blocks)
            Nav.turnRight(); Nav.turnRight()
            Utils.forward(state)
            Nav.turnRight(); Nav.turnRight()
            return
        end
        os.sleep(0.3)
    end
    Trail.record(tostring((Nav.facing + 2) % 4))  -- moved backwards
end

local function safeAfterDig(inspect, place)
    local ok, b = inspect()
    if ok and Utils.isLava(b.name) then
        Utils.seal(place)
        return false
    end
    return true
end

local function veinMine(depth)
    -- stop aborts the chase immediately (deep veins take a while)
    if depth <= 0 or stopFlag then return end

    local ok, b = turtle.inspectUp()
    if ok and Utils.isOre(b.name, b.tags) then
        Utils.record(state, b.name)
        noteOre(b.name)
        turtle.digUp()
        if safeAfterDig(turtle.inspectUp, turtle.placeUp) and turtle.up() then
            Trail.record("U")
            veinMine(depth - 1)
            Utils.down(state)  -- guarded + records the trail move
        end
    end

    ok, b = turtle.inspectDown()
    if ok and Utils.isOre(b.name, b.tags) then
        Utils.record(state, b.name)
        noteOre(b.name)
        turtle.digDown()
        if safeAfterDig(turtle.inspectDown, turtle.placeDown) and turtle.down() then
            Trail.record("D")
            veinMine(depth - 1)
            Utils.up(state)  -- guarded + records the trail move
        end
    end

    for _ = 1, 4 do
        ok, b = turtle.inspect()
        if ok and Utils.isOre(b.name, b.tags) then
            Utils.record(state, b.name)
            noteOre(b.name)
            turtle.dig()
            if safeAfterDig(turtle.inspect, turtle.place) and turtle.forward() then
                Trail.record(tostring(Nav.facing))
                veinMine(depth - 1)
                backtrack()
            end
        end
        Nav.turnRight()  -- keeps Nav.facing true (trail uses absolute dirs)
    end
end

-- ============================================================
-- COURIER / FUELER CALLS (negotiation in lib/swarm.lua; meetups
-- happen at open air columns: the shaft or the home position)
-- ============================================================
local function requestCourier()
    local x, y, z = gps.locate(2)
    if not x then
        print("[courier] No GPS signal")
        return false
    end

    local prevPhase = currentPhase
    currentPhase = "waiting_courier"
    local ok = Swarm.requestService(PROTO_COURIER, { x = x, y = y, z = z }, {
        readyType = "arrived",
        abortFn   = function() return stopFlag end,
        onReady   = function(id)
            -- Confirm the courier is actually hovering above before we
            -- dropUp: a courier that crashed between 'arrived' and now
            -- is gone, and dropping into empty air loses the loot. No
            -- turtle above -> keep everything, retry the courier later.
            local up, ub = turtle.inspectUp()
            if not (up and ub.name:find("computercraft")) then
                print("[courier] Courier left before transfer - keeping cargo")
                return
            end
            -- Junk never reaches the chests; coal banks to the tank
            -- (dropCargo does it). Only ore + tank-full surplus coal
            -- go to the courier; one filler stack stays for lava seals.
            Utils.purgeJunk()
            Utils.dropCargo(turtle.dropUp)
            Swarm.to(id, { type = "done" }, PROTO_COURIER)
            print("[courier] Transfer complete (inv " .. Utils.invPercent() ..
                  "% | fuel " .. turtle.getFuelLevel() .. ")")
        end,
    })
    currentPhase = prevPhase
    return ok
end

local function requestFuel()
    local prevPhase = currentPhase
    currentPhase = "waiting_fuel"
    local ok = Fuel.requestDelivery(
        returnCost() + Utils.SAFETY_MARGIN * 10,
        function() return stopFlag end)
    currentPhase = prevPhase
    return ok
end

-- Hand all non-burnable cargo to a courier (persistent: one courier
-- serves one multi-minute trip at a time, so we queue with jitter).
-- Burnables stay aboard and get banked into the tank afterwards.
local function unloadToCourier(maxTries)
    currentPhase = "unloading"
    print("[unload] Calling a courier to collect the cargo...")
    local tries = 0
    while Utils.hasCargo() and tries < maxTries and not stopFlag do
        tries = tries + 1
        if not requestCourier() then
            print("[unload] No courier free (attempt " .. tries .. "/" ..
                  maxTries .. ") - retrying...")
            os.sleep(15 + math.random(0, 10))
        end
    end
    if Utils.hasCargo() then
        print("[unload] Cargo still aboard")
    end
end

-- Used during shaft descent (the open column is right above us)
local function cargoCheck()
    topUpFuel()
    if fuelLow() then
        if os.clock() - lastFuelTry >= COURIER_COOLDOWN then
            lastFuelTry = os.clock()
            requestFuel()
        end
        if fuelLow() then
            print("[!] Fuel low (" .. turtle.getFuelLevel() .. ") - heading home")
            return true
        end
    end
    if Utils.invPercent() >= CALL_COURIER_PCT then
        Utils.bankFuel()   -- bank coal to the tank: frees slots
        Utils.purgeJunk()  -- toss cobble: may avoid the courier call
    end
    if Utils.invPercent() >= CALL_COURIER_PCT then
        if os.clock() - lastCourierTry >= COURIER_COOLDOWN then
            lastCourierTry = os.clock()
            if requestCourier() then return false end
        end
        if Utils.invFull() then
            print("[!] Inventory full and no courier - heading home")
            return true
        end
    end
    return false
end

-- In-room check: detection only; services are negotiated at the shaft
local function roomAbortReason()
    if stopFlag then return "stop" end
    if updateFlag then return "update" end
    topUpFuel()
    if fuelLow() then return "fuel" end
    -- Bank coal to the tank and toss junk before deciding: both free
    -- slots and often drop us back under the threshold, saving the
    -- whole courier round trip
    if Utils.invPercent() >= CALL_COURIER_PCT then
        Utils.bankFuel()
        Utils.purgeJunk()
    end
    if Utils.invFull() then return "full" end
    if Utils.invPercent() >= CALL_COURIER_PCT
       and os.clock() - lastCourierTry >= COURIER_COOLDOWN then
        return "transfer"
    end
    return nil
end

-- ============================================================
-- HORIZONTAL DIG-WALK at the current Y, one axis at a time with a
-- fresh GPS fix per step (self-correcting). Axis order matters:
-- outbound "xz" and return "zx" retrace the SAME L-corridor.
-- With a shared entry, tunnels can overlap: head-on turtles are
-- OVERTAKEN over the top instead of deadlocking.
-- Returns false if lava blocks the way (sealed first).
-- ============================================================
local function walkAxis(axis, target)
    while true do
        local cur = Nav.locate()
        local delta = (axis == "x") and (target - cur.x) or (target - cur.z)
        if delta == 0 then return true end
        if axis == "x" then Nav.face(delta > 0 and 1 or 3)
        else Nav.face(delta > 0 and 0 or 2) end

        local ok, b = turtle.inspect()
        if ok and Utils.isLava(b.name) then
            print("[guard] LAVA in tunnel - sealed")
            Utils.seal(turtle.place)
            return false
        end

        if ok and b.name:find("computercraft") then
            -- Another turtle ahead: wait a RANDOM patience (two
            -- head-on turtles with fixed timers overtake in lockstep
            -- and re-collide forever), then climb over it (the GPS
            -- loop self-corrects any overshoot)
            local patience = 10 + math.random(20)
            local waited = 0
            while waited < patience do
                local o2, b2 = turtle.inspect()
                if not (o2 and b2.name:find("computercraft")) then break end
                os.sleep(0.5)
                waited = waited + 1
            end
            local o3, b3 = turtle.inspect()
            if o3 and b3.name:find("computercraft") then
                print("[tunnel] Overtaking a turtle...")
                Utils.up(state)
                Utils.forward(state)
                Utils.forward(state)
                Utils.down(state)
            end
        else
            Utils.forward(state)
        end
    end
end

local function walkTo(tx, tz, order)
    print("[tunnel] Walking to " .. tx .. "," .. tz .. "...")
    if order == "xz" then
        return walkAxis("x", tx) and walkAxis("z", tz)
    else
        return walkAxis("z", tz) and walkAxis("x", tx)
    end
end

-- ============================================================
-- PHASE: SHAFT DESCENT to MINING_Y (lava/protected guarded)
-- ============================================================
local function descend()
    currentPhase = "descend"
    if targetDepth() == 0 then
        -- Settled at/below MINING_Y already (the entry column opened
        -- into a cave): no shaft needed, rooms stack down from here
        print("[descend] Already at mining level (cave floor) - no shaft needed")
        return "target"
    end
    print("[descend] Digging down to Y=" .. MINING_Y .. "...")
    while not stopFlag and state.depth < targetDepth() do
        waitWhilePaused()
        if cargoCheck() then return "home" end
        local dOk, dB = turtle.inspectDown()
        if dOk and Utils.isLava(dB.name) then
            print("[guard] LAVA below at Y=" .. (state.topY - state.depth) ..
                  " - sealed, mining from here")
            Utils.seal(turtle.placeDown)
            return "lava"
        end
        if dOk and dB.name:find("computercraft") then
            -- Another turtle in the shared lane (slower miner below,
            -- or a courier coming up): wait, then bypass sideways
            print("[descend] Turtle in the lane - waiting...")
            os.sleep(5)
            local still, sB = turtle.inspectDown()
            if still and sB.name:find("computercraft") and Nav.facing then
                print("[descend] Bypassing...")
                Nav.face(1)
                Utils.forward(state)
                for _ = 1, 3 do
                    if state.depth >= targetDepth() then break end
                    Utils.down(state)
                    state.depth = state.depth + 1
                    Utils.saveState(state)
                end
                Nav.face(3)
                Utils.forward(state)
            end
        elseif dOk and Utils.isProtected(dB.name) then
            print("[guard] Protected block below - stopping descent")
            return "home"
        else
            Utils.down(state)
            state.depth = state.depth + 1
            Utils.saveState(state)
            updateCheckpoint()
        end
    end
    if stopFlag then return "home" end
    return "target"
end

-- ============================================================
-- ROOM MINING (3-high, middle layer, stacked levels) - unchanged
-- mechanics, anchored at state.center
-- ============================================================
local DX = { [0] = 0, [1] = 1, [2] = 0, [3] = -1 }
local DZ = { [0] = 1, [1] = 0, [2] = -1, [3] = 0 }

local function faceDir(d)
    while state.room.facing ~= d do
        Nav.turnRight()
        state.room.facing = Nav.facing
    end
end

local levelMined = 0  -- blocks dug in the current level pass

local function clearVert(inspect, dig, place)
    local ok, b = inspect()
    if not ok then return false end
    if Utils.isLava(b.name) then
        Utils.seal(place)
        return false
    end
    if Utils.isProtected(b.name) then return false end
    Utils.record(state, b.name)
    dig()
    levelMined = levelMined + 1
    if Utils.isOre(b.name, b.tags) then noteOre(b.name); return true end
    return false
end

-- One serpentine step. `fast` = catch-up over already-cleared cells
-- (after a service trip / crash resume): just MOVE - no inspections,
-- no ceiling/floor digs, no vein sweeps. Position tracking and the
-- trail stay exact in both modes.
local function roomStep(fast)
    local sawOre = false
    if fast then
        if stopFlag then return "stop" end
        Utils.forward(state)  -- digs only if something refilled the cell
    else
        local turtleWait = 0
        while true do
            local ok, b = turtle.inspect()
            if ok and Utils.isLava(b.name) then
                Utils.seal(turtle.place)
                return "lava"
            end
            if ok and b.name:find("computercraft") then
                -- Another turtle transiting through our room (tunnels
                -- from the shared shaft cross zones): wait it out,
                -- NEVER dig it. Long standoffs get the gridlock jiggle.
                turtleWait = turtleWait + 1
                if turtleWait % 45 == 0 then Utils.jiggle("ahead") end
                os.sleep(1)
            elseif ok and Utils.isProtected(b.name) then
                return "blocked"
            elseif not turtle.detect() then
                break
            else
                if Utils.isOre(b.name, b.tags) then sawOre = true; noteOre(b.name) end
                Utils.record(state, b.name)
                turtle.dig()
                levelMined = levelMined + 1
                os.sleep(0.2)
            end
        end
        -- Move in (block already dug): mobs get swung at, long turtle
        -- blocks get the gridlock jiggle, and stop aborts the wait
        local moveTries = 0
        while not turtle.forward() do
            if stopFlag then return "stop" end
            turtle.attack()
            moveTries = moveTries + 1
            if moveTries % 100 == 0 then Utils.jiggle("ahead") end
            os.sleep(0.3)
        end
        Trail.record(tostring(Nav.facing))
    end
    state.room.px = state.room.px + DX[state.room.facing]
    state.room.pz = state.room.pz + DZ[state.room.facing]

    if not fast then
        if clearVert(turtle.inspectUp, turtle.digUp, turtle.placeUp) then sawOre = true end
        if clearVert(turtle.inspectDown, turtle.digDown, turtle.placeDown) then sawOre = true end
    end

    Utils.saveState(state)
    if sawOre then veinMine(VEIN_MAX_DEPTH) end
    return true
end

local function backToCenter()
    -- Utils.forward is guarded (waits on turtles, never digs them)
    -- and records the trail itself
    if state.room.px > 0 then faceDir(3) elseif state.room.px < 0 then faceDir(1) end
    for _ = 1, math.abs(state.room.px) do
        Utils.forward(state)
    end
    state.room.px = 0

    if state.room.pz > 0 then faceDir(2) elseif state.room.pz < 0 then faceDir(0) end
    for _ = 1, math.abs(state.room.pz) do
        Utils.forward(state)
    end
    state.room.pz = 0

    faceDir(0)
    Utils.saveState(state)
end

local function mineRoom()
    currentPhase = "mining"
    local n = ROOM_RINGS
    print("[room] Mining " .. (2 * n + 1) .. "x" .. (2 * n + 1) ..
          " room at Y=" .. (state.topY - state.depth) .. "...")

    -- Level progress: steps already completed before a service trip
    -- or crash get FAST-walked (move only), not re-mined
    state.room.step = state.room.step or 0
    local target = state.room.step
    local idx = 0
    if target > 0 then
        print("[room] Catching up " .. target .. " cleared steps (fast)...")
    end

    levelMined = 0

    local reason = nil
    local function abort()
        reason = roomAbortReason()
        return reason ~= nil
    end
    local function step()
        idx = idx + 1
        local r = roomStep(idx <= target)
        if r ~= true then reason = r; return false end
        if idx > target then
            state.room.step = idx  -- new frontier (persisted next save)
            -- Zero blocks after a fair sample? this level was already
            -- mined out (manual vein-mine / cavern): skip it entirely
            if idx - target == EMPTY_CHECK_STEPS and levelMined == 0 then
                reason = "empty"
                return false
            end
        end
        return true
    end

    clearVert(turtle.inspectUp, turtle.digUp, turtle.placeUp)
    clearVert(turtle.inspectDown, turtle.digDown, turtle.placeDown)

    faceDir(0)
    for _ = 1, n do
        waitWhilePaused()
        if abort() or not step() then backToCenter(); return reason end
    end
    faceDir(3)
    for _ = 1, n do
        waitWhilePaused()
        if abort() or not step() then backToCenter(); return reason end
    end

    local goingEast = true
    for row = 1, 2 * n + 1 do
        if row > 1 then
            faceDir(2)
            if abort() or not step() then backToCenter(); return reason end
        end
        faceDir(goingEast and 1 or 3)
        for _ = 1, 2 * n do
            waitWhilePaused()
            if abort() or not step() then backToCenter(); return reason end
        end
        goingEast = not goingEast
    end

    backToCenter()
    print("[room] Room complete")
    return "done"
end

local function descendLevel()
    currentPhase = "descend"
    state.room.step = 0  -- fresh level: no progress to catch up
    for _ = 1, LEVEL_STEP do
        local dOk, dB = turtle.inspectDown()
        -- A protected block (dungeon chest, spawner...) stops us; lava
        -- does NOT - Utils.down seals it with filler and drops through,
        -- so we keep descending toward MIN_Y past lava pockets
        if dOk and Utils.isProtected(dB.name) then
            print("[guard] Protected block below - cannot go deeper")
            return false
        end
        -- No filler left to seal the lava below? don't drop into it
        if dOk and Utils.isLava(dB.name) and Utils.fillerStacks() == 0 then
            print("[guard] LAVA below, no filler - stopping descent")
            return false
        end
        Utils.down(state)
        state.depth = state.depth + 1
        Utils.saveState(state)
    end
    return true
end

-- ============================================================
-- RELOCATE: this zone is mined out. Climb our center column to the
-- tunnel level, return to the shaft junction, mark the zone done,
-- acquire a FRESH zone and tunnel out to it - continuous expansion,
-- all at the Y=MINING_Y tunnel level (the entry shaft is untouched).
-- Returns true if a new zone was acquired and reached.
-- ============================================================
local function relocateToNewZone()
    currentPhase = "relocate"
    -- climb our own center column up to the tunnel level
    while state.depth > targetDepth() do
        Utils.up(state)
        state.depth = state.depth - 1
        Utils.saveState(state)
    end
    walkTo(state.shaft.x, state.shaft.z, "zx")  -- back to the hub

    -- atomic: mark this zone done AND get the next free one
    local oldSlot = state.slot
    local idx = acquireZone(state.slot)
    if idx == nil then
        -- no server: best-effort. negotiateSlot ranks among peers and
        -- our own just-vacated slot reads as free, so it can hand back
        -- the SAME exhausted zone -> tight re-mine loop. Force forward.
        idx = negotiateSlot()
        if idx == oldSlot then idx = oldSlot + 1 end
    end
    if idx == nil then return false end
    setZone(idx)

    currentPhase = "tunnel"
    if not walkTo(state.center.x, state.center.z, "xz") then
        return false  -- lava wall to the new zone
    end
    state.room = { px = 0, pz = 0, facing = Nav.facing }
    state.room.step = 0
    Utils.saveState(state)
    return true
end

-- ============================================================
-- SERVICE TRIP: rooms have no open column above, so couriers and
-- fuelers meet us at OUR SHAFT. Climb the center column (open from
-- stacked levels), retrace the tunnel, run fn, come back.
-- A crash mid-trip is recovered by the mining-resume re-center
-- (mission() re-establishes the zone center via GPS before resuming).
-- ============================================================
local function serviceTrip(fn)
    currentPhase = "to_shaft"
    local climb = state.depth - targetDepth()
    for _ = 1, climb do Utils.up(state) end
    walkTo(state.shaft.x, state.shaft.z, "zx")

    -- Hold the shaft during the transfer: the courier/fueler descends
    -- the column to reach us, so nobody else may use it meanwhile.
    -- A stop while queueing skips the transfer (we head home anyway).
    local ok = false
    if Lane.enter(state.shaft.x, state.shaft.z, "service",
                  function() return stopFlag end) then
        ok = fn()
        Lane.exit()
    end

    currentPhase = "to_zone"
    walkTo(state.center.x, state.center.z, "xz")
    for _ = 1, climb do Utils.down(state) end
    return ok
end

-- ============================================================
-- RETURN HOME: room -> center column up -> tunnel -> shaft up ->
-- cruise flight home. GPS-based, no path recording needed.
-- ============================================================
local function goHome()
    currentPhase = "return"
    backToCenter()
    Utils.purgeJunk()  -- junk stays IN the mine, not at the base

    -- Climb the center column to tunnel level
    while state.depth > targetDepth() do
        Utils.up(state)
        state.depth = state.depth - 1
        Utils.saveState(state)
    end

    -- Retrace the tunnel to the shaft bottom and climb out through
    -- the SAME single column (the lane lock serializes traffic)
    walkTo(state.shaft.x, state.shaft.z, "zx")
    -- Join the up-convoy (grandfathered if resuming mid-climb: see
    -- the descend branch for the deadlock rationale)
    if not state.inShaft then
        Lane.enter(state.shaft.x, state.shaft.z, "up")
        state.inShaft = true
        Utils.saveState(state)
    end
    print("[return] Climbing the shaft...")
    while state.depth > 0 do
        Utils.up(state)
        state.depth = state.depth - 1
        Utils.saveState(state)
        updateCheckpoint()
    end
    Lane.exit()  -- clear of the column at the surface
    state.inShaft = false
    Utils.saveState(state)

    -- At the surface: learn facing only if it is actually unknown
    ensureOriented()

    print("[return] Flying home...")
    Nav.goTo(home)

    -- Verify arrival. If the flight missed, retry once; still lost ->
    -- nuclear option: replay the whole trail backwards (it ends at
    -- home by construction, no GPS/facing trust needed).
    local function awayFromHome()
        local x, y, z = gps.locate(2)
        return x and (math.abs(x - home.x) + math.abs(y - home.y)
                    + math.abs(z - home.z)) > 2
    end
    if awayFromHome() then
        print("[return] Not at home - retrying flight...")
        pcall(Nav.orient)
        Nav.goTo(home)
        if awayFromHome() then
            print("[return] Still lost - backtracking the full trail...")
            pcall(Nav.orient)
            Trail.backtrack(Nav)
        end
    end
    print("[return] Home. Mission complete.")
end

-- ============================================================
-- MISSION
-- ============================================================
local function mission()
    local saved = Utils.loadState()
    local bootPhase = saved and saved.phase  -- phase we BOOTED in
    if saved then
        state = saved
        print("[resume] phase=" .. state.phase .. " depth=" .. (state.depth or 0))
        -- Re-learn facing from GPS: the persisted value goes stale if
        -- we rebooted during a flight/tunnel (turns there aren't saved)
        -- and trusting it sends navigation off in a wrong direction.
        -- Enclosed (mid-shaft)? fine: vertical phases don't need facing
        -- and the tunnel step re-orients later.
        if pcall(Nav.orient) then
            state.room.facing = Nav.facing
        end
    end

    if not state.site then
        print("[error] No dig site in state. Reboot and wait for one.")
        return
    end

    -- HEAL legacy fractional coordinates (old pockets broadcast the
    -- player's float position): integer-walking turtles oscillate
    -- around a fractional target forever
    local function floorPos(p)
        if not p then return end
        p.x = math.floor(p.x)
        if p.y then p.y = math.floor(p.y) end
        p.z = math.floor(p.z)
    end
    floorPos(state.site)
    floorPos(state.shaft)
    floorPos(state.center)

    -- First boot at this site: remember home and negotiate a slot
    if not home then
        home = Nav.locate()
        Utils.writeJSON(HOME_FILE, home)
        print("[init] Home saved: " .. home.x .. "," .. home.y .. "," .. home.z)
    end
    if not state.slot then
        -- fresh: ask the server, else decentralized fallback
        setZone(acquireZone() or negotiateSlot())
    end
    -- (resume keeps its saved slot; the server resumes the same claim
    -- if still held. A >30min crash can free it and let another miner
    -- take the zone - a rare, non-destructive overlap that the
    -- empty-skip + jiggle resolve on their own.)

    if state.phase == "goto" then
        currentPhase = "goto"
        -- Leftover cargo from an aborted run (emergency home, failed
        -- unload)? hand it over BEFORE flying out with a dirty inventory
        if Utils.hasCargo() then
            print("[goto] Carrying leftovers - unloading first...")
            unloadToCourier(10)
        end
        Trail.clear()  -- at home: the journal starts fresh this mission
        ensureOriented()
        print("[goto] Flying to shaft slot at " .. state.shaft.x .. "," .. state.shaft.z)
        Nav.goTo({ x = state.shaft.x, y = state.site.y, z = state.shaft.z })

        -- Settle onto the actual TERRAIN: the pocket's Y may be above
        -- the ground at this XZ. The shaft starts where the ground is,
        -- and we only mine from there DOWN.
        while true do
            local ok, b = turtle.inspectDown()
            if ok then
                if b.name:find("computercraft") then
                    -- A queued miner below us is NOT the ground: wait
                    -- for it to take the lane and free the spot
                    os.sleep(2)
                elseif Utils.isWater(b.name) or Utils.isLava(b.name) then
                    if Utils.isLava(b.name) then Utils.seal(turtle.placeDown) end
                    break
                else
                    break  -- solid ground reached
                end
            else
                while not turtle.down() do os.sleep(0.3) end
                Trail.record("D")
            end
        end

        local _, gy, _ = gps.locate(2)
        state.topY  = gy or state.site.y
        state.depth = 0
        state.phase = "descend"
        Utils.saveState(state)
        print("[goto] Shaft starts at Y=" .. state.topY)
    end

    if state.phase == "descend" then
        -- Join the down-convoy. GRANDFATHERED on resume: if we are
        -- already inside the column (crash/update mid-shaft), asking
        -- for the lane could deadlock against an opposite flow that we
        -- physically block - proceed instead, bypasses handle meetings.
        local why
        if not state.inShaft then
            if Lane.enter(state.shaft.x, state.shaft.z, "down",
                          function() return stopFlag end) then
                state.inShaft = true
                Utils.saveState(state)
            else
                why = "home"  -- stop arrived while queueing at the entry
            end
        end
        if not why then
            why = descend()
            Lane.exit()  -- at the bottom junction: column is free again
            state.inShaft = false
        end
        if not stopFlag and (why == "target" or why == "lava")
           and not fuelLow() and not Utils.invFull() then
            -- Tunnel to my zone (re-orient only if facing is unknown)
            currentPhase = "tunnel"
            ensureOriented()
            state.room.facing = Nav.facing
            if walkTo(state.center.x, state.center.z, "xz") then
                state.phase = "mining"
            else
                state.phase = "return"  -- lava wall in the tunnel
            end
        else
            state.phase = "return"
        end
        Utils.saveState(state)
    end

    -- RESUME into mining: an ungraceful crash (chunk unload while the
    -- player wandered off, server kill) can leave us mid-serpentine or
    -- mid-service-trip - NOT at the center mineRoom assumes. Re-establish
    -- the exact center via GPS before the dead-reckoning room logic runs.
    -- (Graceful update reboots already happen at center -> this no-ops.)
    if bootPhase == "mining" then
        print("[resume] Re-centering in the zone...")
        ensureOriented()
        walkTo(state.center.x, state.center.z, "xz")  -- center column, current Y
        local _, cy = gps.locate(2)
        local roomY = (state.topY or MINING_Y) - state.depth
        if cy then
            for _ = 1, cy - roomY do Utils.down(state) end  -- down the open column
            for _ = 1, roomY - cy do Utils.up(state) end    -- defensive
        end
        state.room.px, state.room.pz = 0, 0
        state.room.facing = Nav.facing
        faceDir(0)
        Utils.saveState(state)
    end

    while state.phase == "mining" do
        local result = mineRoom()  -- always ends at the zone center
        if result == "update" then
            updateCheckpoint()
        elseif result == "done" or result == "lava" or result == "empty" then
            if result == "lava" then
                print("[room] Lava sealed at this level - trying the next one")
            elseif result == "empty" then
                print("[room] Level already mined out - skipping down")
            end
            local nextY = state.topY - state.depth - LEVEL_STEP
            if not stopFlag and nextY >= MIN_Y and descendLevel() then
                print("[room] Next level: Y=" .. (state.topY - state.depth))
            elseif not stopFlag and relocateToNewZone() then
                -- zone exhausted -> moved to a fresh one, keep mining
                print("[room] Zone done - relocated to a fresh zone")
            else
                print("[room] No more zones (or stop) - heading home")
                state.phase = "return"
            end
        elseif result == "stop" or result == "blocked" then
            state.phase = "return"
        elseif result == "fuel" then
            lastFuelTry = os.clock()
            local ok = serviceTrip(requestFuel)
            if not ok or fuelLow() then
                state.phase = "return"
            end
        elseif result == "transfer" or result == "full" then
            lastCourierTry = os.clock()
            local ok = serviceTrip(requestCourier)
            if not ok and Utils.invFull() then
                state.phase = "return"
            end
        end
        Utils.saveState(state)
    end

    if state.phase == "return" then
        goHome()
    end

    -- Unload at home: a courier collects everything non-burnable
    -- (fuel items are the miner's own reserve and never leave it).
    -- Persistent ~10 min: several miners finishing together queue
    -- for the courier one multi-minute trip at a time.
    if Utils.hasCargo() then
        unloadToCourier(30)
    end

    print("--- Mined blocks ---")
    if state.mined and next(state.mined) then
        for name, count in pairs(state.mined) do
            print("  " .. name .. ": " .. count)
        end
    else
        print("  None")
    end

    -- Clean slate; reboot into startup to wait for the next site
    Trail.clear()  -- verified home: journal no longer needed
    Utils.clearState()
    print("[done] Rebooting to wait for the next dig site...")
    os.sleep(2)
    os.reboot()
end

-- ============================================================
-- MAIN
-- ============================================================
local modemSide = Utils.openModem()
-- Fresh mission: demand a real reserve (a mission burns far more than
-- 100). Resume: just enough to move - the in-mission rescue covers it.
local boot = Utils.loadState()
Fuel.ensure((boot and boot.phase ~= "goto") and 200 or 1000, false)
print("[init] Modem: " .. modemSide .. " | Fuel: " .. turtle.getFuelLevel())
parallel.waitForAny(mission, listener, statusLoop, siteListener,
                    Lane.listener, laneBeats)
rednet.close(modemSide)
