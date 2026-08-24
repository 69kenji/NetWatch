from __future__ import annotations

import asyncio
import base64
from typing import Optional

import aiohttp

from config import settings
from services.exceptions import DependencyUnavailableError


class RangeRequestSupersededError(RuntimeError):
    pass


class RangeRequestCancelledError(RuntimeError):
    pass


class TorrentEngineService:
    """HTTP adapter for NetWatch's direct-libtorrent sidecar.

    The public FastAPI torrent routes keep their existing contract while this
    adapter owns communication with the dedicated direct-libtorrent sidecar.
    """

    _session: Optional[aiohttp.ClientSession] = None
    _base = settings.TORRENT_ENGINE_URL.rstrip("/")

    @classmethod
    async def _ensure_session(cls) -> aiohttp.ClientSession:
        if cls._session is None or cls._session.closed:
            cls._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=settings.DEPENDENCY_TIMEOUT_SECS)
            )
        return cls._session

    @classmethod
    async def _json(
        cls,
        method: str,
        path: str,
        *,
        payload=None,
        timeout: Optional[float] = None,
        allow_404: bool = False,
    ):
        session = await cls._ensure_session()
        request_kwargs = {"json": payload}
        if timeout is not None:
            request_kwargs["timeout"] = aiohttp.ClientTimeout(total=timeout)

        try:
            async with session.request(
                method,
                cls._base + path,
                **request_kwargs,
            ) as response:
                if response.status == 404 and allow_404:
                    return None
                data = await response.json(content_type=None)
                if not 200 <= response.status < 300:
                    detail = data.get("detail") if isinstance(data, dict) else None
                    raise DependencyUnavailableError(
                        "torrent-engine",
                        str(detail or f"HTTP {response.status}"),
                    )
                return data
        except DependencyUnavailableError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise DependencyUnavailableError("torrent-engine", str(exc)) from exc

    @classmethod
    async def health_check(cls):
        return await cls._json("GET", "/health")

    @classmethod
    async def add_torrent(
        cls,
        source_url: str,
        media_name: str,
        expected_hash: Optional[str] = None,
    ):
        return await cls._json(
            "POST",
            "/torrents/add",
            payload={
                "source": source_url,
                "expected_hash": expected_hash,
                "media_name": media_name,
            },
        )

    @classmethod
    async def add_torrent_file(
        cls,
        torrent_bytes: bytes,
        media_name: str,
        expected_hash: Optional[str] = None,
    ):
        # The libtorrent service derives the canonical v1/v2 hash from the
        # parsed .torrent itself. That avoids incorrectly treating a v2-only
        # torrent as a v1 SHA-1 torrent.
        return await cls._json(
            "POST",
            "/torrents/add",
            payload={
                "torrent_b64": base64.b64encode(torrent_bytes).decode("ascii"),
                "expected_hash": expected_hash,
                "media_name": media_name,
            },
        )

    @classmethod
    async def get_progress(cls, info_hash: str):
        return (
            await cls._json(
                "GET",
                f"/torrents/{info_hash.lower()}/progress",
                allow_404=True,
            )
        ) or {}

    @classmethod
    async def prepare_video_stream(cls, info_hash: str):
        return (
            await cls._json(
                "POST",
                f"/torrents/{info_hash.lower()}/prepare",
                allow_404=True,
            )
        ) or {"metadata_ready": False, "video_file": None, "files": []}

    @classmethod
    async def get_video_file(cls, info_hash: str):
        return await cls.prepare_video_stream(info_hash)

    @classmethod
    async def get_status(cls, info_hash: str):
        progress = await cls.get_progress(info_hash)
        if not progress:
            return {}
        return {**progress, **(await cls.prepare_video_stream(info_hash))}

    @classmethod
    async def reannounce(cls, info_hash: str):
        await cls._json("POST", f"/torrents/{info_hash.lower()}/reannounce")

    @classmethod
    async def file_range_piece_status(
        cls,
        info_hash: str,
        video_file: dict,
        start: int,
        end: int,
        request_generation: Optional[int] = None,
    ):
        index = video_file.get("index")
        if index is None:
            raise ValueError("selected video file has no index")
        return await cls._json(
            "POST",
            f"/torrents/{info_hash.lower()}/range-status",
            payload={
                "file_index": int(index),
                "start": int(start),
                "end": int(end),
                "schedule": True,
                "request_generation": request_generation,
            },
        )

    @classmethod
    async def wait_for_file_range(
        cls,
        info_hash: str,
        video_file: dict,
        start: int,
        end: int,
        timeout_seconds: float = 240.0,
        poll_interval: float = 0.2,
        request_generation: Optional[int] = None,
    ):
        del poll_interval  # Polling lives inside the engine to avoid HTTP chatter.
        index = video_file.get("index")
        if index is None:
            raise ValueError("selected video file has no index")
        try:
            result = await cls._json(
                "POST",
                f"/torrents/{info_hash.lower()}/wait-range",
                payload={
                    "file_index": int(index),
                    "start": int(start),
                    "end": int(end),
                    "schedule": True,
                    "timeout_seconds": float(timeout_seconds),
                    "request_generation": request_generation,
                },
                timeout=float(timeout_seconds) + 10.0,
            )
        except DependencyUnavailableError as exc:
            if "time-critical torrent pieces" in exc.message:
                raise TimeoutError(exc.message) from exc
            raise

        if result.get("superseded"):
            raise RangeRequestSupersededError(
                f"stream request generation {request_generation} was superseded by a newer seek"
            )
        if result.get("cancelled"):
            raise RangeRequestCancelledError(
                f"stream request generation {request_generation} was cancelled"
            )
        return result

    @classmethod
    async def cancel_file_range_request(
        cls, info_hash: str, request_generation: int
    ):
        return await cls._json(
            "POST",
            f"/torrents/{info_hash.lower()}/range-requests/{int(request_generation)}/cancel",
        )

    @classmethod
    async def remove_torrent(
        cls,
        info_hash: str,
        delete_files: bool = True,
        verify: bool = True,
    ) -> bool:
        del verify  # Engine DELETE always performs its own verification.
        data = await cls._json(
            "DELETE",
            f"/torrents/{info_hash.lower()}?delete_files={str(bool(delete_files)).lower()}",
            allow_404=True,
        )
        return True if data is None else bool(data.get("verified_absent"))

    @classmethod
    async def close(cls):
        if cls._session and not cls._session.closed:
            await cls._session.close()
        cls._session = None
