#!/usr/bin/env python3
"""Read-only smoke test for NetWatch's TMDB -> Prowlarr catalog flow."""

import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"


def get_json(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=40) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    query = " ".join(sys.argv[1:]).strip() or "Inception"
    print(f"Searching TMDB for: {query}")
    payload = get_json("/api/metadata/movies/search?" + urllib.parse.urlencode({"query": query}))
    results = payload.get("results") or []
    if not results:
        print("FAIL: TMDB returned no movies")
        return 1

    movie = results[0]
    print(
        f"TMDB: {movie.get('title')} ({movie.get('year') or 'unknown year'}) "
        f"poster={'yes' if movie.get('poster') else 'no'} backdrop={'yes' if movie.get('backdrop') else 'no'}"
    )

    stream_payload = get_json(f"/api/metadata/movies/{int(movie['id'])}/stream-options?min_seeders=1")
    detail = stream_payload.get("movie") or {}
    releases = stream_payload.get("results") or []
    print(f"Detail: imdb={detail.get('imdb_id') or 'n/a'} runtime={detail.get('runtime') or 'n/a'} min")
    print(f"Automatic torrent query: {stream_payload.get('query')!r}")
    print(f"Torrent options: {len(releases)}")

    release_error = stream_payload.get("release_error")
    if release_error:
        print(f"FAIL: release search error: {release_error}")
        return 1

    print("PASS: TMDB search -> movie detail -> automatic Prowlarr release search")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
