-- lib/updater.lua
-- Downloads the latest scripts from GitHub for a given role.
-- Two-pass: refreshes ITSELF first and delegates to the fresh copy,
-- so files newly added to the manifest are picked up in the same boot.

local Updater = {}

local BASE = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/"

local MANIFEST = {
    miner = {
        { url = BASE .. "lib/utils.lua",      dest = "/lib/utils.lua" },
        { url = BASE .. "lib/fuel.lua",       dest = "/lib/fuel.lua" },
        { url = BASE .. "lib/swarm.lua",      dest = "/lib/swarm.lua" },
        { url = BASE .. "lib/trail.lua",      dest = "/lib/trail.lua" },
        { url = BASE .. "lib/nav.lua",        dest = "/lib/nav.lua" },
        { url = BASE .. "lib/lane.lua",       dest = "/lib/lane.lua" },
        { url = BASE .. "miner/main.lua",     dest = "/main.lua" },
        { url = BASE .. "miner/home.lua",     dest = "/home.lua" },
        { url = BASE .. "miner/startup.lua",  dest = "/startup.lua" },
    },
    courier = {
        { url = BASE .. "lib/utils.lua",       dest = "/lib/utils.lua" },
        { url = BASE .. "lib/fuel.lua",        dest = "/lib/fuel.lua" },
        { url = BASE .. "lib/swarm.lua",       dest = "/lib/swarm.lua" },
        { url = BASE .. "lib/trail.lua",       dest = "/lib/trail.lua" },
        { url = BASE .. "lib/nav.lua",         dest = "/lib/nav.lua" },
        { url = BASE .. "lib/service.lua",     dest = "/lib/service.lua" },
        { url = BASE .. "courier/main.lua",    dest = "/main.lua" },
        { url = BASE .. "courier/startup.lua", dest = "/startup.lua" },
    },
    fueler = {
        { url = BASE .. "lib/utils.lua",      dest = "/lib/utils.lua" },
        { url = BASE .. "lib/fuel.lua",       dest = "/lib/fuel.lua" },
        { url = BASE .. "lib/swarm.lua",      dest = "/lib/swarm.lua" },
        { url = BASE .. "lib/trail.lua",      dest = "/lib/trail.lua" },
        { url = BASE .. "lib/nav.lua",        dest = "/lib/nav.lua" },
        { url = BASE .. "lib/service.lua",    dest = "/lib/service.lua" },
        { url = BASE .. "fueler/main.lua",    dest = "/main.lua" },
        { url = BASE .. "fueler/startup.lua", dest = "/startup.lua" },
    },
    bridge = {
        { url = BASE .. "lib/swarm.lua",      dest = "/lib/swarm.lua" },
        { url = BASE .. "bridge/main.lua",    dest = "/main.lua" },
        { url = BASE .. "bridge/startup.lua", dest = "/startup.lua" },
    },
}

-- Cache-busted download (GitHub raw CDN caches ~5 min)
local function fetch(url, dest)
    local res = http.get(url .. "?t=" .. os.epoch("utc"))
    if res then
        local fh = fs.open(dest, "w")
        fh.write(res.readAll())
        fh.close()
        res.close()
        return true
    end
    return false
end

-- Fire all requests at once (http.request is async) and collect
-- http_success / http_failure events: N files in ~1 round trip.
local function fetchAll(files)
    local pending = {}  -- busted url -> dest
    local count   = 0
    local bust    = "?t=" .. os.epoch("utc")

    for _, file in ipairs(files) do
        local url = file.url .. bust
        pending[url] = file.dest
        count = count + 1
        http.request(url)
    end

    local okAll = true
    while count > 0 do
        local ev, url, res = os.pullEvent()
        if (ev == "http_success" or ev == "http_failure") and pending[url] then
            local dest = pending[url]
            pending[url] = nil
            count = count - 1
            if ev == "http_success" then
                local fh = fs.open(dest, "w")
                fh.write(res.readAll())
                fh.close()
                res.close()
                print("[ok] " .. dest)
            else
                print("[warn] Download failed: " .. dest)
                if not fs.exists(dest) then
                    print("[error] No local copy of " .. dest)
                    okAll = false
                else
                    print("[info] Using local copy of " .. dest)
                end
            end
        end
    end
    return okAll
end

function Updater.run(role, skipSelfUpdate)
    if not MANIFEST[role] then
        print("[update] Unknown role: " .. tostring(role))
        return false
    end
    if not fs.exists("/lib") then fs.makeDir("/lib") end

    -- Pass 1: refresh the updater itself, reload it, and let the
    -- FRESH manifest drive the downloads
    if not skipSelfUpdate then
        if fetch(BASE .. "lib/updater.lua", "/lib/updater.lua") then
            local fresh = dofile("/lib/updater.lua")
            return fresh.run(role, true)
        end
        print("[update] Could not refresh updater - using local manifest")
    end

    -- Pass 2: download everything per the (fresh) manifest, in parallel
    print("[update] Downloading latest code (" .. role .. ")...")
    return fetchAll(MANIFEST[role])
end

return Updater
