import re
import unicodedata

from fastapi import APIRouter, HTTPException, Path as ApiPath, Query, Response

from services.anime_identity import AnimeIdentityResolver
from services.exceptions import DependencyUnavailableError
from services.metadata import MetadataService
from services.release_search import ReleaseSearchService

router = APIRouter()


def dependency_503(exc: DependencyUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={"service": exc.service, "error": exc.message},
    )


_REGION_DISAMBIGUATORS = {"us", "uk", "au", "nz", "ca"}
_MOVIE_RELEASE_BOUNDARIES = {
    "2160p", "1080p", "720p", "480p",
    "web", "webdl", "webrip", "bluray", "bdrip", "brrip", "hdtv", "dvdrip", "hdrip",
    "remux", "x264", "x265", "h264", "h265", "hevc", "av1",
    "proper", "repack", "internal", "extended", "unrated",
}
_MIN_FALLBACK_RESULTS = 3
_MAX_RELEASE_QUERIES = 5
_MAX_ANIME_RELEASE_QUERIES = 9
_MAX_ANIME_RECOVERY_QUERIES = 1
_ANIME_SHORT_ALIAS_REJECT_TOKENS = {
    "movie", "ova", "oad", "ona", "special", "specials", "short", "shorts",
    "recap", "chibi", "petit", "spinoff", "spin-off", "break",
}


def _regex_decimal(value: int, *, minimum: int = 0, maximum: int = 9999) -> str:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError("episode coordinates are out of range")
    return re.escape(str(value))


def _release_tokens(value: str) -> list[str]:
    # A few indexers prepend one or more release-group tags. Ignore a small,
    # bounded set of common decorative tag styles, then compare the actual media
    # identity rather than arbitrary keyword overlap.
    cleaned = value or ""
    leading_tag = re.compile(
        r"^\s*(?:\[[^\]\r\n]{1,80}\]|【[^】\r\n]{1,80}】|〖[^〗\r\n]{1,80}〗|［[^］\r\n]{1,80}］)\s*"
    )
    for _ in range(4):
        match = leading_tag.match(cleaned)
        if not match:
            break
        cleaned = cleaned[match.end():]
    cleaned = cleaned.replace("&", " and ")
    normalized = unicodedata.normalize("NFKD", cleaned.casefold())
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return re.findall(r"[^\W_]+", normalized, flags=re.UNICODE)


def _title_variants(title: str) -> list[list[str]]:
    tokens = _release_tokens(title)
    if not tokens:
        return []
    variants = [tokens]

    # Release names commonly compact punctuated acronyms and numeric title runs.
    # Compact only runs of 2+ single tokens.
    compacted: list[str] = []
    run: list[str] = []
    for token in tokens + [""]:
        if len(token) == 1:
            run.append(token)
            continue
        if run:
            compacted.append("".join(run) if len(run) >= 2 else run[0])
            run = []
        if token:
            compacted.append(token)
    if compacted != tokens:
        variants.append(compacted)

    # A colon-delimited subtitle is sometimes abbreviated to an acronym in
    # release names.
    if ":" in title:
        prefix, suffix = title.split(":", 1)
        prefix_tokens = _release_tokens(prefix)
        suffix_tokens = _release_tokens(suffix)
        if prefix_tokens and len(suffix_tokens) >= 2:
            acronym = "".join(token[0] for token in suffix_tokens if token)
            if len(acronym) >= 2:
                variant = prefix_tokens + [acronym]
                if variant not in variants:
                    variants.append(variant)
    return variants


def _normalize_release_alias(value: str) -> str:
    normalized = unicodedata.normalize("NFC", str(value or ""))
    normalized = re.sub(r"\s+", " ", normalized).strip()
    normalized = re.sub(r"\s+([:!?])", r"\1", normalized)
    return normalized[:160]


def _short_release_alias(value: str) -> str | None:
    # Only shorten an explicit dash-delimited subtitle. Colons remain part of
    # the canonical identity and are never treated as subtitle delimiters.
    match = re.match(r"^(.{2,80}?)\s+[-–—]\s*\S.{3,}$", value)
    if not match:
        return None
    shortened = _normalize_release_alias(match.group(1))
    return shortened if len(_release_tokens(shortened)) <= 6 else None


