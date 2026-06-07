-- lib/utils.lua
-- Shared utilities for all turtles

local Nav   = require("nav")
local Trail = require("trail")
local Fuel  = require("fuel")

local Utils = {}

Utils.STATE_FILE    = "/state.json"
Utils.SAFETY_MARGIN = 10

-- ============================================================
-- PERSISTENCE (serialized-table files)
-- ============================================================
function Utils.readJSON(path)
    if not fs.exists(path) then return nil end
    local f = fs.open(path, "r")
    local data = textutils.unserialize(f.readAll())
    f.close()
    return data
end

function Utils.writeJSON(path, data)
    local f = fs.open(path, "w")
    f.write(textutils.serialize(data))
    f.close()
end

function Utils.saveState(state)
    Utils.writeJSON(Utils.STATE_FILE, state)
end

function Utils.loadState()
    return Utils.readJSON(Utils.STATE_FILE)
end

function Utils.clearState()
    if fs.exists(Utils.STATE_FILE) then
        fs.delete(Utils.STATE_FILE)
    end
end

-- ============================================================
-- MINED BLOCK TRACKING
-- ============================================================
function Utils.record(state, name)
    if not state then return end
    if not state.mined then state.mined = {} end
    state.mined[name] = (state.mined[name] or 0) + 1
end

-- Valuable ores. Tag-based first (c:ores is the Fabric convention,
-- forge:ores for Forge packs - catches MODDED ores too), then name
-- patterns as fallback.
function Utils.isOre(name, tags)
    if tags and (tags["c:ores"] or tags["forge:ores"]) then return true end
    return name:find("_ore") ~= nil or name == "minecraft:ancient_debris"
end

-- ============================================================
-- FLUIDS: lava destroys turtles; detect() returns FALSE on fluids
-- so movement code must inspect explicitly before entering.
-- ============================================================
function Utils.isLava(name)
    return name == "minecraft:lava"
end

function Utils.isWater(name)
    return name == "minecraft:water"
end

-- Throwaway solid blocks we can sacrifice to seal lava
local FILLER = {
    ["minecraft:cobblestone"]        = true,
    ["minecraft:cobbled_deepslate"]  = true,
    ["minecraft:stone"]              = true,
    ["minecraft:deepslate"]          = true,
    ["minecraft:dirt"]               = true,
    ["minecraft:granite"]            = true,
    ["minecraft:diorite"]            = true,
    ["minecraft:andesite"]           = true,
    ["minecraft:tuff"]               = true,
    ["minecraft:netherrack"]         = true,
}

function Utils.findFillerSlot()
    for s = 1, 16 do
        local d = turtle.getItemDetail(s)
        if d and FILLER[d.name] then return s end
    end
    return nil
end

-- Seal a lava space with a filler block (placeFn: turtle.place /
-- placeUp / placeDown). Returns true if sealed.
function Utils.seal(placeFn)
    local s = Utils.findFillerSlot()
    if not s then return false end
    local prev = turtle.getSelectedSlot()
    turtle.select(s)
    local ok = placeFn()
    turtle.select(prev)
    return ok
end

-- ============================================================
-- PROTECTED BLOCKS: never dig these (chests, machines, base stuff)
-- ============================================================
local PROTECTED = {
    ["minecraft:chest"]            = true,
    ["minecraft:trapped_chest"]    = true,
    ["minecraft:ender_chest"]      = true,
    ["minecraft:barrel"]           = true,
    ["minecraft:furnace"]          = true,
    ["minecraft:blast_furnace"]    = true,
    ["minecraft:smoker"]           = true,
    ["minecraft:hopper"]           = true,
    ["minecraft:dispenser"]        = true,
    ["minecraft:dropper"]          = true,
    ["minecraft:crafting_table"]   = true,
    ["minecraft:enchanting_table"] = true,
    ["minecraft:beacon"]           = true,
    ["minecraft:spawner"]          = true,
}

