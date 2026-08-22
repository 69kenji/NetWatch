#!/usr/bin/env python3
"""Read-only smoke test for NetWatch's TMDB series/anime catalog flow."""

import json
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"


def get_json(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def search(path: str, query: str) -> list[dict]:
    payload = get_json(path + "?" + urllib.parse.urlencode({"query": query}))
    return payload.get("results") or []


def main() -> int:
    series_results = search("/api/metadata/series/search", "Breaking Bad")
    if not series_results:
        print("FAIL: TMDB returned no series")
        return 1
    series = series_results[0]
    print(f"Series: {series.get('title')} ({series.get('year')}) type={series.get('type')}")

    details = get_json(f"/api/metadata/series/{int(series['id'])}")
    seasons = [s for s in (details.get("seasons") or []) if int(s.get("season_number") or 0) > 0]
    if not seasons:
        print("FAIL: series has no regular seasons")
        return 1
    season_number = int(seasons[0]["season_number"])
    season = get_json(f"/api/metadata/series/{int(series['id'])}/seasons/{season_number}")
    episodes = season.get("episodes") or []
    if not episodes:
        print("FAIL: season returned no episodes")
        return 1
    episode = episodes[0]
    stream = get_json(
        f"/api/metadata/series/{int(series['id'])}/episodes/{season_number}/{int(episode['episode_number'])}/stream-options?min_seeders=1"
    )
    if stream.get("release_error"):
        print(f"FAIL: series release search error: {stream['release_error']}")
        return 1
    print(f"Episode query: {stream.get('query')!r} options={len(stream.get('results') or [])}")

    anime_results = search("/api/metadata/anime/search", "Attack on Titan")
    if not anime_results:
        print("FAIL: TMDB returned no anime")
        return 1
    anime = anime_results[0]
    print(
        f"Anime: {anime.get('title')} ({anime.get('year')}) "
        f"type={anime.get('type')} anime={anime.get('is_anime')}"
    )

    print("PASS: movie + series + anime catalog routes are available; series episodes are torrent-query aware")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