def _media_aliases(item: dict, *, include_short: bool = True) -> list[str]:
    aliases: list[str] = []
    candidates = [item.get("title"), item.get("original_title")]
    alternatives = item.get("alternative_titles")
    if isinstance(alternatives, list):
        candidates.extend(alternatives[:12])
    for candidate in candidates:
        value = _normalize_release_alias(candidate)
        comparison = unicodedata.normalize("NFKC", value).casefold()
        if value and comparison not in {
            unicodedata.normalize("NFKC", alias).casefold() for alias in aliases
        }:
            aliases.append(value)
        if len(aliases) >= 8:
            break
    if include_short and aliases:
        shortened = _short_release_alias(aliases[0])
        if shortened and shortened.casefold() not in {alias.casefold() for alias in aliases}:
            aliases.append(shortened)
    return aliases[:8]


def _absolute_episode_number(series: dict, season: int, episode: int) -> int | None:
    if season <= 0 or episode <= 0:
        return None
    seasons = series.get("seasons")
    if not isinstance(seasons, list):
        return None
    counts: dict[int, int] = {}
    for item in seasons:
        if not isinstance(item, dict):
            continue
        number = item.get("season_number")
        count = item.get("episode_count")
        if isinstance(number, bool) or not isinstance(number, int):
            continue
        if 0 < number <= season and isinstance(count, int) and not isinstance(count, bool) and 0 < count <= 2000:
            counts[number] = count
    if any(number not in counts for number in range(1, season + 1)) or episode > counts[season]:
        return None
    prior = sum(counts[number] for number in range(1, season))
    absolute = prior + episode
    return absolute if 0 < absolute <= 9999 else None


def _identity_prefix_matches(prefix: str, aliases: list[str], year: str | None) -> bool:
    prefix_tokens = _release_tokens(prefix)
    target_year = str(year or "").strip()
    for alias in aliases:
        for expected in _title_variants(alias):
            if prefix_tokens[:len(expected)] != expected:
                continue
            extras = prefix_tokens[len(expected):]
            if not extras:
                return True
            if target_year and extras == [target_year]:
                return True
            if len(extras) == 1 and extras[0] in _REGION_DISAMBIGUATORS:
                return True
            if target_year and len(extras) == 2 and target_year in extras:
                other = extras[1] if extras[0] == target_year else extras[0]
                if other in _REGION_DISAMBIGUATORS:
                    return True
    return False


def _series_release_identity_matches(
    release_title: str,
    aliases: list[str],
    year: str | None,
    season: int,
    episode: int,
) -> bool:
    season_token = _regex_decimal(season)
    episode_token = _regex_decimal(episode)
    marker = None
    for pattern in (
        rf"\bS0*{season_token}E0*{episode_token}\b",
        rf"\b0*{season_token}x0*{episode_token}\b",
    ):
        marker = re.search(pattern, release_title or "", re.I)
        if marker:
            break
    if marker is None:
        return False

    return _identity_prefix_matches((release_title or "")[:marker.start()], aliases, year)


def _movie_release_identity_matches(release_title: str, aliases: list[str], year: str | None) -> bool:
    tokens = _release_tokens(release_title)
    target_year = str(year or "").strip()
    for alias in aliases:
        for expected in _title_variants(alias):
            if tokens[:len(expected)] != expected:
                continue
            remainder = tokens[len(expected):]
            if not remainder:
                return True
            first = remainder[0]
            if re.fullmatch(r"(?:19|20)\d{2}", first):
                return not target_year or first == target_year
            if first in _MOVIE_RELEASE_BOUNDARIES:
                return True
            if first in _REGION_DISAMBIGUATORS and len(remainder) > 1:
                second = remainder[1]
                if re.fullmatch(r"(?:19|20)\d{2}", second):
                    return not target_year or second == target_year
                return second in _MOVIE_RELEASE_BOUNDARIES
    return False


def episode_query(title: str, season: int, episode: int) -> str:
    return f"{title} S{season:02d}E{episode:02d}"


