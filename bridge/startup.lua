-- bridge/startup.lua
-- Boot: download the bridge code from GitHub, then run it.

local BASE = "https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/"

if not fs.exists("/lib") then fs.makeDir("/lib") end
if not fs.exists("/lib/updater.lua") then
    local res = http.get(BASE .. "lib/updater.lua?t=" .. os.epoch("utc"))
    if res then
        local f = fs.open("/lib/updater.lua", "w")
        f.write(res.readAll()); f.close(); res.close()
    else
        print("[boot] Could not download updater.lua. Aborting.")
        return
    end
end

package.path = package.path .. ";/lib/?.lua"
require("updater").run("bridge")
shell.run("/main.lua")
