-- gps/startup.lua
-- GPS host: asks for this computer's exact coordinates on first boot,
-- saves them, and serves GPS forever. Survives reboots with no input.

local POS_FILE = "/gps_pos.json"

-- Verify a wireless modem is attached before anything else
local modem = peripheral.find("modem", function(_, m)
    return m.isWireless()
end)
if not modem then
    printError("No wireless modem attached!")
    printError("Attach a wireless modem to this computer and reboot.")
    return
end
print("Wireless modem found on: " .. peripheral.getName(modem))

local function loadPos()
    if fs.exists(POS_FILE) then
        local f = fs.open(POS_FILE, "r")
        local pos = textutils.unserialize(f.readAll())
        f.close()
        return pos
    end
    return nil
end

local function askNumber(prompt)
    while true do
        io.write(prompt)
        local n = tonumber(io.read())
        if n then return n end
        print("Not a number, try again.")
    end
end

local pos = loadPos()

if not pos then
    -- Official method (tweaked.cc/guide/gps_setup.html): LOOK at the
    -- computer block and read F3's "Targeted Block" line - exact, no
    -- standing-position guesswork (1-block host errors make fixes
    -- inconsistent and positions jitter).
    print("=== GPS Host Setup ===")
    print("LOOK directly at this computer,")
    print("press F3 and read the line:")
    print("  'Targeted Block: x, y, z'")
    print("Enter those numbers EXACTLY:")
    pos = {
        x = askNumber("X: "),
        y = askNumber("Y: "),
        z = askNumber("Z: "),
    }
    local f = fs.open(POS_FILE, "w")
    f.write(textutils.serialize(pos))
    f.close()
    print("Saved. This computer will auto-host GPS on every boot.")
end

-- Host GPS and ALSO repeat rednet: direct modem range is ~64 blocks
-- at ground level, so pocket commands ('stop'!) never reached miners
-- deep underground. These sky computers (huge range) relay them.
print("GPS host + rednet repeater at " .. pos.x .. "," .. pos.y .. "," .. pos.z)
parallel.waitForAny(
    function()
        shell.run("gps", "host", tostring(pos.x), tostring(pos.y), tostring(pos.z))
    end,
    function()
        shell.run("repeat")
    end
)
