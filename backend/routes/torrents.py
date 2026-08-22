import asyncio
import mimetypes
import os
import re
import time
from contextlib import suppress
from typing import Optional

import aiofiles
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.exceptions import DependencyUnavailableError
from services.prowlarr import ProwlarrService
from services.release_search import ReleaseSearchService
from services.torrent_engine import (
    RangeRequestCancelledError,
    RangeRequestSupersededError,
    TorrentEngineService,
)

router = APIRouter()
PLAYBACK_READY_TIMEOUT_SECONDS = 180.0
STARTUP_PREFIX_MIN_BYTES = 4 * 1024 * 1024
STARTUP_PREFIX_MAX_BYTES = 8 * 1024 * 1024
STARTUP_PREFIX_PIECES = 2
STREAM_CHUNK_BYTES = 4 * 1024 * 1024
STREAM_RANGE_WAIT_SECONDS = 240.0
METADATA_REANNOUNCE_SECONDS = 10.0
METADATA_TIMEOUT_SECONDS = 60.0
STREAM_DISCONNECT_POLL_SECONDS = 0.1
_stream_request_generation = 0


class StreamClientDisconnected(RuntimeError):
    pass


def _next_stream_request_generation() -> int:
    global _stream_request_generation
    candidate = time.time_ns()
    _stream_request_generation = max(candidate, _stream_request_generation + 1)
    return _stream_request_generation


async def _cancel_stream_request(info_hash: str, request_generation: int) -> None:
    try:
        await TorrentEngineService.cancel_file_range_request(
            info_hash, request_generation
        )
    except DependencyUnavailableError:
        # Cancellation is best-effort during client teardown. A newer request
        # generation still prevents this stream from stealing scheduler control.
        pass


async def _wait_for_stream_range(
    request: Request,
    info_hash: str,
    video_file: dict,
    start: int,
    end: int,
    request_generation: int,
):
    wait_task = asyncio.create_task(
        TorrentEngineService.wait_for_file_range(
            info_hash,
            video_file,
            start,
            end,
            timeout_seconds=STREAM_RANGE_WAIT_SECONDS,
            request_generation=request_generation,
        )
    )
    try:
        while True:
            done, _pending = await asyncio.wait(
                {wait_task}, timeout=STREAM_DISCONNECT_POLL_SECONDS
            )
            if done:
                return await wait_task
            if await request.is_disconnected():
                await _cancel_stream_request(info_hash, request_generation)
                wait_task.cancel()
                with suppress(asyncio.CancelledError):
                    await wait_task
                raise StreamClientDisconnected
    except asyncio.CancelledError:
        await _cancel_stream_request(info_hash, request_generation)
        wait_task.cancel()
        with suppress(asyncio.CancelledError):
            await wait_task
        raise


class AddTorrentRequest(BaseModel):
    magnet: str
    media_name: str
    expected_hash: Optional[str] = None


class SearchRequest(BaseModel):
    query: str
    imdb_id: Optional[str] = None
    category: Optional[int] = None
    resolution_filter: Optional[str] = None
    min_seeders: int = 0


def dependency_503(exc: DependencyUnavailableError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={"service": exc.service, "error": exc.message},
    )


@router.post("/search")
async def search_torrents(req: SearchRequest):
    try:
        results = await ReleaseSearchService.search(
            query=req.query,
            imdb_id=req.imdb_id,
            category=req.category,
            resolution_filter=req.resolution_filter,
            min_seeders=req.min_seeders,
        )
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"results": results}


@router.post("/add")
async def add_torrent(req: AddTorrentRequest):
    try:
        if req.magnet.lower().startswith("magnet:?"):
            added = await TorrentEngineService.add_torrent(
                req.magnet, req.media_name, expected_hash=req.expected_hash
            )
        else:
            resolved = await ProwlarrService.resolve_torrent_source(req.magnet)

            if resolved["source_type"] == "magnet":
                added = await TorrentEngineService.add_torrent(
                    resolved["magnet"],
                    req.media_name,
                    expected_hash=req.expected_hash,
                )
                added["source_resolution"] = "prowlarr_redirect_to_magnet"
            else:
                added = await TorrentEngineService.add_torrent_file(
                    resolved["torrent_bytes"],
                    req.media_name,
                    expected_hash=req.expected_hash,
                )
                added["source_resolution"] = "prowlarr_torrent_file"
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return added


