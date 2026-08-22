from __future__ import annotations

import base64
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from engine import TorrentEngine, TorrentEngineError, TorrentNotFoundError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("netwatch.torrent_engine")
engine: Optional[TorrentEngine] = None


class AddTorrentRequest(BaseModel):
    source: Optional[str] = None
    torrent_b64: Optional[str] = None
    expected_hash: Optional[str] = None
    media_name: str


class RangeRequest(BaseModel):
    file_index: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    schedule: bool = True
    lookahead_bytes: Optional[int] = Field(default=None, ge=0)
    request_generation: Optional[int] = Field(default=None, ge=1)


class WaitRangeRequest(RangeRequest):
    timeout_seconds: float = Field(default=240.0, gt=0, le=900.0)


def get_engine() -> TorrentEngine:
    if engine is None:
        raise HTTPException(503, "torrent engine is not initialized")
    return engine


def engine_error(exc: Exception) -> HTTPException:
    if isinstance(exc, TorrentNotFoundError):
        return HTTPException(404, "Torrent not found")
    if isinstance(exc, ValueError):
        return HTTPException(400, str(exc))
    return HTTPException(503, str(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    engine = TorrentEngine()
    try:
        yield
    finally:
        if engine is not None:
            engine.close()
        engine = None


app = FastAPI(title="NetWatch Torrent Engine", lifespan=lifespan)


@app.get("/health")
def health():
    return get_engine().health()


@app.get("/torrents")
def list_torrents():
    return {"torrents": get_engine().list_torrents()}


@app.post("/torrents/add")
def add_torrent(req: AddTorrentRequest):
    try:
        if bool(req.source) == bool(req.torrent_b64):
            raise ValueError("exactly one of source or torrent_b64 is required")
        if req.source:
            return get_engine().add_magnet(req.source, req.expected_hash, req.media_name)
        try:
            torrent_bytes = base64.b64decode(req.torrent_b64 or "", validate=True)
        except Exception as exc:
            raise ValueError("torrent_b64 is not valid base64") from exc
        return get_engine().add_torrent_bytes(
            torrent_bytes, req.expected_hash, req.media_name
        )
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.get("/torrents/{info_hash}/progress")
def torrent_progress(info_hash: str):
    try:
        return get_engine().progress(info_hash)
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.get("/torrents/{info_hash}/files")
def torrent_files(info_hash: str):
    try:
        return get_engine().files(info_hash)
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.post("/torrents/{info_hash}/prepare")
def prepare_torrent(info_hash: str):
    try:
        return get_engine().prepare(info_hash)
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.post("/torrents/{info_hash}/range-status")
def range_status(info_hash: str, req: RangeRequest):
    try:
        kwargs = {
            "schedule": req.schedule,
            "request_generation": req.request_generation,
        }
        if req.lookahead_bytes is not None:
            kwargs["lookahead_bytes"] = req.lookahead_bytes
        return get_engine().range_status(
            info_hash, req.file_index, req.start, req.end, **kwargs
        )
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.post("/torrents/{info_hash}/wait-range")
async def wait_range(info_hash: str, req: WaitRangeRequest):
    try:
        kwargs = {"request_generation": req.request_generation}
        if req.lookahead_bytes is not None:
            kwargs["lookahead_bytes"] = req.lookahead_bytes
        return await get_engine().wait_range(
            info_hash,
            req.file_index,
            req.start,
            req.end,
            req.timeout_seconds,
            **kwargs,
        )
    except TimeoutError as exc:
        raise HTTPException(408, str(exc)) from exc
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.post("/torrents/{info_hash}/range-requests/{request_generation}/cancel")
def cancel_range_request(info_hash: str, request_generation: int):
    try:
        return get_engine().cancel_range_request(info_hash, request_generation)
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.post("/torrents/{info_hash}/reannounce")
def reannounce(info_hash: str):
    try:
        get_engine().reannounce(info_hash)
        return {"ok": True}
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc


@app.delete("/torrents/{info_hash}")
def remove_torrent(info_hash: str, delete_files: bool = True):
    try:
        verified_absent = get_engine().remove(info_hash, delete_files=delete_files)
    except (TorrentEngineError, ValueError) as exc:
        raise engine_error(exc) from exc
    if not verified_absent:
        raise HTTPException(502, "torrent removal was not verified")
    return {
        "removed": True,
        "verified_absent": True,
        "delete_files": delete_files,
    }
