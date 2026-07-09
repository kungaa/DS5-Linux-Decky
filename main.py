import asyncio
import ipaddress
import json
import os
import socket
import struct
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.error import URLError, HTTPError

import decky

# DS5-Linux-Bridge dongle HTTP API client.
#
# The dongle runs a tiny HTTP server exposing a small REST-ish API. There are two
# firmware generations, reachable in different places on the network; the API
# *contract* is identical across both once you have an IP.
#
#   Gen A (current, WiFi): the dongle joins the user's home WiFi and serves the
#     API on the LAN. It advertises over mDNS as `ds5.local` by default, but the
#     name is user-renameable and the IP is a plain DHCP lease, so there is no
#     fixed address to hardcode. Discover it by mDNS name, then by sweeping the
#     Deck's own LAN subnet(s) to catch renamed dongles.
#
#   Gen B (older, USB-NCM): the dongle enumerates as a USB CDC-NCM network
#     adapter and is its own DHCP server on a private /29 link, sitting at a
#     fixed `.105`-equivalent. Discover it by probing the three presets, then by
#     enumerating the host's USB-NCM NICs and probing their /29 neighbours (to
#     catch custom NCM addresses).
#
# Multiple dongles can be present at once, each on its own address and each an
# independent `/api/*` instance. The plugin owns the multi-instance UX; there is
# no cross-dongle aggregation in firmware.
#
# Reference: DECKY_PLUGIN_HANDOVER.md (the firmware HTTP API contract).

# Gen B: candidate dongle IPs, indexed by `webconfig_subnet`. These (and any
# custom NCM address, found via _ncm_neighbour_ips) are probed in the *fast*
# discovery tier alongside the cached IPs and mDNS — a legacy USB dongle on a
# default subnet is found without any LAN sweep, and once reached its address is
# cached/persisted just like a Gen-A dongle. Only the Gen-A LAN sweep (for
# *renamed* WiFi dongles) is deferred to the deep tier.
SUBNET_IPS = {
    0: "10.55.55.105",
    1: "172.31.55.105",
    2: "192.168.137.105",
}

# Reverse map: IP -> subnet index, for reporting which NCM subnet answered.
IP_SUBNETS = {ip: idx for idx, ip in SUBNET_IPS.items()}

# Gen A default mDNS name. User-renameable via the `hostname` config field.
MDNS_DEFAULT_HOST = "ds5.local"

# Keep requests short — lwIP's PCB pool is lean and serves one file at a time.
HTTP_TIMEOUT = 2.0

# A sweep probe must be snappy, since we may probe hundreds of addresses in
# parallel during a LAN sweep. Keep it in the ~200-300ms range the handover
# recommends for sweeps.
PROBE_TIMEOUT = 0.3

# The fast tier probes only a handful of known/mDNS/preset IPs, so it can afford
# a more generous timeout — a real dongle answering slowly over a busy WiFi
# shouldn't be a false negative there.
FAST_PROBE_TIMEOUT = 1.0

# Cap the fan-out of a subnet sweep so we don't open hundreds of sockets at once
# (and so we stay gentle on the network). This is the size of the dedicated
# probe thread pool: the default asyncio executor is tiny (~min(32, cpu+4), i.e.
# ~10 threads on the Deck), which serialises a sweep into many slow batches. We
# run blocking short-timeout socket probes, so a wide thread pool is exactly what
# we want — a /24 (254 hosts) at 0.3s completes in ~2s instead of ~8s+.
SWEEP_CONCURRENCY = 128

# Only sweep reasonably small home LANs. A /24 is 254 hosts; anything larger than
# this many hosts we skip (don't sweep a /16). 2 ** (32 - 22) = 1024.
SWEEP_MAX_HOSTS = 1024

# Transient failures can happen right after a controller (re)connects on Gen B:
# the USB-NCM link briefly re-enumerates on the full<->minimal descriptor swap
# and SteamOS NetworkManager may not have re-taken its DHCP lease yet. Retry a
# couple of times with a short gap (staying under the ~1/sec rate the firmware
# tolerates) before declaring the dongle unreachable. Gen A (WiFi) has no such
# blip, but the retry is harmless there.
RETRY_ATTEMPTS = 3
RETRY_GAP_S = 0.4