@router.get("/progress/{info_hash}")
async def torrent_progress(info_hash: str):
    try:
        progress = await TorrentEngineService.get_progress(info_hash)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    if not progress:
        raise HTTPException(404, "Torrent not found")
    return progress


@router.get("/files/{info_hash}")
async def torrent_files(info_hash: str):
    try:
        progress = await TorrentEngineService.get_progress(info_hash)
        if not progress:
            raise HTTPException(404, "Torrent not found")
        file_state = await TorrentEngineService.get_video_file(info_hash)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    return {"hash": info_hash.lower(), **file_state}


@router.get("/status/{info_hash}")
async def torrent_status(info_hash: str):
    try:
        status = await TorrentEngineService.get_status(info_hash)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    if not status:
        raise HTTPException(404, "Torrent not found")
    return status


def startup_prefix_target_bytes(video_file: dict) -> int:
    """Choose a small piece-aware contiguous prefix for initial playback.

    libtorrent verifies whole pieces, so a fixed byte target can accidentally
    mean one tiny piece on one torrent and many pieces on another. Aim for at
    least 4 MiB and roughly two pieces, but never deliberately hold the player
    for more than 8 MiB of selected-file prefix data. A single unusually large
    torrent piece may still exceed that cap because the piece itself must be
    complete before any bytes inside it are safe to serve.
    """
    file_size = max(0, int(video_file.get("size") or 0))
    if file_size <= 0:
        return 0

    piece_size = max(0, int(video_file.get("piece_size") or 0))
    piece_target = piece_size * STARTUP_PREFIX_PIECES if piece_size > 0 else 0
    target = max(STARTUP_PREFIX_MIN_BYTES, piece_target)
    target = min(target, STARTUP_PREFIX_MAX_BYTES)
    return min(file_size, target)


async def startup_prefix_status(info_hash: str, video_file: dict) -> dict:
    """Report verified contiguous bytes from the beginning of the video file."""
    target_bytes = startup_prefix_target_bytes(video_file)
    if target_bytes <= 0:
        return {
            "ready": False,
            "buffered_bytes": 0,
            "target_bytes": 0,
            "buffer_progress": 0.0,
            "first_piece": None,
            "last_piece": None,
            "missing_pieces": [],
            "piece_size": 0,
            "waiting_for": "piece_geometry",
            "piece_states_available": 0,
        }

    status = await TorrentEngineService.file_range_piece_status(
        info_hash,
        video_file,
        0,
        target_bytes - 1,
    )

    buffered_bytes = 0
    if status.get("ready"):
        buffered_bytes = target_bytes
    elif status.get("waiting_for") == "pieces":
        missing = sorted(
            int(piece)
            for piece in status.get("missing_pieces", [])
            if isinstance(piece, int)
        )
        piece_size = max(0, int(status.get("piece_size") or 0))
        file_offset = max(0, int(video_file.get("offset") or 0))
        if missing and piece_size > 0:
            # Only bytes before the first missing piece are a truly contiguous
            # verified prefix. Later completed pieces do not help initial decode.
            first_missing_global_byte = missing[0] * piece_size
            buffered_bytes = max(0, first_missing_global_byte - file_offset)
            buffered_bytes = min(target_bytes, buffered_bytes)

    result = dict(status)
    result.update(
        {
            "buffered_bytes": buffered_bytes,
            "target_bytes": target_bytes,
            "buffer_progress": (
                min(1.0, buffered_bytes / target_bytes) if target_bytes > 0 else 0.0
            ),
        }
    )
    return result


