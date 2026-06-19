import asyncio
import ipaddress
import json
import socket
import struct
import urllib.parse
import urllib.request
from urllib.error import URLError, HTTPError

import decky

# DS5-Linux-Bridge dongle HTTP API client.
#
# The dongle is a USB-NCM network adapter that runs a tiny HTTP server and its
# own DHCP server. It is reachable on a link-local /29 subnet, and the exact
# address depends on the firmware's `webconfig_subnet` setting (0-3, where 3 is
# a user-typed custom IP). As of firmware v1.2.0 the NCM interface exists whether
# or not a controller is connected, so an unreachable dongle means a host network
# problem (NetworkManager hasn't leased the link), NOT "no controller".
#
# Multiple dongles can be plugged into one host at once, each on its own address.
# Discovery is two-stage: probe the known presets, then enumerate the host's
# USB-NCM interfaces and probe their /29 neighbours (this finds dongles on custom
# addresses, which aren't in the preset list). Each address is an independent
# dongle with its own /api/*; the plugin owns the multi-instance UX.
#
# Reference: DECKY_PLUGIN_HANDOVER.md (the firmware HTTP API contract).

# Candidate dongle IPs, indexed by `webconfig_subnet`. Probed first in discovery.
SUBNET_IPS = {
    0: "10.55.55.105",
    1: "172.31.55.105",
    2: "192.168.137.105",
}

# Reverse map: IP -> subnet index, for reporting which subnet answered.
IP_SUBNETS = {ip: idx for idx, ip in SUBNET_IPS.items()}

# Keep requests short — lwIP's PCB pool is lean and serves one file at a time.
HTTP_TIMEOUT = 2.0

# A discovery probe must be even snappier, since we may probe several addresses.
PROBE_TIMEOUT = 1.0

# Transient failures are common right after a controller (re)connects: the NCM
# link briefly re-enumerates and SteamOS NetworkManager may not have re-taken its
# DHCP lease yet, so there's briefly no route to the dongle. Retry a couple of
# times with a short gap (staying under the ~1/sec rate the firmware tolerates)
# before declaring the dongle unreachable, to ride out that window.
RETRY_ATTEMPTS = 3
RETRY_GAP_S = 0.4


