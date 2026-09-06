from __future__ import annotations

import asyncio
import hashlib
import json
import re
import tempfile
import time
import unicodedata
from datetime import date
from pathlib import Path
from typing import Any

from config import settings
from services.anilist import AniListService
from services.exceptions import DependencyUnavailableError


_SERIES_FORMATS = {"TV", "TV_SHORT", "ONA"}
_MOVIE_FORMATS = {"MOVIE"}
_MAINLINE_RELATIONS = {"PREQUEL", "SEQUEL"}
_CACHE_SCHEMA = 2
_CACHE_FILENAME = "anilist-identity-v2.json"
_POSITIVE_TTL = 30 * 24 * 60 * 60
_NEGATIVE_TTL = 6 * 60 * 60
_MAX_CACHE_ENTRIES = 256
_MAX_ALIASES = 12


def _normalized_title(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").casefold())
    text = "".join(char for char in text if not unicodedata.combining(char))
    return " ".join(re.findall(r"[^\W_]+", text, flags=re.UNICODE))


def _clean_alias(value: Any) -> str | None:
    text = unicodedata.normalize("NFC", str(value or ""))
    text = " ".join(text.split()).strip()
    if not text or len(text) > 160 or any(ord(char) < 32 or ord(char) == 127 for char in text):
        return None
    return text


def _aliases(item: dict[str, Any]) -> list[str]:
    candidates: list[Any] = []
    title = item.get("title")
    if isinstance(title, dict):
        # Anime release names overwhelmingly use the romanized title. Keep the
        # English/native identities for matching, but make romaji the first
        # search alias returned to the release-query planner.
        candidates.extend((title.get("romaji"), title.get("english"), title.get("native")))
    candidates.extend(item.get("synonyms") if isinstance(item.get("synonyms"), list) else [])
    result: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        value = _clean_alias(candidate)
        comparison = _normalized_title(value or "")
        if value and comparison and comparison not in seen:
            seen.add(comparison)
            result.append(value)
        if len(result) >= _MAX_ALIASES:
            break
    return result


def _start_date(item: dict[str, Any]) -> date | None:
    value = item.get("startDate")
    if not isinstance(value, dict):
        return None
    try:
        year = int(value.get("year") or 0)
        month = int(value.get("month") or 1)
        day = int(value.get("day") or 1)
        return date(year, month, day) if year > 0 else None
    except (TypeError, ValueError):
        return None


def _tmdb_date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value or "")[:10])
    except ValueError:
        return None


def _episode_count(item: dict[str, Any]) -> int | None:
    value = item.get("episodes")
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 2000 else None


def _base_eligible(item: dict[str, Any]) -> bool:
    return (
        isinstance(item.get("id"), int)
        and not bool(item.get("isAdult"))
        and str(item.get("countryOfOrigin") or "").upper() == "JP"
        and bool(_aliases(item))
    )


def _eligible_series(item: dict[str, Any]) -> bool:
    if not _base_eligible(item):
        return False
    if item.get("format") in _SERIES_FORMATS:
        return True
    return item.get("format") == "OVA" and (_episode_count(item) or 0) > 1


def _eligible_movie(item: dict[str, Any]) -> bool:
    if not _base_eligible(item):
        return False
    if item.get("format") in _MOVIE_FORMATS:
        return True
    return item.get("format") == "OVA" and _episode_count(item) == 1


def _summary(status: str, **values: Any) -> dict[str, Any]:
    return {
        "status": status,
        "source": values.pop("source", "tmdb"),
        "confidence": values.pop("confidence", "none"),
        "aliases": values.pop("aliases", []),
        "installment_episode": values.pop("installment_episode", None),
        "anilist_id": values.pop("anilist_id", None),
        "anilist_year": values.pop("anilist_year", None),
        **values,
    }


