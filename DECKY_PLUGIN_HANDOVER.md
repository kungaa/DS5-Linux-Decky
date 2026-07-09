# Decky Loader plugin — developer handover

This document is everything needed to build a [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)
plugin for **DS5-Linux-Bridge** without re-reading the firmware. The firmware
already exposes a small HTTP API; the plugin is just another client of it. **No
firmware changes are required for a first version** — the embedded web page and
the plugin are interchangeable clients that can run in parallel.

> Status at handover: the firmware has **two transport generations** for the
> config API (see §2). The API *contract* (§3) is stable across both. The plugin
> is greenfield — nothing exists yet.

---

## 1. The mental model

The dongle runs a tiny HTTP server exposing a small REST-ish API. The existing
config page (`src/web_page.h`) is plain HTML/JS that calls it; the Decky plugin
is just another client of the same API:

```
                 ┌─────────────────── Steam Deck (SteamOS) ───────────────────┐
 DualSense  ~BT~ │   dongle HTTP server  ──HTTP──►   Decky plugin Python        │
                 │   (USB-NCM link, OR              backend (requests)          │
                 │    on your home WiFi)                 │ (Decky RPC)           │
                 │                                  plugin React frontend        │
                 │                                  (Quick Access Menu)          │
                 └─────────────────────────────────────────────────────────────┘
```

- **Python backend** (`main.py`, runs on the Deck with full network access) does
  the HTTP calls. No CORS concerns — it's server-side.
- **React/TS frontend** (`index.tsx`) renders in the QAM and calls the Python
  backend over Decky's RPC bridge (`callable` / `call`).

Reimplement the fetch logic from `src/web_page.h` in Python; rebuild the UI in
React. **`src/web_page.h` is the reference implementation for every call.**

**The one thing to internalize:** how you *reach* the dongle depends on which
firmware generation it runs (§2), but once you have its IP, **every endpoint in
§3 is identical**. Discover the address, then talk the same API.

---

## 2. Network reachability (read this first — it's the only non-obvious part)

There are **two firmware generations**, and they put the dongle in different
places on the network. The plugin should support **both** so it works regardless
of which firmware a user flashed.

### Generation A — WiFi transport (current firmware)

The dongle **joins the user's home WiFi** and serves the API on the LAN, reachable
from anything on that network (the Deck included). It advertises itself over mDNS.

| Role | Address |
| --- | --- |
| Dongle (HTTP server) | a normal DHCP lease on the home LAN (not fixed) |
| mDNS name | **`ds5.local`** by default — **user-renameable** (config `hostname`) |

Because the IP is a DHCP lease and the mDNS name is user-settable, there's **no
fixed address to hardcode**. Discover it (see below).

### Generation B — USB-NCM transport (older firmware)

Older firmware enumerates as a **USB CDC-NCM network adapter** and is its own DHCP
server on a private `/29` link. The dongle sits at a fixed `.105`:

| `webconfig_subnet` | Dongle IP |
| --- | --- |
| 0 (default) | 10.55.55.105 |
| 1 | 172.31.55.105 |
| 2 | 192.168.137.105 |
| 3 (custom) | a private address the user typed |

On the Deck, each NCM link shows up as an extra NIC and takes a DHCP lease from
the dongle; the dongle is the gateway-less `/29` host at `.105`-equivalent.

> This generation's config carried `webconfig_subnet` / `webconfig_custom_ip`
> fields. Current firmware **retires** them (the WiFi build never reads them), so
> `GET /api/config` on Gen-A firmware does **not** return them. Don't require
> those keys — treat them as optional/absent.

### Discovery (support both, in order)

Run these until one answers; each hit is a distinct dongle instance:

1. **mDNS `ds5.local`** (Gen A, default name). One cheap resolve + `GET
   /api/status`. Catches the common current-firmware case with zero guesswork.
2. **Scan the home-LAN subnet(s)** the Deck is on (Gen A, **renamed** dongles).
   The user can rename the dongle (`ds5-den.local` etc.), so mDNS-by-fixed-name
   isn't enough on its own. Enumerate the Deck's own IPv4 addresses, and for each
   `/24`-ish LAN sweep the host range with a short-timeout `GET /api/status`
   (parallel, ~200–300 ms per probe). A dongle answers with the status JSON
   (shape from §3); then `GET /api/config` on that IP confirms it's a Gen-A dongle
   and gives you its `hostname` (its friendly name) + capability flags.
   - *(Alternatively, if you also do mDNS service discovery rather than
     name-lookup: browse `_http._tcp` and match responders that answer
     `/api/status` — but a subnet sweep is simpler and needs no service record.)*
