# CC: Tweaked Turtle Swarm

Multi-turtle mining system for CC: Tweaked (Minecraft): miner turtles, courier (chest) turtles, fueler turtles, a GPS cluster, and a live Pocket Computer dashboard.

## Structure

```
mc/
├── lib/
│   ├── utils.lua      # Movement, inventory, JSON persistence, ore/protected/fluid detection
│   ├── fuel.lua       # Fuel: inventory burning, chest pulls, ensures, remote deliveries
│   ├── swarm.lua      # Heartbeat + request/offer/assign service negotiation
│   ├── trail.lua      # Movement journal: absolute-direction breadcrumbs + reverse replay
│   ├── lane.lua       # Direction-grouped traffic control for the shared shaft
│   ├── service.lua    # Service-turtle plumbing: home, recovery, update cmd, heartbeat
│   ├── nav.lua        # GPS navigation (orient, goTo; optional dig hooks for miners)
│   └── updater.lua    # Auto-updater with per-role manifests, parallel downloads
├── miner/
│   ├── startup.lua    # Miner boot — paste once on each miner turtle
│   └── main.lua       # Mining logic
├── courier/
│   ├── startup.lua    # Courier boot — paste once on each courier turtle
│   └── main.lua       # Pickup/delivery service
├── fueler/
│   ├── startup.lua    # Fueler boot — paste once on each fueler turtle
│   └── main.lua       # Fuel delivery service
├── gps/
│   └── startup.lua    # GPS host — paste once on each of the 4 GPS computers
├── pocket/
│   └── remote.lua     # In-game dashboard + swarm commands
├── bridge/
│   ├── startup.lua    # Rednet<->WebSocket bridge boot
│   └── main.lua       # Forwards status to the web, commands back
└── web/
    ├── server.js      # Node WebSocket + static server
    ├── public/        # Live browser dashboard (list + top-down map)
    ├── Dockerfile · docker-compose.yml · k8s.yaml
    └── package.json
```

## Web dashboard (live, WebSockets)

A browser dashboard mirrors the pocket: live turtle cards + a top-down map (positions, mining zones, fuel/inventory), with command buttons (start/pause/resume/home/update, and set-entry by coords).

```
turtles ──rednet swarm_status──▶ bridge (CC computer) ──WebSocket──▶ Node server ──▶ browsers
                                       ◀────────────── commands ◀──────────────────
```

**Server** (Node) — run anywhere with network to the bridge:
```
cd web && docker compose up --build      # http://localhost:8080
```
or on the cluster: build/push the image and `kubectl apply -f web/k8s.yaml` (Traefik IngressRoute included; WebSockets route transparently).

**Bridge** — one CC computer/turtle with a wireless modem + HTTP, in rednet range of the swarm (next to a GPS repeater is ideal). It defaults to `wss://turtles.infra.com.do`; install:
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/bridge/startup.lua startup.lua
reboot
```
To point it elsewhere: `edit bridge.json` → `{ url = "wss://your-host" }` (use `wss://` for an HTTPS site, `ws://` for plain HTTP).
The bridge re-signs web commands with the swarm key, so the dashboard inherits the same auth as the pocket. If you rotated the key (`k`), give the bridge the same `secret.json`.

## Security (other players)

Every swarm message carries a **shared secret**; messages without the right key are ignored — other players' turtles and pockets cannot command yours, intercept courier pickups, or drain your fuelers. The default key works out of the box; for real protection on a shared server, press **`k` on the pocket**: type a new key once and it propagates to every powered-on device in range and persists in each `/secret.json`. The rekey is sent twice — signed with the current key (the fleet) and with the default key (**onboarding**: brand-new devices still on the default adopt it too, so adding a turtle later is just `wget` + `reboot` + press `k` re-entering your same key). Devices off/out of range keep the old key — rerun `k` near them.

