#!/usr/bin/env python3
"""Read-only subtitle provider smoke test against a running NetWatch backend.

By default this validates credentials and searches both providers without consuming
subtitle download quota. Pass --download to fetch one subtitle from each provider,
verify the local ephemeral file endpoint, then delete it again.
"""

import argparse
import json
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"


def request(method: str, path: str, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.status, dict(response.headers), response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--imdb-id", default="tt1375666", help="IMDb id used for the search smoke test")
    parser.add_argument("--query", default="Inception", help="title fallback used to validate text search")
    parser.add_argument("--language", default="en")
    parser.add_argument("--file-name", default="Inception.2010.1080p.BluRay.x264-REFiNED.mkv", help="release filename used to validate SubDL v2 release matching")
    parser.add_argument("--download", action="store_true", help="also test one download from each provider")
    args = parser.parse_args()

    _, _, body = request("GET", "/api/subtitles/providers")
    providers = json.loads(body)
    print("Provider validation:")
    for name in ("opensubtitles", "subdl"):
        state = providers.get(name) or {}
        print(f"  {name:14} status={state.get('status')} connected={state.get('connected')} authenticated={state.get('authenticated')}")
        if not state.get("connected"):
            print(f"    error={state.get('error')}")
            return 1

    query = urllib.parse.urlencode({
        "imdb_id": args.imdb_id,
        "query": args.query,
        "file_name": args.file_name,
        "languages": args.language,
    })
    _, _, body = request("GET", f"/api/subtitles/search?{query}")
    search = json.loads(body)
    results = search.get("results") or []

    counts = {"opensubtitles": 0, "subdl": 0}
    for row in results:
        if row.get("source") in counts:
            counts[row["source"]] += 1

    print("Search validation:")
    for name, count in counts.items():
        state = (search.get("providers") or {}).get(name) or {}
        extra = ""
        if name == "subdl":
            strategies = sorted({str(row.get("match_strategy")) for row in results if row.get("source") == "subdl" and row.get("match_strategy")})
            if strategies:
                extra = f" strategy={','.join(strategies)}"
        provider_count = state.get("count")
        provider_suffix = f" provider_count={provider_count}" if isinstance(provider_count, int) else ""
        print(f"  {name:14} status={state.get('status')} results={count}{provider_suffix}{extra}")
        if state.get("status") != "ok":
            print(f"    error={state.get('error')}")
            return 1
        if count <= 0:
            print(f"FAIL: {name} authenticated but contributed no visible search results")
            return 1

    leaked = [
        row for row in results
        if "api_key=" in str(row.get("download_ref") or "").lower()
    ]
    if leaked:
        print("FAIL: subtitle search response leaked a provider API key in a download reference")
        return 1

    if not args.download:
        print("PASS: both subtitle providers authenticated and searched successfully")
        return 0

    for provider in ("subdl", "opensubtitles"):
        candidate = next((row for row in results if row.get("source") == provider), None)
        if not candidate:
            print(f"FAIL: no {provider} result available to download")
            return 1

        payload = {
            "subtitle_id": candidate["id"],
            "source": provider,
            "download_ref": candidate["download_ref"],
            "format": candidate.get("format"),
            "file_name": candidate.get("file_name"),
        }
        _, _, body = request("POST", "/api/subtitles/download", payload)
        downloaded = json.loads(body)
        token = downloaded["token"]
        try:
            file_url = downloaded["url"]
            with urllib.request.urlopen(file_url, timeout=45) as response:
                content = response.read()
            if not content:
                print(f"FAIL: {provider} downloaded an empty subtitle")
                return 1
            print(f"  {provider:14} download={len(content)} bytes filename={downloaded.get('filename')}")
        finally:
            request("DELETE", f"/api/subtitles/file/{urllib.parse.quote(token, safe='')}")

    print("PASS: both subtitle providers searched and downloaded successfully")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise
