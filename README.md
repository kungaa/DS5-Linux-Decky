# DS5-Linux-Decky

[![Build](https://github.com/kungaa/DS5-Linux-Decky/actions/workflows/build.yml/badge.svg)](https://github.com/kungaa/DS5-Linux-Decky/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/kungaa/DS5-Linux-Decky)](https://github.com/kungaa/DS5-Linux-Decky/releases/latest)
[![License](https://img.shields.io/github/license/kungaa/DS5-Linux-Decky)](LICENSE)

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for the
**DS5-Linux-Bridge** dongle. It brings the dongle's web config page into the Steam
Deck Quick Access Menu — glanceable battery, connection status, and controller
settings, without leaving your game.

> The dongle exposes a small HTTP API over a USB-NCM link-local network; this
> plugin is just another client of it (the embedded web page is the other).

<!-- TODO: drop a QAM screenshot here once captured on the Deck:
![DS5 Bridge in the Quick Access Menu](assets/screenshot.png) -->

## Features

- **Status** — battery %, charging state, and controller model (DualSense /
  DualSense Edge), polled ~every 4 s.
- **Settings** — controller mode, polling rate, audio buffer length,
  idle-disconnect timeout, and onboard LED, saved to the dongle on change.
- **Network** — shows which subnet the dongle answered on, and lets you switch
  the dongle's `webconfig_subnet` (the plugin re-discovers it automatically).
- **Paired controllers** — list, rename, forget, or forget-all bonded
  controllers.

The dongle's network interface only exists while a controller is connected, so
when nothing is connected the plugin shows *"No controller connected"* rather
than an error. It auto-discovers the dongle across all three selectable subnets
(`10.55.55.105` / `172.31.55.105` / `192.168.137.105`).

## Installation

1. On your Steam Deck, install [Decky Loader](https://decky.xyz/) if you haven't.
2. Download the latest **`DS5-Bridge-vX.Y.Z.zip`** from the
   [Releases page](https://github.com/kungaa/DS5-Linux-Decky/releases/latest).
3. In Decky settings, enable **Developer Mode**, then use
   **"Install Plugin from ZIP"** and pick the downloaded file.
4. Open the **Quick Access Menu** (`•••` button) — **DS5 Bridge** appears with a
   🎮 icon.

> Not on the Decky store (the plugin is hardware-specific). Install from the
> Releases page above.

### Troubleshooting

If the plugin shows "No controller connected" even though one is connected, the
Steam Deck's NetworkManager may not have leased an address on the dongle's
USB-NCM interface. Verify reachability from a terminal:

```bash
curl http://10.55.55.105/api/status
```

If that hangs or refuses, it's a host networking issue (DHCP/NetworkManager),
not the plugin.

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

## License

BSD-3-Clause. See [LICENSE](LICENSE).