3. **NCM presets + neighbours** (Gen B, older firmware). Probe the three preset
   IPs (`10.55.55.105`, `172.31.55.105`, `192.168.137.105`); then enumerate the
   Deck's USB-NCM NICs and probe their `/29` neighbour range to catch **custom**
   NCM addresses. This whole step only matters for pre-WiFi firmware — keep it for
   backward compatibility, but it can run last / be skipped if no NCM NIC exists.

Whichever step finds it, you now have an IP; everything in §3 is the same. If more
than one answers, treat each as a **separate dongle instance** — let the user pick
which to view/manage; there's no cross-dongle aggregation in firmware, so the
plugin owns the multi-instance UX. Cache the last-known IP per dongle and re-probe
it first on the next launch (a DHCP lease is usually stable) before re-scanning.

Gotchas:
- **The API is reachable whether or not a controller is connected**, in both
  generations. So you can read status / manage bonds while idle. *(Gen B only:
  the USB device briefly re-enumerates on the full↔minimal descriptor swap, so
  the NCM link blips right around a controller connect/disconnect — fire
  requests fire-and-forget, don't wait on a response across a swap. Gen A has no
  such blip; WiFi is independent of the USB face.)*
- **Gen B: SteamOS NetworkManager must accept the USB-NCM iface and take the DHCP
  lease.** Usually automatic; if it doesn't lease, NM may need a nudge
  (unmanaged-device rule or `nmcli`). Gen A has no such requirement — it's on the
  ordinary WiFi the Deck is already using.
- All responses are `Connection: close` (the server serves one file at a time).
  Don't hold keep-alive; fire discrete requests. Don't hammer faster than
  ~once/sec — lwIP's PCB pool is lean (`MEMP_NUM_TCP_PCB 5`, short TIME_WAIT).
  The web page polls `/api/status` every 4 s; match that order of magnitude. When
  subnet-sweeping (step 2), keep probes short-timeout and bounded in parallelism.

---

## 3. The HTTP API (the contract)

Base URL: `http://<dongle-ip>/` (see table above). All JSON is compact, no
auth, no HTTPS (link-local USB segment).

### `GET /api/status`  — live, read-only
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

Gen-A (WiFi) firmware:
```json
{ "version": "1.2.0", "inactive_time": 10, "disable_inactive_disconnect": 0,
  "disable_pico_led": 0, "polling_rate_mode": 2, "audio_buffer_length": 32,
  "controller_mode": 2, "wol_target_mac": "000000000000",
  "wol_target_mac2": "000000000000", "hostname": "ds5", "wake_kbd_enabled": 0,
  "wake_kbd_capable": true, "wol_capable": true, "wifi_capable": true }
```
- `version` is a free-form string (e.g. `"1.2.0"`, `"dev"`); display it, don't
  parse it. Use the **capability flags** for feature detection, not the version:
  - `wol_capable` / `wifi_capable` — this firmware has the WiFi config page + WOL
    (always `true` on Gen A; absent/false on Gen B). Gates the Network/WOL UI.
  - `wake_kbd_capable` — firmware can enumerate the USB wake keyboard. Gates the
    wake-keyboard toggle.
- `wol_target_mac` / `wol_target_mac2` — 12 uppercase hex chars, `"000000000000"`
  when unset.
- `hostname` — the dongle's mDNS name (also its `<name>.local`). Present on Gen A.
- Gen-B firmware instead returns `webconfig_subnet` (0–3) and `webconfig_custom_ip`
  (dotted-quad) and none of the WiFi/WOL fields. **Read fields defensively** —
  use `.get(...)` with defaults; never require a key from the other generation.

### `POST /api/config`  — save settings
`application/x-www-form-urlencoded`. Send any subset of these fields; the
firmware re-validates and clamps every value (the UI is a convenience, not the
source of truth for bounds). Unknown fields are ignored, so it's safe to send a
Gen-A field to Gen-B firmware and vice-versa:

| field | meaning | range | gen |
| --- | --- | --- | --- |
| `controller_mode` | 0 DS5 / 1 DSE / 2 auto | 0–2 | A+B |
| `polling_rate_mode` | 0 250 Hz / 1 500 Hz / 2 1000 Hz | 0–2 | A+B |
| `audio_buffer_length` | latency vs. stutter | 16–128 | A+B |
| `inactive_time` | idle disconnect (min) | 5–60 | A+B |
| `disable_inactive_disconnect` | never idle-disconnect | 0/1 | A+B |
| `disable_pico_led` | onboard LED off | 0/1 | A+B |
| `hostname` | mDNS name (`[a-z0-9-]`, ≤10 chars) | — | A |
| `wol_target_mac` / `wol_target_mac2` | WOL target(s), 12 hex or all-zero | — | A |
| `wake_kbd_enabled` | enumerate USB wake keyboard | 0/1 | A |
| `factory_reset` | `=1` resets settings to defaults (keeps bonds) | — | A+B |
| `webconfig_subnet` / `webconfig_custom_ip` | NCM page address | — | B |