@router.get("/playback-status/{info_hash}")
async def playback_status(info_hash: str, reannounce: bool = False):
    """Return non-blocking playback preparation state for the desktop player.

    The desktop player opens immediately after source selection and polls this
    endpoint while libtorrent acquires metadata and a small verified contiguous
    prefix of the selected video. Unlike /await-ready this endpoint never sleeps,
    times out, or deletes the candidate; closing the player remains the
    authoritative cancellation path.
    """
    try:
        if reannounce:
            await TorrentEngineService.reannounce(info_hash)

        progress = await TorrentEngineService.get_progress(info_hash)
        if not progress:
            raise HTTPException(404, "Torrent not found")

        file_state = await TorrentEngineService.prepare_video_stream(info_hash)
        video_file = file_state.get("video_file")
    except HTTPException:
        raise
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc

    state = str(progress.get("state") or "unknown")
    dl_speed = max(0, int(progress.get("dl_speed") or 0))
    seeds = max(0, int(progress.get("num_seeds") or 0))
    peers = max(0, int(progress.get("num_leechs") or 0))

    result = {
        "hash": info_hash.lower(),
        "ready": False,
        "stage": "metadata",
        "message": "Acquiring torrent metadata…",
        "state": state,
        "progress": float(progress.get("progress") or 0.0),
        "video_progress": None,
        "downloaded": max(0, int(progress.get("downloaded") or 0)),
        "size": max(0, int(progress.get("size") or 0)),
        "dl_speed": dl_speed,
        "seeds": seeds,
        "peers": peers,
        "seq_dl": bool(progress.get("seq_dl")),
        "f_l_piece_prio": bool(progress.get("f_l_piece_prio")),
        "force_start": bool(progress.get("force_start")),
        "path": None,
        "first_ready": False,
        "last_ready": False,
        "buffered_bytes": 0,
        "buffer_target_bytes": 0,
        "buffer_progress": 0.0,
        "waiting_for": None,
    }

    if not video_file:
        if state not in {"metaDL", "checkingDL"} and dl_speed <= 0:
            result["stage"] = "peers"
            result["message"] = "Connecting to peers…"
        return result

    result["path"] = video_file.get("path")
    result["video_progress"] = float(video_file.get("progress") or 0.0)

    try:
        prefix_status = await startup_prefix_status(info_hash, video_file)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc

    missing_pieces = set(prefix_status.get("missing_pieces") or [])
    first_piece = prefix_status.get("first_piece")
    last_piece = prefix_status.get("last_piece")
    piece_states_known = prefix_status.get("waiting_for") not in {
        "piece_geometry",
        "piece_states",
    }
    result["first_ready"] = (
        piece_states_known and first_piece is not None and first_piece not in missing_pieces
    )
    result["last_ready"] = (
        piece_states_known and last_piece is not None and last_piece not in missing_pieces
    )
    result["buffered_bytes"] = int(prefix_status.get("buffered_bytes") or 0)
    result["buffer_target_bytes"] = int(prefix_status.get("target_bytes") or 0)
    result["buffer_progress"] = float(prefix_status.get("buffer_progress") or 0.0)
    result["waiting_for"] = prefix_status.get("waiting_for")

    if prefix_status.get("ready"):
        result["ready"] = True
        result["stage"] = "ready"
        result["message"] = "Stream is ready"
        return result

    waiting_for = prefix_status.get("waiting_for")
    if waiting_for in {"piece_geometry", "piece_states"}:
        result["stage"] = "metadata"
        result["message"] = "Preparing torrent piece map…"
    elif dl_speed <= 0:
        result["stage"] = "peers"
        result["message"] = "Waiting for initial video pieces…"
    else:
        result["stage"] = "buffering"
        result["message"] = "Buffering verified video prefix…"

    return result


async def reject_candidate_and_cleanup(
    info_hash: str,
    status_code: int,
    detail: dict,
) -> None:
    """Delete a failed playback candidate before returning it to the caller.

    Failed candidates must never remain queued in libtorrent: one dead/slow
    torrent can otherwise block every fallback candidate behind it.
    """
    payload = dict(detail)
    try:
        payload["cleanup_verified"] = await TorrentEngineService.remove_torrent(
            info_hash, delete_files=True, verify=True
        )
    except DependencyUnavailableError as exc:
        payload["cleanup_verified"] = False
        payload["cleanup_error"] = exc.message

    raise HTTPException(status_code, detail=payload)


