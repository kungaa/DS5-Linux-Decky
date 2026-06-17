# DS5-Linux-Decky

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for the
**DS5-Linux-Bridge** dongle. It brings the dongle's web config page into the Steam
Deck Quick Access Menu: glanceable battery + connection status, and controller
settings — without leaving the game.

The dongle exposes a small HTTP API over a USB-NCM link-local network; this plugin
is just another client of it (the embedded web page is the other). See
[DECKY_PLUGIN_HANDOVER.md](DECKY_PLUGIN_HANDOVER.md) for the full API contract.

## Features

- **Status** — battery %, charging state, controller model (DualSense / DS Edge),
  polled ~every 4s from `/api/status`.
- **Settings** — controller mode, polling rate, audio buffer length, idle-disconnect
  timeout, onboard LED, mirroring `/api/config` (saved on change).

> The dongle's network interface only exists while a controller is connected. When
> nothing is connected, the plugin shows "No controller connected" rather than an
> error. The plugin auto-discovers the dongle across all three selectable subnets
> (`10.55.55.105` / `172.31.55.105` / `192.168.137.105`).

## Development

Requires Node.js v16.14+ and `pnpm` v9 (`sudo npm i -g pnpm@9`).

```bash
pnpm i            # install frontend deps
pnpm run build    # build the frontend to dist/index.js
```

The Python backend ([main.py](main.py)) uses only the standard library (`urllib`),
so no backend build step or Docker is required.

Every time you change `src/index.tsx` (or anything in `src/`), re-run `pnpm run build`.

If you use VSCode/VSCodium, the `setup`, `build`, and `deploy` tasks from the
template are available.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
