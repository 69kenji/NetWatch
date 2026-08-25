from __future__ import annotations

import json
import re
import threading
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable


class BodySizeLimitMiddleware:
    """Bound request bodies before Starlette/Pydantic allocate arbitrary JSON."""

    def __init__(self, app, max_bytes: int = 256 * 1024):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length")
        if raw_length:
            try:
                if int(raw_length) > self.max_bytes:
                    await self._reject(send)
                    return
            except ValueError:
                await self._reject(send)
                return

        total = 0
        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            message_type = message.get("type")
            if message_type == "http.disconnect":
                return
            if message_type != "http.request":
                continue
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > self.max_bytes:
                await self._reject(send)
                return
            body.extend(chunk)
            more_body = bool(message.get("more_body"))

        delivered = False

        async def replay_receive():
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _reject(send):
        payload = json.dumps({"detail": "Request body exceeds the size limit"}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        })
        await send({"type": "http.response.body", "body": payload})


class RateLimitMiddleware:
    """Small in-process limiter for quota-expensive loopback API operations.

    This is deliberately not an authentication boundary. It protects provider
    quotas and the local service from accidental/renderer request storms.
    """

    # Each rule returns a stable bucket as well as the request/window limit.
    # Dynamic TMDB routes intentionally share buckets so rotating through IDs
    # cannot bypass throttling while still keeping unrelated operations separate.
    LIMITS = {
        ("POST", "/api/torrents/search"): ("torrent-search", 30, 60.0),
        ("POST", "/api/diagnostics/subtitle-credential"): ("credential-validation", 12, 60.0),
        ("GET", "/api/metadata/status"): ("metadata-status", 30, 60.0),
        ("GET", "/api/metadata/home"): ("metadata-home", 30, 60.0),
        ("GET", "/api/metadata/search"): ("metadata-search", 60, 60.0),
        ("GET", "/api/metadata/movies/search"): ("metadata-search", 60, 60.0),
        ("GET", "/api/metadata/series/search"): ("metadata-search", 60, 60.0),
        ("GET", "/api/metadata/anime/search"): ("metadata-search", 60, 60.0),
        ("GET", "/api/metadata/discover"): ("metadata-catalog", 60, 60.0),
        ("GET", "/api/metadata/discover/genres"): ("metadata-catalog", 60, 60.0),
    }
    _METADATA_STREAM_RE = re.compile(
        r"^/api/metadata/(?:movies/\d+|series/\d+/episodes/\d+/\d+)/stream-options$"
    )
    _METADATA_DETAIL_RE = re.compile(
        r"^/api/metadata/(?:movies/\d+|series/\d+(?:/seasons/\d+)?)$"
    )

    def __init__(self, app):
        self.app = app
        self._events: dict[tuple[str, str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _rule_for(self, method: str, path: str) -> tuple[str, int, float] | None:
        direct = self.LIMITS.get((method, path))
        if direct:
            return direct
        if method == "GET" and self._METADATA_STREAM_RE.fullmatch(path):
            return ("metadata-stream-options", 60, 60.0)
        if method == "GET" and self._METADATA_DETAIL_RE.fullmatch(path):
            return ("metadata-details", 90, 60.0)
        return None

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "")
        rule = self._rule_for(method, path)
        if not rule:
            await self.app(scope, receive, send)
            return

        bucket, count, window = rule
        client = scope.get("client") or ("local", 0)
        client_host = str(client[0] or "local")
        now = time.monotonic()
        key = (method, bucket, client_host)
        with self._lock:
            events = self._events[key]
            cutoff = now - window
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= count:
                retry_after = max(1, int(window - (now - events[0]) + 0.999))
            else:
                events.append(now)
                retry_after = 0
            # Bound bookkeeping even if a non-loopback deployment is accidentally used.
            if len(self._events) > 2048:
                stale = [k for k, q in self._events.items() if not q or q[-1] <= cutoff]
                for stale_key in stale[:1024]:
                    self._events.pop(stale_key, None)

        if retry_after:
            payload = json.dumps({"detail": "Too many requests; retry shortly"}).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode("ascii")),
                    (b"retry-after", str(retry_after).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            })
            await send({"type": "http.response.body", "body": payload})
            return

        await self.app(scope, receive, send)