@router.get("/await-ready/{info_hash}")
async def await_ready(info_hash: str):
    """Wait only until the selected torrent is safe to hand to mpv.

    Direct libtorrent piece deadlines make the startup prefix time-critical,
    while the HTTP stream independently gates every requested byte range on
    verified pieces. Startup therefore needs only a small verified contiguous
    prefix from the beginning of the selected video; the video's final piece is
    intentionally not a launch prerequisite.
    """
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    deadline = started_at + PLAYBACK_READY_TIMEOUT_SECONDS
    reannounced = False
    last_progress: dict = {}
    last_prefix_status: dict = {}

    try:
        while loop.time() < deadline:
            try:
                progress = await TorrentEngineService.get_progress(info_hash)
                if not progress:
                    raise HTTPException(404, "Torrent not found")
                last_progress = progress

                elapsed = loop.time() - started_at
                state = str(progress.get("state") or "unknown")
                file_state = await TorrentEngineService.prepare_video_stream(info_hash)
                video_file = file_state.get("video_file")

                if not video_file:
                    if not reannounced and elapsed >= METADATA_REANNOUNCE_SECONDS:
                        await TorrentEngineService.reannounce(info_hash)
                        reannounced = True
                    if elapsed >= METADATA_TIMEOUT_SECONDS:
                        await reject_candidate_and_cleanup(
                            info_hash,
                            409,
                            {
                                "stage": "metadata",
                                "retryable": True,
                                "state": state,
                                "message": "torrent metadata/file list did not become playable",
                            },
                        )
                    await asyncio.sleep(0.5)
                    continue

                prefix_status = await startup_prefix_status(info_hash, video_file)
                last_prefix_status = prefix_status

                if prefix_status["ready"]:
                    progress = await TorrentEngineService.get_progress(info_hash)
                    return {
                        "ready": True,
                        "path": video_file["path"],
                        "progress": progress.get("progress", 0.0),
                        "dl_speed": progress.get("dl_speed", 0),
                        "buffered_bytes": prefix_status.get("buffered_bytes", 0),
                        "buffer_target_bytes": prefix_status.get("target_bytes", 0),
                        "first_piece": prefix_status.get("first_piece"),
                        "last_piece": prefix_status.get("last_piece"),
                        "seq_dl": progress.get("seq_dl", False),
                        "f_l_piece_prio": progress.get("f_l_piece_prio", False),
                        "force_start": progress.get("force_start", False),
                    }

                waiting_for = prefix_status.get("waiting_for")
                piece_states_available = int(prefix_status.get("piece_states_available") or 0)

                if waiting_for in {"piece_geometry", "piece_states"}:
                    if not reannounced and elapsed >= METADATA_REANNOUNCE_SECONDS:
                        await TorrentEngineService.reannounce(info_hash)
                        reannounced = True
                    if elapsed >= METADATA_TIMEOUT_SECONDS:
                        await reject_candidate_and_cleanup(
                            info_hash,
                            409,
                            {
                                "stage": "metadata",
                                "retryable": True,
                                "state": state,
                                "piece_states_available": piece_states_available,
                                "message": "torrent metadata/piece map did not become available",
                            },
                        )

                await asyncio.sleep(0.20)

            except HTTPException:
                raise
            except DependencyUnavailableError as exc:
                raise dependency_503(exc) from exc

        await reject_candidate_and_cleanup(
            info_hash,
            408,
            {
                "stage": "startup",
                "retryable": True,
                "state": str(last_progress.get("state") or "unknown"),
                "progress": float(last_progress.get("progress") or 0.0),
                "dl_speed": int(last_progress.get("dl_speed") or 0),
                "downloaded": int(last_progress.get("downloaded") or 0),
                "seq_dl": bool(last_progress.get("seq_dl")),
                "f_l_piece_prio": bool(last_progress.get("f_l_piece_prio")),
                "force_start": bool(last_progress.get("force_start")),
                "buffered_bytes": int(last_prefix_status.get("buffered_bytes") or 0),
                "buffer_target_bytes": int(last_prefix_status.get("target_bytes") or 0),
                "waiting_for": last_prefix_status.get("waiting_for"),
                "message": (
                    f"verified video startup prefix was not ready within "
                    f"{PLAYBACK_READY_TIMEOUT_SECONDS:.0f}s"
                ),
            },
        )
    except asyncio.CancelledError:
        try:
            await TorrentEngineService.remove_torrent(
                info_hash, delete_files=True, verify=True
            )
        except DependencyUnavailableError:
            pass
        raise


