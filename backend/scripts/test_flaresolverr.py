#!/usr/bin/env python3
"""Read-only smoke test for NetWatch's local FlareSolverr integration."""

import json
import urllib.request

BASE = "http://127.0.0.1:8000"


def get_json(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    payload = get_json("/api/diagnostics/flaresolverr")
    if not payload.get("connected"):
        print(f"FAIL: FlareSolverr unavailable: {payload.get('error') or payload.get('status')}")
        return 1

    print(
        f"FlareSolverr: status={payload.get('status')} "
        f"sessions={payload.get('session_count')} url={payload.get('url')}"
    )
    print("PASS: FlareSolverr API is reachable from NetWatch inside the VPN namespace")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
