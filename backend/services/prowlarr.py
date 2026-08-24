import asyncio
import re
from typing import Optional
from urllib.parse import urljoin, urlparse, urlunparse

import aiohttp

from config import settings
from services.exceptions import DependencyUnavailableError
from services.net_safety import authority_key, pinned_connector, read_response_limited, resolve_public_http_target

# Resolution extraction from torrent title
RESOLUTION_PATTERNS = {
    "2160p": re.compile(r"(2160p|4K|UHD)", re.I),
    "1080p": re.compile(r"1080p", re.I),
    "720p": re.compile(r"720p", re.I),
    "480p": re.compile(r"480p", re.I),
}

CODEC_PATTERNS = {
    "x265/HEVC": re.compile(r"(x265|HEVC|H\.265)", re.I),
    "x264/AVC": re.compile(r"(x264|AVC|H\.264)", re.I),
    "AV1": re.compile(r"AV1", re.I),
}

SOURCE_PATTERNS = {
    "BluRay": re.compile(r"(BluRay|BDRip|BRRip)", re.I),
    "WEB-DL": re.compile(r"(WEB-DL|WEBDL)", re.I),
    "WEBRip": re.compile(r"WEBRip", re.I),
    "HDTV": re.compile(r"HDTV", re.I),
    "CAM": re.compile(r"(CAM|HDCAM|TS\b|TELESYNC)", re.I),
}

AUDIO_PATTERNS = {
    "TrueHD Atmos": re.compile(r"TrueHD.Atmos", re.I),
    "DTS-X": re.compile(r"DTS-X", re.I),
    "DTS-HD MA": re.compile(r"DTS-HD.MA", re.I),
    "Dolby Atmos": re.compile(r"(Atmos|DD\+)", re.I),
    "AAC": re.compile(r"AAC", re.I),
    "MP3": re.compile(r"MP3", re.I),
}


def parse_title(title: str) -> dict:
    resolution = next((r for r, p in RESOLUTION_PATTERNS.items() if p.search(title)), "Unknown")
    codec = next((c for c, p in CODEC_PATTERNS.items() if p.search(title)), "Unknown")
    source = next((s for s, p in SOURCE_PATTERNS.items() if p.search(title)), "Unknown")
    audio = next((a for a, p in AUDIO_PATTERNS.items() if p.search(title)), "Unknown")
    return {"resolution": resolution, "codec": codec, "source": source, "audio": audio}


MAX_TORRENT_SOURCE_BYTES = 16 * 1024 * 1024
MAX_ERROR_BODY_BYTES = 4 * 1024


