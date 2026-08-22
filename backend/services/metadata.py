import asyncio
import json
import re
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import aiohttp

from config import settings
from services.catalog_policy import is_explicit_content, is_indian_production, recent_origin_allowed, recent_score
from services.exceptions import DependencyUnavailableError

TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p"
LOCAL_IMAGE_BASE = "http://127.0.0.1:8000/api/metadata/image"
TMDB_IMAGE_SIZES = {"w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "original"}
_V3_KEY_RE = re.compile(r"^[0-9a-fA-F]{32}$")
ANIMATION_GENRE_ID = 16


def image(path: Optional[str], size: str) -> Optional[str]:
    """Return a local image-proxy URL so Electron never contacts TMDB directly."""
    if not path:
        return None
    normalized_size = size if size in TMDB_IMAGE_SIZES else "w500"
    filename = str(path).lstrip("/")
    return f"{LOCAL_IMAGE_BASE}/{normalized_size}/{quote(filename, safe='._-')}"


def poster(path: Optional[str], size: str = "w500") -> Optional[str]:
    return image(path, size)


def backdrop(path: Optional[str], size: str = "w1280") -> Optional[str]:
    return image(path, size)


def logo(path: Optional[str]) -> Optional[str]:
    return image(path, "original")


class MetadataService:
    _home_cache: Optional[dict] = None
    _home_cache_expires_at: float = 0.0
    HOME_CACHE_TTL_SECS = 43_200.0
    HOME_CACHE_SCHEMA_VERSION = 1
    HOME_CACHE_FILENAME = "home-v1.json"
    CATALOG_ENRICHMENT_TTL_SECS = 21_600.0
    GENRE_CACHE_TTL_SECS = 86_400.0
    RECENT_WINDOW_DAYS = 120
    _catalog_enrichment_cache: dict[tuple[str, int], tuple[float, dict]] = {}
    _genre_cache: dict[str, tuple[float, list[dict]]] = {}

    @classmethod
    def _cache_dir(cls) -> Optional[Path]:
        raw = (settings.NETWATCH_CACHE_DIR or "").strip()
        return Path(raw) if raw else None

    @classmethod
    def _home_cache_path(cls) -> Optional[Path]:
        root = cls._cache_dir()
        return (root / cls.HOME_CACHE_FILENAME) if root else None

    @staticmethod
    def _clone_home_payload(payload: dict) -> dict:
        return {
            key: [dict(item) for item in value]
            for key, value in payload.items()
            if isinstance(value, list)
        }

    @classmethod
    def _load_persistent_home_cache(cls) -> Optional[tuple[dict, float]]:
        path = cls._home_cache_path()
        if path is None or not path.is_file():
            return None
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(envelope, dict):
                return None
            if int(envelope.get("schema_version") or 0) != cls.HOME_CACHE_SCHEMA_VERSION:
                return None
            cached_at = float(envelope.get("cached_at_epoch") or 0)
            age = max(0.0, time.time() - cached_at)
            if cached_at <= 0 or age >= cls.HOME_CACHE_TTL_SECS:
                return None
            payload = envelope.get("payload")
            required = {"movies", "recent_movies", "tv", "recent_tv", "anime", "recent_anime"}
            if not isinstance(payload, dict) or not required.issubset(payload):
                return None
            if not all(isinstance(payload.get(key), list) for key in required):
                return None
            return cls._clone_home_payload(payload), cls.HOME_CACHE_TTL_SECS - age
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None

    @classmethod
    def _store_persistent_home_cache(cls, payload: dict) -> None:
        path = cls._home_cache_path()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            envelope = {
                "schema_version": cls.HOME_CACHE_SCHEMA_VERSION,
                "cached_at_epoch": time.time(),
                "cached_at": datetime.now(timezone.utc).isoformat(),
                "ttl_seconds": int(cls.HOME_CACHE_TTL_SECS),
                "payload": cls._clone_home_payload(payload),
            }
            data = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".home-cache-", suffix=".tmp", delete=False) as handle:
                handle.write(data)
                temp_path = Path(handle.name)
            temp_path.replace(path)
        except OSError:
            # Caching is an optimization. A read-only/full cache directory must
            # never make TMDB catalog browsing unavailable.
            return

    @classmethod
    def _credential(cls) -> str:
        return (settings.TMDB_API_KEY or "").strip()

    @classmethod
    def _configured(cls) -> bool:
        key = cls._credential()
        return bool(key and not key.startswith("your_"))

    @classmethod
    def _timeout(cls) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=max(10.0, settings.DEPENDENCY_TIMEOUT_SECS))

    @classmethod
    def _auth(cls, params: Optional[dict[str, Any]] = None) -> tuple[dict[str, str], dict[str, Any]]:
        key = cls._credential()
        if not cls._configured():
            raise DependencyUnavailableError("tmdb", "TMDB_API_KEY is not configured")

        merged = dict(params or {})
        headers = {"Accept": "application/json"}
        if _V3_KEY_RE.fullmatch(key):
            merged["api_key"] = key
        else:
            headers["Authorization"] = f"Bearer {key}"
        return headers, merged

    @classmethod
    async def _get(cls, path: str, params: Optional[dict[str, Any]] = None) -> dict:
        headers, query = cls._auth(params)
        try:
            async with aiohttp.ClientSession(timeout=cls._timeout(), headers=headers) as session:
                async with session.get(f"{TMDB_BASE}{path}", params=query) as response:
                    if response.status in (401, 403):
                        raise DependencyUnavailableError(
                            "tmdb", f"authentication returned HTTP {response.status}"
                        )
                    if response.status == 404:
                        raise ValueError("TMDB item was not found")
                    if response.status != 200:
                        detail = (await response.text()).strip()
                        suffix = f": {detail[:300]}" if detail else ""
                        raise DependencyUnavailableError(
                            "tmdb", f"request returned HTTP {response.status}{suffix}"
                        )
                    payload = await response.json()
        except (DependencyUnavailableError, ValueError):
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("tmdb", str(exc)) from exc

        if not isinstance(payload, dict):
            raise DependencyUnavailableError("tmdb", "returned an unexpected response")
        return payload


    @classmethod
    async def fetch_image(cls, size: str, filename: str) -> tuple[bytes, str]:
        """Fetch a TMDB image through the backend's VPN-routed network namespace."""
        if size not in TMDB_IMAGE_SIZES:
            raise ValueError("unsupported TMDB image size")
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)", filename, re.I):
            raise ValueError("invalid TMDB image filename")

        url = f"{TMDB_IMAGE}/{size}/{filename}"
        timeout = aiohttp.ClientTimeout(total=max(12.0, settings.DEPENDENCY_TIMEOUT_SECS))
        try:
            async with aiohttp.ClientSession(timeout=timeout, headers={"Accept": "image/*"}) as session:
                async with session.get(url) as response:
                    if response.status == 404:
                        raise ValueError("TMDB image was not found")
                    if response.status != 200:
                        raise DependencyUnavailableError(
                            "tmdb-image", f"image request returned HTTP {response.status}"
                        )
                    content_type = (response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
                    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
                        raise DependencyUnavailableError("tmdb-image", "TMDB returned a non-image response")
                    length = response.headers.get("Content-Length")
                    if length:
                        try:
                            length_value = int(length)
                        except ValueError:
                            length_value = 0
                        if length_value > 15 * 1024 * 1024:
                            raise DependencyUnavailableError("tmdb-image", "TMDB image exceeds the size limit")
                    body = await response.read()
        except (DependencyUnavailableError, ValueError):
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("tmdb-image", str(exc)) from exc

        if not body or len(body) > 15 * 1024 * 1024:
            raise DependencyUnavailableError("tmdb-image", "TMDB image payload is invalid")
        return body, content_type

    @classmethod
    async def health_check(cls) -> dict:
        result = {
            "service": "tmdb",
            "connected": False,
            "authenticated": False,
        }
        if not cls._configured():
            result.update(status="misconfigured", error="TMDB_API_KEY is not configured")
            return result

        try:
            await cls._get("/search/movie", {
                "query": "NetWatch",
                "include_adult": "false",
                "language": "en-US",
                "page": 1,
            })
            result.update(status="ok", connected=True, authenticated=True)
        except DependencyUnavailableError as exc:
            result.update(status="unavailable", error=exc.message)
        return result

    @classmethod
    async def search_movies(cls, query: str, page: int = 1) -> list[dict]:
        normalized = query.strip()
        if not normalized:
            return []

        data = await cls._get("/search/movie", {
            "query": normalized,
            "include_adult": "false",
            "language": "en-US",
            "page": max(1, min(int(page), 500)),
        })
        raw = await cls._filter_explicit_raw([
            ("movie", item) for item in data.get("results", []) if isinstance(item, dict)
        ])
        return [cls._format_movie_result(item) for _, item in raw]

    @classmethod
    async def search_series(cls, query: str, page: int = 1) -> list[dict]:
        normalized = query.strip()
        if not normalized:
            return []

        data = await cls._get("/search/tv", {
            "query": normalized,
            "include_adult": "false",
            "language": "en-US",
            "page": max(1, min(int(page), 500)),
        })
        raw = await cls._filter_explicit_raw([
            ("tv", item) for item in data.get("results", []) if isinstance(item, dict)
        ])
        return [cls._format_tv_result(item) for _, item in raw]


    @staticmethod
    def _select_logo_path(images: dict, original_language: Optional[str]) -> Optional[str]:
        logos = images.get("logos") if isinstance(images, dict) else None
        if not isinstance(logos, list):
            return None

        candidates = [
            item for item in logos
            if isinstance(item, dict)
            and isinstance(item.get("file_path"), str)
            and re.search(r"\.(?:png|webp|jpe?g|svg)$", item.get("file_path") or "", re.I)
        ]
        if not candidates:
            return None

        language_order: list[Optional[str]] = ["en"]
        normalized_original = (original_language or "").strip().lower() or None
        if normalized_original and normalized_original != "en":
            language_order.append(normalized_original)
        language_order.append(None)

        for language in language_order:
            for item in candidates:
                item_language = item.get("iso_639_1")
                if (item_language or None) == language:
                    path = item.get("file_path")
                    return re.sub(r"\.svg$", ".png", path, flags=re.I) if path else None
        path = candidates[0].get("file_path")
        return re.sub(r"\.svg$", ".png", path, flags=re.I) if path else None

    @staticmethod
    def _keyword_names(payload: dict) -> list[str]:
        keywords = payload.get("keywords") if isinstance(payload, dict) else None
        if not isinstance(keywords, list):
            keywords = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(keywords, list):
            return []
        return [str(item.get("name") or "") for item in keywords if isinstance(item, dict) and item.get("name")]

    @staticmethod
    def _movie_release_types(payload: dict) -> set[int]:
        values: set[int] = set()
        if not isinstance(payload, dict):
            return values
        for region in payload.get("results", []):
            if not isinstance(region, dict):
                continue
            for release in region.get("release_dates", []):
                if isinstance(release, dict):
                    try:
                        values.add(int(release.get("type")))
                    except (TypeError, ValueError):
                        pass
        return values

    @classmethod
    async def _catalog_enrichment(cls, media_type: str, tmdb_id: int) -> dict:
        key = (media_type, int(tmdb_id))
        now = time.monotonic()
        cached = cls._catalog_enrichment_cache.get(key)
        if cached and now < cached[0]:
            return dict(cached[1])

        if media_type == "movie":
            data = await cls._get(
                f"/movie/{int(tmdb_id)}",
                {"append_to_response": "keywords,release_dates", "language": "en-US"},
            )
            countries = [
                str(item.get("iso_3166_1") or "").upper()
                for item in data.get("production_countries", [])
                if isinstance(item, dict) and item.get("iso_3166_1")
            ]
            enrichment = {
                "adult": bool(data.get("adult")),
                "title": data.get("title") or data.get("original_title") or "",
                "overview": data.get("overview") or "",
                "keywords": cls._keyword_names(data.get("keywords") or {}),
                "countries": countries,
                "release_types": sorted(cls._movie_release_types(data.get("release_dates") or {})),
            }
        else:
            data = await cls._get(
                f"/tv/{int(tmdb_id)}",
                {"append_to_response": "keywords,content_ratings", "language": "en-US"},
            )
            enrichment = {
                "adult": bool(data.get("adult")),
                "title": data.get("name") or data.get("original_name") or "",
                "overview": data.get("overview") or "",
                "keywords": cls._keyword_names(data.get("keywords") or {}),
                "countries": [str(value).upper() for value in (data.get("origin_country") or []) if value],
                "release_types": [],
            }

        cls._catalog_enrichment_cache[key] = (
            now + cls.CATALOG_ENRICHMENT_TTL_SECS,
            dict(enrichment),
        )
        return enrichment

    @classmethod
    async def _enrich_many(cls, refs: list[tuple[str, int]]) -> dict[tuple[str, int], dict]:
        unique = list(dict.fromkeys((kind, int(item_id)) for kind, item_id in refs if item_id))
        semaphore = asyncio.Semaphore(6)

        async def one(kind: str, item_id: int):
            async with semaphore:
                try:
                    return (kind, item_id), await cls._catalog_enrichment(kind, item_id)
                except (DependencyUnavailableError, ValueError):
                    # Safety is fail-closed only when TMDB explicitly marks adult content.
                    # If optional enrichment fails, keep normal catalog availability rather
                    # than turning one metadata miss into a broken Home screen.
                    return (kind, item_id), {}

        if not unique:
            return {}
        return dict(await asyncio.gather(*(one(kind, item_id) for kind, item_id in unique)))

    @classmethod
    async def _filter_explicit_raw(cls, items: list[tuple[str, dict]], *, enrich_all: bool = False) -> list[tuple[str, dict]]:
        """Apply global catalog exclusions before results reach the UI.

        The method name is retained to keep the existing call graph stable. Besides
        the explicit-content safety policy, NetWatch now excludes any title TMDB
        identifies as an Indian production/origin across Home, Search, and legacy
        media-specific searches. Movie summary payloads do not expose production
        countries, so movies are detail-enriched and fail closed when that country
        check cannot be completed. TV summary payloads normally expose origin_country;
        only entries without it need detail enrichment for the country decision.
        """
        refs: list[tuple[str, int]] = []
        safety_required_enrichment: set[tuple[str, int]] = set()
        country_required_enrichment: set[tuple[str, int]] = set()
        prelim: list[tuple[str, dict]] = []

        for media_type, item in items:
            if not isinstance(item, dict):
                continue

            title = item.get("title") or item.get("name") or item.get("original_title") or item.get("original_name") or ""
            if is_explicit_content(
                adult=bool(item.get("adult")),
                title=str(title),
                overview=str(item.get("overview") or ""),
            ):
                continue

            # TV/search/discover summaries usually carry origin_country and can be
            # rejected without another TMDB request. Movies require detail enrichment
            # because production_countries is absent from summary payloads.
            summary_countries = item.get("origin_country") or () if media_type == "tv" else ()
            if is_indian_production(summary_countries):
                continue

            prelim.append((media_type, item))
            ref = (media_type, int(item.get("id") or 0))
            if not ref[1]:
                continue

            genre_ids = item.get("genre_ids") or []
            if enrich_all or ANIMATION_GENRE_ID in genre_ids or cls._looks_like_anime(item, media_type):
                refs.append(ref)
                safety_required_enrichment.add(ref)

            if media_type == "movie" or not summary_countries:
                refs.append(ref)
                country_required_enrichment.add(ref)

        enriched = await cls._enrich_many(refs)
        filtered: list[tuple[str, dict]] = []
        for media_type, item in prelim:
            ref = (media_type, int(item.get("id") or 0))
            extra = enriched.get(ref, {})

            # Animation is the known TMDB edge case where adult=false can still
            # describe explicit material. Keep that existing fail-closed behavior.
            if ref in safety_required_enrichment and not extra:
                continue

            # Country filtering also fails closed when the summary lacks origin data.
            # This prevents an English-language Indian movie from leaking through a
            # transiently incomplete detail lookup.
            if ref in country_required_enrichment and not extra:
                continue

            countries = extra.get("countries") or (item.get("origin_country") or ())
            if is_indian_production(countries):
                continue

            if extra and is_explicit_content(
                adult=bool(extra.get("adult")),
                title=str(extra.get("title") or ""),
                overview=str(extra.get("overview") or ""),
                keywords=extra.get("keywords") or (),
            ):
                continue
            filtered.append((media_type, item))
        return filtered

    @staticmethod
    def _dedupe_raw(items: list[dict]) -> list[dict]:
        result: list[dict] = []
        seen: set[int] = set()
        for item in items:
            if not isinstance(item, dict):
                continue
            item_id = int(item.get("id") or 0)
            if not item_id or item_id in seen:
                continue
            seen.add(item_id)
            result.append(item)
        return result

    @classmethod
    async def _recent_movie_candidates(cls, min_date: str, max_date: str) -> list[dict]:
        common = {
            "include_adult": "false",
            "include_video": "false",
            "language": "en-US",
            "primary_release_date.gte": min_date,
            "primary_release_date.lte": max_date,
            "with_release_type": "1|2|3|4",
        }
        popular_1, popular_2, newest = await asyncio.gather(
            cls._get("/discover/movie", {**common, "sort_by": "popularity.desc", "page": 1}),
            cls._get("/discover/movie", {**common, "sort_by": "popularity.desc", "page": 2}),
            cls._get("/discover/movie", {**common, "sort_by": "primary_release_date.desc", "page": 1}),
        )
        popular = cls._dedupe_raw((popular_1.get("results") or []) + (popular_2.get("results") or []))[:30]
        newest_items = cls._dedupe_raw(newest.get("results") or [])[:14]
        return cls._dedupe_raw(popular + newest_items)

    @classmethod
    async def _recent_tv_candidates(cls, min_date: str, max_date: str) -> list[dict]:
        common = {
            "include_adult": "false",
            "language": "en-US",
            "first_air_date.gte": min_date,
            "first_air_date.lte": max_date,
        }
        popular_1, popular_2, newest = await asyncio.gather(
            cls._get("/discover/tv", {**common, "sort_by": "popularity.desc", "page": 1}),
            cls._get("/discover/tv", {**common, "sort_by": "popularity.desc", "page": 2}),
            cls._get("/discover/tv", {**common, "sort_by": "first_air_date.desc", "page": 1}),
        )
        popular = cls._dedupe_raw((popular_1.get("results") or []) + (popular_2.get("results") or []))[:30]
        newest_items = cls._dedupe_raw(newest.get("results") or [])[:14]
        return cls._dedupe_raw(popular + newest_items)

    @staticmethod
    def _normalize_discover_media(media: str) -> str:
        normalized = str(media or "").strip().lower()
        if normalized not in {"movies", "tv", "anime"}:
            raise ValueError("unsupported discover media type")
        return normalized

    @staticmethod
    def _normalize_discover_category(category: str) -> str:
        normalized = str(category or "").strip().lower()
        if normalized not in {"popular", "new", "featured"}:
            raise ValueError("unsupported discover category")
        return normalized

    @classmethod
    async def discover_genres(cls, media: str) -> list[dict]:
        """Return TMDB genres used by the Discover selector.

        Anime spans TMDB movie and TV catalogs, so the lists are merged. Animation
        itself is omitted there because every Anime Discover query already requires it.
        """
        media = cls._normalize_discover_media(media)
        now = time.monotonic()
        cached = cls._genre_cache.get(media)
        if cached and now < cached[0]:
            return [dict(item) for item in cached[1]]

        if media == "movies":
            payloads = [await cls._get("/genre/movie/list", {"language": "en-US"})]
        elif media == "tv":
            payloads = [await cls._get("/genre/tv/list", {"language": "en-US"})]
        else:
            payloads = list(await asyncio.gather(
                cls._get("/genre/movie/list", {"language": "en-US"}),
                cls._get("/genre/tv/list", {"language": "en-US"}),
            ))

        merged: dict[int, str] = {}
        for payload in payloads:
            for item in payload.get("genres", []):
                if not isinstance(item, dict):
                    continue
                try:
                    genre_id = int(item.get("id") or 0)
                except (TypeError, ValueError):
                    continue
                name = str(item.get("name") or "").strip()
                if genre_id and name:
                    merged.setdefault(genre_id, name)

        if media == "anime":
            merged.pop(ANIMATION_GENRE_ID, None)

        genres = [{"id": genre_id, "name": name} for genre_id, name in merged.items()]
        genres.sort(key=lambda item: str(item["name"]).casefold())
        cls._genre_cache[media] = (now + cls.GENRE_CACHE_TTL_SECS, [dict(item) for item in genres])
        return genres

    @classmethod
    async def discover_catalog(
        cls,
        media: str,
        category: str,
        genre: Optional[int] = None,
    ) -> list[dict]:
        """Browse TMDB without exposing a renderer-side Internet path.

        Movies and TV are kept separate from the dedicated Anime catalog. Popular
        and New use TMDB Discover so genre selection is server-side. Featured uses
        TMDB's weekly Trending order and applies the optional genre locally because
        Trending itself has no genre parameter.
        """
        media = cls._normalize_discover_media(media)
        category = cls._normalize_discover_category(category)
        genre_id = int(genre) if genre is not None else None
        if genre_id is not None and genre_id <= 0:
            raise ValueError("genre must be a positive TMDB genre id")

        today = date.today().isoformat()

        def discover_params(kind: str, page: int) -> dict[str, Any]:
            params: dict[str, Any] = {
                "include_adult": "false",
                "language": "en-US",
                "page": page,
            }
            genres: list[int] = []
            if media == "anime":
                genres.append(ANIMATION_GENRE_ID)
                params["with_original_language"] = "ja"
            if genre_id is not None and genre_id not in genres:
                genres.append(genre_id)
            if genres:
                # TMDB treats comma-separated genre ids as AND, which is what we
                # want for Anime + a user-selected genre such as Drama or Action.
                params["with_genres"] = ",".join(str(value) for value in genres)

            if category == "popular":
                params["sort_by"] = "popularity.desc"
            elif category == "new":
                if kind == "movie":
                    params["sort_by"] = "primary_release_date.desc"
                    params["primary_release_date.lte"] = today
                else:
                    params["sort_by"] = "first_air_date.desc"
                    params["first_air_date.lte"] = today
            return params

        raw: list[tuple[str, dict]] = []
        if category == "featured":
            kinds = ["movie", "tv"] if media == "anime" else (["movie"] if media == "movies" else ["tv"])
            calls = [
                cls._get(f"/trending/{kind}/week", {"language": "en-US", "page": page})
                for kind in kinds
                for page in (1, 2)
            ]
            payloads = await asyncio.gather(*calls)
            index = 0
            for kind in kinds:
                for _page in (1, 2):
                    payload = payloads[index]
                    index += 1
                    for item in payload.get("results", []):
                        if not isinstance(item, dict):
                            continue
                        if genre_id is not None and genre_id not in (item.get("genre_ids") or []):
                            continue
                        raw.append((kind, item))
        else:
            kinds = ["movie", "tv"] if media == "anime" else (["movie"] if media == "movies" else ["tv"])
            calls = [
                cls._get(f"/discover/{kind}", discover_params(kind, page))
                for kind in kinds
                for page in (1, 2)
            ]
            payloads = await asyncio.gather(*calls)
            index = 0
            for kind in kinds:
                for _page in (1, 2):
                    payload = payloads[index]
                    index += 1
                    raw.extend((kind, item) for item in payload.get("results", []) if isinstance(item, dict))

        if media == "anime":
            raw = [(kind, item) for kind, item in raw if cls._looks_like_anime(item, kind)]
            raw = await cls._filter_explicit_raw(raw, enrich_all=True)
        else:
            raw = [(kind, item) for kind, item in raw if not cls._looks_like_anime(item, kind)]
            raw = await cls._filter_explicit_raw(raw)

        results: list[dict] = []
        seen: set[tuple[str, int]] = set()
        for kind, item in raw:
            key = (kind, int(item.get("id") or 0))
            if not key[1] or key in seen:
                continue
            seen.add(key)
            formatted = cls._format_movie_result(item) if kind == "movie" else cls._format_tv_result(item)
            if media == "anime":
                formatted["is_anime"] = True
            results.append(formatted)

        if media == "anime":
            if category == "new":
                results.sort(
                    key=lambda item: (str(item.get("release_date") or ""), float(item.get("popularity") or 0)),
                    reverse=True,
                )
            else:
                results.sort(
                    key=lambda item: (float(item.get("popularity") or 0), int(item.get("vote_count") or 0)),
                    reverse=True,
                )

        return results[:40]

    @classmethod
    async def search_catalog(cls, query: str, page: int = 1) -> list[dict]:
        """Search movies and TV together while suppressing explicit catalog leaks."""
        normalized = query.strip()
        if not normalized:
            return []

        page = max(1, min(int(page), 500))
        movie_data, tv_data = await asyncio.gather(
            cls._get("/search/movie", {
                "query": normalized,
                "include_adult": "false",
                "language": "en-US",
                "page": page,
            }),
            cls._get("/search/tv", {
                "query": normalized,
                "include_adult": "false",
                "language": "en-US",
                "page": page,
            }),
        )

        raw: list[tuple[str, dict]] = []
        raw.extend(("movie", item) for item in movie_data.get("results", []) if isinstance(item, dict))
        raw.extend(("tv", item) for item in tv_data.get("results", []) if isinstance(item, dict))
        raw = await cls._filter_explicit_raw(raw)

        results = [
            cls._format_movie_result(item) if media_type == "movie" else cls._format_tv_result(item)
            for media_type, item in raw
        ]

        needle = normalized.casefold()

        def score(item: dict) -> tuple[int, int, float, int]:
            title = str(item.get("title") or "").casefold()
            original = str(item.get("original_title") or "").casefold()
            exact = int(title == needle or original == needle)
            prefix = int(title.startswith(needle) or original.startswith(needle))
            popularity = float(item.get("popularity") or 0)
            votes = int(item.get("vote_count") or 0)
            return exact, prefix, popularity, votes

        results.sort(key=score, reverse=True)
        return results[:60]

    @classmethod
    async def home_catalog(cls) -> dict:
        """Return Trending + Recent discovery shelves with conservative quality policy."""
        now = time.monotonic()
        if cls._home_cache is not None and now < cls._home_cache_expires_at:
            return cls._clone_home_payload(cls._home_cache)

        persisted = cls._load_persistent_home_cache()
        if persisted is not None:
            persisted_payload, remaining_ttl = persisted
            cls._home_cache = cls._clone_home_payload(persisted_payload)
            cls._home_cache_expires_at = now + remaining_ttl
            return cls._clone_home_payload(persisted_payload)

        today = date.today()
        recent_start = today - timedelta(days=cls.RECENT_WINDOW_DAYS)
        min_date, max_date = recent_start.isoformat(), today.isoformat()
        anime_common = {
            "include_adult": "false",
            "language": "en-US",
            "with_genres": str(ANIMATION_GENRE_ID),
            "with_original_language": "ja",
        }

        (
            movies_data,
            tv_data,
            anime_movies_data,
            anime_tv_data,
            recent_movie_raw,
            recent_tv_raw,
            recent_anime_movies,
            recent_anime_tv,
        ) = await asyncio.gather(
            cls._get("/trending/movie/week", {"language": "en-US"}),
            cls._get("/trending/tv/week", {"language": "en-US"}),
            cls._get("/discover/movie", {**anime_common, "sort_by": "popularity.desc", "page": 1}),
            cls._get("/discover/tv", {**anime_common, "sort_by": "popularity.desc", "page": 1}),
            cls._recent_movie_candidates(min_date, max_date),
            cls._recent_tv_candidates(min_date, max_date),
            cls._get("/discover/movie", {
                **anime_common,
                "primary_release_date.gte": min_date,
                "primary_release_date.lte": max_date,
                "sort_by": "popularity.desc",
                "page": 1,
            }),
            cls._get("/discover/tv", {
                **anime_common,
                "first_air_date.gte": min_date,
                "first_air_date.lte": max_date,
                "sort_by": "popularity.desc",
                "page": 1,
            }),
        )

        # Trending keeps TMDB's order. Only explicit material and cross-shelf anime
        # duplicates are removed; there is no vote/country/"quality" gate here.
        trending_raw = await cls._filter_explicit_raw(
            [("movie", item) for item in movies_data.get("results", []) if isinstance(item, dict)]
            + [("tv", item) for item in tv_data.get("results", []) if isinstance(item, dict)]
        )
        movies = [
            cls._format_movie_result(item)
            for media_type, item in trending_raw
            if media_type == "movie" and not cls._looks_like_anime(item, "movie")
        ][:20]
        tv = [
            cls._format_tv_result(item)
            for media_type, item in trending_raw
            if media_type == "tv" and not cls._looks_like_anime(item, "tv")
        ][:20]

        anime_raw = await cls._filter_explicit_raw(
            [("movie", item) for item in anime_movies_data.get("results", []) if isinstance(item, dict)]
            + [("tv", item) for item in anime_tv_data.get("results", []) if isinstance(item, dict)],
            enrich_all=True,
        )
        anime: list[dict] = []
        for media_type, item in anime_raw:
            formatted = cls._format_movie_result(item) if media_type == "movie" else cls._format_tv_result(item)
            formatted["is_anime"] = True
            anime.append(formatted)
        anime_deduped: dict[tuple[str, int], dict] = {}
        for item in anime:
            anime_deduped.setdefault((str(item.get("type")), int(item.get("id") or 0)), item)
        anime = list(anime_deduped.values())
        anime.sort(key=lambda item: (item.get("popularity") or 0, item.get("vote_count") or 0), reverse=True)
        anime = anime[:24]

        trending_movie_ids = {int(item.get("id") or 0) for item in movies_data.get("results", []) if isinstance(item, dict)}
        trending_tv_ids = {int(item.get("id") or 0) for item in tv_data.get("results", []) if isinstance(item, dict)}

        # Recent movies are enriched because production countries and release types
        # are not present in Discover summaries. No major-studio or vote threshold is used.
        movie_refs = [("movie", int(item.get("id") or 0)) for item in recent_movie_raw if isinstance(item, dict)]
        movie_enrichment = await cls._enrich_many(movie_refs)
        recent_movies_scored: list[tuple[float, dict]] = []
        for item in recent_movie_raw:
            if not isinstance(item, dict) or cls._looks_like_anime(item, "movie"):
                continue
            extra = movie_enrichment.get(("movie", int(item.get("id") or 0)), {})
            if is_explicit_content(
                adult=bool(item.get("adult")) or bool(extra.get("adult")),
                title=str(extra.get("title") or item.get("title") or ""),
                overview=str(extra.get("overview") or item.get("overview") or ""),
                # Non-animation movies rely on TMDB's adult flag plus strong text
                # signals. Generic pornography-themed keywords can describe a
                # legitimate film about the industry, so they are not a hard gate.
                keywords=(),
            ):
                continue
            if is_indian_production(extra.get("countries") or ()):
                continue
            if not recent_origin_allowed(extra.get("countries") or ()):
                continue
            formatted = cls._format_movie_result(item)
            score = recent_score(
                popularity=formatted.get("popularity") or 0,
                vote_count=formatted.get("vote_count") or 0,
                rating=formatted.get("rating") or 0,
                release_date=formatted.get("release_date"),
                today=today,
                trending=int(item.get("id") or 0) in trending_movie_ids,
                release_types=extra.get("release_types") or (),
                has_poster=bool(formatted.get("poster")),
                has_backdrop=bool(formatted.get("backdrop")),
            )
            recent_movies_scored.append((score, formatted))
        recent_movies_scored.sort(key=lambda pair: pair[0], reverse=True)
        recent_movies = [item for _, item in recent_movies_scored[:24]]

        recent_tv_filtered = await cls._filter_explicit_raw(
            [("tv", item) for item in recent_tv_raw if isinstance(item, dict)]
        )
        recent_tv_scored: list[tuple[float, dict]] = []
        for _, item in recent_tv_filtered:
            if cls._looks_like_anime(item, "tv"):
                continue
            if not recent_origin_allowed(item.get("origin_country") or ()):
                continue
            formatted = cls._format_tv_result(item)
            score = recent_score(
                popularity=formatted.get("popularity") or 0,
                vote_count=formatted.get("vote_count") or 0,
                rating=formatted.get("rating") or 0,
                release_date=formatted.get("release_date"),
                today=today,
                trending=int(item.get("id") or 0) in trending_tv_ids,
                has_poster=bool(formatted.get("poster")),
                has_backdrop=bool(formatted.get("backdrop")),
            )
            recent_tv_scored.append((score, formatted))
        recent_tv_scored.sort(key=lambda pair: pair[0], reverse=True)
        recent_tv = [item for _, item in recent_tv_scored[:24]]

        recent_anime_raw = await cls._filter_explicit_raw(
            [("movie", item) for item in recent_anime_movies.get("results", []) if isinstance(item, dict)]
            + [("tv", item) for item in recent_anime_tv.get("results", []) if isinstance(item, dict)],
            enrich_all=True,
        )
        recent_anime_scored: list[tuple[float, dict]] = []
        seen_recent_anime: set[tuple[str, int]] = set()
        for media_type, item in recent_anime_raw:
            key = (media_type, int(item.get("id") or 0))
            if key in seen_recent_anime:
                continue
            seen_recent_anime.add(key)
            formatted = cls._format_movie_result(item) if media_type == "movie" else cls._format_tv_result(item)
            formatted["is_anime"] = True
            score = recent_score(
                popularity=formatted.get("popularity") or 0,
                vote_count=formatted.get("vote_count") or 0,
                rating=formatted.get("rating") or 0,
                release_date=formatted.get("release_date"),
                today=today,
                trending=int(item.get("id") or 0) in (trending_movie_ids if media_type == "movie" else trending_tv_ids),
                has_poster=bool(formatted.get("poster")),
                has_backdrop=bool(formatted.get("backdrop")),
            )
            recent_anime_scored.append((score, formatted))
        recent_anime_scored.sort(key=lambda pair: pair[0], reverse=True)
        recent_anime = [item for _, item in recent_anime_scored[:24]]

        payload = {
            "movies": movies,
            "recent_movies": recent_movies,
            "tv": tv,
            "recent_tv": recent_tv,
            "anime": anime,
            "recent_anime": recent_anime,
        }
        cls._home_cache = cls._clone_home_payload(payload)
        cls._home_cache_expires_at = now + cls.HOME_CACHE_TTL_SECS
        cls._store_persistent_home_cache(payload)
        return payload

    @classmethod
    async def search_anime(cls, query: str, page: int = 1) -> list[dict]:
        """Search both TMDB movies and TV, keeping Japanese animation results.

        TMDB exposes anime through its normal movie/TV catalog. NetWatch treats
        Japanese-language Animation entries as the dedicated Anime shelf while
        preserving the underlying movie-vs-TV type for playback behavior.
        """
        normalized = query.strip()
        if not normalized:
            return []

        page = max(1, min(int(page), 500))
        movie_data, tv_data = await asyncio.gather(
            cls._get("/search/movie", {
                "query": normalized,
                "include_adult": "false",
                "language": "en-US",
                "page": page,
            }),
            cls._get("/search/tv", {
                "query": normalized,
                "include_adult": "false",
                "language": "en-US",
                "page": page,
            }),
        )

        raw = [
            ("movie", item) for item in movie_data.get("results", [])
            if isinstance(item, dict) and cls._looks_like_anime(item, "movie")
        ] + [
            ("tv", item) for item in tv_data.get("results", [])
            if isinstance(item, dict) and cls._looks_like_anime(item, "tv")
        ]
        raw = await cls._filter_explicit_raw(raw, enrich_all=True)

        results: list[dict] = []
        for media_type, item in raw:
            formatted = cls._format_movie_result(item) if media_type == "movie" else cls._format_tv_result(item)
            formatted["is_anime"] = True
            results.append(formatted)

        results.sort(key=lambda item: (item.get("popularity") or 0, item.get("rating") or 0), reverse=True)
        return results[:40]

    @classmethod
    async def get_movie(cls, tmdb_id: int) -> dict:
        data = await cls._get(
            f"/movie/{int(tmdb_id)}",
            {
                "append_to_response": "credits,external_ids,images",
                "include_image_language": "en,null",
                "language": "en-US",
            },
        )
        if not cls._select_logo_path(data.get("images") or {}, data.get("original_language")):
            original_language = (data.get("original_language") or "").strip().lower()
            if original_language and original_language != "en":
                try:
                    data["images"] = await cls._get(
                        f"/movie/{int(tmdb_id)}/images",
                        {"include_image_language": f"en,{original_language},null"},
                    )
                except DependencyUnavailableError:
                    pass
        countries = [
            str(item.get("iso_3166_1") or "").upper()
            for item in data.get("production_countries", [])
            if isinstance(item, dict) and item.get("iso_3166_1")
        ]
        if is_indian_production(countries):
            raise ValueError("TMDB item was not found")
        return cls._format_movie(data)

    @classmethod
    async def get_series(cls, tmdb_id: int) -> dict:
        data = await cls._get(
            f"/tv/{int(tmdb_id)}",
            {
                "append_to_response": "aggregate_credits,external_ids,images",
                "include_image_language": "en,null",
                "language": "en-US",
            },
        )
        if not cls._select_logo_path(data.get("images") or {}, data.get("original_language")):
            original_language = (data.get("original_language") or "").strip().lower()
            if original_language and original_language != "en":
                try:
                    data["images"] = await cls._get(
                        f"/tv/{int(tmdb_id)}/images",
                        {"include_image_language": f"en,{original_language},null"},
                    )
                except DependencyUnavailableError:
                    pass
        if is_indian_production(data.get("origin_country") or ()):
            raise ValueError("TMDB item was not found")
        return cls._format_series(data)

    @classmethod
    async def get_season(cls, tmdb_id: int, season_number: int) -> dict:
        data = await cls._get(
            f"/tv/{int(tmdb_id)}/season/{int(season_number)}",
            {"language": "en-US"},
        )
        return cls._format_season(data)

    @classmethod
    async def get_episode(cls, tmdb_id: int, season_number: int, episode_number: int) -> dict:
        data = await cls._get(
            f"/tv/{int(tmdb_id)}/season/{int(season_number)}/episode/{int(episode_number)}",
            {
                "append_to_response": "external_ids",
                "language": "en-US",
            },
        )
        return cls._format_episode(data)

    @classmethod
    async def trending_movies(cls) -> list[dict]:
        data = await cls._get("/trending/movie/week", {"language": "en-US"})
        raw = await cls._filter_explicit_raw([
            ("movie", item) for item in data.get("results", []) if isinstance(item, dict)
        ])
        return [cls._format_movie_result(item) for _, item in raw]

    @staticmethod
    def _looks_like_anime(item: dict, media_type: str) -> bool:
        genre_ids = item.get("genre_ids") or []
        if ANIMATION_GENRE_ID not in genre_ids:
            return False
        if (item.get("original_language") or "").lower() == "ja":
            return True
        if media_type == "tv":
            return "JP" in (item.get("origin_country") or [])
        return False

    @staticmethod
    def _format_movie_result(item: dict) -> dict:
        release_date = item.get("release_date") or ""
        return {
            "id": int(item["id"]),
            "type": "movie",
            "title": item.get("title") or item.get("original_title") or "Untitled",
            "original_title": item.get("original_title") or item.get("title"),
            "year": release_date[:4],
            "release_date": release_date or None,
            "overview": item.get("overview") or "",
            "poster": poster(item.get("poster_path")),
            "backdrop": backdrop(item.get("backdrop_path")),
            "rating": float(item.get("vote_average") or 0),
            "vote_count": int(item.get("vote_count") or 0),
            "popularity": float(item.get("popularity") or 0),
            "original_language": item.get("original_language") or None,
            "is_anime": MetadataService._looks_like_anime(item, "movie"),
        }

    @staticmethod
    def _format_tv_result(item: dict) -> dict:
        first_air_date = item.get("first_air_date") or ""
        return {
            "id": int(item["id"]),
            "type": "tv",
            "title": item.get("name") or item.get("original_name") or "Untitled",
            "original_title": item.get("original_name") or item.get("name"),
            "year": first_air_date[:4],
            "release_date": first_air_date or None,
            "overview": item.get("overview") or "",
            "poster": poster(item.get("poster_path")),
            "backdrop": backdrop(item.get("backdrop_path")),
            "rating": float(item.get("vote_average") or 0),
            "vote_count": int(item.get("vote_count") or 0),
            "popularity": float(item.get("popularity") or 0),
            "original_language": item.get("original_language") or None,
            "origin_country": item.get("origin_country") or [],
            "is_anime": MetadataService._looks_like_anime(item, "tv"),
        }

    @staticmethod
    def _format_movie(data: dict) -> dict:
        release_date = data.get("release_date") or ""
        credits = data.get("credits") or {}
        external_ids = data.get("external_ids") or {}
        return {
            "id": int(data["id"]),
            "type": "movie",
            "title": data.get("title") or data.get("original_title") or "Untitled",
            "original_title": data.get("original_title") or data.get("title"),
            "year": release_date[:4],
            "release_date": release_date or None,
            "overview": data.get("overview") or "",
            "tagline": data.get("tagline") or "",
            "runtime": data.get("runtime"),
            "genres": [g.get("name") for g in data.get("genres", []) if g.get("name")],
            "rating": float(data.get("vote_average") or 0),
            "vote_count": int(data.get("vote_count") or 0),
            "poster": poster(data.get("poster_path")),
            "backdrop": backdrop(data.get("backdrop_path")),
            "player_backdrop": backdrop(data.get("backdrop_path"), "original"),
            "logo": logo(MetadataService._select_logo_path(data.get("images") or {}, data.get("original_language"))),
            "imdb_id": external_ids.get("imdb_id"),
            "original_language": data.get("original_language") or None,
            "status": data.get("status") or None,
            "is_anime": ANIMATION_GENRE_ID in [g.get("id") for g in data.get("genres", []) if isinstance(g, dict)]
                and (data.get("original_language") or "").lower() == "ja",
            "cast": [
                {
                    "name": member.get("name") or "",
                    "character": member.get("character") or "",
                    "photo": poster(member.get("profile_path"), "w185"),
                }
                for member in credits.get("cast", [])[:8]
                if isinstance(member, dict)
            ],
        }

    @staticmethod
    def _format_series(data: dict) -> dict:
        first_air_date = data.get("first_air_date") or ""
        credits = data.get("aggregate_credits") or {}
        external_ids = data.get("external_ids") or {}
        genres = [g for g in data.get("genres", []) if isinstance(g, dict)]
        origin_country = data.get("origin_country") or []
        is_anime = (
            ANIMATION_GENRE_ID in [g.get("id") for g in genres]
            and ((data.get("original_language") or "").lower() == "ja" or "JP" in origin_country)
        )

        cast = []
        for member in credits.get("cast", [])[:8]:
            if not isinstance(member, dict):
                continue
            roles = member.get("roles") or []
            character = ""
            if roles and isinstance(roles[0], dict):
                character = roles[0].get("character") or ""
            cast.append({
                "name": member.get("name") or "",
                "character": character,
                "photo": poster(member.get("profile_path"), "w185"),
            })

        seasons = []
        for season in data.get("seasons", []):
            if not isinstance(season, dict):
                continue
            seasons.append({
                "id": int(season.get("id") or 0),
                "season_number": int(season.get("season_number") or 0),
                "name": season.get("name") or f"Season {season.get('season_number') or 0}",
                "episode_count": int(season.get("episode_count") or 0),
                "air_date": season.get("air_date") or None,
                "overview": season.get("overview") or "",
                "poster": poster(season.get("poster_path"), "w300"),
            })

        return {
            "id": int(data["id"]),
            "type": "tv",
            "title": data.get("name") or data.get("original_name") or "Untitled",
            "original_title": data.get("original_name") or data.get("name"),
            "year": first_air_date[:4],
            "release_date": first_air_date or None,
            "last_air_date": data.get("last_air_date") or None,
            "overview": data.get("overview") or "",
            "tagline": data.get("tagline") or "",
            "genres": [g.get("name") for g in genres if g.get("name")],
            "rating": float(data.get("vote_average") or 0),
            "vote_count": int(data.get("vote_count") or 0),
            "poster": poster(data.get("poster_path")),
            "backdrop": backdrop(data.get("backdrop_path")),
            "player_backdrop": backdrop(data.get("backdrop_path"), "original"),
            "logo": logo(MetadataService._select_logo_path(data.get("images") or {}, data.get("original_language"))),
            "imdb_id": external_ids.get("imdb_id"),
            "original_language": data.get("original_language") or None,
            "origin_country": origin_country,
            "status": data.get("status") or None,
            "number_of_seasons": int(data.get("number_of_seasons") or 0),
            "number_of_episodes": int(data.get("number_of_episodes") or 0),
            "episode_run_time": [int(v) for v in (data.get("episode_run_time") or []) if isinstance(v, (int, float))],
            "networks": [n.get("name") for n in data.get("networks", []) if isinstance(n, dict) and n.get("name")],
            "seasons": seasons,
            "cast": cast,
            "is_anime": is_anime,
        }

    @staticmethod
    def _format_episode(data: dict) -> dict:
        external_ids = data.get("external_ids") or {}
        return {
            "id": int(data.get("id") or 0),
            "season_number": int(data.get("season_number") or 0),
            "episode_number": int(data.get("episode_number") or 0),
            "name": data.get("name") or f"Episode {data.get('episode_number') or ''}".strip(),
            "overview": data.get("overview") or "",
            "air_date": data.get("air_date") or None,
            "runtime": data.get("runtime"),
            "rating": float(data.get("vote_average") or 0),
            "still": backdrop(data.get("still_path"), "w500"),
            "imdb_id": external_ids.get("imdb_id"),
        }

    @staticmethod
    def _format_season(data: dict) -> dict:
        episodes = [
            MetadataService._format_episode(item)
            for item in data.get("episodes", [])
            if isinstance(item, dict)
        ]
        return {
            "id": int(data.get("id") or 0),
            "season_number": int(data.get("season_number") or 0),
            "name": data.get("name") or f"Season {data.get('season_number') or 0}",
            "overview": data.get("overview") or "",
            "air_date": data.get("air_date") or None,
            "poster": poster(data.get("poster_path"), "w300"),
            "episodes": episodes,
        }
