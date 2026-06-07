-- courier/main.lua
-- Courier (chest) Turtle: idles on top of a chest at home, answers
-- pickup requests, flies to the miner, receives its inventory from
-- above, returns home and deposits into the chest below.
-- No pickaxe: never digs. REQUIRES a GPS cluster.

package.path = package.path .. ";/lib/?.lua"
local Utils   = require("utils")
local Nav     = require("nav")
local Fuel    = require("fuel")
local Swarm   = require("swarm")
local Service = require("service")

-- ============================================================
-- CONFIG
-- ============================================================
local SAFETY              = 20
local LOW_FUEL            = 500   -- request a fuel delivery below this
local FUEL_CHECK_INTERVAL = 60

local PROTO_COURIER = "swarm_courier"

local refueling = false  -- a fueler is on its way: don't fly off

-- Everything into the chest below home (keep our fuel)
local function deposit()
    Utils.dropAll(turtle.dropDown, Fuel.findSlot())
end

-- When idle at home with low fuel, request a fueler delivery
local function fuelWatch()
    while true do
        os.sleep(FUEL_CHECK_INTERVAL)
        if Service.phase == "idle" and not refueling
           and Fuel.level() < LOW_FUEL then
            if not Fuel.refuel(LOW_FUEL) then
                refueling = true
                Fuel.requestDelivery(LOW_FUEL * 2)
                refueling = false
            end
        end
    end
end

-- ============================================================
-- DELIVERY: full pickup round trip for one assigned miner
-- ============================================================
local function runDelivery(minerId, pos)
    Service.phase = "delivering"
    print("[job] Flying to miner #" .. minerId ..
          " at " .. pos.x .. "," .. pos.y .. "," .. pos.z)

    -- Hover directly above the miner so it can dropUp into us.
    -- Nav.giveUp aborts after ~2 min hard-blocked (unreachable miner)
    local ok = pcall(Nav.goTo, { x = pos.x, y = pos.y + 1, z = pos.z })
    if ok then
        Swarm.to(minerId, { type = "arrived" }, PROTO_COURIER)

        -- Wait for the miner to finish transferring (max 2 min)
        local deadline = os.clock() + 120
        while os.clock() < deadline do
            local id, msg = rednet.receive(PROTO_COURIER, 1)
            if id == minerId and Swarm.ok(msg) and msg.type == "done" then
                break
            end
        end
    else
        print("[job] Could not reach the miner - returning home")
    end

    print("[job] Returning home...")
    Service.returnHome(deposit)
    print("[job] Cargo deposited. Idle.")
end

-- Offer only when idle with fuel for the round trip
local function canServe(reqPos)
    if refueling then return nil end
    local cur  = Nav.locate()
    local cost = Nav.manhattan(cur, reqPos) * 2 + SAFETY
    Fuel.refuel(cost)
    if turtle.getFuelLevel() >= cost then return cur end
    print("[job] Not enough fuel for request (need " .. cost .. ")")
    return nil
end

local function mainLoop()
    Service.phase = "idle"
    Swarm.serve(PROTO_COURIER, canServe, runDelivery)
end

-- ============================================================
-- MAIN
-- ============================================================
local modemSide = Service.init({ role = "courier", onArriveHome = deposit })
print("[init] Courier ready, waiting for pickup requests...")

parallel.waitForAny(mainLoop, Service.statusLoop, Service.cmdListener, fuelWatch)
rednet.close(modemSide)
