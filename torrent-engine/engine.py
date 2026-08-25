from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

try:
    import libtorrent as lt
except ImportError:  # Allows syntax/unit testing outside the engine container.
    lt = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {
    ".mkv",
    ".mp4",
    ".m4v",
    ".avi",
    ".mov",
    ".webm",
    ".ts",
    ".m2ts",
    ".mpg",
    ".mpeg",
    ".wmv",
    ".vob",
    ".mts",
    ".flv",
    ".ogv",
}
SAMPLE_PATTERN = re.compile(r"(^|[\\/._ -])sample([\\/._ -]|$)", re.I)
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, value)


DOWNLOAD_ROOT = os.path.realpath(
    os.environ.get("NETWATCH_DOWNLOAD_DIR", "/tmp/netwatch")
)
VPN_INTERFACE = os.environ.get("NETWATCH_VPN_INTERFACE", "wg0").strip() or "wg0"
LISTEN_PORT = _env_int("NETWATCH_LISTEN_PORT", 6881, 1)
UPLOAD_LIMIT = _env_int("NETWATCH_UPLOAD_LIMIT", 64 * 1024, 0)
RANGE_LOOKAHEAD_BYTES = _env_int(
    "NETWATCH_RANGE_LOOKAHEAD_BYTES", 32 * 1024 * 1024, 0
)
DEADLINE_STEP_MS = _env_int("NETWATCH_DEADLINE_STEP_MS", 250, 10)
RANGE_POLL_MS = _env_int("NETWATCH_RANGE_POLL_MS", 100, 25)


@dataclass
class TorrentRecord:
    info_hash: str
    handle: Any
    save_path: str
    media_name: str
    added_at: float = field(default_factory=time.time)
    selected_file_index: Optional[int] = None
    selected_path: Optional[str] = None
    selected_size: int = 0
    prepared: bool = False
    deadline_window: Optional[tuple[int, int]] = None
    pending_far_window: Optional[tuple[int, int, float, int]] = None
    active_request_generation: Optional[int] = None
    cancelled_request_generations: set[int] = field(default_factory=set)


class TorrentEngineError(RuntimeError):
    pass


class TorrentNotFoundError(TorrentEngineError):
    pass


