"""Optional episode metadata. All provider traffic stays inside the VPN runtime."""

import asyncio
import json
import math
import re
import time
from collections import OrderedDict
from datetime import date, datetime, timezone

import aiohttp

from services.metadata import MetadataService
from services.anime_identity import AnimeIdentityResolver, absolute_episode_number
from services.exceptions import DependencyUnavailableError
from services.net_safety import pinned_connector, read_response_limited, resolve_public_http_target


_IMDB = re.compile(r"tt\d{5,12}\Z")
_CATEGORIES = {
    "SEXUAL_CONTENT": "Sex & nudity",
    "VIOLENCE": "Violence",
    "PROFANITY": "Language",
    "ALCOHOL_DRUGS": "Alcohol & drugs",
    "FRIGHTENING_INTENSE_SCENES": "Intense scenes",
}
_cache = OrderedDict()
_pending = {}


def parse_segment(payload, kind="intro"):
    segment = payload.get(kind) if isinstance(payload, dict) else None
    if not isinstance(segment, dict):
        return None
    start, end = segment.get("start_sec"), segment.get("end_sec")
    if not all(type(value) in (int, float) and math.isfinite(value) for value in (start, end)):
        return None
    if not (0 <= start < end <= 4 * 3600 and end - start <= (300 if kind == "intro" else 600)):
        return None
    confidence = segment.get("confidence")
    if confidence is not None and (
        type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0.5 <= confidence <= 1
    ):
        return None
    return {"start": start, "end": end}


def parse_guidance(payload):
    rows = payload.get("parentsGuide") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        return []
    result = {}
    for row in rows[:20]:
        if not isinstance(row, dict) or row.get("category") not in _CATEGORIES:
            continue
        votes = {"none": 0, "mild": 0, "moderate": 0, "severe": 0}
        breakdowns = row.get("severityBreakdowns")
        for entry in breakdowns[:20] if isinstance(breakdowns, list) else []:
            if not isinstance(entry, dict):
                continue
            level, count = str(entry.get("severityLevel", "")).lower(), entry.get("voteCount")
            if level in votes and type(count) is int and 0 <= count <= 100_000_000:
                votes[level] = max(votes[level], count)
        severity = max(votes, key=votes.get)
        if severity != "none" and votes[severity] > 0:
            result[row["category"]] = {"label": _CATEGORIES[row["category"]], "severity": severity}
    # Provider reviews can contain spoilers; only return controlled labels and severity.
    return [result[key] for key in _CATEGORIES if key in result]


def matched_segment(payload, imdb_id, season, episode, kind="intro"):
    if not isinstance(payload, dict) or payload.get("imdb_id") != imdb_id:
        return None
    if type(payload.get("season")) is not int or type(payload.get("episode")) is not int:
        return None
    if payload["season"] != season or payload["episode"] != episode or payload.get("is_movie") is True:
        return None
    return parse_segment(payload, kind)


def parse_aniskip(payload, duration):
    if not isinstance(payload, dict) or payload.get("found") is not True or not 0 < duration <= 14400:
        return None
    rows = payload.get("results")
    if not isinstance(rows, list):
        return None
    result = {}
    for skip_type, kind in (("op", "intro"), ("ed", "outro")):
        candidates = []
        for row in rows[:100]:
            if not isinstance(row, dict) or row.get("skipType") != skip_type:
                continue
            length = row.get("episodeLength")
            interval = row.get("interval")
            if not isinstance(interval, dict):
                continue
            start, end = interval.get("startTime"), interval.get("endTime")
            if not all(type(v) in (int, float) and math.isfinite(v) for v in (length, start, end)):
                continue
            # Different cuts can move the opening independently of the ending.
            # Never stretch or shift timestamps to fit a different release.
            if abs(length - duration) > 2 or not 0 <= start < end <= duration + 0.5:
                continue
            if end - start > (300 if kind == "intro" else 600):
                continue
            if (kind == "intro" and (start >= duration / 2 or end >= duration)) or (kind == "outro" and start < duration / 2):
                continue
            candidates.append((abs(length - duration), start, min(end, duration)))
        if candidates:
            candidates.sort()
            best = candidates[0]
            # Equally close but conflicting submissions are not safe to auto-skip.
            if any(abs(row[0] - best[0]) <= 0.1 and (abs(row[1] - best[1]) > 2 or abs(row[2] - best[2]) > 2)
                   for row in candidates[1:]):
                continue
            result[kind] = {"start": best[1], "end": best[2]}
    return result or None