@router.api_route("/stream/{info_hash}", methods=["GET", "HEAD"])
async def stream_file(info_hash: str, request: Request):
    """Serve only byte ranges whose backing torrent pieces are verified.

    libtorrent can preallocate the selected file to its final logical size long
    before every byte is downloaded. Reading an unwritten sparse region would feed
    zero/corrupt bytes to mpv. Every GET chunk is therefore gated on libtorrent's
    verified piece state before it is read from disk.

    Each GET also carries a monotonically increasing request generation. Once a
    distant request is confirmed as a seek, older abandoned GETs are superseded in
    the torrent engine and cannot reprioritize the old playback window.
    """
    try:
        file_state = await TorrentEngineService.prepare_video_stream(info_hash)
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc

    video_file = file_state.get("video_file")
    if not video_file:
        raise HTTPException(404, "Video file metadata is not ready")

    file_path = video_file.get("path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(404, "File not found")

    file_size = int(video_file.get("size") or 0)
    if file_size <= 0:
        raise HTTPException(404, "Video file is empty")

    start = 0
    end = file_size - 1
    status_code = 200
    range_header = request.headers.get("range")

    if range_header:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if not match:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

        first, last = match.groups()
        if first == "" and last == "":
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

        if first == "":
            suffix = int(last)
            if suffix <= 0:
                return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
            start = max(0, file_size - suffix)
        else:
            start = int(first)
            if last:
                end = min(int(last), file_size - 1)

        if start >= file_size or end < start:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})
        status_code = 206

    content_length = end - start + 1
    media_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
        "Cache-Control": "no-store",
        "X-NetWatch-Piece-Gated": "1",
    }
    if status_code == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"

    if request.method == "HEAD":
        return Response(status_code=status_code, media_type=media_type, headers=headers)

    request_generation = _next_stream_request_generation()

    # Do not commit HTTP headers until the first requested window is actually
    # available. While waiting, also watch the mpv connection so an abandoned
    # pre-seek request is cancelled instead of lingering for up to four minutes.
    first_chunk_end = min(end, start + STREAM_CHUNK_BYTES - 1)
    try:
        await _wait_for_stream_range(
            request,
            info_hash,
            video_file,
            start,
            first_chunk_end,
            request_generation,
        )
    except StreamClientDisconnected as exc:
        raise HTTPException(499, "Stream client disconnected") from exc
    except (RangeRequestSupersededError, RangeRequestCancelledError) as exc:
        raise HTTPException(409, str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(503, f"Requested torrent range is still buffering: {exc}") from exc
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc

    async def iter_file():
        cursor = start
        first_window = True
        try:
            async with aiofiles.open(file_path, "rb") as file_handle:
                while cursor <= end:
                    if await request.is_disconnected():
                        break

                    chunk_end = min(end, cursor + STREAM_CHUNK_BYTES - 1)
                    if not first_window:
                        try:
                            await _wait_for_stream_range(
                                request,
                                info_hash,
                                video_file,
                                cursor,
                                chunk_end,
                                request_generation,
                            )
                        except (
                            StreamClientDisconnected,
                            RangeRequestSupersededError,
                            RangeRequestCancelledError,
                            TimeoutError,
                            DependencyUnavailableError,
                        ):
                            # End the old transfer cleanly. mpv's newer Range GET
                            # owns scheduling after a seek and can retry normally.
                            break
                    first_window = False

                    wanted = chunk_end - cursor + 1
                    await file_handle.seek(cursor)
                    chunk = await file_handle.read(wanted)
                    if len(chunk) != wanted:
                        break

                    cursor += len(chunk)
                    yield chunk
        finally:
            await _cancel_stream_request(info_hash, request_generation)

    return StreamingResponse(
        iter_file(),
        media_type=media_type,
        headers=headers,
        status_code=status_code,
    )


@router.delete("/{info_hash}")
async def remove_torrent(info_hash: str, delete_files: bool = True):
    try:
        verified_absent = await TorrentEngineService.remove_torrent(
            info_hash, delete_files, verify=True
        )
    except DependencyUnavailableError as exc:
        raise dependency_503(exc) from exc
    if not verified_absent:
        raise HTTPException(502, "libtorrent accepted delete but torrent is still present")
    return {
        "removed": True,
        "verified_absent": True,
        "delete_files": delete_files,
    }
