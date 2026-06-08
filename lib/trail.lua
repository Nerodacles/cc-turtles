-- lib/trail.lua
-- Movement journal (breadcrumb trail). Every move is appended to a
-- file as one char in ABSOLUTE terms, so replaying it in reverse
-- walks the turtle back to where the trail started - no GPS needed:
--   '0'..'3' = horizontal move towards +z/+x/-z/-x
--   'U'/'D'  = vertical move
-- Cleared when the turtle is verified back at home.

local Trail = {}

Trail.FILE = "/trail.log"

function Trail.record(c)
    local f = fs.open(Trail.FILE, "a")
    f.write(c)
    f.close()
end

function Trail.size()
    if fs.exists(Trail.FILE) then return fs.getSize(Trail.FILE) end
    return 0
end

function Trail.clear()
    if fs.exists(Trail.FILE) then fs.delete(Trail.FILE) end
end

-- Replay the journal in reverse, ending where the trail started.
-- Needs Nav with a valid facing (orient first). Progress is persisted
-- every 100 moves so a crash mid-backtrack resumes correctly.
function Trail.backtrack(Nav)
    if not fs.exists(Trail.FILE) then return false end
    local f = fs.open(Trail.FILE, "r")
    local moves = f.readAll() or ""
    f.close()
    if #moves == 0 then return false end

    -- Guarded dig: clear gravel etc but NEVER another turtle/computer.
    -- (trail is standalone; minimal inline checks to avoid require cycles)
    local function safeDig(inspect, dig)
        local ok, b = inspect()
        if ok and not b.name:find("computercraft") then dig() end
    end
    -- Each reverse move below also waits out lava (detect() is false
    -- on fluids, so a naive move would walk in and die).
    print("[trail] Backtracking " .. #moves .. " moves...")
    for i = #moves, 1, -1 do
        local c = moves:sub(i, i)
        if c == "U" then        -- went up -> go down
            while true do
                local ok, b = turtle.inspectDown()
                if ok and b.name == "minecraft:lava" then os.sleep(0.5)
                elseif turtle.down() then break
                else safeDig(turtle.inspectDown, turtle.digDown); os.sleep(0.2) end
            end
        elseif c == "D" then    -- went down -> go up
            while true do
                local ok, b = turtle.inspectUp()
                if ok and b.name == "minecraft:lava" then os.sleep(0.5)
                elseif turtle.up() then break
                else safeDig(turtle.inspectUp, turtle.digUp); os.sleep(0.2) end
            end
        else
            local d = tonumber(c)
            if d then           -- moved towards d -> move towards opposite
                Nav.face((d + 2) % 4)
                while true do
                    local ok, b = turtle.inspect()
                    if ok and b.name == "minecraft:lava" then os.sleep(0.5)
                    elseif turtle.forward() then break
                    else safeDig(turtle.inspect, turtle.dig); os.sleep(0.2) end
                end
            end
        end
        if i % 100 == 1 and i > 1 then
            local fh = fs.open(Trail.FILE, "w")
            fh.write(moves:sub(1, i - 1))
            fh.close()
        end
    end

    Trail.clear()
    print("[trail] Backtrack complete")
    return true
end

return Trail