class AnimeIdentityResolver:
    _cache: dict[str, dict[str, Any]] | None = None
    _cache_lock = asyncio.Lock()
    _inflight: dict[str, asyncio.Task] = {}

    @classmethod
    def _cache_path(cls) -> Path | None:
        root = str(settings.NETWATCH_CACHE_DIR or "").strip()
        return Path(root) / _CACHE_FILENAME if root else None

    @classmethod
    def _load_cache(cls) -> dict[str, dict[str, Any]]:
        if cls._cache is not None:
            return cls._cache
        cls._cache = {}
        path = cls._cache_path()
        if path is None or not path.is_file():
            return cls._cache
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
            if envelope.get("schema_version") != _CACHE_SCHEMA or not isinstance(envelope.get("entries"), dict):
                return cls._cache
            now = time.time()
            cls._cache = {
                str(key): value for key, value in envelope["entries"].items()
                if isinstance(value, dict) and float(value.get("expires_at") or 0) > now
            }
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            cls._cache = {}
        return cls._cache

    @classmethod
    def _store_cache(cls) -> None:
        if cls._cache is None:
            return
        now = time.time()
        cls._cache = dict(sorted(
            (
                (key, value) for key, value in cls._cache.items()
                if float(value.get("expires_at") or 0) > now
            ),
            key=lambda pair: float(pair[1].get("cached_at") or 0),
            reverse=True,
        )[:_MAX_CACHE_ENTRIES])
        path = cls._cache_path()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            data = json.dumps(
                {"schema_version": _CACHE_SCHEMA, "entries": cls._cache},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            with tempfile.NamedTemporaryFile(
                dir=path.parent, prefix=".anilist-cache-", suffix=".tmp", delete=False
            ) as handle:
                handle.write(data)
                temporary = Path(handle.name)
            temporary.replace(path)
        except OSError:
            return

    @classmethod
    def _key(cls, series: dict[str, Any], season: int, episode: int) -> str:
        target = next(
            (
                item for item in series.get("seasons", [])
                if isinstance(item, dict) and item.get("season_number") == season
            ),
            {},
        )
        identity = json.dumps({
            "id": series.get("id"),
            "title": series.get("title"),
            "original_title": series.get("original_title"),
            "year": series.get("year"),
            "season": season,
            "episode": episode,
            "season_air_date": target.get("air_date"),
            "season_episodes": target.get("episode_count"),
        }, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    @classmethod
    def _movie_key(cls, movie: dict[str, Any]) -> str:
        identity = json.dumps({
            "kind": "movie",
            "id": movie.get("id"),
            "title": movie.get("title"),
            "original_title": movie.get("original_title"),
            "year": movie.get("year"),
        }, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    @classmethod
    async def resolve_movie(cls, movie: dict[str, Any]) -> dict[str, Any]:
        if not AniListService.enabled():
            return _summary("ANILIST_DISABLED")
        key = cls._movie_key(movie)
        async with cls._cache_lock:
            cached = cls._load_cache().get(key)
            if cached and float(cached.get("expires_at") or 0) > time.time():
                result = dict(cached.get("result") or {})
                result["status"] = "ANILIST_CACHE_HIT"
                return result
            task = cls._inflight.get(key)
            if task is None:
                task = asyncio.create_task(cls._resolve_movie_uncached(movie))
                cls._inflight[key] = task
        try:
            result = dict(await task)
        finally:
            async with cls._cache_lock:
                if cls._inflight.get(key) is task:
                    cls._inflight.pop(key, None)
        ttl = _POSITIVE_TTL if result.get("confidence") == "high" else _NEGATIVE_TTL
        if result.get("status") != "ANILIST_UNAVAILABLE":
            async with cls._cache_lock:
                cls._load_cache()[key] = {
                    "cached_at": time.time(),
                    "expires_at": time.time() + ttl,
                    "result": result,
                }
                cls._store_cache()
        return result

    @classmethod
    async def _resolve_movie_uncached(cls, movie: dict[str, Any]) -> dict[str, Any]:
        tmdb_aliases = [
            value for value in (
                _clean_alias(movie.get("title")),
                _clean_alias(movie.get("original_title")),
                *[_clean_alias(value) for value in (movie.get("alternative_titles") or [])[:8]],
            ) if value
        ]
        queries: list[str] = []
        for value in tmdb_aliases:
            if _normalized_title(value) not in {_normalized_title(item) for item in queries}:
                queries.append(value)
            if len(queries) >= 2:
                break
        if not queries:
            return _summary("ANILIST_AMBIGUOUS", reason="no TMDB title identity")
        try:
            pages = await asyncio.gather(*(AniListService.search(value) for value in queries))
        except DependencyUnavailableError as exc:
            return _summary("ANILIST_UNAVAILABLE", reason=exc.message)

        candidates: dict[int, dict[str, Any]] = {}
        for page in pages:
            for item in page:
                if _eligible_movie(item):
                    candidates[item["id"]] = item
        normalized_tmdb = {_normalized_title(value) for value in tmdb_aliases if _normalized_title(value)}
        target_date = _tmdb_date(movie.get("release_date"))
        target_year = int(movie.get("year") or 0) if str(movie.get("year") or "").isdigit() else 0
        ranked: list[tuple[int, dict[str, Any]]] = []
        for item in candidates.values():
            if not (normalized_tmdb & {_normalized_title(value) for value in _aliases(item)}):
                continue
            started = _start_date(item)
            if target_year and started and abs(started.year - target_year) > 1:
                continue
            score = 8
            if target_year and started and started.year == target_year:
                score += 4
            if target_date and started and abs((started - target_date).days) <= 120:
                score += 3
            if item.get("format") == "MOVIE":
                score += 1
            ranked.append((score, item))
        ranked.sort(key=lambda pair: (-pair[0], _start_date(pair[1]) or date.max, pair[1]["id"]))
        if not ranked:
            return _summary("ANILIST_AMBIGUOUS", reason="no exact movie title and year match")
        if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
            return _summary("ANILIST_AMBIGUOUS", reason="multiple anime movies had equal evidence")
        selected = ranked[0][1]
        started = _start_date(selected)
        return _summary(
            "ANILIST_MATCHED",
            source="anilist",
            confidence="high",
            aliases=_aliases(selected),
            anilist_id=selected["id"],
            anilist_year=(started.year if started else None),
            evidence="exact movie title plus release-year evidence",
            media_strategy=("movie" if selected.get("format") == "MOVIE" else "single-episode-ova"),
        )

    @classmethod
    async def resolve(
        cls,
        series: dict[str, Any],
        season: int,
        episode: int,
        tmdb_absolute: int | None,
    ) -> dict[str, Any]:
        if not AniListService.enabled():
            return _summary("ANILIST_DISABLED")
        key = cls._key(series, season, episode)
        async with cls._cache_lock:
            cached = cls._load_cache().get(key)
            if cached and float(cached.get("expires_at") or 0) > time.time():
                result = dict(cached.get("result") or {})
                result["status"] = "ANILIST_CACHE_HIT"
                return result
            task = cls._inflight.get(key)
            if task is None:
                task = asyncio.create_task(cls._resolve_uncached(series, season, episode, tmdb_absolute))
                cls._inflight[key] = task
        try:
            result = dict(await task)
        finally:
            async with cls._cache_lock:
                if cls._inflight.get(key) is task:
                    cls._inflight.pop(key, None)
        ttl = _POSITIVE_TTL if result.get("confidence") == "high" else _NEGATIVE_TTL
        if result.get("status") != "ANILIST_UNAVAILABLE":
            async with cls._cache_lock:
                cls._load_cache()[key] = {
                    "cached_at": time.time(),
                    "expires_at": time.time() + ttl,
                    "result": result,
                }
                cls._store_cache()
        return result

    @classmethod
    async def _resolve_uncached(
        cls,
        series: dict[str, Any],
        season: int,
        episode: int,
        tmdb_absolute: int | None,
    ) -> dict[str, Any]:
        tmdb_aliases = [
            value for value in (
                _clean_alias(series.get("title")),
                _clean_alias(series.get("original_title")),
                *[_clean_alias(value) for value in (series.get("alternative_titles") or [])[:8]],
            ) if value
        ]
        queries: list[str] = []
        for value in tmdb_aliases:
            if _normalized_title(value) not in {_normalized_title(item) for item in queries}:
                queries.append(value)
            if len(queries) >= 2:
                break
        if not queries:
            return _summary("ANILIST_AMBIGUOUS", reason="no TMDB title identity")
        try:
            pages = await asyncio.gather(*(AniListService.search(value) for value in queries))
        except DependencyUnavailableError as exc:
            return _summary("ANILIST_UNAVAILABLE", reason=exc.message)

        nodes: dict[int, dict[str, Any]] = {}
        edges: set[tuple[int, int]] = set()
        for page in pages:
            for item in page:
                if isinstance(item.get("id"), int):
                    nodes[item["id"]] = item
                relations = item.get("relations")
                relation_edges = relations.get("edges") if isinstance(relations, dict) else None
                for edge in relation_edges if isinstance(relation_edges, list) else []:
                    if not isinstance(edge, dict) or edge.get("relationType") not in _MAINLINE_RELATIONS:
                        continue
                    node = edge.get("node")
                    if not isinstance(node, dict) or not isinstance(node.get("id"), int):
                        continue
                    nodes.setdefault(node["id"], node)
                    if isinstance(item.get("id"), int):
                        edges.add(tuple(sorted((item["id"], node["id"]))))

        eligible = {key: value for key, value in nodes.items() if _eligible_series(value)}
        normalized_tmdb = {_normalized_title(value) for value in tmdb_aliases if _normalized_title(value)}
        series_date = _tmdb_date(series.get("release_date"))
        anchors: list[dict[str, Any]] = []
        for item in eligible.values():
            exact = bool(normalized_tmdb & {_normalized_title(value) for value in _aliases(item)})
            started = _start_date(item)
            year_ok = not series_date or not started or abs(started.year - series_date.year) <= 1
            if exact and year_ok:
                anchors.append(item)
        if not anchors:
            return _summary("ANILIST_AMBIGUOUS", reason="no exact title and year anchor")

        anchors.sort(key=lambda item: (
            abs(((_start_date(item) or date.max) - (series_date or _start_date(item) or date.max)).days),
            item["id"],
        ))
        if len(anchors) > 1:
            first_date = _start_date(anchors[0])
            second_date = _start_date(anchors[1])
            first_distance = abs(((first_date or date.max) - (series_date or first_date or date.max)).days)
            second_distance = abs(((second_date or date.max) - (series_date or second_date or date.max)).days)
            if first_distance == second_distance:
                return _summary("ANILIST_AMBIGUOUS", reason="multiple exact title anchors had equal evidence")
        anchor = anchors[0]
        component = {anchor["id"]}
        adjacency: dict[int, set[int]] = {}
        for left, right in edges:
            adjacency.setdefault(left, set()).add(right)
            adjacency.setdefault(right, set()).add(left)
        frontier = [anchor["id"]]
        while frontier and len(component) < 20:
            current = frontier.pop(0)
            for related in sorted(adjacency.get(current, set())):
                if related not in eligible or related in component:
                    continue
                component.add(related)
                frontier.append(related)
                if len(component) >= 20:
                    break

        target_season = next(
            (
                item for item in series.get("seasons", [])
                if isinstance(item, dict) and item.get("season_number") == season
            ),
            {},
        )
        target_date = _tmdb_date(target_season.get("air_date"))
        target_count = target_season.get("episode_count")
        target_count = target_count if isinstance(target_count, int) and target_count > 0 else None

        ranked: list[tuple[int, dict[str, Any]]] = []
        for item_id in component:
            item = eligible[item_id]
            score = 4
            aliases = {_normalized_title(value) for value in _aliases(item)}
            if normalized_tmdb & aliases:
                score += 4
            started = _start_date(item)
            if target_date and started:
                distance = abs((started - target_date).days)
                score += 5 if distance <= 120 else 3 if distance <= 370 else 0
            count = _episode_count(item)
            if target_count and count == target_count:
                score += 4
            if item.get("format") == "TV":
                score += 1
            ranked.append((score, item))
        ranked.sort(key=lambda pair: (-pair[0], _start_date(pair[1]) or date.max, pair[1]["id"]))
        if not ranked:
            return _summary("ANILIST_AMBIGUOUS", reason="mainline relation graph was empty")
        best_score, selected = ranked[0]
        if len(ranked) > 1 and ranked[1][0] == best_score:
            return _summary("ANILIST_AMBIGUOUS", reason="multiple installments had equal evidence")

        selected_episode: int | None = None
        selected_start = _start_date(selected)
        selected_count = _episode_count(selected)
        date_aligned = bool(target_date and selected_start and abs((selected_start - target_date).days) <= 370)
        counts_match = bool(target_count and selected_count == target_count)
        count_conflict = bool(target_count and selected_count and target_count != selected_count)
        if best_score >= 9 and (counts_match or (date_aligned and not count_conflict)):
            selected_episode = episode
        elif tmdb_absolute:
            anchor_start = _start_date(anchor)
            timeline = sorted(
                (
                    item for item_id, item in eligible.items()
                    if item_id in component and _episode_count(item) and (
                        not anchor_start or not _start_date(item) or _start_date(item) >= anchor_start
                    )
                ),
                key=lambda item: (_start_date(item) or date.max, item["id"]),
            )
            remaining = tmdb_absolute
            for item in timeline:
                count = _episode_count(item) or 0
                if remaining <= count:
                    selected = item
                    selected_start = _start_date(selected)
                    selected_episode = remaining
                    break
                remaining -= count

        if selected_episode is None or selected_episode <= 0:
            return _summary(
                "ANILIST_COORDINATE_UNPROVEN",
                anilist_id=selected.get("id"),
                anilist_year=(selected_start.year if selected_start else None),
                reason="installment episode could not be proven",
            )
        return _summary(
            "ANILIST_MATCHED",
            source="anilist",
            confidence="high",
            aliases=_aliases(selected),
            installment_episode=selected_episode,
            anilist_id=selected["id"],
            anilist_year=(selected_start.year if selected_start else None),
            evidence="exact title anchor plus mainline date/episode evidence",
        )