def _anime_installment_queries(
    aliases: list[str],
    season: int,
    episode: int,
    installment_episode: int,
) -> list[str]:
    """Build bounded searches for a proven AniList installment identity.

    Release indexers mix three coordinate conventions: the metadata season
    coordinate (S04E15), an installment-local coordinate (S01E15), and a bare
    local episode (15). Search all three for AniList's romaji alias, then one
    bare fallback for its English alias. The strict title matcher still decides
    which returned rows belong to the selected episode.
    """
    if not aliases or installment_episode <= 0:
        return []
    primary = aliases[0]
    queries = [
        episode_query(primary, season, episode),
        f"{primary} {installment_episode:02d}",
    ]
    if (season, episode) != (1, installment_episode):
        queries.append(episode_query(primary, 1, installment_episode))
    if len(aliases) > 1:
        queries.append(f"{aliases[1]} {installment_episode:02d}")
    return queries


def _episode_title_matches(title: str, season: int, episode: int) -> bool:
    normalized = title or ""
    season_token = _regex_decimal(season)
    episode_token = _regex_decimal(episode)
    patterns = [
        rf"\bS0*{season_token}E0*{episode_token}\b",
        rf"\b0*{season_token}x0*{episode_token}\b",
    ]
    return any(re.search(pattern, normalized, re.I) for pattern in patterns)


def _anime_identity_segments(prefix: str) -> list[str]:
    segments = [prefix or ""]
    segments.extend(
        segment
        for segment in re.split(r"[\/／|｜_]+", prefix or "")
        if segment.strip()
    )
    deduped: list[str] = []
    seen: set[str] = set()
    for segment in segments:
        normalized = unicodedata.normalize("NFKC", segment).casefold().strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            deduped.append(segment)
    return deduped


def _anime_short_alias_prefix_matches(
    prefix: str,
    short_alias: str | None,
    year: str | None,
) -> bool:
    """Match a conservative short alias against longer anime release identities.

    Some anime indexers publish localized, original-script, and romanized names in
    the same release title. Metadata may only provide a short localized alias. This
    exception is intentionally limited to absolute-episode matching; normal TV and
    movie identity checks remain strict.
    """
    if not short_alias:
        return False

    target_year = str(year or "").strip()
    for candidate in _anime_identity_segments(prefix):
        prefix_tokens = _release_tokens(candidate)
        for expected in _title_variants(short_alias):
            if len(expected) < 2:
                continue

            # Decorative group tags are stripped by _release_tokens(). Explicit
            # multilingual separators are split above, so the alias still has to
            # begin a meaningful title segment rather than occur arbitrarily inside
            # an unrelated release name.
            if prefix_tokens[:len(expected)] != expected:
                continue

            extras = prefix_tokens[len(expected):]
            if target_year and extras[-1:] == [target_year]:
                extras = extras[:-1]
            if extras[-1:] and extras[-1] in _REGION_DISAMBIGUATORS:
                extras = extras[:-1]

            # Exact short-alias matches are handled by _identity_prefix_matches().
            # Here we only permit a bounded longer identity, which covers romanized
            # naming without turning the short alias into a general keyword match.
            if len(extras) < 2 or len(extras) > 16:
                continue
            if any(token in _ANIME_SHORT_ALIAS_REJECT_TOKENS for token in extras):
                continue
            return True
    return False


def _anime_identity_matches_prefix(
    prefix: str,
    aliases: list[str],
    year: str | None,
    short_alias: str | None,
) -> bool:
    if any(_identity_prefix_matches(segment, aliases, year) for segment in _anime_identity_segments(prefix)):
        return True
    return _anime_short_alias_prefix_matches(prefix, short_alias, year)


def _anime_series_coordinate_matches(
    title: str,
    aliases: list[str],
    year: str | None,
    season: int,
    episode: int,
    short_alias: str | None,
) -> bool:
    season_token = _regex_decimal(season)
    episode_token = _regex_decimal(episode)
    for pattern in (
        rf"\bS0*{season_token}E0*{episode_token}\b",
        rf"\b0*{season_token}x0*{episode_token}\b",
    ):
        marker = re.search(pattern, title or "", re.I)
        if marker and _anime_identity_matches_prefix(
            (title or "")[:marker.start()], aliases, year, short_alias
        ):
            return True
    return False


