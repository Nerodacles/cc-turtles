-- courier/startup.lua
-- Boot: update code and start the courier service immediately

local BASE = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/"

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

Updater.run("courier")
shell.run("/main.lua")