function Utils.isProtected(name)
    if PROTECTED[name] then return true end
    return name:find("shulker_box")  ~= nil
        or name:find("_bed")         ~= nil
        or name:find("anvil")        ~= nil
        or name:find("sign")         ~= nil
        or name:find("computercraft") ~= nil  -- computers, turtles, modems
end

-- ============================================================
-- TURTLE GRIDLOCK BREAKER (jiggle)
-- When the blocker is another turtle for a sustained time, we may be
-- in a circular wait (A waits on B's cell, B waits on A's). Free OUR
-- cell briefly with a random-length VERTICAL hop and come back:
-- net zero, so counters stay valid and the trail stays exact (U+D),
-- and no turns, so room facing is untouched. CSMA-style backoff.
-- ============================================================
local function jiggleLeg(mv, det, insp, dg, rec, back, recBack)
    if det() then
        local ok, b = insp()
        if not ok or Utils.isProtected(b.name) or Utils.isLava(b.name) then
            return false  -- can't make room that way
        end
        Utils.record(nil, b.name)
        dg()  -- miners clear a normal block; toolless digs fail -> mv fails
    end
    if not mv() then return false end
    Trail.record(rec)
    os.sleep(2 + math.random() * 6)  -- random: breaks symmetric standoffs
    while not back() do os.sleep(0.5) end  -- reclaim our cell
    Trail.record(recBack)
    return true
end

function Utils.jiggle(label)
    print("[jam] Turtle gridlock (" .. label .. ") - making way...")
    -- hop in a vertical direction that is not the blocked one
    if label ~= "above" and jiggleLeg(turtle.up, turtle.detectUp,
            turtle.inspectUp, turtle.digUp, "U", turtle.down, "D") then
        return
    end
    if label ~= "below" and jiggleLeg(turtle.down, turtle.detectDown,
            turtle.inspectDown, turtle.digDown, "D", turtle.up, "U") then
        return
    end
    -- boxed in: a random pause still desynchronizes retry rhythms
    os.sleep(math.random() * 5)
end

-- ============================================================
-- MOVEMENT WITH AUTO-DIG (handles gravel/sand stacks)
-- Never digs protected blocks: waits instead (caller should avoid
-- routing through them - this is the last line of defense).
-- ============================================================
local JAM_AFTER = 100  -- blocked-by-turtle ticks (~45s) before jiggling

local function digMove(move, detect, inspect, dig, attack, state, label)
    local tries = 0
    while not move() do
        Fuel.rescueIfStranded()  -- empty tank? call a fueler from here
        if detect() then
            local ok, b = inspect()
            if ok and Utils.isProtected(b.name) then
                tries = tries + 1
                if tries % 50 == 1 then
                    print("[guard] Protected block " .. label .. " (" ..
                          b.name .. ") - will NOT dig, waiting...")
                end
                -- Sustained block by another TURTLE? break the gridlock
                if b.name:find("computercraft") and tries % JAM_AFTER == 0 then
                    Utils.jiggle(label)
                end
                os.sleep(0.4)
            else
                if ok then Utils.record(state, b.name) end
                dig()
                os.sleep(0.2)
            end
        else
            -- No block but can't move: an entity is in the way.
            -- Swing at it (works with any tool; harmless without one).
            attack()
            os.sleep(0.4)
        end
    end
end

function Utils.forward(state)
    digMove(turtle.forward, turtle.detect, turtle.inspect,
            turtle.dig, turtle.attack, state, "ahead")
    if Nav.facing then Trail.record(tostring(Nav.facing)) end
end

function Utils.down(state)
    digMove(turtle.down, turtle.detectDown, turtle.inspectDown,
            turtle.digDown, turtle.attackDown, state, "below")
    Trail.record("D")
end

function Utils.up(state)
    digMove(turtle.up, turtle.detectUp, turtle.inspectUp,
            turtle.digUp, turtle.attackUp, state, "above")
    Trail.record("U")