def _anime_absolute_episode_pattern(absolute_episode: int) -> re.Pattern[str]:
    episode_value = _regex_decimal(absolute_episode)
    return re.compile(
        rf"(?:"
        rf"(?:^|[^\w]|_)(?:(?:e(?:p(?:isode)?)?|#)[\s._\-:#]*)?0*{episode_value}(?:v\d+)?(?=$|[^\w]|_)"
        rf"|(?:总|總)?第\s*0*{episode_value}(?:\s*[集話话])?(?:v\d+)?(?=$|[^\w]|_)"
        rf")",
        re.I,
    )


def _anime_explicit_overall_episode_pattern(absolute_episode: int) -> re.Pattern[str]:
    episode_value = _regex_decimal(absolute_episode)
    return re.compile(
        rf"(?:"
        rf"(?:总|總)?第\s*0*{episode_value}(?:\s*[集話话])?"
        rf"|\b(?:overall|total|absolute|abs)\s*(?:(?:episode|ep|e)\s*)?[#:\-]?\s*0*{episode_value}\b"
        rf")",
        re.I,
    )


def _anime_alternate_coordinate(
    title: str,
    aliases: list[str],
    year: str | None,
    absolute_episode: int,
    short_alias: str | None,
) -> tuple[int, int] | None:
    """Infer a broadcast-style coordinate from a release that also names the absolute episode.

    This is deliberately evidence-based. A coordinate is only returned when the
    release identity matches and the same title contains the requested absolute
    episode plus an explicit season/local-episode relationship.
    """
    value = title or ""
    for absolute_marker in _anime_explicit_overall_episode_pattern(absolute_episode).finditer(value):
        prefix = value[:absolute_marker.start()]
        if not _anime_identity_matches_prefix(prefix, aliases, year, short_alias):
            continue

        # Strongest form: the release itself contains an SxxEyy coordinate before
        # the absolute marker.
        explicit = list(re.finditer(r"\bS0*(\d{1,2})E0*(\d{1,3})\b", prefix, re.I))
        if explicit:
            season = int(explicit[-1].group(1))
            episode = int(explicit[-1].group(2))
            if 0 < season <= 99 and 0 < episode <= 999:
                return season, episode

        # Some release names state a season identity, then put the local episode
        # immediately before an explicit overall/absolute marker.
        season_markers: list[tuple[int, int]] = []
        for match in re.finditer(r"\bS(?:eason)?\s*0*(\d{1,2})\b", prefix, re.I):
            season_markers.append((match.start(), int(match.group(1))))
        for match in re.finditer(r"\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b", prefix, re.I):
            season_markers.append((match.start(), int(match.group(1))))
        if not season_markers:
            continue
        season = max(season_markers, key=lambda item: item[0])[1]

        local = re.search(r"(?:^|[^\w])0*(\d{1,3})\s*[-–—~:]\s*$", prefix)
        if local:
            episode = int(local.group(1))
            if 0 < season <= 99 and 0 < episode <= 999:
                return season, episode
    return None


def _anime_episode_title_matches(
    title: str,
    aliases: list[str],
    year: str | None,
    season: int,
    episode: int,
    absolute_episode: int | None,
    short_alias: str | None = None,
) -> bool:
    if _anime_series_coordinate_matches(title, aliases, year, season, episode, short_alias):
        return True
    # Anime releases frequently use a simple absolute/episode number instead of
    # SxxEyy. Keep this conservative and reject obvious packs/batches so the
    # existing largest-video auto-selection cannot accidentally choose a season pack.
    lowered = (title or "").lower()
    if any(token in lowered for token in (" batch", "complete", "season pack", "全集")):
        return False
    if absolute_episode is None:
        return False
    episode_value = _regex_decimal(absolute_episode)
    # A plain numeric range is a pack even when the title omits words such as
    # "batch" or "complete". Require a real token boundary before the first
    # range number so season labels such as S01 - 81 are not mistaken for 01-81.
    if re.search(rf"(?<![\w])\d{{1,4}}\s*[-–—~]\s*0*{episode_value}(?![\w])", title or "", re.I):
        return False
    if re.search(rf"(?<![\w])0*{episode_value}\s*[-–—~]\s*\d{{1,4}}(?![\w])", title or "", re.I):
        return False

    # Absolute-number releases appear in several common forms: a separated bare
    # number, E/EP/Episode/# markers, or an explicit ordinal/overall marker.
    # Evaluate every candidate occurrence because title decorations may contain
    # other numbers before the actual episode marker.
    episode_token = _anime_absolute_episode_pattern(absolute_episode)
    for marker in episode_token.finditer(title or ""):
        prefix = (title or "")[:marker.start()]
        if _anime_identity_matches_prefix(prefix, aliases, year, short_alias):
            return True
    return False