class Plugin:
    def __init__(self) -> None:
        # IPs we've successfully reached a dongle on, most-recent-first. Used to
        # bias discovery and to keep a per-call request cheap (no re-probe).
        self._known_ips: list[str] = []

    # --- low-level HTTP -----------------------------------------------------

    def _request(
        self, ip: str, path: str, data: dict | None = None, timeout: float = HTTP_TIMEOUT
    ) -> dict:
        """Blocking HTTP GET/POST against a specific dongle IP. Runs in an
        executor (see _run). Raises URLError/HTTPError/OSError on failure."""
        url = f"http://{ip}{path}"
        body = None
        headers = {}
        if data is not None:
            body = urllib.parse.urlencode(data).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
        # Some POST endpoints may return an empty body; tolerate that.
        return json.loads(raw) if raw.strip() else {}

    async def _run(self, ip: str, path: str, data: dict | None = None) -> dict:
        """Reach the dongle at a specific `ip` on `path`. Returns the parsed JSON
        dict, or `{_reachable: False, ...}` if unreachable.

        Retries a few times before giving up, to ride out the brief window after
        a controller (re)connects where the NCM link is re-enumerating and
        SteamOS NetworkManager hasn't re-leased an address yet (so there's no
        route)."""
        loop = asyncio.get_event_loop()
        last_err: Exception | None = None

        for attempt in range(RETRY_ATTEMPTS):
            try:
                result = await loop.run_in_executor(None, self._request, ip, path, data)
                self._remember(ip)
                result.setdefault("_reachable", True)
                result["_ip"] = ip
                result["_subnet"] = IP_SUBNETS.get(ip)
                return result
            except (URLError, HTTPError, OSError, ValueError) as err:
                last_err = err
                if attempt < RETRY_ATTEMPTS - 1:
                    await asyncio.sleep(RETRY_GAP_S)

        # Still nothing after retries. As of v1.2.0 the NCM interface exists even
        # with no controller connected, so this is a host networking hiccup
        # (NetworkManager hasn't leased the dongle interface) rather than "no
        # controller". The frontend offers the re-toggle / replug guidance.
        decky.logger.info(f"dongle {ip} unreachable on {path}: {last_err}")
        return {
            "_reachable": False,
            "_ip": ip,
            "_subnet": IP_SUBNETS.get(ip),
            "_error": str(last_err) if last_err else None,
        }

    def _remember(self, ip: str) -> None:
        """Move `ip` to the front of the known list (most-recently-reached)."""
        if ip in self._known_ips:
            self._known_ips.remove(ip)
        self._known_ips.insert(0, ip)

    # --- discovery ----------------------------------------------------------

    def _ncm_neighbour_ips(self) -> list[str]:
        """Enumerate the host's IPv4 interfaces and, for each that looks like a
        link-local /29 USB-NCM segment, return the dongle's address on it.

        The dongle is the DHCP server and always takes the `.105`-equivalent (the
        first host address of its /29). We compute the network from the host's own
        address + netmask and return that first usable host. This finds dongles on
        *custom* IPs that aren't in the preset list.

        Uses SIOCGIFCONF/SIOCGIFNETMASK via fcntl/ioctl — Linux + stdlib only."""
        import fcntl

        neighbours: list[str] = []
        try:
            names = socket.if_nameindex()
        except OSError:
            return neighbours

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            for _, name in names:
                ifname = name.encode("utf-8")
                try:
                    # SIOCGIFADDR = 0x8915, SIOCGIFNETMASK = 0x891b
                    addr_raw = fcntl.ioctl(
                        sock.fileno(), 0x8915, struct.pack("256s", ifname[:15])
                    )
                    mask_raw = fcntl.ioctl(
                        sock.fileno(), 0x891B, struct.pack("256s", ifname[:15])
                    )
                except OSError:
                    continue
                host_ip = socket.inet_ntoa(addr_raw[20:24])
                netmask = socket.inet_ntoa(mask_raw[20:24])
                try:
                    iface = ipaddress.ip_interface(f"{host_ip}/{netmask}")
                except ValueError:
                    continue
                net = iface.network
                # Only the dongle's link-local /29 layout: a tiny private /29.
                if net.prefixlen != 29 or not iface.ip.is_private:
                    continue
                hosts = list(net.hosts())
                if not hosts:
                    continue
                dongle = str(hosts[0])  # the .105-equivalent / DHCP server
                if dongle != host_ip and dongle not in neighbours:
                    neighbours.append(dongle)
        finally:
            sock.close()
        return neighbours

    def _candidate_ips(self) -> list[str]:
        """Ordered, de-duplicated candidate dongle IPs: known-good first, then the
        presets, then any NCM-neighbour addresses (custom IPs)."""
        seen: set[str] = set()
        ordered: list[str] = []
        for ip in [*self._known_ips, *SUBNET_IPS.values(), *self._ncm_neighbour_ips()]:
            if ip not in seen:
                seen.add(ip)
                ordered.append(ip)
        return ordered

    async def discover(self) -> dict:
        """Two-stage discovery. Probe every candidate IP with a cheap GET
        /api/status; return one entry per dongle that answers.

        Returns `{ "dongles": [ {ip, subnet, status...}, ... ] }`. The frontend
        owns instance selection; we just report who's there."""
        loop = asyncio.get_event_loop()
        candidates = self._candidate_ips()

        async def probe(ip: str) -> dict | None:
            try:
                status = await loop.run_in_executor(
                    None, self._request, ip, "/api/status", None, PROBE_TIMEOUT
                )
            except (URLError, HTTPError, OSError, ValueError):
                return None
            self._remember(ip)
            return {
                "ip": ip,
                "subnet": IP_SUBNETS.get(ip),
                "status": status,
            }

        results = await asyncio.gather(*(probe(ip) for ip in candidates))
        dongles = [r for r in results if r is not None]
        return {"dongles": dongles}

    # --- API methods (called from the frontend via @decky/api) --------------
    # Each takes an explicit `ip` so the frontend can scope calls to the dongle
    # instance the user picked. The frontend gets these IPs from discover().

    async def get_status(self, ip: str) -> dict:
        """GET /api/status — live battery + connection state."""
        return await self._run(ip, "/api/status")

    async def get_config(self, ip: str) -> dict:
        """GET /api/config — current firmware settings."""
        return await self._run(ip, "/api/config")

    async def set_config(self, ip: str, fields: dict) -> dict:
        """POST /api/config — save a subset of settings. The firmware
        re-validates and clamps every value, so we just pass them through."""
        return await self._run(ip, "/api/config", data=fields)

    async def get_bonds(self, ip: str) -> dict:
        """GET /api/bonds — paired controllers."""
        return await self._run(ip, "/api/bonds")

    async def rename_bond(self, ip: str, addr: str, name: str) -> dict:
        """POST /api/bonds action=rename. `name` <= 15 chars (firmware clamps)."""
        return await self._run(
            ip, "/api/bonds", data={"action": "rename", "addr": addr, "name": name}
        )

    async def forget_bond(self, ip: str, addr: str) -> dict:
        """POST /api/bonds action=forget. Blacklists the address; disconnects
        the live controller if it's the target."""
        return await self._run(ip, "/api/bonds", data={"action": "forget", "addr": addr})

    async def forget_all_bonds(self, ip: str) -> dict:
        """POST /api/bonds action=forgetall."""
        return await self._run(ip, "/api/bonds", data={"action": "forgetall"})

    async def pair_controller(self, ip: str) -> dict:
        """POST /api/bonds action=pair — open a 30 s inquiry window for a new
        controller (in Share + PS mode).

        This disconnects any currently-connected controller (keeping its bond)
        and the NCM link blips as it does, so we fire-and-forget: a short timeout
        with no retries, and a dropped connection is treated as success rather
        than an error (the firmware acted; we just lost the reply to the blip)."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None,
                self._request,
                ip,
                "/api/bonds",
                {"action": "pair"},
                PROBE_TIMEOUT,
            )
        except (URLError, HTTPError, OSError, ValueError) as err:
            # Expected: the link drops mid-request as the controller disconnects.
            decky.logger.info(f"pair on {ip} reply lost (expected blip): {err}")
        return {"_reachable": True, "_ip": ip, "started": True}

    # --- lifecycle ----------------------------------------------------------

    async def _main(self) -> None:
        self.loop = asyncio.get_event_loop()
        decky.logger.info("DS5-Linux-Decky backend started")

    async def _unload(self) -> None:
        decky.logger.info("DS5-Linux-Decky backend unloading")

    async def _uninstall(self) -> None:
        decky.logger.info("DS5-Linux-Decky uninstalled")
