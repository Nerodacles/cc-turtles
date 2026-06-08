-- lib/service.lua
-- Shared plumbing for service turtles (courier, fueler): home
-- persistence + boot recovery, the deferred-update command listener,
-- the status heartbeat and the standard return-home tail of a
-- delivery. One service role per turtle -> module-level state.

local Utils = require("utils")
local Nav   = require("nav")
local Fuel  = require("fuel")
local Swarm = require("swarm")
local Trail = require("trail")

local Service = {}

local HOME_FILE = "/home.json"

Service.role          = "?"
Service.phase         = "boot"
Service.home          = nil
Service.updatePending = false

-- Boot: modem, fuel, orient, home persistence and lost-recovery.
-- opts: role (required), onArriveHome (e.g. deposit) run after a
-- recovery flight. Returns the modem side.
function Service.init(opts)
    Service.role = opts.role

    local modemSide = Utils.openModem()
    Nav.giveUp = true   -- no pickaxe: never wait forever on a blocked path
    Fuel.ensure(100, true)
    -- Patient orient: a raw error here (boxed in by parked turtles)
    -- would crash the whole service program
    while not pcall(Nav.orient) do
        print("[init] Cannot orient (boxed in?) - retrying...")
        os.sleep(2 + math.random() * 4)
    end

    Service.home = Utils.readJSON(HOME_FILE)
    if not Service.home then
        Service.home = Nav.locate()
        Utils.writeJSON(HOME_FILE, Service.home)
    else
        -- Rebooted away from home (mid-flight update/crash)? walk the
        -- trail backwards (exact); fall back to a GPS flight
        local cur = Nav.locate()
        if cur.x ~= Service.home.x or cur.y ~= Service.home.y
           or cur.z ~= Service.home.z then
            print("[init] Not at home - recovering...")
            -- pcall: giveUp is on, so a blocked goTo would otherwise
            -- crash the boot. The first delivery's return self-corrects
            -- to the saved home if this didn't fully land.
            if not Trail.backtrack(Nav) then pcall(Nav.goTo, Service.home) end
            if opts.onArriveHome then opts.onArriveHome() end
        end
    end
    Trail.clear()  -- at home: start the journal fresh

    print("[init] Home: " .. Service.home.x .. "," .. Service.home.y ..
          "," .. Service.home.z .. " | Fuel: " .. turtle.getFuelLevel())
    return modemSide
end

-- Standard delivery tail: fly home (trail backtrack if blocked), run
-- the arrival callback (e.g. deposit), honor a queued update, idle.
function Service.returnHome(onArriveHome)
    Service.phase = "returning"
    if not pcall(Nav.goTo, Service.home) then
        print("[job] Blocked flying home - backtracking the trail")
        pcall(Trail.backtrack, Nav)
    end
    if onArriveHome then onArriveHome() end
    Trail.clear()  -- back at home: journal no longer needed

    if Service.updatePending then
        print("[update] Rebooting to update...")
        os.reboot()
    end
    Service.phase = "idle"
end

-- Parallel thread: status heartbeat for the pocket dashboard
function Service.statusLoop()
    Swarm.heartbeat(5, function()
        return {
            role  = Service.role,
            label = os.getComputerLabel()
                    or (Service.role .. "-" .. os.getComputerID()),
            phase = Service.phase,
            fuel  = turtle.getFuelLevel(),
            inv   = Utils.invPercent(),
        }
    end)
end

-- Parallel thread: 'update' reboots when idle, defers mid-delivery
function Service.cmdListener()
    while true do
        local _, msg = rednet.receive(Swarm.PROTO_CMD)
        if Swarm.ok(msg) then
            if msg.cmd == "update" then
                if Service.phase == "idle" then
                    print("[update] Rebooting to update...")
                    os.reboot()
                else
                    print("[update] Queued - will update after this delivery")
                    Service.updatePending = true
                end
            elseif msg.cmd == "rekey" and msg.newKey then
                Swarm.setKey(msg.newKey)
                print("[cmd] Swarm key updated")
            end
        end
    end
end

return Service
