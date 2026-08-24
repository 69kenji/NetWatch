from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Iterable
from dataclasses import dataclass
from urllib.parse import ParseResult, urlparse

import aiohttp
from aiohttp.abc import AbstractResolver


DEFAULT_PORTS = {"http": 80, "https": 443}


def _authority_key(parsed: ParseResult) -> tuple[str, str, int]:
    if parsed.scheme not in DEFAULT_PORTS or not parsed.hostname:
        raise ValueError("URL must use HTTP(S) and include a hostname")
    try:
        port = parsed.port or DEFAULT_PORTS[parsed.scheme]
    except ValueError as exc:
        raise ValueError("URL contains an invalid port") from exc
    return parsed.scheme, parsed.hostname.lower().rstrip("."), port


def authority_key(url: str) -> tuple[str, str, int]:
    return _authority_key(urlparse(str(url or "").strip()))


@dataclass(frozen=True)
class ResolvedHttpTarget:
    url: str
    scheme: str
    hostname: str
    port: int
    addresses: tuple[str, ...]


class PinnedResolver(AbstractResolver):
    """aiohttp resolver that can return only addresses validated beforehand.

    The request URL still contains the original hostname, so HTTP Host and HTTPS
    SNI/certificate validation retain normal hostname semantics while the TCP
    connection is pinned to the DNS answer that passed the SSRF policy.
    """

    def __init__(self, hostname: str, addresses: Iterable[str]):
        self._hostname = hostname.lower().rstrip(".")
        self._addresses = tuple(dict.fromkeys(str(address) for address in addresses))
        if not self._addresses:
            raise ValueError("Pinned resolver requires at least one address")

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[dict]:
        if host.lower().rstrip(".") != self._hostname:
            raise OSError("Pinned resolver refused an unexpected hostname")
        rows: list[dict] = []
        for address in self._addresses:
            ip = ipaddress.ip_address(address)
            address_family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
            if family not in {socket.AF_UNSPEC, 0, address_family}:
                continue
            rows.append({
                "hostname": host,
                "host": address,
                "port": port,
                "family": address_family,
                "proto": socket.IPPROTO_TCP,
                "flags": socket.AI_NUMERICHOST,
            })
        if not rows:
            raise OSError("Pinned resolver has no address for the requested family")
        return rows

    async def close(self) -> None:
        return None


def pinned_connector(target: ResolvedHttpTarget) -> aiohttp.TCPConnector:
    """Return a connector that cannot perform a second unrestricted DNS lookup."""
    return aiohttp.TCPConnector(
        resolver=PinnedResolver(target.hostname, target.addresses),
        use_dns_cache=False,
    )


async def resolve_public_http_target(
    url: str,
    *,
    require_https: bool = False,
    allowed_private_authorities: Iterable[tuple[str, str, int]] = (),
) -> ResolvedHttpTarget:
    """Validate an HTTP(S) target and return the exact addresses that passed.

    Callers making requests to untrusted/provider-supplied URLs should use the
    returned addresses with :func:`pinned_connector`. Merely validating and then
    allowing the HTTP library to resolve the hostname again creates a DNS-rebind
    time-of-check/time-of-use gap.
    """
    candidate = str(url or "").strip()
    parsed = urlparse(candidate)

    if parsed.scheme not in DEFAULT_PORTS:
        raise ValueError("URL must use HTTP or HTTPS")
    if require_https and parsed.scheme != "https":
        raise ValueError("URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL user information is not allowed")

    scheme, hostname, port = _authority_key(parsed)
    key = (scheme, hostname, port)
    allowed = set(allowed_private_authorities)

    addresses: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    try:
        addresses.add(ipaddress.ip_address(hostname))
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            resolved = await loop.getaddrinfo(
                hostname,
                port,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise ValueError(f"Could not resolve download host: {hostname}") from exc

        for _family, _socktype, _proto, _canonname, sockaddr in resolved:
            if not sockaddr:
                continue
            try:
                addresses.add(ipaddress.ip_address(sockaddr[0]))
            except ValueError:
                continue

    if not addresses:
        raise ValueError(f"Could not resolve download host: {hostname}")

    if key not in allowed and any(not address.is_global for address in addresses):
        raise ValueError("Download URL resolves to a non-public network address")

    # Stable ordering keeps tests/logging deterministic while preserving all
    # acceptable A/AAAA answers for normal multi-address hosts.
    rendered = tuple(sorted(str(address) for address in addresses))
    return ResolvedHttpTarget(candidate, scheme, hostname, port, rendered)


async def validate_public_http_url(
    url: str,
    *,
    require_https: bool = False,
    allowed_private_authorities: Iterable[tuple[str, str, int]] = (),
) -> str:
    """Compatibility validator for callers that do not make a later connection."""
    target = await resolve_public_http_target(
        url,
        require_https=require_https,
        allowed_private_authorities=allowed_private_authorities,
    )
    return target.url


async def read_response_limited(response: aiohttp.ClientResponse, max_bytes: int) -> bytes:
    """Read a response while enforcing a hard decoded-payload byte limit."""
    if max_bytes <= 0:
        raise ValueError("Response size limit must be positive")

    content_length = response.content_length
    if content_length is not None and content_length > max_bytes:
        raise ValueError("Response exceeds the size limit")

    payload = bytearray()
    async for chunk in response.content.iter_chunked(min(64 * 1024, max_bytes + 1)):
        if len(payload) + len(chunk) > max_bytes:
            raise ValueError("Response exceeds the size limit")
        payload.extend(chunk)
    return bytes(payload)