class Plugin:
    def __init__(self) -> None:
        # IPs we've successfully reached a dongle on, most-recent-first. Used to
        # bias discovery (a DHCP lease is usually stable, so re-probe last-known
        # first) and to keep a per-call request cheap (no re-probe). Persisted to
        # disk so a QAM cycle / reboot re-probes the cached IP first (instant hit)
        # instead of paying for a full LAN sweep every time.
        self._known_ips: list[str] = []
        # A dedicated wide thread pool for probes, so a subnet sweep actually runs
        # ~SWEEP_CONCURRENCY blocking socket calls in parallel (the default
        # asyncio executor is far too small for this). Created in _main.
        self._probe_pool: ThreadPoolExecutor | None = None

    # --- persistence --------------------------------------------------------

    def _known_ips_path(self) -> str:
        """Path to the persisted known-IPs cache in the plugin's settings dir."""
        base = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "/tmp")
        return os.path.join(base, "known_ips.json")

    def _load_known_ips(self) -> None:
        """Load the persisted known-IP list (best-effort; ignore any problem)."""
        try:
            with open(self._known_ips_path(), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                self._known_ips = [ip for ip in data if isinstance(ip, str)]
        except (OSError, ValueError):
            pass

    def _save_known_ips(self) -> None:
        """Persist the known-IP list (best-effort; ignore any problem)."""
        try:
            os.makedirs(os.path.dirname(self._known_ips_path()), exist_ok=True)
            with open(self._known_ips_path(), "w", encoding="utf-8") as fh:
                json.dump(self._known_ips[:8], fh)
        except OSError:
            pass

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
        a controller (re)connects on Gen B where the NCM link is re-enumerating
        and SteamOS NetworkManager hasn't re-leased an address yet."""
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

        decky.logger.info(f"dongle {ip} unreachable on {path}: {last_err}")
        return {
            "_reachable": False,
            "_ip": ip,
            "_subnet": IP_SUBNETS.get(ip),
            "_error": str(last_err) if last_err else None,
        }

    def _remember(self, ip: str) -> None:
        """Move `ip` to the front of the known list (most-recently-reached) and
        persist, so the next launch re-probes it first and skips the sweep."""
        if self._known_ips and self._known_ips[0] == ip:
            return  # already front; no reorder, no write
        if ip in self._known_ips:
            self._known_ips.remove(ip)
        self._known_ips.insert(0, ip)
        self._save_known_ips()

    def _pool(self) -> ThreadPoolExecutor | None:
        """The dedicated probe pool (falls back to the default executor if the
        plugin's _main hasn't created it yet)."""
        return self._probe_pool

    # --- discovery: Gen A (WiFi) --------------------------------------------

    def _mdns_resolve(self, name: str = MDNS_DEFAULT_HOST) -> list[str]:
        """Resolve a `.local` name to IPv4 address(es) via a one-shot multicast
        DNS query. Stdlib-only: we craft an A-record query and read unicast/
        multicast answers off 224.0.0.251:5353.

        Returns every distinct A address that answered (usually one). Empty if
        nothing responds within a short window."""
        labels = name.rstrip(".").split(".")
        if not labels:
            return []

        # Build a minimal DNS query: header + QNAME + QTYPE(A)/QCLASS(IN).
        # ID 0, flags 0 (standard query, not truncated). QU bit unset -> answers
        # may come back multicast; we listen on the group so either works.
        header = struct.pack(">HHHHHH", 0x0000, 0x0000, 1, 0, 0, 0)
        qname = b"".join(
            struct.pack(">B", len(l)) + l.encode("ascii", "ignore") for l in labels
        ) + b"\x00"
        question = qname + struct.pack(">HH", 0x0001, 0x0001)  # A / IN
        query = header + question

        addrs: list[str] = []
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            # Co-bind with the system mDNS responder (avahi) where the platform
            # supports it, so port 5353 isn't exclusively held.
            if hasattr(socket, "SO_REUSEPORT"):
                try:
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
                except OSError:
                    pass
            try:
                sock.bind(("", 5353))
                # Join the mDNS group so we also catch multicast answers.
                mreq = struct.pack("=4sl", socket.inet_aton("224.0.0.251"), socket.INADDR_ANY)
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            except OSError:
                # Port 5353 may already be in use (a system mDNS responder). Fall
                # back to an ephemeral port; we'll still receive unicast answers.
                pass
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            sock.settimeout(0.4)
            try:
                sock.sendto(query, ("224.0.0.251", 5353))
            except OSError as err:
                decky.logger.info(f"mDNS query send failed: {err}")
                return addrs

            # Collect answers for a short window.
            import time as _time

            deadline = 0.8
            start = _time.monotonic()
            while _time.monotonic() - start < deadline:
                try:
                    data, _ = sock.recvfrom(2048)
                except socket.timeout:
                    break
                except OSError:
                    break
                for a in self._parse_mdns_a(data, name):
                    if a not in addrs:
                        addrs.append(a)
                if addrs:
                    break
        finally:
            sock.close()
        return addrs

    @staticmethod
    def _parse_mdns_a(data: bytes, want_name: str) -> list[str]:
        """Extract A-record IPv4 addresses from a DNS response packet. Lenient:
        we don't fully match the queried name (mDNS packets can carry extra
        records), we just harvest every A record's address. Returns [] on any
        parse issue."""
        out: list[str] = []
        try:
            if len(data) < 12:
                return out
            (_id, _flags, qd, an, ns, ar) = struct.unpack(">HHHHHH", data[:12])
            pos = 12

            def skip_name(p: int) -> int:
                while p < len(data):
                    length = data[p]
                    if length == 0:
                        return p + 1
                    if length & 0xC0 == 0xC0:  # compression pointer
                        return p + 2
                    p += 1 + length
                return p

            # Skip the question section.
            for _ in range(qd):
                pos = skip_name(pos)
                pos += 4  # QTYPE + QCLASS

            total_rr = an + ns + ar
            for _ in range(total_rr):
                pos = skip_name(pos)
                if pos + 10 > len(data):
                    break
                rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[pos : pos + 10])
                pos += 10
                if rtype == 1 and rdlen == 4 and pos + 4 <= len(data):  # A record
                    out.append(socket.inet_ntoa(data[pos : pos + 4]))
                pos += rdlen
        except (struct.error, IndexError, OSError):
            return out
        return out

    def _lan_sweep_ips(self) -> list[str]:
        """Enumerate the host's own IPv4 interfaces and, for each private LAN the
        Deck is on, return the sweepable host range (excluding the Deck's own
        address). This catches Gen-A dongles that the user renamed, so mDNS-by-
        name alone would miss them.

        We only sweep small-enough private subnets (<= SWEEP_MAX_HOSTS) and skip
        the tiny /29 NCM links (those are handled by _ncm_neighbour_ips)."""
        candidates: list[str] = []
        seen: set[str] = set()
        for host_ip, netmask in self._host_ipv4s():
            try:
                iface = ipaddress.ip_interface(f"{host_ip}/{netmask}")
            except ValueError:
                continue
            net = iface.network
            if not iface.ip.is_private or iface.ip.is_loopback:
                continue
            # Skip the NCM /29 links (handled separately) and anything too big.
            if net.prefixlen >= 29 or net.num_addresses > SWEEP_MAX_HOSTS:
                continue
            for h in net.hosts():
                s = str(h)
                if s == host_ip or s in seen:
                    continue
                seen.add(s)
                candidates.append(s)
        return candidates

    # --- discovery: Gen B (USB-NCM) -----------------------------------------

    def _host_ipv4s(self) -> list[tuple[str, str]]:
        """Return (ip, netmask) for every up IPv4 interface on the host, via
        SIOCGIFADDR/SIOCGIFNETMASK. Linux + stdlib only."""
        import fcntl

        out: list[tuple[str, str]] = []
        try:
            names = socket.if_nameindex()
        except OSError:
            return out

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
                out.append((host_ip, netmask))
        finally:
            sock.close()
        return out

    def _ncm_neighbour_ips(self) -> list[str]:
        """Enumerate the host's IPv4 interfaces and, for each that looks like a
        link-local /29 USB-NCM segment, return the dongle's address on it.

        The dongle is the DHCP server and always takes the `.105`-equivalent (the
        first host address of its /29). This finds Gen-B dongles on *custom* IPs
        that aren't in the preset list."""
        neighbours: list[str] = []
        for host_ip, netmask in self._host_ipv4s():
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
        return neighbours

    # --- discovery: orchestration -------------------------------------------

    async def _probe_many(
        self, ips: list[str], timeout: float = PROBE_TIMEOUT
    ) -> list[dict]:
        """Probe a de-duplicated list of candidate IPs in parallel and return one
        entry per dongle that answers `GET /api/status`. Fetches `/api/config`
        for each hit too (generation + capability flags + friendly name).

        `timeout` is per probe: the fast tier (few known/mDNS IPs) can afford a
        more generous timeout so a real dongle answering slowly over a busy WiFi
        isn't a false negative; the wide LAN sweep stays snappy."""
        loop = asyncio.get_event_loop()
        pool = self._pool()
        sem = asyncio.Semaphore(SWEEP_CONCURRENCY)

        async def probe(ip: str) -> dict | None:
            async with sem:
                try:
                    status = await loop.run_in_executor(
                        pool, self._request, ip, "/api/status", None, timeout
                    )
                except (URLError, HTTPError, OSError, ValueError):
                    return None
            self._remember(ip)
            config: dict = {}
            try:
                config = await loop.run_in_executor(
                    pool, self._request, ip, "/api/config", None, HTTP_TIMEOUT
                )
            except (URLError, HTTPError, OSError, ValueError):
                config = {}
            return {
                "ip": ip,
                "subnet": IP_SUBNETS.get(ip),
                "gen": self._gen_of(config),
                "status": status,
                "config": config,
            }

        results = await asyncio.gather(*(probe(ip) for ip in ips))
        return [r for r in results if r is not None]

    @staticmethod
    def _dedup(*groups: list[str]) -> list[str]:
        """Flatten candidate groups, dropping blanks and duplicates, preserving
        first-seen (priority) order."""
        seen: set[str] = set()
        ordered: list[str] = []
        for group in groups:
            for ip in group:
                if ip and ip not in seen:
                    seen.add(ip)
                    ordered.append(ip)
        return ordered

    async def discover(self, deep: bool = False) -> dict:
        """Discover dongles across both firmware generations. Returns one entry
        per instance that answers, plus `_deep` (whether a full LAN sweep ran).

        Two tiers, because the LAN sweep is the only slow part:
          - Fast (default): known-good IPs (a lease is usually stable, and we
            persist them across launches), Gen-A mDNS `ds5.local`, Gen-B NCM
            presets + neighbours. A handful of probes; ~1-2s worst case. This
            alone catches the common cases: cached dongle, default-named dongle,
            USB dongle.
          - Deep (`deep=True`): additionally sweep the Deck's own home-LAN
            subnet(s) to find Gen-A dongles the user *renamed* (so mDNS-by-name
            misses them). This is the 254-host part; the frontend triggers it on
            the explicit Search button, and the fast path auto-escalates to it
            when it finds nothing.

        Returns `{ "dongles": [...], "_deep": bool }`."""
        loop = asyncio.get_event_loop()
        pool = self._pool()

        # Fast candidates: cheap and few. mDNS + interface enumeration are
        # blocking, so run them off the event loop.
        mdns, ncm_neighbours = await asyncio.gather(
            loop.run_in_executor(pool, self._mdns_resolve),
            loop.run_in_executor(pool, self._ncm_neighbour_ips),
        )
        fast_ips = self._dedup(
            self._known_ips, mdns, list(SUBNET_IPS.values()), ncm_neighbours
        )
        dongles = await self._probe_many(fast_ips, timeout=FAST_PROBE_TIMEOUT)

        # Escalate to a full LAN sweep only when asked, or when the cheap tier
        # found nothing (so a first-run renamed dongle is still discovered).
        did_deep = False
        if deep or not dongles:
            did_deep = True
            lan = await loop.run_in_executor(pool, self._lan_sweep_ips)
            already = {d["ip"] for d in dongles}
            sweep_ips = [ip for ip in self._dedup(lan) if ip not in already]
            dongles.extend(await self._probe_many(sweep_ips))

        return {"dongles": dongles, "_deep": did_deep}

    @staticmethod
    def _gen_of(config: dict) -> str:
        """Classify a dongle from its /api/config. Gen A (WiFi) advertises
        `wifi_capable`/`wol_capable`; Gen B carries `webconfig_subnet` and none
        of the WiFi fields. Default to 'A' when ambiguous (current firmware)."""
        if config.get("wifi_capable") or config.get("wol_capable"):
            return "A"
        if "webconfig_subnet" in config:
            return "B"
        return "A"

    # --- API methods (called from the frontend via @decky/api) --------------
    # Each takes an explicit `ip` so the frontend can scope calls to the dongle
    # instance the user picked. The frontend gets these IPs from discover().

    async def get_status(self, ip: str) -> dict:
        """GET /api/status — live battery + connection state."""
        return await self._run(ip, "/api/status")

    async def get_config(self, ip: str) -> dict:
        """GET /api/config — current firmware settings (+ capability flags)."""
        return await self._run(ip, "/api/config")

    async def set_config(self, ip: str, fields: dict) -> dict:
        """POST /api/config — save a subset of settings. The firmware
        re-validates and clamps every value, and ignores unknown fields, so we
        just pass them through (safe across generations)."""
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

        This disconnects any currently-connected controller (keeping its bond).
        On Gen B the NCM link blips as it does, so we fire-and-forget: a short
        timeout with no retries, and a dropped connection is treated as success
        rather than an error (the firmware acted; we just lost the reply). On
        Gen A there's no blip, but the same fire-and-forget is fine."""
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
            decky.logger.info(f"pair on {ip} reply lost (expected blip): {err}")
        return {"_reachable": True, "_ip": ip, "started": True}

    # --- Gen-A only: Wake-on-LAN & network ----------------------------------

    async def wol_wake(self, ip: str, mac: str | None = None) -> dict:
        """POST /api/wol action=wake. With no `mac`, fires a magic packet at
        every stored target (wol_target_mac + wol_target_mac2). With `mac`, wakes
        that one explicit target. No-op in firmware if no target is configured."""
        data = {"action": "wake"}
        if mac:
            data["mac"] = mac
        return await self._run(ip, "/api/wol", data=data)

    async def resolve_mac_start(self, ip: str, target_ip: str) -> dict:
        """POST /api/resolve_mac (ip=A.B.C.D) — start a two-step ARP lookup to
        fill a WOL target MAC from an IP. Poll resolve_mac_poll for the result."""
        return await self._run(ip, "/api/resolve_mac", data={"ip": target_ip})

    async def resolve_mac_poll(self, ip: str) -> dict:
        """GET /api/resolve_mac — poll the in-flight ARP lookup:
        {"pending":true} while resolving, then
        {"pending":false,"ok":true,"mac":"AABBCCDDEEFF"} or
        {"pending":false,"ok":false}."""
        return await self._run(ip, "/api/resolve_mac")

    async def wifi_reset(self, ip: str) -> dict:
        """POST /api/wifi_reset action=reset — clear saved WiFi creds and reboot
        into DS5-Setup-XXXX onboarding AP mode. DESTRUCTIVE to connectivity: the
        dongle drops off the LAN and must be re-onboarded. There's no un-reset.

        The dongle reboots as it acts, so the reply is often lost; treat a
        dropped connection as success (fire-and-forget)."""
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(
                None,
                self._request,
                ip,
                "/api/wifi_reset",
                {"action": "reset"},
                PROBE_TIMEOUT,
            )
        except (URLError, HTTPError, OSError, ValueError) as err:
            decky.logger.info(f"wifi_reset on {ip} reply lost (expected reboot): {err}")
        return {"_reachable": True, "_ip": ip, "started": True}

    # --- lifecycle ----------------------------------------------------------

    async def _main(self) -> None:
        self.loop = asyncio.get_event_loop()
        self._probe_pool = ThreadPoolExecutor(
            max_workers=SWEEP_CONCURRENCY, thread_name_prefix="ds5-probe"
        )
        self._load_known_ips()
        decky.logger.info(
            f"DS5-Linux-Decky backend started (cached IPs: {self._known_ips})"
        )

    async def _unload(self) -> None:
        if self._probe_pool is not None:
            self._probe_pool.shutdown(wait=False)
            self._probe_pool = None
        decky.logger.info("DS5-Linux-Decky backend unloading")

    async def _uninstall(self) -> None:
        decky.logger.info("DS5-Linux-Decky uninstalled")
