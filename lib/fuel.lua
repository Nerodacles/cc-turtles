-- lib/fuel.lua
-- Fuel management for all turtles: inventory burning, chest pulls,
-- blocking ensures, and remote fuel deliveries via swarm_fuel.

local Swarm = require("swarm")

local Fuel = {}

Fuel.PROTO = "swarm_fuel"

-- Current level as a number (unlimited -> huge)
function Fuel.level()
    local l = turtle.getFuelLevel()
    if l == "unlimited" then return math.huge end
    return l
end

-- First slot containing a burnable item, or nil
function Fuel.findSlot()
    local prev = turtle.getSelectedSlot()
    for s = 1, 16 do
        if turtle.getItemCount(s) > 0 then
            turtle.select(s)
            if turtle.refuel(0) then
                turtle.select(prev)
                return s
            end
        end
    end
    turtle.select(prev)
    return nil
end

-- Burn inventory items until level >= target. Burns one item to
-- measure its yield, then the exact remainder in a single call
-- (instead of one refuel(1) round-trip per item). Returns true if reached.
function Fuel.refuel(target)
    if Fuel.level() >= target then return true end
    local prev = turtle.getSelectedSlot()
    for s = 1, 16 do
        if Fuel.level() >= target then break end
        if turtle.getItemCount(s) > 0 then
            turtle.select(s)
            if turtle.refuel(0) then
                local before = Fuel.level()
                turtle.refuel(1)
                local gain = Fuel.level() - before
                if gain > 0 and Fuel.level() < target then
                    local need = math.ceil((target - Fuel.level()) / gain)
                    turtle.refuel(math.min(need, turtle.getItemCount(s)))
                end
            end
        end
    end
    turtle.select(prev)
    return Fuel.level() >= target
end

-- Inventory first, then pull stacks from the chest below. Non-blocking.
-- Pulls into an EMPTY slot: sucking into a fixed occupied slot lands
-- items elsewhere, fails the burn, and ejects the slot's own item.
function Fuel.refuelFromChest(target)
    if Fuel.refuel(target) then return true end
    local prev = turtle.getSelectedSlot()
    while Fuel.level() < target do
        local free = nil
        for s = 1, 16 do
            if turtle.getItemCount(s) == 0 then free = s; break end
        end
        if not free then break end       -- no room to pull into
        turtle.select(free)
        if not turtle.suckDown(16) then break end  -- chest empty
        if not turtle.refuel(64) then
            turtle.dropDown()  -- not burnable, give it back
        end
    end
    turtle.select(prev)
    return Fuel.level() >= target
end

-- Block until level >= min. Tries the inventory (and the chest below
-- when allowed), then CALLS A FUELER: a stranded turtle (even at fuel
-- 0) cannot move, but a fueler can fly to it and drop fuel on it.
-- Falls back to asking the player while it waits.
function Fuel.ensure(min, useChestBelow)
    if Fuel.level() >= min then return end
    print("[fuel] Low fuel (" .. turtle.getFuelLevel() .. "), refueling...")
    local lastDelivery = -math.huge
    while Fuel.level() < min do
        local ok
        if useChestBelow then
            ok = Fuel.refuelFromChest(min)
        else
            ok = Fuel.refuel(min)
        end
        if not ok then
            -- Nothing burnable aboard: request a fueler (every 60s)
            if os.clock() - lastDelivery >= 60 then
                lastDelivery = os.clock()
                Fuel.requestDelivery(min)
            end
            if Fuel.level() < min then
                print("[fuel] NEED FUEL: add coal" ..
                      (useChestBelow and " (inventory/chest below)" or "") ..
                      " or waiting for a fueler...")
                os.sleep(5)
            end
        end
    end
    print("[fuel] Fuel OK: " .. turtle.getFuelLevel())
end

-- Called from movement retry loops: a turtle whose moves fail with an
-- EMPTY tank is stranded mid-mission. Burn inventory or call a fueler
-- (waiting costs no fuel). 60s cooldown between attempts.
local lastRescue = -math.huge
function Fuel.rescueIfStranded()
    local l = turtle.getFuelLevel()
    if l ~= "unlimited" and l == 0 and os.clock() - lastRescue >= 60 then
        lastRescue = os.clock()
        print("[fuel] STRANDED at 0 fuel - calling for help")
        if not Fuel.refuel(500) then
            Fuel.requestDelivery(500)
        end
    end
end

-- Ask a fueler turtle to fly over and drop fuel on us, then burn it
-- up to `target`. Requires GPS. Optional abortFn cancels the wait.
function Fuel.requestDelivery(target, abortFn)
    local x, y, z = gps.locate(2)
    if not x then
        print("[fuel] No GPS signal - cannot call a fueler")
        return false
    end

    return Swarm.requestService(Fuel.PROTO, { x = x, y = y, z = z }, {
        readyType = "delivered",
        abortFn   = abortFn,
        onReady   = function()
            os.sleep(1)  -- let the dropped items settle into inventory
            Fuel.refuel(target)
            print("[fuel] Refueled to " .. turtle.getFuelLevel())
        end,
    })
end

return Fuel
