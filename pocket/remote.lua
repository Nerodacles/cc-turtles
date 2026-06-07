-- pocket/remote.lua
-- Pocket Computer: compact live dashboard + swarm commands.
-- One line per turtle; scroll with up/down arrows.

local PROTO_STATUS = "swarm_status"
local PROTO_CMD    = "swarm_cmd"

-- Shared secret (must match the turtles'). Override the default by
-- creating /secret.json -> { key = "your-own-key" } on every device.
local KEY = "swarm-default-key"
if fs.exists("/secret.json") then
    local f = fs.open("/secret.json", "r")
    local s = textutils.unserialize(f.readAll())
    f.close()
    if s and s.key then KEY = s.key end
end

-- All commands are keyed tables: turtles ignore unkeyed messages
local function sendCmd(c, extra)
    local msg = extra or {}
    msg.cmd = c
    msg.k = KEY
    rednet.broadcast(msg, PROTO_CMD)
end

local modem = peripheral.find("modem", function(_, m)
    return m.isWireless()
end)
if not modem then
    print("No wireless modem on this pocket computer.")
    return
end
local modemSide = peripheral.getName(modem)
rednet.open(modemSide)

local turtles = {}   -- id -> { data, last }
local scroll  = 0

-- ============================================================
-- LISTENER
-- ============================================================
local function listener()
    while true do
        local id, msg, proto = rednet.receive()
        -- Only OUR turtles' heartbeats (matching key)
        if proto == PROTO_STATUS and type(msg) == "table" and msg.k == KEY then
            turtles[id] = { data = msg, last = os.clock() }
        end
    end
end

-- ============================================================
-- DASHBOARD (fits the pocket screen: 1 line per turtle)
-- ============================================================
local function fmtFuel(f)
    if f == "unlimited" then return "inf" end
    f = tonumber(f) or 0
    if f >= 100000 then return math.floor(f / 1000) .. "k" end
    if f >= 1000 then
        return string.format("%.1fk", f / 1000):gsub("%.0k", "k")
    end
    return tostring(f)
end

local function render()
    local w, h = term.getSize()
    term.clear()
    term.setCursorPos(1, 1)
    print("m=entry s=start p=pause")
    print("r=res h=home u=upd k=key")

    local ids = {}
    for id in pairs(turtles) do ids[#ids + 1] = id end
    table.sort(ids)

    local rows = h - 3
    local maxScroll = math.max(0, #ids - rows)
    if scroll > maxScroll then scroll = maxScroll end

    local scrollMark = maxScroll > 0 and (" ^v " .. scroll .. "/" .. maxScroll) or ""
    print(("-- %d turtles%s --"):format(#ids, scrollMark))

    if #ids == 0 then
        print("No turtles reporting...")
        return
    end

    local now = os.clock()
    for i = scroll + 1, math.min(#ids, scroll + rows) do
        local id = ids[i]
        local t = turtles[id]
        local d = t.data
        local age = now - t.last
        -- "!" = no heartbeat for 15s (offline?)
        local off   = age > 15 and "!" or " "
        -- Miners show their zone slot (M3): two miners with the SAME
        -- number would be mining the same zone - a negotiation bug
        local role  = (d.role or "?"):sub(1, 1):upper()
        if d.role == "miner" and d.slot then role = "M" .. d.slot end
        local name  = (d.label or "?"):sub(1, 7)
        local phase = (d.phase or "?"):sub(1, 4)
        local line = string.format("%s%-2d %-7s %-3s %-4s %4s %2d%%",
            off, id, name, role, phase, fmtFuel(d.fuel), d.inv or 0)
        term.write(line:sub(1, w))
        local _, cy = term.getCursorPos()
        term.setCursorPos(1, cy + 1)
    end
end

-- ============================================================
-- UI: 1s refresh, single-key commands, arrow scrolling
-- ============================================================
local function ui()
    render()
    local timer = os.startTimer(1)
    while true do
        local ev, p1 = os.pullEvent()
        if ev == "timer" and p1 == timer then
            render()
            timer = os.startTimer(1)
        elseif ev == "key" then
            if p1 == keys.up then
                scroll = math.max(0, scroll - 1)
                render()
            elseif p1 == keys.down then
                scroll = scroll + 1
                render()
            end
        elseif ev == "char" then
            if p1 == "m" then
                -- Mark the PERSISTENT entry point at MY position.
                local x, y, z = gps.locate(2)
                term.clear()
                term.setCursorPos(1, 1)
                if x then
                    -- A pocket's GPS fix is the PLAYER's float position
                    -- (-847.88...): floor to the block coordinate, or
                    -- integer-walking turtles oscillate around the
                    -- fractional target forever
                    x, y, z = math.floor(x), math.floor(y), math.floor(z)
                    sendCmd("mine_at", { pos = { x = x, y = y, z = z } })
                    print("Entry point saved:")
                    print(x .. "," .. y .. "," .. z)
                    print("Press 's' to start.")
                else
                    print("No GPS - cannot set entry.")
                end
                os.sleep(2)
            elseif p1 == "s" then
                sendCmd("start")
            elseif p1 == "p" then
                sendCmd("pause")
            elseif p1 == "r" then
                sendCmd("resume")
            elseif p1 == "h" then
                sendCmd("stop")
            elseif p1 == "u" then
                sendCmd("update")
                term.clear()
                term.setCursorPos(1, 1)
                print("Update sent to all turtles.")
                print("Updating myself...")
                local url = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/pocket/remote.lua?t="
                            .. os.epoch("utc")
                local res = http.get(url)
                if res then
                    local f = fs.open("/remote.lua", "w")
                    f.write(res.readAll())
                    f.close()
                    res.close()
                    print("Updated. Restarting...")
                    rednet.close(modemSide)
                    os.sleep(1)
                    shell.run("/remote.lua")
                    return
                else
                    print("Self-update failed, continuing.")
                    os.sleep(2)
                end
            elseif p1 == "k" then
                -- KEY ROTATION: broadcast the new key signed with the
                -- current one; every listening device adopts it. Do
                -- this once with everything powered on and in range.
                term.clear()
                term.setCursorPos(1, 1)
                print("New swarm key (empty=cancel):")
                io.write("> ")
                local nk = io.read()
                if nk and #nk > 0 then
                    -- Fleet copy: signed with our CURRENT key
                    sendCmd("rekey", { newKey = nk })
                    -- Onboarding copy: signed with the DEFAULT key, so
                    -- brand-new devices (still on default) adopt it
                    -- too. No new risk: a default-key device is open
                    -- to anyone until onboarded anyway.
                    rednet.broadcast({ cmd = "rekey", newKey = nk,
                                       k = "swarm-default-key" }, PROTO_CMD)
                    KEY = nk
                    local f = fs.open("/secret.json", "w")
                    f.write(textutils.serialize({ key = nk }))
                    f.close()
                    print("Key rotated and saved.")
                    print("New devices onboarded too.")
                    print("Turtles off/out of range keep")
                    print("the OLD key: rerun 'k' near them.")
                    os.sleep(4)
                end
            elseif p1 == "q" then
                return
            end
        end
    end
end

parallel.waitForAny(listener, ui)
rednet.close(modemSide)
term.clear()
term.setCursorPos(1, 1)
print("Disconnected.")
