#!/usr/bin/env python3
"""Read-only smoke test for NetWatch's direct 1337x -> FlareSolverr search path."""

import argparse
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("query", nargs="?", default="Interstellar")
    args = parser.parse_args()

    request = urllib.request.Request(
        BASE + "/api/torrents/search",
        data=json.dumps({"query": args.query, "min_seeders": 1}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=80) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"FAIL: backend returned HTTP {exc.code}: {body}")
        return 1
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 1

    direct = [
        item for item in (payload.get("results") or [])
        if item.get("source_type") == "1337x_detail"
    ]
    if not direct:
        print("FAIL: no direct 1337x results were returned")
        return 1

    print(f"1337x direct results: {len(direct)}")
    for item in direct[:5]:
        print(f"  seeds={item.get('seeders', 0):>5} size={item.get('size', 0):>12}  {item.get('title')}")
    print("PASS: NetWatch -> FlareSolverr -> 1337x search results are visible")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
