# Decky Loader plugin — developer handover

This document is everything needed to build a [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)
plugin for **DS5-Linux-Bridge** without re-reading the firmware. The firmware
already exposes a small HTTP API; the plugin is just another client of it. **No
firmware changes are required for a first version** — the embedded web page and
the plugin are interchangeable clients that can run in parallel.

> Status at handover: firmware `v1.1.0`. API is stable and shipped. The plugin
> is greenfield — nothing exists yet.

---

## 1. The mental model

The dongle enumerates as a **USB CDC-NCM network adapter** alongside the
controller. It runs a tiny HTTP server and is its own DHCP server. The existing
config page (`src/web_page.h`) is plain HTML/JS that calls a REST-ish API. The
Decky plugin reimplements that client:

```
                 ┌─────────────────── Steam Deck (SteamOS) ───────────────────┐
 DualSense  ~BT~ │  [dongle USB-NCM iface]  ──HTTP──►  Decky plugin Python      │
                 │      10.55.55.105:80               backend (requests)        │
                 │                                          │ (Decky RPC)        │
                 │                                     plugin React frontend     │
                 │                                     (Quick Access Menu)       │
                 └─────────────────────────────────────────────────────────────┘
```

- **Python backend** (`main.py`, runs on the Deck with full network access) does
  the HTTP calls. No CORS concerns — it's server-side.
- **React/TS frontend** (`index.tsx`) renders in the QAM and calls the Python
  backend over Decky's RPC bridge (`callable` / `call`).

Reimplement the fetch logic from `src/web_page.h` in Python; rebuild the UI in
React. **`src/web_page.h` is the reference implementation for every call.**

---

## 2. Network reachability (read this first — it's the only non-obvious part)

The firmware is the **DHCP server**. Addresses (from `src/usb_net.cpp`,
`build_subnet`), default subnet, `/29`:

| Role | Address |
| --- | --- |
| Dongle (HTTP server + DHCP server) | **10.55.55.105** |
| Host (Deck) — first DHCP lease | 10.55.55.106 |
| Netmask | 255.255.255.248 (`/29`) |
| Gateway / DNS | none (link-local only; never routes, never hijacks DNS) |

The subnet is **user-selectable** (config field `webconfig_subnet`, 0–2) in case
of collision:

| `webconfig_subnet` | Dongle IP |
| --- | --- |
| 0 (default) | 10.55.55.105 |
| 1 | 172.31.55.105 |
| 2 | 192.168.137.105 |

**Plugin must handle all three.** Read `webconfig_subnet` from `/api/config`, or
just probe each `*.105` until one answers. Hardcoding only `.105` is the common
first-version shortcut but will silently fail for users who changed it.

Gotchas:
- **The interface only exists while a controller is connected.** On this branch
  NCM lives in the FULL USB descriptor variant; with no controller the dongle
  drops to a minimal descriptor and the network interface disappears. So
  "dongle present but no controller" = endpoint unreachable. Treat connection
  failures as "no controller / not plugged in," not as errors.
- **SteamOS NetworkManager must accept the USB-NCM iface and take the DHCP
  lease.** Usually automatic. If it doesn't lease, NM may need a nudge (e.g. an
  unmanaged-device rule or `nmcli` connection). Verify this early — it's the most
  likely integration snag, and it's a *host* problem, not a firmware one.
- All responses are `Connection: close` (the server serves one custom file at a
  time). Don't hold keep-alive; just fire discrete requests. Don't hammer faster
  than ~once/sec — lwIP's PCB pool is lean (`MEMP_NUM_TCP_PCB 5`, short TIME_WAIT).
  The web page polls `/api/status` every 4 s; match that order of magnitude.

---

## 3. The HTTP API (the contract)

Base URL: `http://<dongle-ip>/` (see table above). All JSON is compact, no
auth, no HTTPS (link-local USB segment).

### `GET /api/status`  — live, read-only  *(added v1.1.0)*
```json
{ "connected": true, "model": "DS5", "battery_valid": true,
  "battery_pct": 80, "charging": false }
```
- `model`: `"DS5"` (DualSense) or `"DSE"` (DualSense Edge).
- `battery_pct`: 0–100, in ~10% steps (DS5 reports coarse levels).
- `battery_valid`: false until the first input report after connect — show a
  spinner / "—" rather than "0%" when false.
