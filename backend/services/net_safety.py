import asyncio
import ipaddress
import socket
from collections.abc import Iterable
from urllib.parse import ParseResult, urlparse

import aiohttp


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


async def validate_public_http_url(
    url: str,
    *,
    require_https: bool = False,
    allowed_private_authorities: Iterable[tuple[str, str, int]] = (),
) -> str:
    """Reject HTTP(S) targets that resolve to non-public network addresses.

    A small explicit authority allowlist is supported for Docker-internal services
    such as Prowlarr. Everything else must resolve only to globally routable IPs.
    Validation is repeated by callers before each redirect hop.
    """
    candidate = str(url or "").strip()
    parsed = urlparse(candidate)

    if parsed.scheme not in DEFAULT_PORTS:
        raise ValueError("URL must use HTTP or HTTPS")
    if require_https and parsed.scheme != "https":
        raise ValueError("URL must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL user information is not allowed")

    key = _authority_key(parsed)
    allowed = set(allowed_private_authorities)
    if key in allowed:
        return candidate

    _scheme, hostname, port = key
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

    if any(not address.is_global for address in addresses):
        raise ValueError("Download URL resolves to a non-public network address")

    return candidate


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
