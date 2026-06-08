-- lib/log.lua
-- Tees print() into a small ring buffer so the dashboard can show each
-- turtle's log. Log.init() wraps the global print once; Log.flush()
-- returns and clears the lines accumulated since the last flush (the
-- status heartbeat ships them, like the ore buffer).

local Log = {}
local buf = {}
local MAX = 60  -- cap pending lines (a slow heartbeat can't blow up memory)

function Log.init()
    if Log._wrapped then return end
    Log._wrapped = true
    local orig = _G.print
    _G.print = function(...)
        orig(...)
        local n = select("#", ...)
        local parts = {}
        for i = 1, n do parts[i] = tostring(select(i, ...)) end
        buf[#buf + 1] = table.concat(parts, " ")
        if #buf > MAX then table.remove(buf, 1) end
    end
end

-- Return and clear pending lines (nil if none)
function Log.flush()
    if #buf == 0 then return nil end
    local out = buf
    buf = {}
    return out
end

return Log