`controller_mode` / `polling_rate_mode` take effect after the controller
reconnects. `hostname` and `wake_kbd_enabled` take effect after the dongle reboots
/ re-plugs itself (saving `wake_kbd_enabled` re-enumerates USB immediately).

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
- `pair` (no `addr`) — add another controller

Forget disconnects the live controller if it's the target and blacklists its
address (persists across power cycles); re-pair with **Share + PS** to restore.

The adapter only auto-scans for a controller when none is bonded; once one is
paired it relies on page-scan reconnect. `pair` is the explicit way to add a
second controller. Because the firmware connects one controller at a time,
`pair` **disconnects the currently connected controller** (if any) — keeping its
bond, so it reconnects later — and opens a 30 s inquiry window. The new
controller (in **Share + PS** mode) becomes the active connection. During the
window incoming auto-reconnects from the just-disconnected controller are
rejected so it can't reclaim the slot before the new one pairs; the window
closes when a controller connects or the inquiry finds nothing. Issue `pair`
fire-and-forget — don't block your UI on the response.

> **Behaviour shared with the web page (not plugin bugs):** the API is reachable
> with or without a controller connected, so you can forget bonds / start pairing
> while idle. Forgetting the *currently connected* controller drops the link
> immediately (expected). *(Gen B / NCM only:* any operation that
> connects/disconnects a controller causes a brief NCM re-enumeration blip as the
> USB face swaps full↔minimal. On Gen A / WiFi the API link is unaffected by
> controller connect/disconnect.)*

### Gen-A only: Wake-on-LAN & network endpoints

These exist only on WiFi firmware (gate on `wol_capable` / `wifi_capable` from
`/api/config`). All `application/x-www-form-urlencoded`.

- **`POST /api/wol`** — `action=wake` fires a magic packet at **every** stored
  target (`wol_target_mac` + `wol_target_mac2`). Add `&mac=AABBCCDDEEFF` to wake
  one explicit target instead. No-op if no transport / no target configured.
- **`POST /api/resolve_mac`** (`ip=A.B.C.D`) + **`GET /api/resolve_mac`** — a
  two-step ARP lookup to fill a WOL target MAC from an IP. The POST only *starts*
  it; then poll the GET: `{"pending":true}` while in flight, then
  `{"pending":false,"ok":true,"mac":"AABBCCDDEEFF"}` or
  `{"pending":false,"ok":false}`. (Mirrors the page's `wol_resolve` handler.)
- **`POST /api/wifi_reset`** (`action=reset`) — clears saved WiFi creds and
  reboots into `DS5-Setup-XXXX` onboarding AP mode. **Destructive to
  connectivity:** the dongle drops off the LAN and you re-onboard it. Confirm in
  the UI first. (There's no un-reset over the API — that's the whole point.)

> Note: in onboarding **AP mode** the firmware serves only the setup portal
> (`/api/wifi_scan`, `/api/wifi_provision`) and 404s `config`/`bonds`/`status`/
> `wol` — a security measure, since the setup AP is open. The plugin only ever
> talks to a dongle that's already on the LAN (STA mode), so it won't hit AP mode;
> just don't expect the normal API from a dongle still in setup.

---

## 4. Suggested plugin scope

**v1 (parallel to web page, zero firmware work):**
- QAM panel: battery gauge + model + connected state (poll `/api/status` ~4 s).
- A settings sub-page mirroring `/api/config` (sliders/dropdowns, POST on change).
- Optional: bond list (`/api/bonds`) with rename/forget.
- Optional (Gen-A firmware): a "Wake PC" button (`POST /api/wol`) — glanceable and
  genuinely useful from the QAM. Gate it on `wol_capable`.

**Nice-to-haves that WOULD need firmware additions** (follow the `/api/status`
pattern in `src/web_api.cpp` + `bt_get_status` in `src/bt.cpp` — small, additive):
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

From the Deck (or any Linux box on the same network as the dongle). Substitute
the dongle's address for `$DONGLE`:

```bash
# Gen A (WiFi): default mDNS name, or the dongle's LAN IP if renamed
DONGLE=ds5.local
# Gen B (NCM): the fixed link-local address instead
# DONGLE=10.55.55.105

curl http://$DONGLE/api/status
curl http://$DONGLE/api/config
curl http://$DONGLE/api/bonds
```
If those return JSON, the plugin is purely a UI exercise. If they hang/refuse:
on Gen A check the dongle actually joined WiFi (is it still serving
`DS5-Setup-XXXX`?) and that `.local` resolves — else use its IP; on Gen B it's
the NetworkManager/DHCP reachability issue in §2 — fix that first.
