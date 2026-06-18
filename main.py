import asyncio
import json
import urllib.parse
import urllib.request
from urllib.error import URLError, HTTPError

import decky

# DS5-Linux-Bridge dongle HTTP API client.
#
# The dongle is a USB-NCM network adapter that runs a tiny HTTP server and its
# own DHCP server. It is reachable on a link-local /29 subnet, and the exact
# address depends on the firmware's `webconfig_subnet` setting (0-2). The
# interface only exists while a controller is connected, so connection failures
# are treated as "no controller / not plugged in", not as hard errors.
#
# Reference: DECKY_PLUGIN_HANDOVER.md (the firmware HTTP API contract).

# Candidate dongle IPs, indexed by `webconfig_subnet`. We probe these in order.
SUBNET_IPS = {
    0: "10.55.55.105",
    1: "172.31.55.105",
    2: "192.168.137.105",
}

# Reverse map: IP -> subnet index, for reporting which subnet answered.
IP_SUBNETS = {ip: idx for idx, ip in SUBNET_IPS.items()}

# Keep requests short — lwIP's PCB pool is lean and serves one file at a time.
HTTP_TIMEOUT = 2.0

# Transient failures are common right after the controller connects: the dongle's
# USB-NCM interface has just appeared and SteamOS NetworkManager may not have taken
# its DHCP lease yet, so there's briefly no route to the dongle. Retry a couple of
# times with a short gap (staying under the ~1/sec rate the firmware tolerates)
# before declaring the dongle unreachable, to ride out that window.
RETRY_ATTEMPTS = 3
RETRY_GAP_S = 0.4


class Plugin:
    def __init__(self) -> None:
        # The IP we last reached the dongle on. Cached so we don't re-probe all
        # three subnets on every call. Reset to None whenever a request fails.
        self._base_ip: str | None = None

    # --- low-level HTTP -----------------------------------------------------

    def _request(self, ip: str, path: str, data: dict | None = None) -> dict:
        """Blocking HTTP GET/POST against a specific dongle IP. Runs in an
        executor (see _call). Raises URLError/HTTPError on failure."""
        url = f"http://{ip}{path}"
        body = None
        headers = {}
        if data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
        # Some POST endpoints may return an empty body; tolerate that.
        return json.loads(raw) if raw.strip() else {}

    def _probe_order(self) -> list[str]:
        """Cached-IP-first ordering of candidate dongle IPs."""
        candidates: list[str] = []
        if self._base_ip:
            candidates.append(self._base_ip)
        for ip in SUBNET_IPS.values():
            if ip not in candidates:
                candidates.append(ip)
        return candidates

    async def _call(self, path: str, data: dict | None = None) -> dict:
        """Reach the dongle on `path`, auto-discovering the subnet. Returns the
        parsed JSON dict, or `{_reachable: False, ...}` if unreachable.

        Retries a few times before giving up, to ride out the brief window after
        a controller connects where the USB-NCM interface exists but SteamOS
        NetworkManager hasn't leased an address yet (so there's no route)."""
        loop = asyncio.get_event_loop()
        last_err: Exception | None = None

        for attempt in range(RETRY_ATTEMPTS):
            for ip in self._probe_order():
                try:
                    result = await loop.run_in_executor(
                        None, self._request, ip, path, data
                    )
                    self._base_ip = ip
                    result.setdefault("_reachable", True)
                    # Tell the frontend which subnet/IP actually answered, so it
                    # can show a "connected via" indicator.
                    result["_ip"] = ip
                    result["_subnet"] = IP_SUBNETS.get(ip)
                    return result
                except (URLError, HTTPError, OSError, ValueError) as err:
                    last_err = err
                    continue
            # No IP answered this round. Drop the cached IP and back off briefly
            # before retrying (but not on the final attempt).
            self._base_ip = None
            if attempt < RETRY_ATTEMPTS - 1:
                await asyncio.sleep(RETRY_GAP_S)

        # Still nothing after retries. This is usually "no controller connected"
        # (the NCM interface only exists while connected), but can also be a host
        # networking hiccup (NetworkManager hasn't leased the dongle interface).
        # We can't tell the two apart from here, so let the frontend offer the
        # right guidance (re-plug / re-toggle the controller).
        decky.logger.info(f"dongle unreachable on {path}: {last_err}")
        return {"_reachable": False, "_error": str(last_err) if last_err else None}

    # --- API methods (called from the frontend via @decky/api) --------------

    async def get_status(self) -> dict:
        """GET /api/status — live battery + connection state."""
        return await self._call("/api/status")

    async def get_config(self) -> dict:
        """GET /api/config — current firmware settings."""
        return await self._call("/api/config")

    async def set_config(self, fields: dict) -> dict:
        """POST /api/config — save a subset of settings. The firmware
        re-validates and clamps every value, so we just pass them through."""
        return await self._call("/api/config", data=fields)

    async def get_bonds(self) -> dict:
        """GET /api/bonds — paired controllers."""
        return await self._call("/api/bonds")

    async def rename_bond(self, addr: str, name: str) -> dict:
        """POST /api/bonds action=rename. `name` <= 15 chars (firmware clamps)."""
        return await self._call(
            "/api/bonds", data={"action": "rename", "addr": addr, "name": name}
        )

    async def forget_bond(self, addr: str) -> dict:
        """POST /api/bonds action=forget. Blacklists the address; disconnects
        the live controller if it's the target."""
        return await self._call("/api/bonds", data={"action": "forget", "addr": addr})

    async def forget_all_bonds(self) -> dict:
        """POST /api/bonds action=forgetall."""
        return await self._call("/api/bonds", data={"action": "forgetall"})

    # --- lifecycle ----------------------------------------------------------

    async def _main(self) -> None:
        self.loop = asyncio.get_event_loop()
        decky.logger.info("DS5-Linux-Decky backend started")

    async def _unload(self) -> None:
        decky.logger.info("DS5-Linux-Decky backend unloading")

    async def _uninstall(self) -> None:
        decky.logger.info("DS5-Linux-Decky uninstalled")