async def _anime_segments(series, season, episode, duration):
    if not 0 < duration <= 14400:
        return None
    try:
        identity = await AnimeIdentityResolver.resolve(
            series, season, episode, absolute_episode_number(series, season, episode))
    except (DependencyUnavailableError, aiohttp.ClientError, OSError, ValueError, TypeError, TimeoutError):
        return None
    mal_id, number = identity.get("mal_id"), identity.get("installment_episode")
    count = identity.get("installment_episode_count")
    if (identity.get("confidence") != "high" or type(mal_id) is not int or not 0 < mal_id <= 2147483647
            or type(number) is not int or not 0 < number <= 9999
            or (type(count) is int and count > 0 and number > count)):
        return None
    return await _optional(
        f"https://api.aniskip.com/v2/skip-times/{mal_id}/{number}?types=op&types=ed&episodeLength={duration:.3f}",
        lambda payload: parse_aniskip(payload, duration))


async def _fetch_optional(url, parser):
    async def fetch():
        target = await resolve_public_http_target(url, require_https=True)
        async with aiohttp.ClientSession(
            connector=pinned_connector(target), timeout=aiohttp.ClientTimeout(total=6), trust_env=False,
        ) as session:
            async with session.get(url, allow_redirects=False, headers={"Accept": "application/json"}) as response:
                if response.status != 200:
                    return None
                return parser(json.loads(await read_response_limited(response, 256 * 1024)))
    try:
        return await asyncio.wait_for(fetch(), timeout=8)
    except (aiohttp.ClientError, OSError, ValueError, TypeError, TimeoutError, RecursionError):
        return None


async def _optional(url, parser):
    cached = _cache.get(url)
    if cached and cached[0] > time.monotonic():
        _cache.move_to_end(url)
        return cached[1]
    task = _pending.get(url)
    if task is None:
        if len(_pending) >= 16:
            return None

        async def run():
            try:
                value = await _fetch_optional(url, parser)
                _cache[url] = (time.monotonic() + (3600 if value else 300), value)
                _cache.move_to_end(url)
                while len(_cache) > 256:
                    _cache.popitem(last=False)
                return value
            finally:
                _pending.pop(url, None)
        task = asyncio.create_task(run())
        _pending[url] = task
    return await asyncio.shield(task)


def content_rating(series):
    ratings = series.get("content_ratings") or []
    countries = ["US", "GB", *(series.get("origin_country") or [])]
    for country in dict.fromkeys(countries):
        for rating in ratings:
            if not isinstance(rating, dict) or rating.get("iso_3166_1") != country:
                continue
            value = rating.get("rating")
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9 +\-/]{1,16}", value.strip()):
                return {"label": value.strip(), "country": country}
    return None


def _aired(episode):
    try:
        return date.fromisoformat(episode.get("air_date") or "") <= datetime.now(timezone.utc).date()
    except (TypeError, ValueError):
        return False


async def next_episode(tmdb_id, season, episode, series=None):
    series = series or await MetadataService.get_series(tmdb_id)
    current = await MetadataService.get_season(tmdb_id, season)
    episodes = current.get("episodes") or []
    if not any(item.get("episode_number") == episode for item in episodes):
        return None
    candidates = sorted((item for item in episodes if item.get("episode_number", 0) > episode),
                        key=lambda item: item["episode_number"])
    if not candidates:
        # Never jump from specials into the regular season order.
        seasons = sorted(item["season_number"] for item in series.get("seasons", [])
                         if season > 0 and item.get("season_number", 0) > season and item.get("episode_count", 0) > 0)
        if not seasons:
            return None
        following = await MetadataService.get_season(tmdb_id, seasons[0])
        candidates = sorted(following.get("episodes") or [], key=lambda item: item["episode_number"])
    if not candidates or not _aired(candidates[0]):
        return None
    return candidates[0]


async def playback_info(tmdb_id, season, episode, duration=0):
    series = await MetadataService.get_series(tmdb_id)
    imdb_id = series.get("imdb_id") or ""
    valid_imdb = isinstance(imdb_id, str) and _IMDB.fullmatch(imdb_id)

    async def segments():
        if series.get("is_anime"):
            return await _anime_segments(series, season, episode, duration)
        if valid_imdb:
            return await _optional(
                f"https://api.introdb.app/segments?imdb_id={imdb_id}&season={season}&episode={episode}",
                lambda payload: {kind: matched_segment(payload, imdb_id, season, episode, kind)
                                 for kind in ("intro", "outro")})
        return None

    async def guidance():
        return await _optional(f"https://api.tiffara.com/titles/{imdb_id}/parentsGuide", parse_guidance) if valid_imdb else []

    timings, warnings = await asyncio.gather(segments(), guidance())
    return {
        "genres": [genre[:60] for genre in series.get("genres", []) if isinstance(genre, str)][:3],
        "rating": content_rating(series),
        "intro": (timings or {}).get("intro"),
        "outro": (timings or {}).get("outro"),
        "guidance": warnings or [],
        "guidance_scope": "series",
    }
