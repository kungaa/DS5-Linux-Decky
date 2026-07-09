# DS5-Linux-Decky

[![Build](https://github.com/kungaa/DS5-Linux-Decky/actions/workflows/build.yml/badge.svg)](https://github.com/kungaa/DS5-Linux-Decky/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/kungaa/DS5-Linux-Decky)](https://github.com/kungaa/DS5-Linux-Decky/releases/latest)
[![License](https://img.shields.io/github/license/kungaa/DS5-Linux-Decky)](LICENSE)

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for the
[**DS5-Linux-Bridge**](https://github.com/kungaa/ds5-linux-bridge) dongle — a
USB-to-Bluetooth bridge for the Sony DualSense on a Raspberry Pi Pico 2 W. It
brings the dongle's web config page into the Steam Deck Quick Access Menu —
glanceable battery, connection status, and controller settings, without leaving
your game.

> **Requires the [DS5-Linux-Bridge](https://github.com/kungaa/ds5-linux-bridge)
> dongle.** This plugin is a client of the firmware's HTTP API (the dongle's
> embedded web page is the other client). Without the dongle it has nothing to
> talk to.

<p align="center">
  <img src="assets/screenshot-status.jpg" width="45%" alt="DS5 Bridge: status and settings in the Quick Access Menu" />
  &nbsp;
  <img src="assets/screenshot-bonds.jpg" width="45%" alt="DS5 Bridge: network subnet and paired controllers" />
</p>

## Features

- **Status** — battery %, charging state, and controller model (DualSense /
  DualSense Edge), polled ~every 4 s.
- **Settings** — controller mode, polling rate, audio buffer length,
  idle-disconnect timeout, onboard LED, USB wake keyboard (where supported), and
  a factory reset, saved to the dongle on change.
- **Dongle selector** — when multiple dongles are found, shows each dongle as a
  selectable row with its name/IP and current state.
- **Wake-on-LAN** (WiFi firmware) — a glanceable **Wake PC** button, two
  configurable wake targets (enter a MAC or resolve one from an IP), rename the
  dongle's `.local` name, and reset its WiFi to re-onboard.
- **Network** (USB firmware) — shows which subnet the dongle answered on, and
  lets you switch the dongle's `webconfig_subnet` — including a **custom IP**.
- **Paired controllers** — list, rename, forget, forget-all, or **pair a new
  controller** (opens a 30-second pairing window).

### Two firmware generations, one plugin

The dongle has two transport generations, and the plugin discovers **both**:

- **WiFi firmware (current)** — the dongle joins your home WiFi and advertises
  itself over mDNS as `ds5.local` (renameable). The plugin resolves that name and
  also sweeps the Steam Deck's own LAN to find dongles you've renamed. This
  firmware also exposes Wake-on-LAN and WiFi setup.
- **USB firmware (older)** — the dongle is a USB-NCM network adapter on a private
  link-local subnet. The plugin probes the three preset subnets (`10.55.55.105` /
  `172.31.55.105` / `192.168.137.105`) and any **custom** NCM address.

The API is reachable whether or not a controller is connected, so the plugin can
manage the dongle while idle; "no controller connected" is a normal state, not an
error. UI that only applies to one generation (Wake-on-LAN, WiFi reset vs. the
NCM subnet selector) is shown only for the firmware that supports it, gated on the
capability flags the dongle reports.

When more than one dongle is reachable, a **Dongle** section appears above the
status panel. Each row is one discovered dongle; click a row to make it the
active dongle. The selector keeps the chosen dongle while the plugin re-discovers
devices, so it should not jump back to the first dongle unless the selected one
disappears.

## Installation

Install [Decky Loader](https://decky.xyz/) first, then enable **Developer Mode**
in Decky settings (this reveals the install options below).

**Easiest — install from URL.** In Decky settings → **"Install Plugin from URL"**,
paste this permanent link (always points to the newest release):

```
https://github.com/kungaa/DS5-Linux-Decky/releases/latest/download/DS5-Bridge.zip
```

**Or — install from ZIP.** Download the latest `DS5-Bridge.zip` from the
[Releases page](https://github.com/kungaa/DS5-Linux-Decky/releases/latest), then
use **"Install Plugin from ZIP"** and pick the file.

Either way, open the **Quick Access Menu** (`•••` button) afterward — **DS5
Bridge** appears with a 🎮 icon.

> Not on the Decky store (the plugin is hardware-specific). Install from the URL
> or Releases page above.

### Troubleshooting

**"No dongle found." / "Can't reach the dongle."**

**WiFi firmware:** make sure the dongle actually joined your WiFi (it isn't still
serving its `DS5-Setup-XXXX` onboarding network) and is on the **same** network as
the Steam Deck. Verify from a terminal (Konsole in Desktop Mode):

```bash
curl http://ds5.local/api/status       # or the dongle's LAN IP if you renamed it
```

If `ds5.local` doesn't resolve, use the dongle's IP directly (check your router's
client list). The plugin also sweeps the Deck's own subnet, so a renamed dongle
on the same LAN is still found.

**USB firmware:** the USB-NCM network interface is always present, but the Deck's
NetworkManager doesn't always lease an address on it right away — most often right
after installing the plugin, or just after a controller (re)connects (the link
briefly re-enumerates). While that's happening there's no route, so fetches (and
`curl`) fail. Quick fixes, in order:

1. Press **Retry** / **Refresh** in the plugin.
2. Toggle the **controller off and back on** (or replug the dongle). This
   re-creates the interface and prompts NetworkManager to lease it — usually all
   it takes.

```bash
curl http://10.55.55.105/api/status    # should return JSON
ip addr show | grep 10.55.55            # Deck should have a 10.55.55.106 address
```

If `curl` fails and there's no `10.55.55.x` address, it's a host networking issue
(NetworkManager hasn't leased the interface), **not the plugin** — re-toggling the
controller is the fix. The plugin retries automatically to ride out short delays,
but it can't create a network route that the host hasn't set up.

## Development

Requires Node.js v16.14+ and `pnpm` v9 (`npm i -g pnpm@9`).

```bash
pnpm i            # install frontend deps
pnpm run build    # build the frontend to dist/index.js
```

The Python backend ([main.py](main.py)) uses only the standard library
(`urllib`), so there is no backend build step or Docker requirement. Re-run
`pnpm run build` after any change under `src/`.

### Releasing

Releases are automated. Bump `version` in [package.json](package.json), then push
a tag:

```bash
git tag v0.3.0
git push origin v0.3.0
```

GitHub Actions builds the plugin and publishes a Release with the installable zip
attached. See [.github/workflows/release.yml](.github/workflows/release.yml).

## Related

- [DS5-Linux-Bridge](https://github.com/kungaa/ds5-linux-bridge) — the dongle
  firmware this plugin controls (the source of truth for the HTTP API).

## License

BSD-3-Clause. See [LICENSE](LICENSE).