end

-- ============================================================
-- INVENTORY
-- ============================================================

-- Percentage of occupied slots (0-100)
function Utils.invPercent()
    local used = 0
    for s = 1, 16 do
        if turtle.getItemCount(s) > 0 then used = used + 1 end
    end
    return math.floor(used / 16 * 100)
end

function Utils.invFull()
    return turtle.getItemCount(16) > 0
end

-- Drop every occupied slot via dropFn (turtle.drop/dropUp/dropDown),
-- except keepSlot (e.g. our own fuel stack)
function Utils.dropAll(dropFn, keepSlot)
    local prev = turtle.getSelectedSlot()
    for s = 1, 16 do
        if s ~= keepSlot and turtle.getItemCount(s) > 0 then
            turtle.select(s)
            dropFn()
        end
    end
    turtle.select(prev)
end

-- ============================================================
-- JUNK: bulk blocks we'd rather TOSS than haul to the chests.
-- One filler stack is always kept aboard for lava sealing.
-- ============================================================
local JUNK = {
    ["minecraft:cobblestone"]       = true,
    ["minecraft:cobbled_deepslate"] = true,
    ["minecraft:dirt"]              = true,
    ["minecraft:gravel"]            = true,
    ["minecraft:granite"]           = true,
    ["minecraft:diorite"]           = true,
    ["minecraft:andesite"]          = true,
    ["minecraft:tuff"]              = true,
    ["minecraft:netherrack"]        = true,
}

-- Toss junk overboard (default: down), keeping ONE filler stack for
-- lava seals. Returns the number of slots freed.
function Utils.purgeJunk(dropFn)
    dropFn = dropFn or turtle.dropDown
    local prev = turtle.getSelectedSlot()
    local fillerKept = false
    local freed = 0
    for s = 1, 16 do
        local d = turtle.getItemDetail(s)
        if d and JUNK[d.name] then
            if FILLER[d.name] and not fillerKept then
                fillerKept = true  -- lava-sealing reserve
            else
                turtle.select(s)
                dropFn()
                freed = freed + 1
            end
        end
    end
    turtle.select(prev)
    if freed > 0 then
        print("[junk] Tossed " .. freed .. " slot(s) of junk")
    end
    return freed
end

-- Drop only the VALUABLE cargo: burnables (fuel reserve) and one
-- filler stack (lava seals) stay aboard
function Utils.dropCargo(dropFn)
    local prev = turtle.getSelectedSlot()
    local fillerKept = false
    for s = 1, 16 do
        local d = turtle.getItemDetail(s)
        if d then
            turtle.select(s)
            if turtle.refuel(0) then
                -- burnable: our fuel reserve, stays
            elseif FILLER[d.name] and not fillerKept then
                fillerKept = true  -- lava-sealing reserve, stays
            else
                dropFn()
            end
        end
    end
    turtle.select(prev)
end

-- Anything aboard that is neither fuel reserve nor the filler stack?
function Utils.hasCargo()
    local prev = turtle.getSelectedSlot()
    local fillerKept = false
    local found = false
    for s = 1, 16 do
        local d = turtle.getItemDetail(s)
        if d then
            turtle.select(s)
            if turtle.refuel(0) then
                -- reserve
            elseif FILLER[d.name] and not fillerKept then
                fillerKept = true
            else
                found = true
                break
            end
        end
    end
    turtle.select(prev)
    return found
end

-- ============================================================
-- MODEM
-- ============================================================

-- Find and open the wireless modem on any side. Returns the side.
function Utils.openModem()
    local modem = peripheral.find("modem", function(_, m)
        return m.isWireless()
    end)
    if not modem then
        error("No wireless modem attached! Equip one and reboot.")
    end
    local side = peripheral.getName(modem)
    rednet.open(side)
    return side
end

return Utils