async def _bounded_anime_search(
    queries: list[str],
    *,
    imdb_id: str | None,
    min_seeders: int,
    aliases: list[str],
    year: str | None,
    season: int,
    episode: int,
    absolute_episode: int,
    short_alias: str | None,
    extra_matcher=None,
) -> tuple[list[str], list[dict]]:
    attempts: list[str] = []
    accepted: list[dict] = []
    observed: list[dict] = []

    def base_matcher(release_title: str) -> bool:
        matched = _anime_episode_title_matches(
            release_title,
            aliases,
            year,
            season,
            episode,
            absolute_episode,
            short_alias,
        )
        return matched or bool(extra_matcher and extra_matcher(release_title))

    for query in _dedupe_queries(queries, max_queries=_MAX_ANIME_RELEASE_QUERIES):
        attempts.append(query)
        raw = await ReleaseSearchService.search(
            query=query,
            imdb_id=imdb_id,
            min_seeders=min_seeders,
            max_results=80,
        )
        observed = ReleaseSearchService.merge([*observed, *raw], max_results=160)
        accepted = ReleaseSearchService.merge([
            *accepted,
            *(item for item in raw if base_matcher(item.get("title") or "")),
        ], max_results=80)
        if len(accepted) >= _MIN_FALLBACK_RESULTS:
            break

    # If metadata uses continuous numbering while releases use a broadcast-style
    # season coordinate, infer that coordinate only from a matching release that
    # explicitly ties it to the requested absolute episode. Then allow one extra,
    # bounded targeted query for that coordinate.
    coordinate_counts: dict[tuple[int, int], int] = {}
    for item in observed:
        coordinate = _anime_alternate_coordinate(
            item.get("title") or "",
            aliases,
            year,
            absolute_episode,
            short_alias,
        )
        if coordinate and coordinate != (season, episode):
            coordinate_counts[coordinate] = coordinate_counts.get(coordinate, 0) + 1

    if coordinate_counts:
        alternate = max(coordinate_counts, key=lambda value: (coordinate_counts[value], -value[0], -value[1]))

        def alternate_matcher(release_title: str) -> bool:
            return base_matcher(release_title) or _anime_series_coordinate_matches(
                release_title,
                aliases,
                year,
                alternate[0],
                alternate[1],
                short_alias,
            )

        accepted = ReleaseSearchService.merge([
            *accepted,
            *(item for item in observed if alternate_matcher(item.get("title") or "")),
        ], max_results=80)

        recovery_alias = short_alias or (aliases[0] if aliases else "")
        recovery_query = (
            f"{recovery_alias} S{alternate[0]:02d}E{alternate[1]:02d}"
            if recovery_alias else ""
        )
        if recovery_query and all(
            unicodedata.normalize("NFKC", recovery_query).casefold()
            != unicodedata.normalize("NFKC", attempt).casefold()
            for attempt in attempts
        ):
            for _ in range(_MAX_ANIME_RECOVERY_QUERIES):
                attempts.append(recovery_query)
                raw = await ReleaseSearchService.search(
                    query=recovery_query,
                    imdb_id=imdb_id,
                    min_seeders=min_seeders,
                    max_results=80,
                )
                accepted = ReleaseSearchService.merge([
                    *accepted,
                    *(item for item in raw if alternate_matcher(item.get("title") or "")),
                ], max_results=80)
                break

    return attempts, accepted


def _dedupe_queries(values: list[str], *, max_queries: int = _MAX_RELEASE_QUERIES) -> list[str]:
    queries: list[str] = []
    comparisons: set[str] = set()
    for value in values:
        normalized = _normalize_release_alias(value)
        comparison = unicodedata.normalize("NFKC", normalized).casefold()
        if normalized and comparison not in comparisons:
            comparisons.add(comparison)
            queries.append(normalized)
        if len(queries) >= max_queries:
            break
    return queries


