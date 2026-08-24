from __future__ import annotations

import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass


@dataclass(frozen=True)
class ReleaseReference:
    source_url: str
    expected_hash: str | None
    expires_at: float


class ReleaseReferenceStore:
    """Short-lived opaque references for provider download URLs.

    Provider URLs may embed credentials (for example Prowlarr's ``apikey`` query
    parameter). They must never cross the backend/renderer trust boundary. Search
    results therefore expose only a random reference that is resolved here when a
    user actually starts playback.
    """

    TTL_SECONDS = 15 * 60
    MAX_ENTRIES = 2048
    _entries: "OrderedDict[str, ReleaseReference]" = OrderedDict()
    _lock = threading.Lock()

    @classmethod
    def _purge_locked(cls, now: float) -> None:
        expired = [key for key, value in cls._entries.items() if value.expires_at <= now]
        for key in expired:
            cls._entries.pop(key, None)
        while len(cls._entries) > cls.MAX_ENTRIES:
            cls._entries.popitem(last=False)

    @classmethod
    def issue(cls, source_url: str, expected_hash: str | None = None) -> str:
        source = str(source_url or "").strip()
        if not source:
            raise ValueError("release source is empty")
        normalized_hash = str(expected_hash or "").strip().lower() or None
        now = time.monotonic()
        with cls._lock:
            cls._purge_locked(now)
            token = secrets.token_urlsafe(32)
            while token in cls._entries:
                token = secrets.token_urlsafe(32)
            cls._entries[token] = ReleaseReference(
                source_url=source,
                expected_hash=normalized_hash,
                expires_at=now + cls.TTL_SECONDS,
            )
            cls._purge_locked(now)
            return token

    @classmethod
    def resolve(cls, token: str) -> ReleaseReference | None:
        key = str(token or "").strip()
        if not key:
            return None
        now = time.monotonic()
        with cls._lock:
            cls._purge_locked(now)
            entry = cls._entries.get(key)
            if entry is None:
                return None
            cls._entries.move_to_end(key)
            return entry

    @classmethod
    def discard(cls, token: str) -> None:
        key = str(token or "").strip()
        if not key:
            return
        with cls._lock:
            cls._entries.pop(key, None)

    @classmethod
    def clear(cls) -> None:
        """Test/support hook; never returns stored provider URLs."""
        with cls._lock:
            cls._entries.clear()
