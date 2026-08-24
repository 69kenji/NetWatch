import asyncio
import hashlib
import io
import os
import re
import secrets
import time
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Optional
from urllib.parse import urljoin, urlparse

import aiohttp

from config import settings
from services.net_safety import pinned_connector, read_response_limited, resolve_public_http_target

OPENSUBTITLES_BASE = "https://api.opensubtitles.com/api/v1"
SUBDL_BASE = "https://api.subdl.com/api/v2"
SUBDL_DOWNLOAD_BASE = "https://dl.subdl.com"
USER_AGENT = "NetWatch v0.1"

SUPPORTED_EXTENSIONS = (".srt", ".ass", ".ssa", ".vtt", ".sub")
CONTENT_TYPES = {
    ".srt": "application/x-subrip; charset=utf-8",
    ".ass": "text/x-ssa; charset=utf-8",
    ".ssa": "text/x-ssa; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".sub": "text/plain; charset=utf-8",
}
CACHE_TTL_SECONDS = 6 * 60 * 60
CACHE_MAX_ENTRIES = 24
CACHE_MAX_BYTES = 64 * 1024 * 1024
MAX_SUBTITLE_BYTES = 8 * 1024 * 1024
MAX_HEALTH_RESPONSE_BYTES = 1024 * 1024


