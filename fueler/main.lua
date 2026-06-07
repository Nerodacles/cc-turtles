-- fueler/main.lua
-- Fueler Turtle: idles on top of a chest FULL OF FUEL, answers fuel
-- requests, flies to the requester and drops fuel into it from above.
-- No pickaxe: never digs. REQUIRES a GPS cluster.

package.path = package.path .. ";/lib/?.lua"
local Nav     = require("nav")
local Fuel    = require("fuel")
local Swarm   = require("swarm")
local Service = require("service")

-- ============================================================
-- CONFIG
-- ============================================================
local SAFETY        = 20
local DELIVERY_FUEL = 2000  -- fuel VALUE to carry per delivery

local PROTO_FUEL = "swarm_fuel"

-- ============================================================
-- FUEL CARGO (measured in fuel VALUE, not slots: a coal block is
-- worth 10 pieces of coal)
-- ============================================================
local FUEL_VALUE = {
    ["minecraft:coal"]             = 80,
    ["minecraft:charcoal"]         = 80,
    ["minecraft:coal_block"]       = 800,
    ["minecraft:blaze_rod"]        = 120,
    ["minecraft:lava_bucket"]      = 1000,
    ["minecraft:dried_kelp_block"] = 200,
    ["minecraft:stick"]            = 5,
}

-- Worth of all burnable cargo aboard, in fuel units
local function cargoValue()
    local prev = turtle.getSelectedSlot()
    local v = 0
    for s = 1, 16 do
        local d = turtle.getItemDetail(s)
        if d then
            turtle.select(s)
            if turtle.refuel(0) then
                v = v + (FUEL_VALUE[d.name] or 80) * d.count
            end
        end
    end
    turtle.select(prev)
    return v
end

-- Pull from the chest below until the cargo is WORTH >= target fuel
-- (so the machines we serve can actually keep working)
local function loadFuel(target)
    while cargoValue() < target do
        local free = nil
        for s = 1, 16 do
            if turtle.getItemCount(s) == 0 then free = s; break end
        end
        if not free then break end       -- no room left
        turtle.select(free)
        if not turtle.suckDown(64) then  -- chest empty
            turtle.select(1)
            break
        end
    end
    turtle.select(1)
    return cargoValue()
end

-- Drop every burnable item into the turtle below us
local function dropFuelDown()
    local prev = turtle.getSelectedSlot()
    for s = 1, 16 do
        if turtle.getItemCount(s) > 0 then
            turtle.select(s)
            if turtle.refuel(0) then  -- only burnables
                turtle.dropDown()
            end
        end
    end
    turtle.select(prev)
end

-- ============================================================
-- DELIVERY
-- ============================================================
local function runDelivery(clientId, pos)
    Service.phase = "delivering"
    print("[job] Flying fuel to #" .. clientId ..
          " at " .. pos.x .. "," .. pos.y .. "," .. pos.z)

    -- Nav.giveUp aborts after ~2 min hard-blocked (unreachable client)
    local ok = pcall(Nav.goTo, { x = pos.x, y = pos.y + 1, z = pos.z })
    if ok then
        Swarm.to(clientId, { type = "arrived" }, PROTO_FUEL)
        dropFuelDown()
        Swarm.to(clientId, { type = "delivered" }, PROTO_FUEL)
        print("[job] Fuel delivered")
    else
        print("[job] Could not reach the client - returning home")
    end

    Service.returnHome()
    print("[job] Back home. Idle.")
end

-- Offer only with fuel for the round trip AND cargo worth delivering.
-- If the chest can't fill DELIVERY_FUEL worth, deliver what there is.
local function canServe(reqPos)
    local cur  = Nav.locate()
    local cost = Nav.manhattan(cur, reqPos) * 2 + SAFETY
    Fuel.refuelFromChest(cost)
    local cargo = loadFuel(DELIVERY_FUEL)
    if turtle.getFuelLevel() >= cost and cargo > 0 then
        print("[job] Offering (cargo worth " .. cargo .. " fuel)")
        return cur
    end
    print("[job] Cannot serve (fuel " .. turtle.getFuelLevel() ..
          "/" .. cost .. ", cargo worth " .. cargo .. ")")
    return nil
end

local function mainLoop()
    Service.phase = "idle"
    Swarm.serve(PROTO_FUEL, canServe, runDelivery)
end

-- ============================================================
-- MAIN
-- ============================================================
local modemSide = Service.init({ role = "fueler" })
print("[init] Fueler ready, waiting for fuel requests...")

parallel.waitForAny(mainLoop, Service.statusLoop, Service.cmdListener)
rednet.close(modemSide)