class TorrentEngine:
    """Single-process libtorrent owner for NetWatch.

    The FastAPI wrapper is intentionally thin. All torrent handles live here, in
    the shared VPN network namespace. The main NetWatch backend shares that
    namespace and reaches this engine over loopback only.
    """

    def __init__(self) -> None:
        if lt is None:
            raise RuntimeError(
                "python3-libtorrent is not installed; use the supplied torrent-engine Dockerfile"
            )
        self._lock = threading.RLock()
        self._records: dict[str, TorrentRecord] = {}
        self._ensure_download_root()
        self._wipe_download_root()
        self._session = self._create_session()

    @staticmethod
    def _ensure_download_root() -> None:
        if DOWNLOAD_ROOT in {"", "/"}:
            raise RuntimeError("unsafe NETWATCH_DOWNLOAD_DIR")
        Path(DOWNLOAD_ROOT).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _wipe_download_root() -> None:
        """Remove stale payload from a previous engine process.

        This volume is dedicated to NetWatch. A direct-libTorrent engine does
        not persist resume state yet, so retaining orphaned sparse files would be
        misleading and would weaken close/crash cleanup guarantees.
        """
        root = Path(DOWNLOAD_ROOT)
        for entry in root.iterdir():
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink(missing_ok=True)
            except FileNotFoundError:
                pass

    @staticmethod
    def _session_settings() -> dict[str, Any]:
        # Keep the public-discovery behavior that made current sources reliable,
        # but bind all peer/tracker sockets to the WireGuard interface as a second
        # layer behind the container kill switch.
        return {
            "listen_interfaces": f"{VPN_INTERFACE}:{LISTEN_PORT}",
            "outgoing_interfaces": VPN_INTERFACE,
            "enable_dht": True,
            "enable_lsd": False,
            "enable_upnp": False,
            "enable_natpmp": False,
            "anonymous_mode": True,
            "announce_to_all_trackers": True,
            "announce_to_all_tiers": True,
            "active_downloads": 8,
            "active_limit": 16,
            "active_dht_limit": -1,
            "active_tracker_limit": -1,
            "connections_limit": 500,
            # libtorrent's 'enabled/prefer' encryption policy. It allows plain
            # peers when encryption is unavailable while preferring encryption.
            "out_enc_policy": 1,
            "in_enc_policy": 1,
        }

    def _create_session(self):
        # Pass network/privacy settings into the constructor so there is no
        # startup window where libtorrent briefly opens its default listeners
        # before apply_settings() moves them onto WireGuard. The Python binding
        # keeps its default ut_metadata/ut_pex plugins when constructed this way.
        session = lt.session(self._session_settings())
        logger.info(
            "libtorrent %s started on %s:%s",
            self._libtorrent_version(),
            VPN_INTERFACE,
            LISTEN_PORT,
        )
        return session

    @staticmethod
    def _libtorrent_version() -> str:
        for name in ("version", "version_str", "__version__"):
            value = getattr(lt, name, None)
            if value is None:
                continue
            try:
                value = value() if callable(value) else value
            except Exception:
                logger.debug("Ignored optional libtorrent binding failure", exc_info=True)
                continue
            rendered = str(value).strip()
            if rendered:
                return rendered
        return "unknown"

    @classmethod
    def _hash_candidates(cls, hashes: Any) -> list[str]:
        candidates: list[str] = []
        if hashes is None:
            return candidates
        for attr_name, width in (("v1", 40), ("v2", 64)):
            try:
                value = getattr(hashes, attr_name, None)
                value = value() if callable(value) else value
                rendered = str(value).strip().lower() if value is not None else ""
            except Exception:
                logger.debug("Ignored optional libtorrent binding failure", exc_info=True)
                continue
            if len(rendered) == width and set(rendered) != {"0"}:
                normalized = cls._valid_hash(rendered)
                if normalized and normalized not in candidates:
                    candidates.append(normalized)
        return candidates

    @classmethod
    def _params_hash_candidates(cls, params: Any) -> list[str]:
        candidates: list[str] = []
        try:
            candidates.extend(cls._hash_candidates(getattr(params, "info_hashes", None)))
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        try:
            info = getattr(params, "ti", None)
            if info is not None:
                candidates.extend(cls._hash_candidates(info.info_hashes()))
                try:
                    rendered = str(info.info_hash()).strip().lower()
                    normalized = cls._valid_hash(rendered)
                    if normalized and normalized not in candidates:
                        candidates.insert(0, normalized)
                except Exception:
                    logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        return list(dict.fromkeys(candidates))

    @staticmethod
    def _valid_hash(value: object) -> Optional[str]:
        if not isinstance(value, str):
            return None
        normalized = value.strip().lower()
        if HEX40.fullmatch(normalized) or HEX64.fullmatch(normalized):
            return normalized
        return None

    @classmethod
    def _hash_from_handle(cls, handle: Any) -> str:
        """Return a stable v1 hash when present, otherwise the full v2 hash."""
        candidates: list[str] = []
        try:
            candidates.extend(cls._hash_candidates(handle.info_hashes()))
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        try:
            rendered = str(handle.info_hash()).strip().lower()
            normalized = cls._valid_hash(rendered)
            if normalized and normalized not in candidates:
                candidates.insert(0, normalized)
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        if candidates:
            return candidates[0]
        raise TorrentEngineError("libtorrent did not expose a usable info hash")

    @staticmethod
    def _safe_save_path(info_hash: str) -> str:
        candidate = os.path.realpath(os.path.join(DOWNLOAD_ROOT, info_hash))
        if os.path.commonpath([DOWNLOAD_ROOT, candidate]) != DOWNLOAD_ROOT:
            raise TorrentEngineError("unsafe torrent save path")
        if candidate == DOWNLOAD_ROOT:
            raise TorrentEngineError("torrent save path cannot equal download root")
        return candidate

    @staticmethod
    def _set_add_flags(params: Any) -> None:
        try:
            params.flags &= ~lt.torrent_flags.auto_managed
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        try:
            params.flags &= ~lt.torrent_flags.paused
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        # Added in libtorrent 2.0.8. It prevents arbitrary payload pieces from
        # downloading while a magnet is still acquiring metadata. Once the video
        # file is identified we explicitly enable only that file.
        try:
            params.flags |= lt.torrent_flags.default_dont_download
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)

    def _finish_add(
        self,
        params: Any,
        expected_hash: Optional[str],
        media_name: str,
        resolution: str,
    ) -> dict[str, Any]:
        with self._lock:
            expected = self._valid_hash(expected_hash) if expected_hash else None
            candidates = self._params_hash_candidates(params)
            if expected and candidates and expected not in candidates:
                raise TorrentEngineError(
                    f"torrent info hash mismatch: expected {expected}, metadata exposes {candidates[0]}"
                )
            requested_hash = expected or (candidates[0] if candidates else None)
            if not requested_hash:
                raise TorrentEngineError("torrent source did not expose a deterministic v1/v2 info hash")

            existing = self._records.get(requested_hash)
            if existing and existing.handle.is_valid():
                return {
                    "hash": requested_hash,
                    "resolution": resolution,
                    "already_existed": True,
                    "engine": "libtorrent",
                }

            save_path = self._safe_save_path(requested_hash)
            Path(save_path).mkdir(parents=True, exist_ok=True)
            params.save_path = save_path
            try:
                params.upload_limit = UPLOAD_LIMIT
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
            self._set_add_flags(params)

            try:
                handle = self._session.add_torrent(params)
                try:
                    handle.unset_flags(lt.torrent_flags.auto_managed)
                except Exception:
                    logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
                handle.resume()
                handle.set_upload_limit(UPLOAD_LIMIT)
                actual_hash = self._hash_from_handle(handle)
            except Exception:
                shutil.rmtree(save_path, ignore_errors=True)
                raise

            handle_candidates: list[str] = []
            try:
                handle_candidates.extend(self._hash_candidates(handle.info_hashes()))
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
            if requested_hash not in handle_candidates and requested_hash != actual_hash:
                try:
                    self._session.remove_torrent(handle)
                finally:
                    shutil.rmtree(save_path, ignore_errors=True)
                raise TorrentEngineError(
                    f"torrent info hash mismatch: expected {requested_hash}, got {actual_hash}"
                )

            # Use the requested/source hash as the session key. For hybrid torrents
            # it may be v2 while _hash_from_handle prefers v1; both identify the
            # same torrent but callers must keep the hash returned from /add.
            canonical_hash = requested_hash
            self._records[canonical_hash] = TorrentRecord(
                info_hash=canonical_hash,
                handle=handle,
                save_path=save_path,
                media_name=media_name,
            )
            logger.info("Added %s for %s", canonical_hash, media_name)
            return {
                "hash": canonical_hash,
                "resolution": resolution,
                "already_existed": False,
                "engine": "libtorrent",
            }

    def add_magnet(
        self,
        source: str,
        expected_hash: Optional[str],
        media_name: str,
    ) -> dict[str, Any]:
        if not source.lower().startswith("magnet:?"):
            raise ValueError("direct libtorrent engine accepts magnet URIs only in add_magnet")
        try:
            params = lt.parse_magnet_uri(source)
        except Exception as exc:
            raise ValueError(f"invalid magnet URI: {exc}") from exc
        return self._finish_add(params, expected_hash, media_name, "magnet_info_hash")

    def add_torrent_bytes(
        self,
        torrent_bytes: bytes,
        expected_hash: Optional[str],
        media_name: str,
    ) -> dict[str, Any]:
        if not torrent_bytes:
            raise ValueError("torrent metadata is empty")
        try:
            if hasattr(lt, "load_torrent_buffer"):
                params = lt.load_torrent_buffer(torrent_bytes)
            else:
                params = lt.add_torrent_params()
                params.ti = lt.torrent_info(lt.bdecode(torrent_bytes))
        except Exception as exc:
            raise ValueError(f"invalid .torrent metadata: {exc}") from exc
        return self._finish_add(params, expected_hash, media_name, "torrent_info_hash")

    def _record(self, info_hash: str) -> TorrentRecord:
        normalized = self._valid_hash(info_hash)
        if not normalized:
            raise TorrentNotFoundError("invalid torrent hash")
        record = self._records.get(normalized)
        if not record or not record.handle.is_valid():
            raise TorrentNotFoundError(normalized)
        return record

    @staticmethod
    def _state_name(status: Any) -> str:
        try:
            value = int(status.state)
        except Exception:
            logger.debug("Could not coerce libtorrent state enum to int", exc_info=True)
            rendered = str(status.state).split(".")[-1]
            aliases = {
                "checking_files": "checkingDL",
                "downloading_metadata": "metaDL",
                "downloading": "downloading",
                "finished": "finished",
                "seeding": "seeding",
                "checking_resume_data": "checkingDL",
            }
            return aliases.get(rendered, rendered or "unknown")

        # libtorrent's public state_t values are stable in the 2.0 series.
        mapping = {
            1: "checkingDL",
            2: "metaDL",
            3: "downloading",
            4: "finished",
            5: "seeding",
            7: "checkingDL",
        }
        name = mapping.get(value, "unknown")
        if name == "downloading" and int(
            getattr(status, "download_payload_rate", 0) or 0
        ) <= 0:
            return "stalledDL"
        return name

    def health(self) -> dict[str, Any]:
        with self._lock:
            interface_present = any(
                name == VPN_INTERFACE for _, name in __import__("socket").if_nameindex()
            )
            try:
                listening = bool(self._session.is_listening())
            except Exception:
                logger.debug("Could not query libtorrent listener state", exc_info=True)
                listening = False
            return {
                "service": "torrent-engine",
                "engine": "libtorrent",
                "connected": bool(interface_present and listening),
                "status": "ok" if interface_present and listening else "unavailable",
                "libtorrent_version": self._libtorrent_version(),
                "vpn_interface": VPN_INTERFACE,
                "vpn_interface_present": interface_present,
                "listening": listening,
                "torrent_count": len(self._records),
            }

    def list_torrents(self) -> list[dict[str, Any]]:
        with self._lock:
            result = []
            for info_hash in list(self._records):
                try:
                    item = self.progress(info_hash)
                except TorrentNotFoundError:
                    continue
                if item:
                    item["added_at"] = self._records[info_hash].added_at
                    result.append(item)
            return result

    def progress(self, info_hash: str) -> dict[str, Any]:
        with self._lock:
            record = self._record(info_hash)
            status = record.handle.status()
            total_wanted = max(0, int(getattr(status, "total_wanted", 0) or 0))
            total_wanted_done = max(0, int(getattr(status, "total_wanted_done", 0) or 0))
            total = max(0, int(getattr(status, "total", 0) or 0))
            if total_wanted <= 0:
                total_wanted = total
            progress = (
                min(1.0, total_wanted_done / total_wanted)
                if total_wanted > 0
                else float(getattr(status, "progress", 0.0) or 0.0)
            )
            return {
                "hash": record.info_hash,
                "progress": progress,
                "downloaded": total_wanted_done,
                "amount_left": max(0, total_wanted - total_wanted_done),
                "dl_speed": max(0, int(getattr(status, "download_payload_rate", 0) or 0)),
                "ul_speed": max(0, int(getattr(status, "upload_payload_rate", 0) or 0)),
                "state": self._state_name(status),
                "save_path": record.save_path,
                "content_path": record.save_path,
                "name": str(getattr(status, "name", "") or record.media_name),
                "size": total_wanted,
                "eta": 0,
                "num_seeds": max(0, int(getattr(status, "num_seeds", 0) or 0)),
                "num_leechs": max(0, int(getattr(status, "num_peers", 0) or 0)),
                "time_critical": True,
                "scheduler": "piece_deadlines",
                "has_metadata": bool(getattr(status, "has_metadata", False)),
            }

    @staticmethod
    def _torrent_info(handle: Any) -> Any:
        info = handle.torrent_file()
        if info is None:
            return None
        try:
            if hasattr(info, "is_loaded") and not info.is_loaded():
                return None
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
        return info

    @staticmethod
    def _file_storage(info: Any) -> Any:
        if hasattr(info, "files"):
            return info.files()
        return info.layout()

    @staticmethod
    def _file_path(storage: Any, index: int, save_path: Optional[str] = None) -> str:
        if save_path:
            try:
                return str(storage.file_path(index, save_path))
            except TypeError:
                pass
        relative = str(storage.file_path(index))
        return os.path.join(save_path, relative) if save_path else relative

    @staticmethod
    def _piece_range_for_file(storage: Any, index: int, piece_size: int) -> list[int]:
        size = max(0, int(storage.file_size(index)))
        offset = max(0, int(storage.file_offset(index)))
        if size <= 0 or piece_size <= 0:
            first = offset // max(1, piece_size)
            return [first, first]
        return [offset // piece_size, (offset + size - 1) // piece_size]

    def files(self, info_hash: str) -> dict[str, Any]:
        with self._lock:
            record = self._record(info_hash)
            info = self._torrent_info(record.handle)
            if info is None:
                return {"metadata_ready": False, "files": []}
            storage = self._file_storage(info)
            piece_size = max(0, int(info.piece_length()))
            try:
                progress_values = list(record.handle.file_progress())
            except Exception:
                logger.debug("Could not read libtorrent file progress", exc_info=True)
                progress_values = []
            try:
                priorities = list(record.handle.get_file_priorities())
            except Exception:
                logger.debug("Could not read libtorrent file priorities", exc_info=True)
                priorities = []

            files: list[dict[str, Any]] = []
            for index in range(int(storage.num_files())):
                size = max(0, int(storage.file_size(index)))
                downloaded = (
                    max(0, int(progress_values[index])) if index < len(progress_values) else 0
                )
                try:
                    priority = int(priorities[index]) if index < len(priorities) else 0
                except Exception:
                    logger.debug("Could not coerce libtorrent file priority", exc_info=True)
                    priority = 0
                files.append(
                    {
                        "index": index,
                        "name": str(storage.file_path(index)),
                        "size": size,
                        "progress": min(1.0, downloaded / size) if size > 0 else 1.0,
                        "priority": priority,
                        "availability": 0.0,
                        "piece_range": self._piece_range_for_file(storage, index, piece_size),
                        "offset": max(0, int(storage.file_offset(index))),
                    }
                )
            return {"metadata_ready": True, "files": files}

    @staticmethod
    def select_video_file(files: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
        candidates = []
        for item in files:
            extension = os.path.splitext(item.get("name", ""))[1].lower()
            if extension not in VIDEO_EXTENSIONS:
                continue
            is_sample = bool(SAMPLE_PATTERN.search(item.get("name", "")))
            candidates.append(
                (
                    is_sample,
                    -int(item.get("size", 0)),
                    int(item.get("index") or 0),
                    item,
                )
            )
        if not candidates:
            return None
        candidates.sort(key=lambda row: (row[0], row[1], row[2]))
        selected = dict(candidates[0][3])
        selected["extension"] = os.path.splitext(selected["name"])[1].lower()
        selected["is_sample"] = candidates[0][0]
        selected["candidate_count"] = len(candidates)
        return selected

    def prepare(self, info_hash: str) -> dict[str, Any]:
        with self._lock:
            record = self._record(info_hash)
            file_state = self.files(info_hash)
            if not file_state["metadata_ready"]:
                return {"metadata_ready": False, "video_file": None, "files": []}

            selected = self.select_video_file(file_state["files"])
            if not selected:
                return {
                    "metadata_ready": True,
                    "video_file": None,
                    "files": file_state["files"],
                }

            info = self._torrent_info(record.handle)
            if info is None:
                raise TorrentEngineError("torrent metadata unexpectedly unavailable during prepare")
            storage = self._file_storage(info)
            index = int(selected["index"])
            if not record.prepared or record.selected_file_index != index:
                priorities = [0] * int(storage.num_files())
                priorities[index] = 7
                record.handle.prioritize_files(priorities)
                record.selected_file_index = index
                record.prepared = True
                record.deadline_window = None
                record.pending_far_window = None
                record.active_request_generation = None
                record.cancelled_request_generations.clear()
                try:
                    record.handle.clear_piece_deadlines()
                except Exception:
                    logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
                logger.info("Selected file %s for %s", selected["name"], info_hash)

            selected["priority"] = 7
            selected["piece_size"] = max(0, int(info.piece_length()))
            selected["pieces_num"] = max(0, int(info.num_pieces()))
            selected["path"] = self._file_path(storage, index, record.save_path)
            selected_path = os.path.realpath(selected["path"])
            if os.path.commonpath([record.save_path, selected_path]) != record.save_path:
                raise TorrentEngineError("selected file resolved outside managed save path")
            record.selected_path = selected_path
            record.selected_size = int(selected["size"])
            return {
                "metadata_ready": True,
                "video_file": selected,
                "files": file_state["files"],
            }

    def _range_geometry(
        self, record: TorrentRecord, file_index: int, start: int, end: int
    ) -> tuple[Any, Any, int, int, int, int]:
        info = self._torrent_info(record.handle)
        if info is None:
            raise TorrentEngineError("torrent metadata is not ready")
        storage = self._file_storage(info)
        if file_index < 0 or file_index >= int(storage.num_files()):
            raise ValueError("invalid file index")
        file_size = max(0, int(storage.file_size(file_index)))
        if file_size <= 0:
            raise ValueError("selected video file has no size")
        if start < 0 or end < start or start >= file_size:
            raise ValueError("requested file byte range is invalid")
        end = min(end, file_size - 1)
        piece_size = max(0, int(info.piece_length()))
        if piece_size <= 0:
            raise TorrentEngineError("torrent piece geometry is not ready")
        file_offset = max(0, int(storage.file_offset(file_index)))
        first_piece = (file_offset + start) // piece_size
        last_piece = (file_offset + end) // piece_size
        return info, storage, file_size, piece_size, first_piece, last_piece

    def _schedule_deadlines(
        self,
        record: TorrentRecord,
        file_index: int,
        start: int,
        end: int,
        lookahead_bytes: int,
        request_generation: Optional[int] = None,
    ) -> tuple[int, int, bool, bool]:
        info, storage, file_size, piece_size, first_piece, requested_last = self._range_geometry(
            record, file_index, start, end
        )
        file_offset = max(0, int(storage.file_offset(file_index)))
        lookahead_end = min(file_size - 1, end + max(0, lookahead_bytes))
        window_last = (file_offset + lookahead_end) // piece_size

        if request_generation is not None:
            request_generation = max(1, int(request_generation))
            if request_generation in record.cancelled_request_generations:
                return first_piece, requested_last, False, True
            if (
                record.active_request_generation is not None
                and request_generation < record.active_request_generation
            ):
                # A newer stream request has already taken ownership of the
                # time-critical window. Never let an abandoned older HTTP GET
                # pull libtorrent back to the pre-seek playback position.
                return first_piece, requested_last, True, False
            if record.active_request_generation is None:
                record.active_request_generation = request_generation

        previous = record.deadline_window
        now = time.monotonic()
        if previous is not None:
            prev_first, prev_last = previous
            far_from_previous = first_piece < prev_first - 2 or first_piece > prev_last + 2
            if far_from_previous:
                pending = record.pending_far_window
                confirmed_far_request = (
                    pending is not None
                    and pending[0] - 2 <= first_piece <= pending[1] + 2
                    and now - pending[2] <= 3.0
                    and (
                        request_generation is None
                        or pending[3] == request_generation
                    )
                )
                if confirmed_far_request:
                    # A sustained request at a distant location is a real seek.
                    # Promote this request generation before clearing deadlines.
                    # Any older stream still blocked in a piece wait will then be
                    # marked superseded instead of fighting the new seek window.
                    try:
                        record.handle.clear_piece_deadlines()
                    except Exception:
                        logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
                    record.deadline_window = None
                    record.pending_far_window = None
                    if request_generation is not None:
                        record.active_request_generation = request_generation
                else:
                    pending_generation = request_generation or 0
                    record.pending_far_window = (
                        first_piece,
                        window_last,
                        now,
                        pending_generation,
                    )
            else:
                # Do not let an older, still-alive playback GET erase a pending
                # far seek from a newer request generation before it can be
                # confirmed on the next scheduler pass.
                pending = record.pending_far_window
                preserve_newer_pending = (
                    pending is not None
                    and request_generation is not None
                    and pending[3] > request_generation
                )
                if not preserve_newer_pending:
                    record.pending_far_window = None
                if request_generation is not None:
                    active = record.active_request_generation or 0
                    record.active_request_generation = max(active, request_generation)

        for piece in range(first_piece, window_last + 1):
            if record.handle.have_piece(piece):
                continue
            # Requested pieces are due immediately; lookahead pieces get
            # progressively later deadlines so libtorrent can keep the pipe full
            # without starving the current HTTP range.
            distance = max(0, piece - requested_last)
            deadline_ms = 0 if piece <= requested_last else distance * DEADLINE_STEP_MS
            record.handle.set_piece_deadline(piece, int(deadline_ms))
            try:
                record.handle.piece_priority(piece, 7)
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)

        if record.deadline_window is None:
            record.deadline_window = (first_piece, window_last)
        else:
            prev_first, prev_last = record.deadline_window
            if not (first_piece > prev_last + 2 or window_last < prev_first - 2):
                record.deadline_window = (
                    min(prev_first, first_piece),
                    max(prev_last, window_last),
                )
        return first_piece, requested_last, False, False

    def range_status(
        self,
        info_hash: str,
        file_index: int,
        start: int,
        end: int,
        *,
        schedule: bool = True,
        lookahead_bytes: int = RANGE_LOOKAHEAD_BYTES,
        request_generation: Optional[int] = None,
    ) -> dict[str, Any]:
        with self._lock:
            record = self._record(info_hash)
            try:
                info, storage, _file_size, piece_size, first_piece, last_piece = self._range_geometry(
                    record, file_index, start, end
                )
            except TorrentEngineError:
                return {
                    "ready": False,
                    "first_piece": None,
                    "last_piece": None,
                    "missing_pieces": [],
                    "piece_size": 0,
                    "waiting_for": "piece_geometry",
                    "piece_states_available": 0,
                    "request_generation": request_generation,
                    "active_request_generation": record.active_request_generation,
                    "superseded": False,
                    "cancelled": False,
                }

            superseded = False
            cancelled = False
            if schedule:
                _first, _last, superseded, cancelled = self._schedule_deadlines(
                    record,
                    file_index,
                    start,
                    end,
                    max(0, int(lookahead_bytes)),
                    request_generation=request_generation,
                )

            missing = [
                piece
                for piece in range(first_piece, last_piece + 1)
                if not record.handle.have_piece(piece)
            ]
            return {
                "ready": not missing and not superseded and not cancelled,
                "first_piece": first_piece,
                "last_piece": last_piece,
                "missing_pieces": missing,
                "piece_size": piece_size,
                "waiting_for": (
                    "superseded"
                    if superseded
                    else "cancelled"
                    if cancelled
                    else None
                    if not missing
                    else "pieces"
                ),
                "piece_states_available": max(0, int(info.num_pieces())),
                "scheduler": "piece_deadlines",
                "time_critical": True,
                "request_generation": request_generation,
                "active_request_generation": record.active_request_generation,
                "superseded": superseded,
                "cancelled": cancelled,
            }

    async def wait_range(
        self,
        info_hash: str,
        file_index: int,
        start: int,
        end: int,
        timeout_seconds: float,
        lookahead_bytes: int = RANGE_LOOKAHEAD_BYTES,
        request_generation: Optional[int] = None,
    ) -> dict[str, Any]:
        deadline = asyncio.get_running_loop().time() + max(0.1, float(timeout_seconds))
        last_status: Optional[dict[str, Any]] = None
        reschedule_at = 0.0
        while True:
            now = asyncio.get_running_loop().time()
            schedule = now >= reschedule_at
            last_status = self.range_status(
                info_hash,
                file_index,
                start,
                end,
                schedule=schedule,
                lookahead_bytes=lookahead_bytes,
                request_generation=request_generation,
            )
            if schedule:
                reschedule_at = now + 2.0
            if last_status.get("superseded") or last_status.get("cancelled"):
                return last_status
            if last_status.get("ready"):
                return last_status
            if now >= deadline:
                first_piece = last_status.get("first_piece")
                last_piece = last_status.get("last_piece")
                raise TimeoutError(
                    f"time-critical torrent pieces {first_piece}-{last_piece} were not ready "
                    f"within {timeout_seconds:.0f}s"
                )
            await asyncio.sleep(RANGE_POLL_MS / 1000.0)

    def cancel_range_request(self, info_hash: str, request_generation: int) -> dict[str, Any]:
        with self._lock:
            record = self._record(info_hash)
            generation = max(1, int(request_generation))
            record.cancelled_request_generations.add(generation)
            # Bound teardown bookkeeping for very long playback sessions.
            if len(record.cancelled_request_generations) > 256:
                newest = sorted(record.cancelled_request_generations)[-128:]
                record.cancelled_request_generations = set(newest)
            pending = record.pending_far_window
            if pending is not None and pending[3] == generation:
                record.pending_far_window = None
            return {
                "cancelled": True,
                "request_generation": generation,
            }

    def reannounce(self, info_hash: str) -> None:
        with self._lock:
            record = self._record(info_hash)
            record.handle.force_reannounce()
            try:
                record.handle.force_dht_announce()
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)

    @staticmethod
    def _delete_files_flag():
        # Python binding names changed across libtorrent ABIs/distributions.
        for owner_name in ("options_t", "session", "session_handle"):
            owner = getattr(lt, owner_name, None)
            flag = getattr(owner, "delete_files", None) if owner is not None else None
            if flag is not None:
                return flag
        return None

    def remove(self, info_hash: str, delete_files: bool = True) -> bool:
        normalized = self._valid_hash(info_hash)
        if not normalized:
            return True
        with self._lock:
            record = self._records.pop(normalized, None)
            if record is None:
                return True
            try:
                record.handle.pause()
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
            try:
                record.handle.clear_piece_deadlines()
            except Exception:
                logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
            try:
                delete_flag = self._delete_files_flag() if delete_files else None
                if delete_flag is not None:
                    self._session.remove_torrent(record.handle, delete_flag)
                else:
                    self._session.remove_torrent(record.handle)
            except Exception as exc:
                logger.warning("remove_torrent(%s) raised: %s", normalized, exc)

        if delete_files:
            # libtorrent deletion is asynchronous. Repeating the managed-directory
            # removal also covers bindings that do not expose delete_files and
            # prevents a late disk callback from recreating payload after close.
            for _ in range(60):
                shutil.rmtree(record.save_path, ignore_errors=True)
                if not os.path.exists(record.save_path):
                    time.sleep(0.05)
                    if not os.path.exists(record.save_path):
                        break
                time.sleep(0.05)

        verified = normalized not in self._records and (
            not delete_files or not os.path.exists(record.save_path)
        )
        if verified:
            logger.info("Removed torrent %s; files deleted=%s", normalized, delete_files)
        return verified

    def close(self) -> None:
        for info_hash in list(self._records):
            try:
                self.remove(info_hash, delete_files=True)
            except Exception as exc:
                logger.warning("Could not remove %s during engine shutdown: %s", info_hash, exc)
        try:
            self._session.pause()
        except Exception:
            logger.debug("Ignored optional libtorrent operation failure", exc_info=True)