- `charging`: true while charging **or** full.
- When `connected` is false the other fields are meaningless.
- This is the **primary endpoint for a QAM panel** (glanceable battery + status).

### `GET /api/config`  — current settings
```json
{ "version": "v1.1.0", "inactive_time": 10, "disable_inactive_disconnect": 0,
  "disable_pico_led": 0, "polling_rate_mode": 2, "audio_buffer_length": 32,
  "controller_mode": 2, "webconfig_subnet": 0 }
```

### `POST /api/config`  — save settings
`application/x-www-form-urlencoded`. Send any subset of these fields; the
firmware re-validates and clamps every value (the UI is a convenience, not the
source of truth for bounds):

| field | meaning | range |
| --- | --- | --- |
| `controller_mode` | 0 DS5 / 1 DSE / 2 auto | 0–2 |
| `polling_rate_mode` | 0 250 Hz / 1 500 Hz / 2 1000 Hz | 0–2 |
| `audio_buffer_length` | latency vs. stutter | 16–128 |
| `inactive_time` | idle disconnect (min) | 5–60 |
| `disable_inactive_disconnect` | never idle-disconnect | 0/1 |
| `disable_pico_led` | onboard LED off | 0/1 |
| `webconfig_subnet` | page address index | 0–2 |

`controller_mode`, `polling_rate_mode`, `webconfig_subnet` take effect after the
controller reconnects / the adapter is replugged.

### `GET /api/bonds`  — paired controllers
```json
{ "connected": "AABBCCDDEEFF", "max": 4,
  "bonds": [ { "addr": "AABBCCDDEEFF", "name": "Player 1" }, ... ] }
```
- `addr`: 12 uppercase hex chars, no separators. `connected` is the live one (or `""`).
- `name`: nickname (may be `""`).

### `POST /api/bonds`  — manage pairings
`application/x-www-form-urlencoded`, `action` =
- `rename` + `addr` + `name` (≤15 chars; URL-encode it)
- `forget` + `addr`
- `forgetall`

Forget disconnects the live controller if it's the target and blacklists its
address (persists across power cycles); re-pair with **Share + PS** to restore.

> **Behaviour shared with the web page (not plugin bugs):** because the network
> interface only exists while connected, you can't reach the API to forget bonds
> when nothing is connected. And forgetting the *currently connected* controller
> drops the link immediately (expected).

---

## 4. Suggested plugin scope

**v1 (parallel to web page, zero firmware work):**
- QAM panel: battery gauge + model + connected state (poll `/api/status` ~4 s).
- A settings sub-page mirroring `/api/config` (sliders/dropdowns, POST on change).
- Optional: bond list (`/api/bonds`) with rename/forget.

**Nice-to-haves that WOULD need firmware additions** (follow the `/api/status`
pattern in `src/usb_net.cpp` + `bt_get_status` in `src/bt.cpp` — small, additive):
- jack/mic state (`HP_DETECT`/`MIC_DETECT`, mic muted) — data already tracked.
- Anything else the firmware already knows; expose as new read-only JSON fields.
- **Do not** re-add RSSI: over BR/EDR it's golden-range-relative and reads ~0
  (verified). See the comment in `src/bt.h` / `BtStatus`.

---

## 5. Build/tooling pointers (Decky side, separate repo)

- Use the official template: https://github.com/SteamDeckHomebrew/decky-plugin-template
- Frontend: `@decky/ui` + `@decky/api`; backend: a `main.py` Plugin class.
- The plugin lives in its **own repo**, not in this firmware repo. Keep this
  firmware's HTTP API as the single source of truth; the plugin and the embedded
  page (`src/web_page.h`) are two clients of it — keep them feature-parallel.
- Reference client logic: `src/web_page.h` (`loadStatus`, `load`, `save`,
  `loadBonds`, `postBonds`). Port those four functions and you have the API
  layer done.

---

## 6. Quick manual test before writing any plugin code

From the Deck (or any Linux box with the dongle + a connected controller):
```bash
curl http://10.55.55.105/api/status
curl http://10.55.55.105/api/config
curl http://10.55.55.105/api/bonds
```
If those return JSON, the plugin is purely a UI exercise. If they hang/refuse,
it's the NetworkManager/DHCP reachability issue in §2 — fix that first.
