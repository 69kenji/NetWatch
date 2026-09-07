from __future__ import annotations

import asyncio
import json
import time
import unicodedata
from collections import deque
from typing import Any

import aiohttp

from config import settings
from services.exceptions import DependencyUnavailableError
from services.net_safety import read_response_limited


ANILIST_GRAPHQL_URL = "https://graphql.anilist.co"
ANILIST_RESPONSE_LIMIT = 512 * 1024
ANILIST_MAX_REQUESTS_PER_MINUTE = 20
ANILIST_SEARCH_LIMIT = 20
ANILIST_SEARCH_CACHE_TTL = 6 * 60 * 60
ANILIST_SEARCH_CACHE_MAX_ENTRIES = 128

_SEARCH_QUERY = """
query NetWatchAnimeIdentity($search: String!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji english native }
      synonyms
      format
      status
      episodes
      duration
      countryOfOrigin
      startDate { year month day }
      endDate { year month day }
      season
      seasonYear
      isAdult
      relations {
        edges {
          relationType(version: 2)
          node {
            id
            idMal
            title { romaji english native }
            synonyms
            format
            episodes
            countryOfOrigin
            startDate { year month day }
            isAdult
          }
        }
      }
    }
  }
}
"""


def _clean_query(value: str) -> str:
    normalized = unicodedata.normalize("NFC", str(value or ""))
    if any(ord(char) < 32 or ord(char) == 127 for char in normalized):
        raise ValueError("AniList search title contains control characters")
    normalized = " ".join(normalized.split()).strip()
    if not normalized or len(normalized) > 160:
        raise ValueError("AniList search title is invalid")
    return normalized


class AniListService:
    """Small, unauthenticated AniList client used only for anime identity data."""

    _request_times: deque[float] = deque()
    _rate_lock = asyncio.Lock()
    _blocked_until = 0.0
    _search_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    @classmethod
    def _prune_search_cache(cls, now: float) -> None:
        cls._search_cache = {
            key: value for key, value in cls._search_cache.items()
            if value[0] > now
        }
        overflow = len(cls._search_cache) - ANILIST_SEARCH_CACHE_MAX_ENTRIES
        if overflow > 0:
            for key in list(cls._search_cache)[:overflow]:
                cls._search_cache.pop(key, None)

    @classmethod
    def enabled(cls) -> bool:
        return bool(settings.ANILIST_ENRICHMENT_ENABLED)

    @classmethod
    def _timeout(cls) -> aiohttp.ClientTimeout:
        value = max(1.0, min(float(settings.ANILIST_TIMEOUT_SECS), 10.0))
        return aiohttp.ClientTimeout(total=value, connect=min(value, 3.0))

    @classmethod
    async def _reserve_request(cls) -> None:
        async with cls._rate_lock:
            now = time.monotonic()
            if now < cls._blocked_until:
                raise DependencyUnavailableError("anilist", "rate limit cooldown is active")
            cutoff = now - 60.0
            while cls._request_times and cls._request_times[0] <= cutoff:
                cls._request_times.popleft()
            if len(cls._request_times) >= ANILIST_MAX_REQUESTS_PER_MINUTE:
                raise DependencyUnavailableError("anilist", "local request limit reached")
            cls._request_times.append(now)

    @classmethod
    async def search(cls, title: str) -> list[dict[str, Any]]:
        if not cls.enabled():
            return []
        query_title = _clean_query(title)
        cache_key = unicodedata.normalize("NFKC", query_title).casefold()
        now = time.monotonic()
        cls._prune_search_cache(now)
        cached = cls._search_cache.get(cache_key)
        if cached:
            return [dict(item) for item in cached[1]]
        await cls._reserve_request()
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "NetWatch/1.1.2",
        }
        body = {
            "query": _SEARCH_QUERY,
            "variables": {"search": query_title, "perPage": ANILIST_SEARCH_LIMIT},
        }
        try:
            async with aiohttp.ClientSession(timeout=cls._timeout(), headers=headers) as session:
                async with session.post(
                    ANILIST_GRAPHQL_URL,
                    json=body,
                    allow_redirects=False,
                ) as response:
                    if response.status == 429:
                        retry_after = response.headers.get("Retry-After", "60")
                        try:
                            cooldown = max(1.0, min(float(retry_after), 300.0))
                        except ValueError:
                            cooldown = 60.0
                        cls._blocked_until = time.monotonic() + cooldown
                        raise DependencyUnavailableError("anilist", "request was rate limited")
                    if response.status != 200:
                        raise DependencyUnavailableError(
                            "anilist", f"request returned HTTP {response.status}"
                        )
                    content_type = (response.headers.get("Content-Type") or "").lower()
                    if "application/json" not in content_type:
                        raise DependencyUnavailableError("anilist", "returned a non-JSON response")
                    try:
                        raw = await read_response_limited(response, ANILIST_RESPONSE_LIMIT)
                    except ValueError as exc:
                        raise DependencyUnavailableError("anilist", str(exc)) from exc
        except DependencyUnavailableError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("anilist", str(exc) or "request failed") from exc

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DependencyUnavailableError("anilist", "returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise DependencyUnavailableError("anilist", "returned an unexpected response")
        errors = payload.get("errors")
        if errors:
            raise DependencyUnavailableError("anilist", "GraphQL query failed")
        page = (payload.get("data") or {}).get("Page")
        media = page.get("media") if isinstance(page, dict) else None
        if not isinstance(media, list):
            raise DependencyUnavailableError("anilist", "returned an unexpected response")
        result = [item for item in media if isinstance(item, dict)][:ANILIST_SEARCH_LIMIT]
        cls._search_cache[cache_key] = (
            time.monotonic() + ANILIST_SEARCH_CACHE_TTL,
            [dict(item) for item in result],
        )
        cls._prune_search_cache(time.monotonic())
        return result

    @classmethod
    async def health_check(cls) -> dict[str, Any]:
        return {
            "service": "anilist",
            "enabled": cls.enabled(),
            "status": "ready" if cls.enabled() else "disabled",
            "connected": None,
        }