Limits to know: the key travels in plaintext (a determined player sniffing raw modem traffic could read it — there's no crypto in CC), and **physical access is not covered**: anyone who can right-click your turtle can read its files. Use a server claims/protection mod for the physical layer.

## Rednet protocols

| Protocol | Purpose |
|---|---|
| `swarm_status` | Heartbeat every 5s from every turtle (role, phase, fuel, inv%, GPS pos, zone) |
| `swarm_cmd` | Pocket commands: `mine_at` (entry point) / `start` / `pause` / `resume` / `stop` / `update` |
| `swarm_courier` | Pickup negotiation: `request` → `offer` → `assign` → `arrived` → `done` |
| `swarm_fuel` | Fuel delivery: `request` → `offer` → `assign` → `arrived` → `delivered` |
| `swarm_site` | Zone slot negotiation between miners at a dig site |
| `swarm_lane` | Shared-shaft traffic: `using` / `waiting` heartbeats |

## GPS requirement

The whole swarm **requires a GPS cluster** (4 computers with wireless modems placed high up running `gps host x y z`): miners navigate to the dig site by GPS, couriers/fuelers navigate deliveries, and the dashboard shows positions.

The GPS computers also run the **`repeat` program** (rednet repeater): direct modem range is only ~64 blocks at ground level, so pocket commands (`stop`!) would never reach miners deep underground far from you. The sky computers relay every rednet message across the whole region transparently.

### Building the cluster

1. Place **4 regular computers** high in the sky (Y 250+ recommended for max range), each with a **wireless modem** attached.
2. They must NOT be in a straight line — use a tetrahedron-ish layout, e.g. three corners of a ~10-block triangle plus one a few blocks higher.
3. On each computer:
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/gps/startup.lua startup.lua
reboot
```
4. On first boot it asks for that computer's exact coordinates: **look directly at the computer block** and read F3's **`Targeted Block`** line (official method — do NOT use your own standing position, a 1-block host error makes every GPS fix jitter). Saved once; every reboot after that auto-hosts with no input.

Verify from any turtle/pocket in range: run `gps locate` several times — it must print the **same** coordinates every time. Jittering results mean one of the four hosts has wrong coordinates.

## Miner Turtle

### Mission

1. **Entry point** — stand where you want the operation and press `m` on the pocket: miners save your GPS position to `site.json` as the **persistent entry point** (it survives reboots and missions, until a new `m` replaces it). Press `s` to start: all idle miners fly there (terrain-hugging GPS navigation). An `m` sent mid-mission applies to the next mission.
2. **Shared shaft (single block in/out)** — ALL miners enter AND exit through the exact x/z of the entry point: one 1×1 column. `lib/lane.lua` runs it as **direction-grouped traffic**: any number of turtles flow the same direction together as a convoy (vertical queueing makes head-ons impossible), opposite traffic waits for the flow to drain, and courier transfers hold the column exclusively. Anti-starvation: a waiter older than 30s blocks new joiners so a busy flow can't lock the other direction out. No coordinator — Rednet heartbeats with TTL, crashed users free the lane automatically.
3. **Zone split below** — at Y=30 each miner tunnels from the shared shaft bottom to its negotiated zone center (spiral × 16 blocks), so 11×11 rooms never overlap. Tunnels may share corridors: head-on turtles get overtaken over the top (GPS self-corrects the overshoot).
4. **Rooms (stacked)** — mines an 11×11 room, **3 blocks high**, traveling the middle layer (3 blocks per move). Then drops 3 blocks and mines the next level — **contiguous, no floor left between levels** — repeating until `MIN_Y`. Level progress persists: after a service trip or crash, already-cleared steps are **fast-walked** (move only — no inspections, digs or vein sweeps) instead of re-mined. A level that yields **zero blocks in 60 real steps** (manually vein-mined area, old shafts, a giant cavern) is declared already mined and skipped down — the threshold is deliberately high so half-cave rooms (which always dig *something*) are never skipped and keep their ores.
5. **Return** — climbs its zone's center column, retraces its tunnel, climbs its shaft, flies home.
6. **Unload** — at home, calls a courier to collect everything non-burnable, retrying persistently (~10 min with jitter — several miners finishing together queue for the courier). Burnables stay aboard and get banked into the fuel tank. The miner then reboots and waits for the next `start`. The same check runs **at mission start**: a miner carrying leftovers from an aborted run unloads before flying out.

### Adding miners mid-operation

Drop in a new miner anytime (`wget` + `reboot`) and press `s`: it asks the swarm for the entry point (`site_query` — both active and idle miners answer from their `site.json`), negotiates a free zone slot against the ones already mining, queues for the shaft lane like everyone else and starts working. No re-marking needed; miners mid-mission ignore the `s` and just keep going.

### Multi-miner zone assignment (no coordinator)

On receiving a dig site, every miner announces itself on `swarm_site` for 3 seconds. Miners that already own a slot reply with it; the rest sort themselves by computer ID and take the free slots in order. Latecomers query the same way and pick the lowest free slot. Slots map deterministically to zone centers on a spiral **starting at ring 1** — nobody mines on top of the shared junction every tunnel radiates from.

### Service meetups

Rooms have no open column above them, so couriers/fuelers meet the miner **at the shared shaft bottom** (open column to the sky): the miner climbs its zone's center column, retraces its tunnel, holds the lane exclusively while the courier descends the column, transfers, and walks back. During shaft descent and at home the meetup happens in place.

### Ore focus (vein mining)

Every block dug (front/ceiling/floor) is identified first. When an ore shows up (`*_ore` incl. deepslate variants, plus ancient debris), the turtle runs a full 6-direction recursive vein chase (up to 16 blocks, exact backtrack). The expensive 4-turn sweep only runs when an ore was actually seen — ore-less steps stay fast.

### Lava safety (verified for MC 26.1.x worldgen)

World generation facts ([Lava Lake](https://minecraft.wiki/w/Lava_Lake), [Aquifer](https://minecraft.wiki/w/Aquifer), [Java 26.1](https://minecraft.wiki/w/Java_Edition_26.1) — 26.x has no worldgen changes):
- Underground **lava lakes generate only above Y=0**, commonly Y 0–50 → the default mining zone (Y 30→8) is inside lava-lake territory.
- Below Y=0 aquifers may be lava; **Y −55 to −63 is always lava**.
- `turtle.detect()` returns **false** on fluids — a naive `forward()` walks straight into lava and destroys the turtle.

Defenses (lava is detected via `inspect` before every entry):
- **Front lava** → sealed with a filler block (cobblestone/deepslate from its own loot), level aborted, next level attempted.
- **Ceiling/floor lava** → sealed in place, room continues.
- **Lava during descent** → sealed below, rooms start from that depth instead.
- **Vein chase** → re-inspects after digging; flowed-in lava is sealed, branch skipped.
- Water is harmless to turtles and is simply passed through.

### Auto-refuel

Whenever fuel drops below a comfort threshold (return cost + margin), the turtle refuels itself from any burnable item in its inventory (coal, lava buckets, etc.) before deciding it must go home.

### Courier calls

At **80% inventory** (and only if fuel is healthy):
1. The miner walks back to the shared shaft bottom (service trip) and broadcasts a pickup request with its GPS position.
2. Couriers in range answer with offers; the **closest** one is assigned.
3. The courier descends the shaft and hovers directly above the miner; the miner transfers the loot via `dropUp()` — **every burnable item (coal, coal blocks...) stays aboard** as its own refuel reserve, and gets banked into the fuel tank right after (the tank stores fuel without occupying inventory slots).
4. The miner walks back to its zone and the room restarts (walking through cleared rows is fast).

If no courier answers, it keeps mining until the inventory is truly full, then returns home (retries couriers every 60s).

### Fueler calls

When fuel drops to the return threshold and the inventory has no burnables left, the miner requests a fuel delivery (same closest-offer protocol as couriers). The fueler flies over, hovers above and drops fuel items in; the miner burns them and keeps mining. Waiting costs no fuel, so this happens *before* giving up. If no fueler answers, it heads home.

### Return triggers

| Trigger | Condition |
|---|---|
| Fuel low | Fuel ≤ actual return cost + margin (after auto-refuel AND a fueler attempt) |
| Inventory full | Slot 16 occupied and no courier available |
| Remote `stop` | Received via Rednet — aborts everything and returns |

### Trail (lost-turtle recovery)

Every single move (flights, shaft, tunnel, rooms, vein chases) is journaled to `trail.log` as one char in **absolute directions** (`0-3` horizontal, `U`/`D` vertical) — so replaying the file in reverse walks the turtle back to where the trail started, with **no GPS or facing trust needed**.

- Miner: journal starts fresh at home each mission. If the flight home misses (after one GPS retry), the full trail is replayed backwards. An idle miner booting far from home with a trail backtracks automatically.
- Courier/fueler: trail per delivery; a reboot away from home backtracks the trail (falls back to GPS flight if there is none).
- The file is cleared every time the turtle is verified at its real home.

### Crash recovery

Every step persists to `state.json` (phase, zone slot, shaft depth, room offset, mined counts). On reboot `startup.lua` resumes automatically — re-orienting via GPS, and skipping the lane lock when already inside the column (a resumed turtle waiting for a flow it physically blocks would deadlock). After a successful mission the state file is deleted, so the next boot waits for `start` again.

Known gap: a crash in the middle of a vein chase or a service trip (short windows) can desync position — the trail backtrack recovers the turtle to home.

### Config (top of miner/main.lua)

| Variable | Default | Description |
|---|---|---|
| `MINING_Y` | 30 | Y of the first room (surface Y comes from the dig site) |
| `MIN_Y` | −50 | Deepest room level — top of the diamond band, still above the always-lava aquifer (Y −55..−63). Lava guards seal everything on the way down |
| `LEVEL_STEP` | 3 | Blocks between stacked rooms (3 = contiguous, no floors; set 4 to leave a 1-block floor) |
| `ROOM_RINGS` | 5 | Room radius → 11×11 |
| `ZONE_SPREAD` | 16 | Blocks between room centers below the shared shaft |
| `VEIN_MAX_DEPTH` | 16 | Max vein recursion |
| `CALL_COURIER_PCT` | 80 | Inventory % that triggers a courier |
| `Utils.FILLER_RESERVE` | 4 | Filler stacks (deepslate/cobble) kept aboard for lava sealing |

### Emergency `home` command (on the turtle)

If a miner gets into a state you don't trust, force it straight home from its own terminal:

```
(hold Ctrl+T to kill the running program)
home
```

It refuels (calling a fueler if at 0), orients, bores up to surface height if needed and flies directly home — never digging protected blocks, lava or other turtles. If the flight fails it replays the trail backwards. The mission state is wiped, so after `reboot` it waits for a fresh `start`.

### Gridlock breaker (turtle vs turtle jams)

Turtles recognize each other and never dig one another — but mutual waits can form circular jams (A waits on B's cell while B waits on A's, e.g. several miners returning at once). After ~45s blocked by another **turtle**, the blocked one runs a **jiggle**: it frees its own cell with a vertical hop of random duration, then reclaims it. Net zero (counters and trail stay exact, no turns), CSMA-style random backoff — symmetric standoffs desynchronize and drain within a few cycles, and everyone continues home or to whatever they were doing.

### Junk filter (no cobblestone in your chests)

Bulk junk (cobblestone, cobbled deepslate, dirt, gravel, granite/diorite/andesite, tuff, netherrack) is **tossed on the spot** instead of hauled: when inventory hits 80% (often avoiding the courier trip entirely), before every courier transfer, and before flying home — so the junk despawns inside the mine, never at the base. One filler stack is always kept aboard for lava sealing.

### Protected blocks

The miner **never digs**: chests (all types), barrels, shulker boxes, furnaces, hoppers, dispensers/droppers, crafting/enchanting tables, beacons, spawners, anvils, beds, signs, and any ComputerCraft block (computers, turtles, modems — turtles can't destroy each other). Behavior per phase:

- **Descent**: stops descending and mines from the reached depth.
- **Tunnel/Room**: aborts and returns home, leaving the area intact.
- Last line of defense: the low-level movement functions refuse to dig protected blocks no matter what.

## Courier Turtle — NO pickaxe needed

A plain **wireless turtle** (no tool) that idles **on top of a chest** at its home position. On boot it records home via GPS and detects its facing automatically.

Service turtles never break blocks. Navigation is **terrain-hugging**: fly straight at the target's height and hop 1 block up over any obstacle (ending only as high as the tallest thing on the path), then descend through open air columns — e.g. the miner's own shaft. The miner always returns to its shaft before requesting a pickup, so the column above it is clear. If a path stays hard-blocked for ~2 minutes, service turtles abort and return home.

- Answers pickup requests only if it has fuel for the round trip (auto-refuels from its own inventory first).
- Hovers 1 block above the miner, receives the cargo, returns home and deposits everything into the chest below (keeps its own fuel).
- If blocked (mob, fallen gravel), it waits and retries — it never digs.
- **Fuel watch**: when idle at home below 500 fuel, it requests a fueler delivery for itself (and refuses new pickup jobs while the fueler is en route).

## Fueler Turtle — NO pickaxe needed

A plain **wireless turtle** (no tool) that idles **on top of a chest filled with fuel** (coal, coal blocks, blaze rods, etc.). Same no-dig terrain-hugging navigation as the courier. Cargo is measured in **fuel value** (coal block = 800, coal = 80, lava bucket = 1000...): it pulls from the chest until carrying ~2000 fuel worth per delivery.

- Answers fuel requests only if it can make the round trip (refuels itself from the chest) and has cargo worth delivering (~2000 fuel value).
- Flies to the requester (descending through the shaft), hovers above, drops all burnable items into it, returns home.
- **Rescues stranded turtles**: any turtle booting with fuel 0 (it can't move, but it can still broadcast) automatically requests a fueler delivery every 60s and gets refueled in place — no manual coal needed.

## Pocket Dashboard

Compact live view, one line per turtle — `id name role phase fuel inv%` (role is `M`/`C`/`F`; a leading `!` flags 15s+ without heartbeat). Scroll with the **up/down arrows** when there are more turtles than screen lines. Commands stay pinned at the top.

| Key | Action |
|---|---|
| `m` | **mark entry**: saves your position as the persistent entry point (does not start) |
| `s` | **start**: all idle miners fly to the saved entry point and begin |
| `p` / `r` | pause / resume |
| `h` | send everyone home (`stop`) |
| `u` | update the whole swarm + the pocket itself |
| `k` | **rotate the swarm key**: propagates to every device in range, persists everywhere |
| `q` | quit |

`u` broadcasts `update`: every turtle reboots and its startup downloads the latest code. Miners mid-mission defer the reboot to the next **safe checkpoint** (between steps, with state just saved — never mid-vein-chase) and resume exactly where they were (`state.json`). Couriers/fuelers mid-delivery finish the trip first, then update — their home position persists to `home.json`, so even a reboot away from home is recovered by flying back.

## Setup

**Miner turtle** (diamond pickaxe + wireless modem — any side, auto-detected):
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/miner/startup.lua startup.lua
reboot
```

**Courier turtle** (wireless modem, sitting on a chest):
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/courier/startup.lua startup.lua
reboot
```

**Fueler turtle** (wireless modem, sitting on a chest full of coal/coal blocks):
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/fueler/startup.lua startup.lua
reboot
```

**Pocket Computer** (wireless modem):
```
wget https://raw.githubusercontent.com/Nerodacles/cc-turtles/main/pocket/remote.lua remote.lua
remote
```

Every boot auto-downloads the latest code from this repo. To deploy changes: `git push`, then press `u` on the pocket.

**Server requirement:** HTTP enabled in `config/computercraft-common.toml` → `http.enabled = true`.
