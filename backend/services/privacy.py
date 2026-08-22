from __future__ import annotations

import asyncio
import ipaddress
import socket
from datetime import datetime, timezone

import aiohttp

from config import settings
from services.exceptions import DependencyUnavailableError

# Literal IP endpoints keep the public-IP check independent from DNS. Cloudflare
# serves /cdn-cgi/trace on its 1.1.1.1 service, and the response includes ip=<client>.
PUBLIC_IP_TRACE_URLS = (
    "https://1.1.1.1/cdn-cgi/trace",
    "https://1.0.0.1/cdn-cgi/trace",
)
DNS_TEST_HOST = "api.themoviedb.org"
VPN_INTERFACE = "wg0"


class PrivacyService:
    @staticmethod
    def _interfaces() -> list[str]:
        try:
            return [name for _, name in socket.if_nameindex()]
        except OSError:
            return []

    @staticmethod
    def _trace_ip(body: str) -> str:
        for raw_line in body.splitlines():
            key, separator, value = raw_line.partition("=")
            if separator and key.strip().lower() == "ip":
                return value.strip()
        return ""

    @classmethod
    async def _public_ip_without_dns(cls) -> tuple[str, str]:
        timeout = aiohttp.ClientTimeout(total=max(8.0, settings.DEPENDENCY_TIMEOUT_SECS))
        errors: list[str] = []
        async with aiohttp.ClientSession(
            timeout=timeout,
            headers={"Accept": "text/plain", "User-Agent": "NetWatch/0.1"},
        ) as session:
            for url in PUBLIC_IP_TRACE_URLS:
                try:
                    async with session.get(url, allow_redirects=False) as response:
                        if response.status != 200:
                            errors.append(f"{url}: HTTP {response.status}")
                            continue
                        raw_ip = cls._trace_ip(await response.text())
                        parsed = ipaddress.ip_address(raw_ip)
                        if parsed.version != 4:
                            errors.append(f"{url}: returned non-IPv4 address")
                            continue
                        return str(parsed), url
                except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
                    errors.append(f"{url}: {exc}")

        raise DependencyUnavailableError(
            "vpn-sanity",
            "; ".join(errors) if errors else "public IP trace request failed",
        )

    @staticmethod
    async def _dns_probe() -> tuple[bool, list[str], str | None]:
        try:
            records = await asyncio.wait_for(
                asyncio.to_thread(
                    socket.getaddrinfo,
                    DNS_TEST_HOST,
                    443,
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                ),
                timeout=6.0,
            )
            addresses = sorted({str(record[4][0]) for record in records if record and record[4]})
            if not addresses:
                return False, [], "resolver returned no IPv4 addresses"
            return True, addresses[:8], None
        except (asyncio.TimeoutError, OSError, socket.gaierror) as exc:
            return False, [], str(exc)

    @classmethod
    async def vpn_sanity(cls) -> dict:
        """Report VPN egress and DNS health as two independent signals.

        The external-IP step is DNS-independent. Electron separately runs
        docker/verify-networking.py first, proving backend, Prowlarr, FlareSolverr
        and torrent-engine are attached to the WireGuard namespace and that their
        configured DNS server routes through wg0.
        """
        interfaces = cls._interfaces()
        vpn_present = VPN_INTERFACE in interfaces
        checked_at = datetime.now(timezone.utc).isoformat()

        if not vpn_present:
            return {
                "status": "unsafe",
                "connected": False,
                "vpn_interface": VPN_INTERFACE,
                "vpn_interface_present": False,
                "public_ip": None,
                "checked_at": checked_at,
                "dns_ok": False,
                "dns_host": DNS_TEST_HOST,
                "dns_addresses": [],
                "dns_error": "VPN interface is absent",
                "error": f"{VPN_INTERFACE} is not present; external IP check was not attempted",
            }

        public_ip, source = await cls._public_ip_without_dns()
        dns_ok, dns_addresses, dns_error = await cls._dns_probe()

        return {
            "status": "ok" if dns_ok else "degraded",
            "connected": True,
            "vpn_interface": VPN_INTERFACE,
            "vpn_interface_present": True,
            "public_ip": public_ip,
            "checked_at": checked_at,
            "source": source,
            "dns_ok": dns_ok,
            "dns_host": DNS_TEST_HOST,
            "dns_addresses": dns_addresses,
            "dns_error": dns_error,
            "error": None if dns_ok else "VPN egress is verified, but DNS resolution is currently failing",
        }
