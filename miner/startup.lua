-- miner/startup.lua
-- Boot: update code, then resume mission (crash) or wait for 'start'

local STATE_FILE   = "/state.json"
local BASE         = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/"
local PROTO_CMD    = "swarm_cmd"

-- Find the wireless modem on any side (don't assume right: the
-- pickaxe may occupy it). Inline: utils.lua may not exist yet.
local function openModem()
    local modem = peripheral.find("modem", function(_, m)
        return m.isWireless()
    end)
    if not modem then
        printError("No wireless modem attached! Equip one and reboot.")
        error()
    end
    local side = peripheral.getName(modem)
    rednet.open(side)
    return side
end

-- Bootstrap the updater if missing
if not fs.exists("/lib") then fs.makeDir("/lib") end
if not fs.exists("/lib/updater.lua") then
    print("[boot] Downloading updater...")
    local res = http.get(BASE .. "lib/updater.lua?t=" .. os.epoch("utc"))
    if res then
        local f = fs.open("/lib/updater.lua", "w")
        f.write(res.readAll())
        f.close()
        res.close()
    else
        print("[error] Could not download updater.lua. Aborting.")
        return
    end
end

package.path = package.path .. ";/lib/?.lua"
local Updater = require("updater")

if fs.exists(STATE_FILE) then
    -- Crash / server restart with an active mission: update and resume
    print("[boot] Previous session found. Updating and resuming...")
    Updater.run("miner")
    shell.run("/main.lua")
else
    -- Fresh boot: wait for 'start'. The dig site ('m' on the pocket)
    -- persists in site.json and stays the entry point until changed.
    local modemSide = openModem()
    local SITE_FILE = "/site.json"

    -- Update now so the libs exist for the idle threads below
    Updater.run("miner")
    local Fuel  = require("fuel")
    local Swarm = require("swarm")
    local Nav   = require("nav")
    local Trail = require("trail")

    -- Lost-turtle recovery: idle far from home with a trail? walk the
    -- journal backwards step by step (no GPS/facing trust needed).
    if fs.exists("/home.json") then
        local hf = fs.open("/home.json", "r")
        local homePos = textutils.unserialize(hf.readAll())
        hf.close()
        local x, y, z = gps.locate(2)
        if homePos and x then
            local dist = math.abs(x - homePos.x) + math.abs(y - homePos.y)
                       + math.abs(z - homePos.z)
            if dist > 2 and Trail.size() > 0 then
                print("[boot] Far from home (" .. dist .. " blocks) - backtracking...")
                pcall(Nav.orient)
                Trail.backtrack(Nav)
            elseif dist <= 2 then
                Trail.clear()  -- at home: journal no longer needed
            end
        end
    end

    local function loadSite()
        if fs.exists(SITE_FILE) then
            local f = fs.open(SITE_FILE, "r")
            local s = textutils.unserialize(f.readAll())
            f.close()
            return s
        end
        return nil
    end

    local function saveSite(pos)
        -- Floor to block coords: pocket fixes are the player's FLOAT
        -- position and fractional targets make navigation oscillate
        local f = fs.open(SITE_FILE, "w")
        f.write(textutils.serialize({
            x = math.floor(pos.x),
            y = math.floor(pos.y),
            z = math.floor(pos.z),
        }))
        f.close()
    end

    local known = loadSite()
    print("[boot] Modem on " .. modemSide .. ".")
    if known then
        print("[boot] Entry point: " .. known.x .. "," .. known.y .. "," .. known.z)
        print("[boot] Waiting for 'start' ('s' on the pocket)...")
    else
        print("[boot] No entry point set. Press 'm' on the pocket first.")
    end

    local site = nil
    local function waitSite()
        while true do
            local _, msg = rednet.receive(PROTO_CMD)
            -- Keyed commands only (other players' pockets are ignored)
            if Swarm.ok(msg) then
                if msg.cmd == "mine_at" and msg.pos then
                    saveSite(msg.pos)
                    print("[boot] Entry point saved: " .. msg.pos.x .. "," ..
                          msg.pos.y .. "," .. msg.pos.z .. ". Waiting for 'start'...")
                elseif msg.cmd == "start" then
                    site = loadSite()
                    if not site then
                        -- Newly added miner that never heard an 'm':
                        -- ask the swarm for the entry point
                        print("[boot] No entry point - asking other miners...")
                        Swarm.bcast({ type = "site_query" }, "swarm_site")
                        local deadline = os.clock() + 3
                        while os.clock() < deadline do
                            local _, m2 = rednet.receive("swarm_site", 0.5)
                            if Swarm.ok(m2) and m2.type == "site" and m2.pos then
                                saveSite(m2.pos)
                                site = loadSite()
                                break
                            end
                        end
                    end
                    if site then
                        -- legacy site.json may hold fractional coords
                        site.x = math.floor(site.x)
                        site.y = math.floor(site.y)
                        site.z = math.floor(site.z)
                        return
                    end
                    print("[boot] Cannot start: nobody knows the entry point. Press 'm' first.")
                elseif msg.cmd == "update" then
                    os.reboot()  -- re-download on boot
                elseif msg.cmd == "rekey" and msg.newKey then
                    Swarm.setKey(msg.newKey)
                    print("[boot] Swarm key updated")
                end
            end
        end
    end

    local function heartbeat()
        Swarm.heartbeat(5, function()
            return {
                role  = "miner",
                label = os.getComputerLabel() or ("miner-" .. os.getComputerID()),
                phase = "ready",
                fuel  = turtle.getFuelLevel(),
                inv   = 0,
            }
        end)
    end

    -- Idle fuel watch: a parked miner at fuel 0 gets a fueler
    -- delivery automatically (it can broadcast even without fuel)
    local function fuelWatch()
        while true do
            if turtle.getFuelLevel() ~= "unlimited"
               and turtle.getFuelLevel() < 100 then
                if not Fuel.refuel(100) then
                    Fuel.requestDelivery(200)
                end
            end
            os.sleep(60)
        end
    end

    -- Answer site queries from newly added miners while idle
    local function siteResponder()
        while true do
            local id, msg = rednet.receive("swarm_site")
            if Swarm.ok(msg) and msg.type == "site_query" then
                local s = loadSite()
                if s then
                    Swarm.to(id, { type = "site", pos = s }, "swarm_site")
                end
            end
        end
    end

    parallel.waitForAny(waitSite, heartbeat, fuelWatch, siteResponder)

    print("[boot] Dig site: " .. site.x .. "," .. site.y .. "," .. site.z)
    -- Seed the mission state so main.lua (and crash resumes) know the site
    local f = fs.open(STATE_FILE, "w")
    f.write(textutils.serialize({
        phase = "goto",
        site  = site,
        depth = 0,
        mined = {},
        room  = { px = 0, pz = 0, facing = 0 },
    }))
    f.close()

    print("[boot] Updating code...")
    Updater.run("miner")
    rednet.close(modemSide)
    shell.run("/main.lua")
end
