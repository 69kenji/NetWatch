import re
import unicodedata

from fastapi import APIRouter, HTTPException, Query, Response

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


def _release_tokens(value: str) -> list[str]:
    # A few indexers prepend a release-group tag. Ignore at most two simple tags,
    # then compare the actual media identity rather than arbitrary keyword overlap.
    cleaned = value or ""
    for _ in range(2):
        match = re.match(r"^\s*\[[^\]\r\n]{1,80}\]\s*", cleaned)
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

    # Release names commonly compact punctuated acronyms: S.W.A.T. -> SWAT and
    # 9-1-1: Lone Star -> 911 Lone Star. Compact only runs of 2+ single tokens.
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

    # A colon-delimited subtitle is sometimes abbreviated in release names, e.g.
    # Law & Order: Special Victims Unit -> Law and Order SVU.
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


def _media_aliases(item: dict) -> list[str]:
    aliases: list[str] = []
    for key in ("title", "original_title"):
        value = str(item.get(key) or "").strip()
        if value and value.casefold() not in {alias.casefold() for alias in aliases}:
            aliases.append(value)
    return aliases


def _series_release_identity_matches(
    release_title: str,
    aliases: list[str],
    year: str | None,
    season: int,
    episode: int,
) -> bool:
    marker = None
    for pattern in (
        rf"\bS0*{season}E0*{episode}\b",
        rf"\b0*{season}x0*{episode}\b",
    ):
        marker = re.search(pattern, release_title or "", re.I)
        if marker:
            break
    if marker is None:
        return False

    prefix_tokens = _release_tokens((release_title or "")[:marker.start()])
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


def _episode_title_matches(title: str, season: int, episode: int) -> bool:
    normalized = title or ""
    patterns = [
        rf"\bS0*{season}E0*{episode}\b",
        rf"\b0*{season}x0*{episode}\b",
    ]
    return any(re.search(pattern, normalized, re.I) for pattern in patterns)


def _anime_episode_title_matches(title: str, season: int, episode: int) -> bool:
    if _episode_title_matches(title, season, episode):
        return True

    # Anime releases frequently use a simple absolute/episode number instead of
    # SxxEyy. Keep this conservative and reject obvious packs/batches so the
    # existing largest-video auto-selection cannot accidentally choose a season pack.
    lowered = (title or "").lower()
    if any(token in lowered for token in (" batch", "complete", "season pack", "全集")):
        return False

    episode_token = re.compile(
        rf"(?:^|[\s._\-\[\(])(?:ep(?:isode)?[\s._\-]*)?0*{episode}(?:v\d+)?(?=$|[\s._\-\]\)])",
        re.I,
    )
    return bool(episode_token.search(title or ""))


async def _movie_payload(tmdb_id: int, min_seeders: int) -> dict:
    movie = await MetadataService.get_movie(tmdb_id)
    title = (movie.get("title") or "").strip()
    results: list[dict] = []
    release_error = None

    if title:
        try:
            results = await ReleaseSearchService.search(
                query=title,
                imdb_id=movie.get("imdb_id"),
                min_seeders=min_seeders,
            )
            if not movie.get("is_anime"):
                aliases = _media_aliases(movie)
                results = [
                    item for item in results
                    if _movie_release_identity_matches(
                        item.get("title") or "", aliases, movie.get("year")
                    )
                ]
        except DependencyUnavailableError as exc:
            release_error = {"service": exc.service, "error": exc.message}

    return {
        "movie": movie,
        "query": title,
        "results": results,
        "release_error": release_error,
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
async def series_season(tmdb_id: int, season_number: int):
    try:
        return await MetadataService.get_season(tmdb_id, season_number)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc


@router.get("/series/{tmdb_id}/episodes/{season_number}/{episode_number}/stream-options")
async def episode_stream_options(
    tmdb_id: int,
    season_number: int,
    episode_number: int,
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
    query_attempts = [query]
    results: list[dict] = []
    release_error = None

    try:
        raw = await ReleaseSearchService.search(
            query=query,
            imdb_id=series.get("imdb_id"),
            min_seeders=min_seeders,
            max_results=80,
        )
        if anime or series.get("is_anime"):
            results = [
                item for item in raw
                if _anime_episode_title_matches(
                    item.get("title") or "", season_number, episode_number
                )
            ]
        else:
            aliases = _media_aliases(series)
            results = [
                item for item in raw
                if _series_release_identity_matches(
                    item.get("title") or "",
                    aliases,
                    series.get("year"),
                    season_number,
                    episode_number,
                )
            ]

        if not results and (anime or series.get("is_anime")):
            # Many anime indexers use absolute episode numbering and omit SxxEyy.
            # Retry once with the title + episode number, still filtering out packs.
            alt_query = f"{title} {episode_number:02d}"
            query_attempts.append(alt_query)
            raw = await ReleaseSearchService.search(
                query=alt_query,
                imdb_id=series.get("imdb_id"),
                min_seeders=min_seeders,
                max_results=80,
            )
            results = [item for item in raw if _anime_episode_title_matches(
                item.get("title") or "", season_number, episode_number
            )]
    except DependencyUnavailableError as exc:
        release_error = {"service": exc.service, "error": exc.message}

    return {
        "series": series,
        "episode": episode,
        "query": query,
        "query_attempts": query_attempts,
        "results": results,
        "release_error": release_error,
        "anime": bool(anime or series.get("is_anime")),
    }