async def _bounded_search(
    queries: list[str],
    *,
    imdb_id: str | None,
    min_seeders: int,
    matcher,
    max_queries: int = _MAX_RELEASE_QUERIES,
) -> tuple[list[str], list[dict]]:
    attempts: list[str] = []
    accepted: list[dict] = []
    for query in _dedupe_queries(queries, max_queries=max_queries):
        attempts.append(query)
        raw = await ReleaseSearchService.search(
            query=query,
            imdb_id=imdb_id,
            min_seeders=min_seeders,
            max_results=80,
        )
        accepted = ReleaseSearchService.merge([
            *accepted,
            *(item for item in raw if matcher(item.get("title") or "")),
        ], max_results=80)
        if len(accepted) >= _MIN_FALLBACK_RESULTS:
            break
    return attempts, accepted


async def _movie_payload(tmdb_id: int, min_seeders: int) -> dict:
    movie = await MetadataService.get_movie(tmdb_id)
    title = (movie.get("title") or "").strip()
    results: list[dict] = []
    query_attempts: list[str] = []
    release_error = None
    anime_identity = {
        "status": "ANILIST_DISABLED",
        "source": "tmdb",
        "confidence": "none",
    }

    if title:
        try:
            aliases = _media_aliases(movie)
            query_aliases = [*aliases]
            if movie.get("is_anime"):
                try:
                    resolved = await AnimeIdentityResolver.resolve_movie(movie)
                    anime_identity = {
                        key: resolved.get(key)
                        for key in (
                            "status", "source", "confidence", "anilist_id",
                            "anilist_year", "evidence", "reason", "media_strategy",
                        )
                        if resolved.get(key) is not None
                    }
                    resolved_aliases = resolved.get("aliases")
                    if resolved.get("confidence") == "high" and isinstance(resolved_aliases, list):
                        enriched: list[str] = []
                        seen = {unicodedata.normalize("NFKC", value).casefold() for value in aliases}
                        for candidate in resolved_aliases:
                            value = _normalize_release_alias(candidate)
                            comparison = unicodedata.normalize("NFKC", value).casefold()
                            if value and comparison not in seen:
                                seen.add(comparison)
                                enriched.append(value)
                            if len(enriched) >= 8:
                                break
                        aliases = [*aliases, *enriched]
                        query_aliases = [*enriched, *query_aliases]
                except Exception:
                    anime_identity = {
                        "status": "ANILIST_UNAVAILABLE",
                        "source": "tmdb",
                        "confidence": "none",
                    }
            query_attempts, results = await _bounded_search(
                query_aliases,
                imdb_id=movie.get("imdb_id"),
                min_seeders=min_seeders,
                matcher=(
                    lambda release_title: _movie_release_identity_matches(
                        release_title, aliases, movie.get("year")
                    )
                ),
            )
        except DependencyUnavailableError as exc:
            release_error = {"service": exc.service, "error": exc.message}

    return {
        "movie": movie,
        "query": title,
        "query_attempts": query_attempts,
        "results": results,
        "release_error": release_error,
        "anime_identity": anime_identity,
    }


@router.get("/status")
async def metadata_status():
    return await MetadataService.health_check()


@router.get("/image/{size}/{filename}")
async def metadata_image(size: str, filename: str):
    """Proxy TMDB artwork through FastAPI so artwork requests use the VPN namespace."""
    try:
        body, content_type = await MetadataService.fetch_image(size, filename)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"},
    )


@router.get("/home")
async def home_catalog():
    try:
        return await MetadataService.home_catalog()
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/discover/genres")
async def discover_genres(
    media: str = Query("movies", min_length=2, max_length=16),
):
    try:
        genres = await MetadataService.discover_genres(media)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"media": media.strip().lower(), "genres": genres}


