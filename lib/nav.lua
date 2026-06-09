-- lib/nav.lua
-- GPS navigation for service turtles (courier, fueler).
-- NO-DIG: service turtles carry no tool, so they never break blocks.
-- They cruise above the terrain and descend through open air columns
-- (e.g. the miner's shaft).

local Trail = require("trail")
local Fuel  = require("fuel")

local Nav = {}

Nav.giveUp = false  -- service turtles set true: error out instead of
                    -- waiting forever when a path can't be cleared

Nav.facing = nil  -- 0=+z  1=+x  2=-z  3=-x
Nav.digFns = nil  -- miners set {fwd=,up=,down=} guarded dig fns;
                  -- service turtles leave nil (never dig)

-- Two consecutive fixes must AGREE: a host with bad coordinates makes
-- single fixes jitter, and jittery positions make per-step navigation
-- oscillate (walk forward, walk back, turn... in circles).
function Nav.locate()
    local last = nil
    for _ = 1, 5 do
        local x, y, z = gps.locate(2)
        if x then
            if last and last.x == x and last.y == y and last.z == z then
                return last
            end
            last = { x = x, y = y, z = z }
        end
    end
    if not last then error("GPS signal required") end
    return last
end

function Nav.manhattan(a, b)
    return math.abs(a.x - b.x) + math.abs(a.y - b.y) + math.abs(a.z - b.z)
end

function Nav.turnRight()
    turtle.turnRight()
    -- Right turn in Minecraft: N->E->S->W, i.e. -z -> +x -> +z -> -x.
    -- In our encoding (0=+z, 1=+x, 2=-z, 3=-x) that's 2->1->0->3:
    -- facing DECREASES. (+1 here tracked rotation backwards and made
    -- GPS navigation walk correct distances in wrong directions.)
    Nav.facing = (Nav.facing + 3) % 4
end

function Nav.face(d)
    if Nav.facing == nil then
        error("nav: facing unknown - call Nav.orient() first", 0)
    end
    while Nav.facing ~= d do Nav.turnRight() end
end

-- Move forward once comparing GPS positions to learn our facing.
-- Needs at least one open horizontal side (no digging).
function Nav.orient()
    if turtle.getFuelLevel() ~= "unlimited" and turtle.getFuelLevel() < 2 then
        error("No fuel - cannot orient. Refuel me first!")
    end
    local p1 = Nav.locate()
    for _ = 1, 4 do
        -- Skip a direction that opens into lava (detect() is false on
        -- fluids, so a naive forward would walk into it and die)
        local lok, lb = turtle.inspect()
        local lava = lok and lb.name == "minecraft:lava"
        if not lava then
            if turtle.detect() and Nav.digFns then Nav.digFns.fwd() end
            if turtle.forward() then
                local p2 = Nav.locate()
                local dx, dz = p2.x - p1.x, p2.z - p1.z
                local dir = (dx == 1 and 1) or (dx == -1 and 3)
                         or (dz == 1 and 0) or (dz == -1 and 2)
                if dir then Trail.record(tostring(dir)) end
                while not turtle.back() do os.sleep(0.2) end
                if dir then
                    Trail.record(tostring((dir + 2) % 4))  -- net zero on replay
                    Nav.facing = dir
                    return dir
                end
            end
        end
        turtle.turnRight()
    end
    error("Could not determine facing (blocked on all sides?)")
end

-- ============================================================
-- NO-DIG MOVEMENT: retry until the path clears (mob walks away,
-- gravel settles...). Warns periodically while blocked.
-- ============================================================
local ATTACK  = { fwd = turtle.attack,   up = turtle.attackUp,   down = turtle.attackDown }
local INSPECT = { fwd = turtle.inspect,  up = turtle.inspectUp,  down = turtle.inspectDown }
local PLACE   = { fwd = turtle.place,    up = turtle.placeUp,    down = turtle.placeDown }

-- Miners set Nav.sealFn = Utils.seal so flights can convert lava to a
-- filler block and cross it. Service turtles (no filler) leave it nil
-- and wait/abort at lava instead.
Nav.sealFn = nil

-- Is the cell in this direction lava? (service turtles can't seal it,
-- so they must never move into it; detect() is false on fluids)
local function lavaAt(digKey)
    local ok, b = INSPECT[digKey]()
    return ok and b.name == "minecraft:lava"
end

-- One iteration of being stuck: swing at entities, rescue an empty
-- tank, warn periodically, give up if configured. Shared by persist
-- (dig-through movement) and hopStep (hop-over flight).
local function stuckTick(digKey, tries, label)
    ATTACK[digKey]()         -- entity in the way? (harmless without tool)
    Fuel.rescueIfStranded()  -- empty tank? call a fueler from here
    if Nav.giveUp and tries > 300 then  -- ~2 min hard-blocked
        error("nav: blocked (" .. label .. ") too long", 0)
    end
    if tries % 50 == 0 then
        print("[nav] Blocked (" .. label .. ") for " ..
              math.floor(tries * 0.4) .. "s, still retrying...")
    end
    os.sleep(0.4)
end

local function persist(move, digKey, label)
    local tries = 0
    while true do
        -- Lava ahead: miners (sealFn set) convert it to filler and
        -- cross; service turtles (no filler) wait it out or give up so
        -- the trip aborts instead of the turtle dying in the lava.
        if lavaAt(digKey) then
            if Nav.sealFn and Nav.sealFn(PLACE[digKey]) then
                -- sealed -> now a solid filler block; the dig path
                -- below clears it on the next iteration
            else
                tries = tries + 1
                if tries % 25 == 0 then
                    print("[nav] LAVA " .. label .. " - cannot enter")
                end
                if Nav.giveUp and tries > 150 then
                    error("nav: lava (" .. label .. ")", 0)
                end
                os.sleep(0.4)
            end
        else
            if Nav.digFns and Nav.digFns[digKey] then Nav.digFns[digKey]() end
            if move() then return end
            tries = tries + 1
            stuckTick(digKey, tries, label)
        end
    end
end

function Nav.fwd()
    persist(turtle.forward, "fwd", "forward")
    if Nav.facing then Trail.record(tostring(Nav.facing)) end
end

function Nav.up()
    persist(turtle.up, "up", "up")
    Trail.record("U")
end

function Nav.down()
    persist(turtle.down, "down", "down")
    Trail.record("D")
end

-- One horizontal flight step that prefers NOT digging: if a block is
-- ahead, hop OVER it (climb 1) instead of tunneling through. Ends only
-- as high as the tallest obstacle on the way.
-- Returns the number of upward hops taken (so goTo can dead-reckon the
-- final descent without a second GPS locate).
local function hopStep()
    local hops = 0
    local tries = 0
    while not turtle.forward() do
        if turtle.detect() or lavaAt("fwd") then
            -- solid obstacle OR lava ahead (detect() is false on lava):
            -- hop OVER it rather than digging/entering
            Nav.up()
            hops = hops + 1
        else
            tries = tries + 1
            stuckTick("fwd", tries, "hop")
        end
    end
    if Nav.facing then Trail.record(tostring(Nav.facing)) end
    return hops
end

-- Terrain-hugging navigation: fly straight at the target's height,
-- hopping over obstacles as needed (no fixed cruise altitude), then
-- descend onto the target through its air column.
-- Dead-reckons final altitude from hop count: eliminates the second
-- GPS locate that was only needed to measure accumulated hop altitude.
function Nav.goTo(t)
    local cur = Nav.locate()
    local extraY = 0  -- net upward displacement from obstacle hops

    -- climb only if the target is higher than we are
    for _ = 1, math.max(0, t.y - cur.y) do Nav.up() end

    local dx = t.x - cur.x
    if dx > 0 then Nav.face(1) elseif dx < 0 then Nav.face(3) end
    for _ = 1, math.abs(dx) do extraY = extraY + hopStep() end

    local dz = t.z - cur.z
    if dz > 0 then Nav.face(0) elseif dz < 0 then Nav.face(2) end
    for _ = 1, math.abs(dz) do extraY = extraY + hopStep() end

    -- drop whatever altitude the hops accumulated, plus any initial
    -- altitude surplus (cur.y > t.y: target was lower than start).
    -- Together these bring the final Y exactly to t.y.
    local totalDescent = extraY + math.max(0, cur.y - t.y)
    for _ = 1, totalDescent do Nav.down() end
end

return Nav