class ProwlarrService:
    BASE = settings.PROWLARR_URL.rstrip("/")

    @classmethod
    def _timeout(cls) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=settings.DEPENDENCY_TIMEOUT_SECS)

    @classmethod
    def _search_timeout(cls) -> aiohttp.ClientTimeout:
        # Search can fan out to multiple indexers. Keep health checks fast, but do
        # not abort a legitimate Prowlarr search at the generic 4-second dependency timeout.
        return aiohttp.ClientTimeout(total=max(5.0, settings.PROWLARR_SEARCH_TIMEOUT_SECS))

    @classmethod
    def _headers(cls) -> dict[str, str]:
        return {"X-Api-Key": settings.PROWLARR_API_KEY}

    @classmethod
    async def health_check(cls) -> dict:
        """Read-only authenticated connectivity check against Prowlarr."""
        result = {
            "service": "prowlarr",
            "url": cls.BASE,
            "connected": False,
            "authenticated": False,
        }

        if not settings.PROWLARR_API_KEY or settings.PROWLARR_API_KEY.startswith("your_"):
            result["status"] = "misconfigured"
            result["error"] = "PROWLARR_API_KEY is not configured"
            return result

        try:
            async with aiohttp.ClientSession(
                timeout=cls._timeout(), headers=cls._headers()
            ) as session:
                async with session.get(f"{cls.BASE}/api/v1/system/status") as response:
                    if response.status in (401, 403):
                        result["status"] = "unauthorized"
                        result["error"] = f"authentication returned HTTP {response.status}"
                        return result
                    if response.status != 200:
                        result["status"] = "unavailable"
                        result["error"] = f"status request returned HTTP {response.status}"
                        return result

                    data = await response.json()
                    result["connected"] = True
                    result["authenticated"] = True
                    result["status"] = "ok"
                    result["version"] = data.get("version")
                    result["app_name"] = data.get("appName")
                    result["instance_name"] = data.get("instanceName")
                    return result
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            result["status"] = "unavailable"
            result["error"] = str(exc)
            return result

    @classmethod
    async def _raw_search(
        cls,
        query: str,
        category: Optional[int],
        max_results: int,
    ) -> list[dict]:
        # Prowlarr's current GET /api/v1/search accepts query, optional categories[]
        # and limit. A category is intentionally optional because some indexers only
        # return results when searched without Prowlarr's standardized category filter.
        params: list[tuple[str, str]] = [
            ("query", query),
            ("limit", str(max_results)),
        ]
        if category is not None:
            params.append(("categories", str(category)))

        try:
            async with aiohttp.ClientSession(
                timeout=cls._search_timeout(), headers=cls._headers()
            ) as session:
                async with session.get(f"{cls.BASE}/api/v1/search", params=params) as response:
                    if response.status in (401, 403):
                        raise DependencyUnavailableError(
                            "prowlarr", f"authentication returned HTTP {response.status}"
                        )
                    if response.status != 200:
                        detail = (await response.text()).strip()
                        suffix = f": {detail[:300]}" if detail else ""
                        raise DependencyUnavailableError(
                            "prowlarr", f"search returned HTTP {response.status}{suffix}"
                        )
                    raw = await response.json()
        except DependencyUnavailableError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("prowlarr", str(exc)) from exc

        if not isinstance(raw, list):
            raise DependencyUnavailableError(
                "prowlarr", "search returned an unexpected non-list response"
            )
        return raw

    @classmethod
    async def search(
        cls,
        query: str,
        imdb_id: Optional[str] = None,
        category: Optional[int] = None,
        resolution_filter: Optional[str] = None,
        min_seeders: int = 0,
        max_results: int = 50,
    ) -> list[dict]:
        if not settings.PROWLARR_API_KEY or settings.PROWLARR_API_KEY.startswith("your_"):
            raise DependencyUnavailableError("prowlarr", "PROWLARR_API_KEY is not configured")

        # `imdbId` is not a parameter on Prowlarr's current GET /api/v1/search.
        # Keep it in our public signature for the future metadata layer, but do not send
        # unsupported query parameters to Prowlarr here.
        _ = imdb_id

        raw = await cls._raw_search(query, category, max_results)
        # If a caller explicitly requested a category and an indexer returns nothing,
        # retry once without categories. This mirrors Prowlarr UI behavior more closely
        # across indexers with imperfect category mappings.
        if category is not None and not raw:
            raw = await cls._raw_search(query, None, max_results)

        results = []
        for item in raw:
            seeders = int(item.get("seeders") or 0)
            leechers = int(item.get("leechers") or 0)
            if seeders < min_seeders:
                continue

            title = item.get("title") or ""
            parsed = parse_title(title)
            if resolution_filter and parsed["resolution"] != resolution_filter:
                continue

            # Prefer Prowlarr's grab/download URL when it is available. It may
            # resolve to an actual .torrent (with metadata immediately available),
            # while magnetUrl is necessarily metadata-less. The resolver below
            # already handles download URLs that ultimately redirect to a magnet,
            # so choosing downloadUrl first preserves that upside without losing
            # compatibility with magnet-only indexers.
            source_url = item.get("downloadUrl") or item.get("magnetUrl")
            if not source_url:
                continue

            source_type = "magnet" if source_url.lower().startswith("magnet:?") else "torrent_url"
            info_hash = (item.get("infoHash") or "").strip().lower() or None
            results.append({
                "title": title,
                # This raw provider URL is internal-only. ReleaseSearchService
                # replaces it with an opaque reference before API serialization.
                "source_url": source_url,
                "source_type": source_type,
                "info_hash": info_hash,
                "size": int(item.get("size") or 0),
                "seeders": seeders,
                "leechers": leechers,
                "indexer": item.get("indexer") or "",
                "indexer_id": item.get("indexerId"),
                "published": item.get("publishDate") or "",
                **parsed,
            })

        res_order = ["2160p", "1080p", "720p", "480p", "Unknown"]
        results.sort(key=lambda item: (res_order.index(item["resolution"]), -item["seeders"]))
        return results

    @classmethod
    def _normalize_download_url(cls, source_url: str) -> str:
        """Make Prowlarr-local download URLs reachable from the backend container."""
        absolute = urljoin(f"{cls.BASE}/", source_url)
        parsed = urlparse(absolute)
        base = urlparse(cls.BASE)

        # Prowlarr may emit localhost URLs based on how its UI was accessed. Inside the
        # backend container localhost is the backend itself, so rewrite only loopback
        # Prowlarr URLs to the configured Docker service authority.
        if parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
            parsed = parsed._replace(scheme=base.scheme, netloc=base.netloc)
            return urlunparse(parsed)
        return absolute

    @classmethod
    async def resolve_torrent_source(cls, source_url: str) -> dict:
        """Resolve a Prowlarr download URL to either a magnet URI or .torrent bytes.

        Some torrent indexers expose only Prowlarr's ``downloadUrl`` in search results,
        but that URL may respond with an HTTP redirect whose Location is ``magnet:?``
        instead of a .torrent file. Treat that as a valid torrent source rather than
        attempting to make an HTTP request to the magnet URI.
        """
        if not settings.PROWLARR_API_KEY or settings.PROWLARR_API_KEY.startswith("your_"):
            raise DependencyUnavailableError("prowlarr", "PROWLARR_API_KEY is not configured")

        if source_url.lower().startswith("magnet:?"):
            return {"source_type": "magnet", "magnet": source_url}

        url = cls._normalize_download_url(source_url)
        base = urlparse(cls.BASE)
        try:
            prowlarr_authority = authority_key(cls.BASE)
        except ValueError as exc:
            raise DependencyUnavailableError("prowlarr", f"Invalid PROWLARR_URL: {exc}") from exc

        def headers_for(candidate_url: str) -> dict[str, str]:
            target = urlparse(candidate_url)
            same_prowlarr = (
                target.scheme == base.scheme
                and target.hostname == base.hostname
                and (target.port or (443 if target.scheme == "https" else 80))
                == (base.port or (443 if base.scheme == "https" else 80))
            )
            return cls._headers() if same_prowlarr else {}

        timeout = aiohttp.ClientTimeout(total=max(settings.DEPENDENCY_TIMEOUT_SECS, 30.0))
        try:
            current_url = url
            for _ in range(6):
                if current_url.lower().startswith("magnet:?"):
                    return {"source_type": "magnet", "magnet": current_url}

                parsed_current = urlparse(current_url)
                if parsed_current.scheme not in {"http", "https"}:
                    raise DependencyUnavailableError(
                        "prowlarr",
                        f"torrent download redirected to unsupported URI scheme: {parsed_current.scheme or 'none'}",
                    )
                try:
                    target = await resolve_public_http_target(
                        current_url,
                        allowed_private_authorities={prowlarr_authority},
                    )
                except ValueError as exc:
                    raise DependencyUnavailableError(
                        "prowlarr", f"Unsafe torrent download URL: {exc}"
                    ) from exc

                # A fresh pinned connector is created for each redirect hop. The
                # request hostname is preserved for Host/SNI, but aiohttp can only
                # connect to the addresses that were just validated above.
                async with aiohttp.ClientSession(
                    timeout=timeout, connector=pinned_connector(target)
                ) as session:
                    async with session.get(
                        current_url,
                        headers=headers_for(current_url),
                        allow_redirects=False,
                    ) as response:
                        if response.status in {301, 302, 303, 307, 308}:
                            location = response.headers.get("Location")
                            if not location:
                                raise DependencyUnavailableError(
                                    "prowlarr", "torrent download redirect did not include Location"
                                )
                            next_url = urljoin(current_url, location)
                            if location.lower().startswith("magnet:?"):
                                next_url = location
                            if next_url.lower().startswith("magnet:?"):
                                return {"source_type": "magnet", "magnet": next_url}
                            current_url = next_url
                            continue
                        if response.status in (401, 403):
                            raise DependencyUnavailableError(
                                "prowlarr", f"torrent download authentication returned HTTP {response.status}"
                            )
                        if response.status != 200:
                            try:
                                detail_bytes = await read_response_limited(response, MAX_ERROR_BODY_BYTES)
                            except ValueError:
                                detail_bytes = b""
                            detail = detail_bytes.decode("utf-8", errors="replace").strip()
                            suffix = f": {detail[:300]}" if detail else ""
                            raise DependencyUnavailableError(
                                "prowlarr", f"torrent download returned HTTP {response.status}{suffix}"
                            )

                        try:
                            payload = await read_response_limited(response, MAX_TORRENT_SOURCE_BYTES)
                        except ValueError as exc:
                            raise DependencyUnavailableError(
                                "prowlarr", "torrent download exceeded the size limit"
                            ) from exc
                        # A few indexers return a magnet URI as a successful text response
                        # instead of redirecting to it. Accept that form as well.
                        text_candidate = payload.decode("utf-8", errors="ignore").strip()
                        if text_candidate.lower().startswith("magnet:?"):
                            return {"source_type": "magnet", "magnet": text_candidate}
                        if not payload or not payload.startswith(b"d"):
                            raise DependencyUnavailableError(
                                "prowlarr", "download URL did not return a magnet URI or bencoded .torrent file"
                            )
                        return {"source_type": "torrent_file", "torrent_bytes": payload}
            raise DependencyUnavailableError(
                "prowlarr", "torrent download exceeded redirect limit"
            )
        except DependencyUnavailableError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("prowlarr", str(exc)) from exc