class SubtitleProviderError(RuntimeError):
    def __init__(self, provider: str, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.status = status


@dataclass
class CachedSubtitle:
    token: str
    filename: str
    content_type: str
    content: bytes
    source: str
    created_at: float


class SubtitleService:
    _cache: dict[str, CachedSubtitle] = {}
    _cache_lock = asyncio.Lock()

    @classmethod
    def _timeout(cls, seconds: float = 20.0) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=seconds)

    @classmethod
    def _opensubtitles_headers(cls) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Api-Key": settings.OPENSUBTITLES_API_KEY,
            "User-Agent": USER_AGENT,
        }

    @classmethod
    def _subdl_headers(cls) -> dict[str, str]:
        return {
            "Accept": "application/json",
            "Authorization": f"Bearer {settings.SUBDL_API_KEY}",
            "User-Agent": USER_AGENT,
        }

    @staticmethod
    def _configured(value: str) -> bool:
        value = (value or "").strip()
        return bool(value and not value.lower().startswith("your_"))

    @staticmethod
    def _normalize_imdb_id(imdb_id: Optional[str]) -> Optional[str]:
        if not imdb_id:
            return None
        value = str(imdb_id).strip().lower()
        if value.startswith("tt"):
            value = value[2:]
        value = value.lstrip("0") or "0"
        return value if value.isdigit() else None

    @staticmethod
    def _clean_language_codes(languages: list[str]) -> list[str]:
        cleaned = []
        for language in languages:
            value = str(language or "").strip().lower()
            if re.fullmatch(r"[a-z]{2,3}", value) and value not in cleaned:
                cleaned.append(value)
        return cleaned or ["en"]

    @staticmethod
    def _derive_episode_numbers(text: Optional[str]) -> tuple[Optional[int], Optional[int]]:
        if not text:
            return None, None
        match = re.search(r"(?i)(?:^|[ ._\-])s(\d{1,2})e(\d{1,3})(?:$|[ ._\-])", text)
        if match:
            return int(match.group(1)), int(match.group(2))
        return None, None

    @staticmethod
    def _safe_name(value: Optional[str], fallback: str) -> str:
        raw = PurePosixPath(str(value or "").replace("\\", "/")).name.strip()
        raw = re.sub(r"[\x00-\x1f<>:\"/\\|?*]", "_", raw)
        raw = raw.strip(" .")
        return (raw or fallback)[:180]

    @staticmethod
    def _format_from_name(name: Optional[str], fallback: str = "srt") -> str:
        suffix = os.path.splitext(str(name or ""))[1].lower().lstrip(".")
        return suffix if f".{suffix}" in SUPPORTED_EXTENSIONS else fallback

    @classmethod
    async def health_check(cls) -> dict:
        open_task = asyncio.create_task(cls._health_opensubtitles())
        subdl_task = asyncio.create_task(cls._health_subdl())
        opensubtitles, subdl = await asyncio.gather(open_task, subdl_task)
        return {
            "opensubtitles": opensubtitles,
            "subdl": subdl,
            "all_configured": bool(opensubtitles.get("configured") and subdl.get("configured")),
            "all_connected": bool(opensubtitles.get("connected") and subdl.get("connected")),
        }

    @classmethod
    async def _health_opensubtitles(cls) -> dict:
        result = {
            "provider": "opensubtitles",
            "configured": cls._configured(settings.OPENSUBTITLES_API_KEY),
            "connected": False,
            "authenticated": False,
        }
        if not result["configured"]:
            result.update(status="misconfigured", error="OPENSUBTITLES_API_KEY is not configured")
            return result

        try:
            async with aiohttp.ClientSession(
                timeout=cls._timeout(12), headers=cls._opensubtitles_headers()
            ) as session:
                # A real /subtitles search validates the application API key while
                # consuming no download quota. Static /infos endpoints may be public
                # and therefore are not sufficient credential checks.
                async with session.get(
                    f"{OPENSUBTITLES_BASE}/subtitles",
                    params={"query": "netwatch", "languages": "en"},
                ) as response:
                    if response.status in (401, 403):
                        result.update(status="unauthorized", error=f"authentication returned HTTP {response.status}")
                        return result
                    if response.status != 200:
                        result.update(status="unavailable", error=f"search validation returned HTTP {response.status}")
                        return result
                    await read_response_limited(response, MAX_HEALTH_RESPONSE_BYTES)
                    result.update(status="ok", connected=True, authenticated=True)
                    return result
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            result.update(status="unavailable", error=str(exc))
            return result

    @classmethod
    async def _health_subdl(cls) -> dict:
        result = {
            "provider": "subdl",
            "configured": cls._configured(settings.SUBDL_API_KEY),
            "connected": False,
            "authenticated": False,
        }
        if not result["configured"]:
            result.update(status="misconfigured", error="SUBDL_API_KEY is not configured")
            return result

        try:
            async with aiohttp.ClientSession(
                timeout=cls._timeout(12), headers=cls._subdl_headers()
            ) as session:
                async with session.get(f"{SUBDL_BASE}/me") as response:
                    payload = await response.json(content_type=None)
                    if response.status in (401, 403) or (isinstance(payload, dict) and payload.get("status") is False):
                        error = payload.get("error") if isinstance(payload, dict) else None
                        result.update(status="unauthorized", error=error or f"authentication returned HTTP {response.status}")
                        return result
                    if response.status != 200:
                        result.update(status="unavailable", error=f"account request returned HTTP {response.status}")
                        return result
                    result.update(status="ok", connected=True, authenticated=True)
                    if isinstance(payload, dict):
                        for key in ("requests", "remaining", "plan", "subscription"):
                            if key in payload:
                                result[key] = payload[key]
                    return result
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            result.update(status="unavailable", error=str(exc))
            return result

    @classmethod
    async def search(
        cls,
        *,
        imdb_id: Optional[str] = None,
        query: Optional[str] = None,
        file_name: Optional[str] = None,
        languages: list[str] | None = None,
        season: Optional[int] = None,
        episode: Optional[int] = None,
    ) -> tuple[list[dict], dict]:
        languages = cls._clean_language_codes(languages or ["en"])
        normalized_imdb = cls._normalize_imdb_id(imdb_id)
        query = (query or "").strip() or None
        file_name = cls._safe_name(file_name, "") if file_name else None

        if not season or not episode:
            derived_season, derived_episode = cls._derive_episode_numbers(file_name or query)
            season = season or derived_season
            episode = episode or derived_episode

        if not any((normalized_imdb, query, file_name)):
            raise ValueError("Subtitle search requires imdb_id, query, or file_name")

        provider_status: dict[str, dict] = {}

        async def run_provider(name: str, coro):
            try:
                rows = await coro
                provider_status[name] = {"status": "ok", "connected": True, "count": len(rows)}
                return rows
            except SubtitleProviderError as exc:
                provider_status[name] = {
                    "status": "error",
                    "connected": False,
                    "error": exc.message,
                    **({"http_status": exc.status} if exc.status else {}),
                }
                return []
            except Exception as exc:
                provider_status[name] = {"status": "error", "connected": False, "error": str(exc)}
                return []

        open_task = asyncio.create_task(run_provider(
            "opensubtitles",
            cls._search_opensubtitles(normalized_imdb, query, file_name, languages, season, episode),
        ))
        subdl_task = asyncio.create_task(run_provider(
            "subdl",
            cls._search_subdl(normalized_imdb, query, file_name, languages, season, episode),
        ))
        open_rows, subdl_rows = await asyncio.gather(open_task, subdl_task)

        def dedupe_provider(rows: list[dict]) -> list[dict]:
            seen: set[str] = set()
            deduped: list[dict] = []
            for row in rows:
                key = str(row.get("download_ref") or "")
                if not key or key in seen:
                    continue
                seen.add(key)
                deduped.append(row)
            return deduped

        # Keep provider diversity in the public 40-row response. Previously all
        # OpenSubtitles rows were sorted before SubDL and then the result was
        # truncated to 40; a normal 40-row OpenSubtitles response therefore hid
        # every valid SubDL result from the UI and smoke test.
        open_rows = dedupe_provider(open_rows)
        subdl_rows = dedupe_provider(subdl_rows)

        open_rows.sort(
            key=lambda row: (
                0 if row.get("trusted") else 1,
                -int(row.get("downloads") or 0),
                -float(row.get("rating") or 0),
            )
        )
        # SubDL's release-aware filename endpoint already ranks by match_score;
        # retain that signal explicitly when exact/title searches are mixed in.
        subdl_rows.sort(
            key=lambda row: (
                -float(row.get("rating") or 0),
                0 if row.get("hearing_impaired") is False else 1,
                str(row.get("name") or "").casefold(),
            )
        )

        limit = 40
        if open_rows and subdl_rows:
            reserve = limit // 2
            selected = open_rows[:reserve] + subdl_rows[:reserve]
            remaining = limit - len(selected)
            if remaining > 0:
                # If one provider has fewer than its reserved share, fill the
                # unused slots from the other provider without hiding either one.
                selected.extend((open_rows[reserve:] + subdl_rows[reserve:])[:remaining])
        else:
            selected = (open_rows or subdl_rows)[:limit]

        return selected[:limit], provider_status

    @classmethod
    async def _search_opensubtitles(
        cls,
        imdb_id: Optional[str],
        query: Optional[str],
        file_name: Optional[str],
        languages: list[str],
        season: Optional[int],
        episode: Optional[int],
    ) -> list[dict]:
        if not cls._configured(settings.OPENSUBTITLES_API_KEY):
            raise SubtitleProviderError("opensubtitles", "OPENSUBTITLES_API_KEY is not configured")

        params: dict[str, object] = {
            "languages": ",".join(languages),
            "order_by": "download_count",
            "order_direction": "desc",
        }
        if imdb_id:
            params["imdb_id"] = imdb_id
        else:
            params["query"] = file_name or query
        if season:
            params["season_number"] = season
        if episode:
            params["episode_number"] = episode

        try:
            async with aiohttp.ClientSession(
                timeout=cls._timeout(), headers=cls._opensubtitles_headers()
            ) as session:
                async with session.get(f"{OPENSUBTITLES_BASE}/subtitles", params=params) as response:
                    payload = await response.json(content_type=None)
                    if response.status != 200:
                        message = payload.get("message") if isinstance(payload, dict) else None
                        raise SubtitleProviderError(
                            "opensubtitles",
                            message or f"search returned HTTP {response.status}",
                            response.status,
                        )
        except SubtitleProviderError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            raise SubtitleProviderError("opensubtitles", str(exc)) from exc

        rows: list[dict] = []
        for item in payload.get("data", []) if isinstance(payload, dict) else []:
            attributes = item.get("attributes") or {}
            files = attributes.get("files") or []
            if not files:
                continue
            file_info = files[0] or {}
            file_id = file_info.get("file_id")
            if file_id is None:
                continue
            file_label = file_info.get("file_name") or attributes.get("release") or ""
            language = str(attributes.get("language") or "und").lower()
            rows.append({
                "id": f"opensubtitles:{item.get('id')}:{file_id}",
                "language": language,
                "name": attributes.get("release") or file_label or f"OpenSubtitles {item.get('id')}",
                "download_ref": str(file_id),
                "source": "opensubtitles",
                "format": cls._format_from_name(file_label),
                "rating": float(attributes.get("ratings") or 0),
                "downloads": int(attributes.get("download_count") or 0),
                "hearing_impaired": bool(attributes.get("hearing_impaired")),
                "trusted": bool(attributes.get("from_trusted")),
                "fps": attributes.get("fps"),
                "file_name": file_label or None,
            })
        return rows

    @classmethod
    async def _search_subdl(
        cls,
        imdb_id: Optional[str],
        query: Optional[str],
        file_name: Optional[str],
        languages: list[str],
        season: Optional[int],
        episode: Optional[int],
    ) -> list[dict]:
        """Search SubDL using its current v2 API.

        Prefer the release-aware filename endpoint during actual playback, then
        fall back to exact subtitle searches by IMDb/title. The v2 API accepts
        free keys for search/download and authenticates with a bearer header.
        """
        if not cls._configured(settings.SUBDL_API_KEY):
            raise SubtitleProviderError("subdl", "SUBDL_API_KEY is not configured")

        language_param = ",".join(language.lower() for language in languages)
        full_imdb = f"tt{imdb_id}" if imdb_id else None
        payload: dict = {}
        strategy = "none"

        async def fetch_json(session, path: str, params: dict[str, object]) -> dict:
            async with session.get(f"{SUBDL_BASE}{path}", params=params) as response:
                current = await response.json(content_type=None)
                if response.status != 200 or (isinstance(current, dict) and current.get("status") is False):
                    message = None
                    if isinstance(current, dict):
                        message = current.get("error") or current.get("message")
                    raise SubtitleProviderError(
                        "subdl",
                        message or f"search returned HTTP {response.status}",
                        response.status,
                    )
                return current if isinstance(current, dict) else {}

        try:
            async with aiohttp.ClientSession(
                timeout=cls._timeout(), headers=cls._subdl_headers()
            ) as session:
                # v2's files/search endpoint is purpose-built for matching a
                # torrent/release filename and ranks results by release match.
                if file_name:
                    file_params: dict[str, object] = {
                        "filename": file_name,
                        "languages": language_param,
                        "subs_per_page": 30,
                        "engine": "auto",
                        "episode_scope": "exact",
                    }
                    current = await fetch_json(session, "/files/search", file_params)
                    if current.get("subtitles"):
                        payload = current
                        strategy = "filename-v2"

                if not payload.get("subtitles"):
                    attempts: list[tuple[str, str]] = []
                    if full_imdb:
                        attempts.append(("imdb_id", full_imdb))
                    if query:
                        attempts.append(("film_name", query))
                    if file_name:
                        attempts.append(("file_name", file_name))

                    seen: set[tuple[str, str]] = set()
                    for key, value in attempts:
                        if (key, value) in seen:
                            continue
                        seen.add((key, value))
                        params: dict[str, object] = {
                            key: value,
                            "languages": language_param,
                            "unpack": 1,
                        }
                        if season:
                            params["season"] = season
                        if episode:
                            params["episode"] = episode
                        current = await fetch_json(session, "/subtitles/search", params)
                        payload = current
                        strategy = f"{key}-v2"
                        if current.get("subtitles"):
                            break

                # Final deterministic title resolution. This avoids relying on
                # fuzzy subtitle search when a title lookup can give us SubDL's
                # canonical sd_id first.
                if not payload.get("subtitles") and query:
                    movie_params: dict[str, object] = {
                        "q": query,
                        "limit": 5,
                        "type": "tv" if season or episode else "movie",
                    }
                    resolved = await fetch_json(session, "/movies/search", movie_params)
                    candidates = resolved.get("results") or []
                    chosen = None
                    query_fold = query.casefold().strip()
                    for candidate in candidates:
                        if str(candidate.get("name") or "").casefold().strip() == query_fold:
                            chosen = candidate
                            break
                    if chosen is None and candidates:
                        chosen = candidates[0]
                    sd_id = chosen.get("sd_id") if isinstance(chosen, dict) else None
                    if sd_id:
                        params = {
                            "sd_id": sd_id,
                            "languages": language_param,
                            "unpack": 1,
                        }
                        if season:
                            params["season"] = season
                        if episode:
                            params["episode"] = episode
                        payload = await fetch_json(session, "/subtitles/search", params)
                        strategy = "sd_id-v2"
        except SubtitleProviderError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            raise SubtitleProviderError("subdl", str(exc)) from exc

        rows: list[dict] = []
        for item in payload.get("subtitles", []) if isinstance(payload, dict) else []:
            unpack_files = item.get("unpack_files") or []
            candidates = unpack_files if unpack_files else [item]
            for child in candidates:
                child_season = child.get("season") or item.get("season")
                child_episode = child.get("episode") or item.get("episode")
                if season and child_season and int(child_season) != int(season):
                    continue
                if episode and child_episode and int(child_episode) != int(episode):
                    continue

                relative_url = child.get("url") or item.get("url")
                n_id = (
                    child.get("n_id")
                    or item.get("n_id")
                    or child.get("nid")
                    or item.get("nid")
                )
                if relative_url:
                    # SubDL v2 currently embeds the caller's API key in the URL
                    # query string it returns. Never expose that URL to React.
                    # Keep only the provider path as an opaque backend reference;
                    # _download_subdl() re-applies authentication server-side.
                    parsed_ref = urlparse(str(relative_url))
                    provider_path = parsed_ref.path or ""
                    if not provider_path.startswith("/"):
                        provider_path = f"/{provider_path}"
                    if not provider_path or ".." in PurePosixPath(provider_path).parts:
                        continue
                    download_ref = f"subdl-path:{provider_path}"
                elif n_id:
                    # Kept as an opaque backend-only reference; download() knows
                    # how to resolve it through the authenticated v2 endpoint.
                    download_ref = f"subdl-v2:{n_id}"
                else:
                    continue

                release_name = (
                    child.get("release_name")
                    or item.get("release_name")
                    or child.get("name")
                    or item.get("name")
                    or "SubDL subtitle"
                )
                language_value = (
                    child.get("language")
                    or child.get("lang")
                    or item.get("language")
                    or item.get("lang")
                    or "und"
                )
                language = str(language_value).lower()
                language = {
                    "english": "en",
                    "greek": "el",
                    "french": "fr",
                    "german": "de",
                    "spanish": "es",
                    "italian": "it",
                    "portuguese": "pt",
                }.get(language, language)
                file_name_value = child.get("name") or item.get("name") or ""
                format_name = str(
                    child.get("format")
                    or item.get("format")
                    or cls._format_from_name(file_name_value)
                ).lower().lstrip(".")
                stable_id = hashlib.sha1(
                    download_ref.encode("utf-8"),
                    usedforsecurity=False,
                ).hexdigest()[:16]
                rows.append({
                    "id": f"subdl:{stable_id}",
                    "language": language,
                    "name": release_name,
                    "download_ref": download_ref,
                    "source": "subdl",
                    "format": format_name if f".{format_name}" in SUPPORTED_EXTENSIONS else "srt",
                    "rating": float(child.get("match_score") or item.get("match_score") or 0),
                    "downloads": int(child.get("downloads") or item.get("downloads") or item.get("count") or 0),
                    "hearing_impaired": bool(child.get("hi", item.get("hi", False))),
                    "trusted": False,
                    "fps": child.get("fps") or item.get("fps"),
                    "file_name": file_name_value or None,
                    "match_strategy": strategy,
                })
        return rows

    @classmethod
    async def download(
        cls,
        *,
        subtitle_id: str,
        source: str,
        download_ref: str,
        preferred_format: Optional[str] = None,
        file_name: Optional[str] = None,
    ) -> CachedSubtitle:
        source = str(source or "").strip().lower()
        if source == "opensubtitles":
            content, remote_name = await cls._download_opensubtitles(download_ref, preferred_format)
        elif source == "subdl":
            content, remote_name = await cls._download_subdl(download_ref)
        else:
            raise SubtitleProviderError(source or "unknown", "Unsupported subtitle provider")

        content, filename = cls._normalize_downloaded_content(
            content,
            file_name or remote_name or f"{subtitle_id}.srt",
            preferred_format,
        )
        extension = os.path.splitext(filename)[1].lower() or ".srt"
        cached = CachedSubtitle(
            token=secrets.token_urlsafe(18),
            filename=filename,
            content_type=CONTENT_TYPES.get(extension, "text/plain; charset=utf-8"),
            content=content,
            source=source,
            created_at=time.time(),
        )
        await cls._cache_put(cached)
        return cached

    @classmethod
    async def _download_opensubtitles(
        cls, download_ref: str, preferred_format: Optional[str]
    ) -> tuple[bytes, Optional[str]]:
        if not cls._configured(settings.OPENSUBTITLES_API_KEY):
            raise SubtitleProviderError("opensubtitles", "OPENSUBTITLES_API_KEY is not configured")
        try:
            file_id = int(str(download_ref).strip())
        except ValueError as exc:
            raise SubtitleProviderError("opensubtitles", "Invalid OpenSubtitles file id") from exc

        params: dict[str, object] = {"file_id": file_id}
        normalized_format = str(preferred_format or "").lower().lstrip(".")
        if normalized_format in {"srt", "ass", "vtt"}:
            params["sub_format"] = normalized_format

        try:
            # The authenticated API call returns a short-lived public download URL.
            # Keep provider credentials confined to api.opensubtitles.com: the file
            # request below uses a separate credential-free session and validates
            # every redirect hop before connecting.
            async with aiohttp.ClientSession(
                timeout=cls._timeout(30), headers=cls._opensubtitles_headers()
            ) as ticket_session:
                async with ticket_session.post(f"{OPENSUBTITLES_BASE}/download", params=params) as response:
                    payload = await response.json(content_type=None)
                    if response.status not in (200, 201):
                        message = payload.get("message") if isinstance(payload, dict) else None
                        raise SubtitleProviderError(
                            "opensubtitles",
                            message or f"download ticket returned HTTP {response.status}",
                            response.status,
                        )
                    download_url = payload.get("link") if isinstance(payload, dict) else None
                    remote_name = payload.get("file_name") if isinstance(payload, dict) else None
                    if not download_url:
                        raise SubtitleProviderError("opensubtitles", "Download response did not include a link")

            current_url = str(download_url)
            for _ in range(6):
                try:
                    target = await resolve_public_http_target(current_url, require_https=True)
                except ValueError as exc:
                    raise SubtitleProviderError(
                        "opensubtitles", f"Unsafe subtitle download URL: {exc}"
                    ) from exc

                async with aiohttp.ClientSession(
                    timeout=cls._timeout(30),
                    headers={"User-Agent": USER_AGENT},
                    connector=pinned_connector(target),
                ) as download_session:
                    async with download_session.get(current_url, allow_redirects=False) as response:
                        if response.status in {301, 302, 303, 307, 308}:
                            location = response.headers.get("Location")
                            if not location:
                                raise SubtitleProviderError(
                                    "opensubtitles",
                                    "Subtitle download redirect did not include Location",
                                )
                            current_url = urljoin(current_url, location)
                            continue
                        if response.status != 200:
                            raise SubtitleProviderError(
                                "opensubtitles",
                                f"subtitle download returned HTTP {response.status}",
                                response.status,
                            )
                        try:
                            content = await read_response_limited(response, MAX_SUBTITLE_BYTES)
                        except ValueError as exc:
                            raise SubtitleProviderError(
                                "opensubtitles", "Downloaded subtitle exceeds the size limit"
                            ) from exc
                        break
            else:
                raise SubtitleProviderError(
                    "opensubtitles", "Subtitle download exceeded redirect limit"
                )
        except SubtitleProviderError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            raise SubtitleProviderError("opensubtitles", str(exc)) from exc

        if not content:
            raise SubtitleProviderError("opensubtitles", "Downloaded subtitle was empty")
        if len(content) > MAX_SUBTITLE_BYTES:
            raise SubtitleProviderError("opensubtitles", "Downloaded subtitle exceeds the size limit")
        return content, remote_name

    @classmethod
    async def _download_subdl(cls, download_ref: str) -> tuple[bytes, Optional[str]]:
        headers = cls._subdl_headers() if cls._configured(settings.SUBDL_API_KEY) else {}
        download_ref = str(download_ref or "").strip()

        # Search results expose only a secret-free provider path. Reconstruct the
        # actual request here so the SubDL API key never crosses the FastAPI/React
        # boundary. Accept an old dl.subdl.com URL defensively, but discard its
        # query string before use.
        provider_path = None
        if download_ref.startswith("subdl-path:"):
            provider_path = download_ref.split(":", 1)[1].strip()
        elif download_ref.startswith("https://"):
            legacy = urlparse(download_ref)
            if legacy.hostname == "dl.subdl.com":
                provider_path = legacy.path

        if provider_path is not None:
            if not provider_path.startswith("/") or ".." in PurePosixPath(provider_path).parts:
                raise SubtitleProviderError("subdl", "Invalid SubDL download path")
            download_url = urljoin(f"{SUBDL_DOWNLOAD_BASE}/", provider_path.lstrip("/"))
            request_headers = {}
            request_params = {}
            if cls._configured(settings.SUBDL_API_KEY):
                request_headers["x-api-key"] = settings.SUBDL_API_KEY
                # Current SubDL download links also accept/return api_key as a
                # query parameter. Supplying it here keeps that credential solely
                # inside the backend even when the CDN requires query auth.
                request_params["api_key"] = settings.SUBDL_API_KEY
            try:
                async with aiohttp.ClientSession(timeout=cls._timeout(30), headers=request_headers) as session:
                    async with session.get(download_url, params=request_params) as response:
                        if response.status != 200:
                            raise SubtitleProviderError(
                                "subdl",
                                f"subtitle download returned HTTP {response.status}",
                                response.status,
                            )
                        content = await read_response_limited(response, MAX_SUBTITLE_BYTES)
                        disposition = response.headers.get("Content-Disposition", "")
                        match = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';]+)', disposition, re.I)
                        remote_name = match.group(1).strip() if match else PurePosixPath(provider_path).name
            except SubtitleProviderError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
                raise SubtitleProviderError("subdl", str(exc)) from exc

            if not content:
                raise SubtitleProviderError("subdl", "Downloaded subtitle was empty")
            if len(content) > MAX_SUBTITLE_BYTES:
                raise SubtitleProviderError("subdl", "Downloaded subtitle exceeds the size limit")
            return content, remote_name

        # If a result only exposes its nId, resolve it through the authenticated
        # v2 download API.
        if str(download_ref or "").startswith("subdl-v2:"):
            n_id = str(download_ref).split(":", 1)[1].strip()
            if not n_id:
                raise SubtitleProviderError("subdl", "Invalid SubDL v2 subtitle id")
            try:
                async with aiohttp.ClientSession(timeout=cls._timeout(30), headers=headers) as session:
                    async with session.get(
                        f"{SUBDL_BASE}/subtitles/{n_id}/download",
                        params={"format": "file"},
                    ) as response:
                        content_type = response.headers.get("Content-Type", "").lower()
                        if response.status != 200:
                            text = await response.text()
                            raise SubtitleProviderError(
                                "subdl",
                                text[:200] or f"v2 download returned HTTP {response.status}",
                                response.status,
                            )
                        if "json" in content_type:
                            payload = await response.json(content_type=None)
                            resolved = None
                            if isinstance(payload, dict):
                                resolved = (
                                    payload.get("url")
                                    or payload.get("link")
                                    or payload.get("download_url")
                                    or payload.get("file_url")
                                )
                            if not resolved:
                                raise SubtitleProviderError("subdl", "v2 download response did not include a file URL")
                            download_ref = urljoin(f"{SUBDL_DOWNLOAD_BASE}/", str(resolved))
                        else:
                            content = await read_response_limited(response, MAX_SUBTITLE_BYTES)
                            disposition = response.headers.get("Content-Disposition", "")
                            match = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';]+)', disposition, re.I)
                            remote_name = match.group(1).strip() if match else f"{n_id}.srt"
                            if not content:
                                raise SubtitleProviderError("subdl", "Downloaded subtitle was empty")
                            if len(content) > MAX_SUBTITLE_BYTES:
                                raise SubtitleProviderError("subdl", "Downloaded subtitle exceeds the size limit")
                            return content, remote_name
            except SubtitleProviderError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
                raise SubtitleProviderError("subdl", str(exc)) from exc

        parsed = urlparse(str(download_ref or ""))
        if parsed.scheme != "https" or parsed.hostname != "dl.subdl.com":
            raise SubtitleProviderError("subdl", "Invalid SubDL download URL")

        # SubDL v2 accepts X-API-Key on download links. Use that instead of the
        # bearer header intended for api.subdl.com endpoints.
        download_headers = {}
        if cls._configured(settings.SUBDL_API_KEY):
            download_headers["x-api-key"] = settings.SUBDL_API_KEY

        try:
            async with aiohttp.ClientSession(timeout=cls._timeout(30), headers=download_headers) as session:
                async with session.get(download_ref) as response:
                    if response.status != 200:
                        raise SubtitleProviderError(
                            "subdl",
                            f"subtitle download returned HTTP {response.status}",
                            response.status,
                        )
                    content = await read_response_limited(response, MAX_SUBTITLE_BYTES)
                    disposition = response.headers.get("Content-Disposition", "")
                    match = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';]+)', disposition, re.I)
                    remote_name = match.group(1).strip() if match else PurePosixPath(parsed.path).name
        except SubtitleProviderError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            raise SubtitleProviderError("subdl", str(exc)) from exc

        if not content:
            raise SubtitleProviderError("subdl", "Downloaded subtitle was empty")
        if len(content) > MAX_SUBTITLE_BYTES:
            raise SubtitleProviderError("subdl", "Downloaded subtitle exceeds the size limit")
        return content, remote_name

    @classmethod
    def _normalize_downloaded_content(
        cls,
        content: bytes,
        suggested_name: str,
        preferred_format: Optional[str],
    ) -> tuple[bytes, str]:
        preferred_extension = f".{str(preferred_format or '').lower().lstrip('.')}"
        if preferred_extension not in SUPPORTED_EXTENSIONS:
            preferred_extension = ".srt"

        if content.startswith(b"PK\x03\x04"):
            try:
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    candidates = []
                    for info in archive.infolist():
                        if info.is_dir() or info.file_size <= 0 or info.file_size > MAX_SUBTITLE_BYTES:
                            continue
                        suffix = os.path.splitext(info.filename)[1].lower()
                        if suffix in SUPPORTED_EXTENSIONS:
                            candidates.append((info, suffix))
                    if not candidates:
                        raise SubtitleProviderError("subdl", "Subtitle archive contains no supported subtitle file")
                    candidates.sort(
                        key=lambda pair: (
                            0 if pair[1] == preferred_extension else 1,
                            SUPPORTED_EXTENSIONS.index(pair[1]),
                            pair[0].file_size,
                        )
                    )
                    selected, suffix = candidates[0]
                    content = archive.read(selected)
                    suggested_name = PurePosixPath(selected.filename).name or suggested_name
            except (zipfile.BadZipFile, RuntimeError) as exc:
                raise SubtitleProviderError("subdl", f"Could not unpack subtitle archive: {exc}") from exc

        if len(content) > MAX_SUBTITLE_BYTES:
            raise SubtitleProviderError("subtitle", "Subtitle exceeds the size limit")

        extension = os.path.splitext(suggested_name)[1].lower()
        if extension not in SUPPORTED_EXTENSIONS:
            extension = preferred_extension
            suggested_name = f"{os.path.splitext(suggested_name)[0]}{extension}"
        filename = cls._safe_name(suggested_name, f"subtitle{extension}")
        return content, filename

    @classmethod
    async def _cache_put(cls, subtitle: CachedSubtitle) -> None:
        async with cls._cache_lock:
            cls._purge_cache_locked()

            def cache_bytes() -> int:
                return sum(len(item.content) for item in cls._cache.values())

            # Bound both entry count and total bytes. The latter prevents a run
            # of maximum-size subtitles from retaining ~200 MiB in-process.
            while cls._cache and (
                len(cls._cache) >= CACHE_MAX_ENTRIES
                or cache_bytes() + len(subtitle.content) > CACHE_MAX_BYTES
            ):
                oldest = min(cls._cache.values(), key=lambda item: item.created_at)
                cls._cache.pop(oldest.token, None)
            cls._cache[subtitle.token] = subtitle

    @classmethod
    async def get_cached(cls, token: str) -> Optional[CachedSubtitle]:
        async with cls._cache_lock:
            cls._purge_cache_locked()
            return cls._cache.get(token)

    @classmethod
    async def delete_cached(cls, token: str) -> bool:
        async with cls._cache_lock:
            return cls._cache.pop(token, None) is not None

    @classmethod
    def _purge_cache_locked(cls) -> None:
        cutoff = time.time() - CACHE_TTL_SECONDS
        expired = [token for token, item in cls._cache.items() if item.created_at < cutoff]
        for token in expired:
            cls._cache.pop(token, None)