@router.get("/discover")
async def discover_catalog(
    media: str = Query("movies", min_length=2, max_length=16),
    category: str = Query("popular", min_length=3, max_length=16),
    genre: int | None = Query(None, ge=1, le=99999),
):
    try:
        results = await MetadataService.discover_catalog(media, category, genre)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {
        "media": media.strip().lower(),
        "category": category.strip().lower(),
        "genre": genre,
        "results": results,
    }


@router.get("/search")
async def search_catalog(
    query: str = Query(..., min_length=1, max_length=160),
    page: int = Query(1, ge=1, le=500),
):
    try:
        results = await MetadataService.search_catalog(query, page=page)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"query": query.strip(), "results": results}


@router.get("/movies/search")
async def search_movies(
    query: str = Query(..., min_length=1, max_length=160),
    page: int = Query(1, ge=1, le=500),
):
    try:
        results = await MetadataService.search_movies(query, page=page)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"query": query.strip(), "results": results}


@router.get("/series/search")
async def search_series(
    query: str = Query(..., min_length=1, max_length=160),
    page: int = Query(1, ge=1, le=500),
):
    try:
        results = await MetadataService.search_series(query, page=page)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"query": query.strip(), "results": results}


@router.get("/anime/search")
async def search_anime(
    query: str = Query(..., min_length=1, max_length=160),
    page: int = Query(1, ge=1, le=500),
):
    try:
        results = await MetadataService.search_anime(query, page=page)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"query": query.strip(), "results": results}


