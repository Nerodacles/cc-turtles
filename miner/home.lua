-- miner/home.lua  (installed as /home.lua)
-- EMERGENCY: force this miner STRAIGHT home, abandoning the mission.
-- Usage on the turtle: hold Ctrl+T to kill the running program, then:
--   home
-- It bores straight up to surface height if needed, flies home,
-- falls back to the trail if the flight fails, and wipes the mission
-- state so the next boot waits for a fresh 'start'.

package.path = package.path .. ";/lib/?.lua"
local Utils = require("utils")
local Nav   = require("nav")
local Fuel  = require("fuel")
local Trail = require("trail")

local home = Utils.readJSON("/home.json")
if not home then
    print("[home] No home.json - this turtle never saved a home.")
    print("[home] Place it where it should live and run a mission first.")
    return
end

Utils.openModem()        -- the 0-fuel rescue broadcasts via rednet
Fuel.ensure(100, false)  -- cannot fly on an empty tank

-- Guarded digs for the flight (same rules as missions: never
-- protected blocks, never lava, never other turtles)
Nav.digFns = {
    fwd = function()
        local ok, b = turtle.inspect()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            turtle.dig()
        end
    end,
    up = function()
        local ok, b = turtle.inspectUp()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            turtle.digUp()
        end
    end,
    down = function()
        local ok, b = turtle.inspectDown()
        if ok and not Utils.isProtected(b.name) and not Utils.isLava(b.name) then
            turtle.digDown()
        end
    end,
}

print("[home] FORCED RETURN to " .. home.x .. "," .. home.y .. "," .. home.z)

-- Learn facing (patiently: neighbors may box us in for a moment)
while not pcall(Nav.orient) do
    print("[home] Cannot orient (boxed in?) - retrying...")
    os.sleep(2 + math.random() * 4)
end

local flew = pcall(Nav.goTo, home)

local function awayFromHome()
    local x, y, z = gps.locate(2)
    return x and (math.abs(x - home.x) + math.abs(y - home.y)
                + math.abs(z - home.z)) > 2
end

if (not flew or awayFromHome()) and Trail.size() > 0 then
    print("[home] Direct flight failed - backtracking the trail...")
    pcall(Nav.orient)
    Trail.backtrack(Nav)
end

-- Abandon the mission: clean slate so the next boot waits for 'start'
Utils.clearState()
Trail.clear()
print("[home] Done. Run 'reboot' to wait for the next mission.")