@router.get("/movies/{tmdb_id}")
async def movie_details(tmdb_id: int):
    try:
        return await MetadataService.get_movie(tmdb_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/movies/{tmdb_id}/stream-options")
async def movie_stream_options(
    tmdb_id: int,
    min_seeders: int = Query(1, ge=0, le=100000),
):
    try:
        return await _movie_payload(tmdb_id, min_seeders)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/series/{tmdb_id}")
async def series_details(tmdb_id: int):
    try:
        return await MetadataService.get_series(tmdb_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/series/{tmdb_id}/seasons/{season_number}")
async def series_season(
    tmdb_id: int,
    season_number: int = ApiPath(..., ge=0, le=9999),
):
    try:
        return await MetadataService.get_season(tmdb_id, season_number)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/series/{tmdb_id}/episodes/{season_number}/{episode_number}/stream-options")
async def episode_stream_options(
    tmdb_id: int,
    season_number: int = ApiPath(..., ge=0, le=9999),
    episode_number: int = ApiPath(..., ge=0, le=9999),
    min_seeders: int = Query(1, ge=0, le=100000),
    anime: bool = Query(False),
):
    """Find single-episode releases for a TMDB TV episode.

    NetWatch deliberately excludes obvious season packs because the current
    torrent engine auto-selects one video file. Returning only episode-shaped
    releases prevents the player from silently opening the wrong episode.
    """
    try:
        series = await MetadataService.get_series(tmdb_id)
        episode = await MetadataService.get_episode(tmdb_id, season_number, episode_number)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc

    title = (series.get("title") or "").strip()
    query = episode_query(title, season_number, episode_number)
    query_attempts: list[str] = []
    results: list[dict] = []
    release_error = None
    is_anime = bool(anime or series.get("is_anime"))
    aliases = _media_aliases(series, include_short=False)
    short_alias = _short_release_alias(title)
    absolute_episode = _absolute_episode_number(series, season_number, episode_number) if is_anime else None
    anime_identity = {
        "status": "ANILIST_DISABLED" if not is_anime else "ANILIST_UNAVAILABLE",
        "source": "tmdb",
        "confidence": "none",
    }
    installment_aliases: list[str] = []
    installment_episode: int | None = None
    installment_year: str | None = None

    if is_anime:
        try:
            resolved = await AnimeIdentityResolver.resolve(
                series,
                season_number,
                episode_number,
                absolute_episode,
            )
            anime_identity = {
                key: resolved.get(key)
                for key in (
                    "status", "source", "confidence", "anilist_id",
                    "anilist_year", "installment_episode", "evidence", "reason",
                )
                if resolved.get(key) is not None
            }
            if resolved.get("confidence") == "high":
                episode_value = resolved.get("installment_episode")
                installment_episode = (
                    episode_value
                    if isinstance(episode_value, int)
                    and not isinstance(episode_value, bool)
                    and 0 < episode_value <= 9999
                    else None
                )
                year_value = resolved.get("anilist_year")
                installment_year = str(year_value) if year_value else series.get("year")
                seen_aliases: set[str] = set()
                resolved_aliases = resolved.get("aliases")
                for candidate in resolved_aliases if isinstance(resolved_aliases, list) else []:
                    value = _normalize_release_alias(candidate)
                    comparison = unicodedata.normalize("NFKC", value).casefold()
                    if value and comparison not in seen_aliases:
                        seen_aliases.add(comparison)
                        installment_aliases.append(value)
                    if len(installment_aliases) >= 8:
                        break
        except Exception:
            # Identity enrichment is optional. An internal/provider failure must
            # preserve the existing strict TMDB matcher and bounded query path.
            anime_identity = {
                "status": "ANILIST_UNAVAILABLE",
                "source": "tmdb",
                "confidence": "none",
            }

    try:
        legacy_query_candidates: list[str] = [query]
        if is_anime and absolute_episode is not None:
            legacy_query_candidates.append(f"{title} {absolute_episode:02d}")
        for alias in aliases[1:2]:
            legacy_query_candidates.append(episode_query(alias, season_number, episode_number))
            if is_anime and absolute_episode is not None:
                legacy_query_candidates.append(f"{alias} {absolute_episode:02d}")
        if is_anime and absolute_episode is not None and short_alias:
            legacy_query_candidates.append(f"{short_alias} {absolute_episode:02d}")

        # A high-confidence AniList match should improve the first searches, not
        # merely add an English S01 query at the tail. All legacy fallbacks remain
        # inside the same explicit bound, including the short absolute query.
        query_candidates: list[str] = []
        if installment_aliases and installment_episode:
            query_candidates.extend(_anime_installment_queries(
                installment_aliases,
                season_number,
                episode_number,
                installment_episode,
            ))
        query_candidates.extend(legacy_query_candidates)

        if is_anime:
            matching_aliases = [*aliases, *installment_aliases]
            if short_alias and short_alias.casefold() not in {value.casefold() for value in matching_aliases}:
                matching_aliases.append(short_alias)
            installment_short_alias = (
                _short_release_alias(installment_aliases[0]) if installment_aliases else None
            )

            def installment_matcher(release_title: str) -> bool:
                if not installment_aliases or not installment_episode:
                    return False
                return _anime_episode_title_matches(
                    release_title,
                    installment_aliases,
                    installment_year,
                    1,
                    installment_episode,
                    installment_episode,
                    installment_short_alias,
                )

            if absolute_episode is None:
                matcher = lambda release_title: _anime_series_coordinate_matches(
                    release_title,
                    matching_aliases,
                    series.get("year"),
                    season_number,
                    episode_number,
                    short_alias,
                ) or installment_matcher(release_title)
                query_attempts, results = await _bounded_search(
                    query_candidates,
                    imdb_id=series.get("imdb_id"),
                    min_seeders=min_seeders,
                    matcher=matcher,
                    max_queries=_MAX_ANIME_RELEASE_QUERIES,
                )
            else:
                query_attempts, results = await _bounded_anime_search(
                    query_candidates,
                    imdb_id=series.get("imdb_id"),
                    min_seeders=min_seeders,
                    aliases=matching_aliases,
                    year=series.get("year"),
                    season=season_number,
                    episode=episode_number,
                    absolute_episode=absolute_episode,
                    short_alias=short_alias,
                    extra_matcher=installment_matcher,
                )
        else:
            matcher = lambda release_title: _series_release_identity_matches(
                release_title,
                aliases,
                series.get("year"),
                season_number,
                episode_number,
            )
            query_attempts, results = await _bounded_search(
                query_candidates,
                imdb_id=series.get("imdb_id"),
                min_seeders=min_seeders,
                matcher=matcher,
            )
    except DependencyUnavailableError as exc:
        release_error = {"service": exc.service, "error": exc.message}

    return {
        "series": series,
        "episode": episode,
        "query": query,
        "query_attempts": query_attempts,
        "results": results,
        "release_error": release_error,
        "anime": is_anime,
        "absolute_episode": absolute_episode,
        "anime_identity": anime_identity,
    }
