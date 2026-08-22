#!/usr/bin/env python3
"""Live backend smoke test for the no-player torrent lifecycle.

Searches Prowlarr, tries candidates in order, skips releases that do not contain
an immediately playable video file, observes real libtorrent engine progress, then
removes the test torrent and its data.

Use only with content you are authorized to download.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


ARCHIVE_EXTENSIONS = {
    ".rar",
    ".zip",
    ".7z",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
}


def api_request(base: str, method: str, path: str, payload=None):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{base.rstrip('/')}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} -> HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{method} {path} failed: {exc}") from exc


def human_bytes(value: int) -> str:
    size = float(value or 0)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024 or unit == "TiB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TiB"


def result_label(result: dict) -> str:
    return (
        f"{result.get('title', '<untitled>')} "
        f"[{result.get('source_type') or 'unknown'}, "
        f"{result.get('resolution') or 'unknown'}, "
        f"{result.get('seeders', 0)} seeders, "
        f"{human_bytes(result.get('size', 0))}]"
    )


def classify_unplayable_files(files: list[dict]) -> str:
    if not files:
        return "torrent metadata contained no files"

    names = [str(item.get("name", "")) for item in files]
    lowered = [name.lower() for name in names]
    archive_like = 0
    for name in lowered:
        ext = os.path.splitext(name)[1]
        if ext in ARCHIVE_EXTENSIONS or re.search(r"\.r\d\d$", name):
            archive_like += 1

    if archive_like:
        return "archive-only/non-direct-play release"
    return "no supported directly playable video file"


def print_file_diagnostics(files: list[dict], max_files: int = 30) -> None:
    if not files:
        print("    Torrent contents: <empty>")
        return

    print(f"    Torrent contents ({len(files)} file(s)):")
    for item in files[:max_files]:
        print(
            f"      #{item.get('index', '?'):>3}  "
            f"{human_bytes(item.get('size', 0)):>10}  "
            f"{item.get('name', '<unnamed>')}"
        )
    if len(files) > max_files:
        print(f"      ... {len(files) - max_files} more file(s) omitted")


def remove_created_torrent(base_url: str, info_hash: str, label: str = "Cleanup") -> bool:
    print(f"{label}: deleting test torrent {info_hash} and its data...")
    _, removed = api_request(
        base_url,
        "DELETE",
        f"/api/torrents/{info_hash}?delete_files=true",
    )
    verified = bool(removed.get("verified_absent"))
    print(f"{label} verified." if verified else f"{label} returned without verification.")
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Search -> try candidates -> add -> resolve hash -> identify video -> "
            "observe progress -> delete"
        )
    )
    parser.add_argument("query", help="Prowlarr movie search query")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--resolution", default=None)
    parser.add_argument("--min-seeders", type=int, default=0)
    parser.add_argument(
        "--result-index",
        type=int,
        default=0,
        help="start trying candidates at this zero-based search result index",
    )
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=5,
        help="maximum number of search results to inspect before failing (default: 5)",
    )
    parser.add_argument("--metadata-timeout", type=int, default=90)
    parser.add_argument("--progress-timeout", type=int, default=45)
    parser.add_argument(
        "--diagnostic-files",
        type=int,
        default=30,
        help="maximum number of torrent files to print when rejecting a candidate",
    )
    args = parser.parse_args()

    active_hash = None
    active_created_here = False
    active_delete_confirmed = False

    try:
        print(f"Searching Prowlarr for: {args.query}")
        _, search = api_request(
            args.base_url,
            "POST",
            "/api/torrents/search",
            {
                "query": args.query,
                "resolution_filter": args.resolution,
                "min_seeders": args.min_seeders,
            },
        )
        results = search.get("results", [])
        if not results:
            raise RuntimeError(
                "Prowlarr returned no usable torrent results after backend filtering."
            )
        if args.result_index >= len(results):
            raise RuntimeError(
                f"result index {args.result_index} is out of range; "
                f"only {len(results)} result(s) were returned"
            )
        if args.max_candidates < 1:
            raise RuntimeError("--max-candidates must be at least 1")

        candidates = results[
            args.result_index : args.result_index + args.max_candidates
        ]
        rejected: list[str] = []
        selected = None
        video = None

        for offset, candidate in enumerate(candidates):
            search_index = args.result_index + offset
            print(f"\nCandidate {offset + 1}/{len(candidates)} (search index {search_index}):")
            print("  ", result_label(candidate))

            _, added = api_request(
                args.base_url,
                "POST",
                "/api/torrents/add",
                {
                    "magnet": candidate["source_url"],
                    "media_name": candidate["title"],
                    "expected_hash": candidate.get("info_hash"),
                },
            )
            active_hash = added["hash"]
            active_created_here = not added.get("already_existed", False)
            active_delete_confirmed = False
            print(
                f"  Resolved info hash: {active_hash} "
                f"({added.get('resolution', 'unknown')})"
            )

            if not active_created_here:
                reason = "torrent already existed in libtorrent engine; refusing to modify/delete it"
                rejected.append(f"index {search_index}: {reason}")
                print(f"  Skipping candidate: {reason}.")
                active_hash = None
                continue

            print("  Waiting for torrent metadata / file list...")
            deadline = time.monotonic() + args.metadata_timeout
            files_state = None
            while time.monotonic() < deadline:
                _, files_state = api_request(
                    args.base_url, "GET", f"/api/torrents/files/{active_hash}"
                )
                if files_state.get("metadata_ready"):
                    break
                time.sleep(1)

            if not files_state or not files_state.get("metadata_ready"):
                reason = "timed out waiting for libtorrent engine torrent metadata"
                rejected.append(f"index {search_index}: {reason}")
                print(f"  Candidate rejected: {reason}.")
                active_delete_confirmed = remove_created_torrent(
                    args.base_url, active_hash, label="  Cleanup"
                )
                active_created_here = not active_delete_confirmed
                if not active_delete_confirmed:
                    raise RuntimeError(
                        "candidate cleanup was not verified; refusing to try another torrent"
                    )
                active_hash = None
                active_created_here = False
                continue

            video = files_state.get("video_file")
            if not video:
                torrent_files = files_state.get("files", [])
                reason = classify_unplayable_files(torrent_files)
                rejected.append(f"index {search_index}: {reason}")
                print(f"  Candidate rejected: {reason}.")
                print_file_diagnostics(torrent_files, args.diagnostic_files)
                active_delete_confirmed = remove_created_torrent(
                    args.base_url, active_hash, label="  Cleanup"
                )
                active_created_here = not active_delete_confirmed
                if not active_delete_confirmed:
                    raise RuntimeError(
                        "candidate cleanup was not verified; refusing to try another torrent"
                    )
                active_hash = None
                active_created_here = False
                print("  Trying next Prowlarr result...")
                continue

            selected = candidate
            break

        if not selected or not video or not active_hash:
            details = "; ".join(rejected) if rejected else "no candidates were attempted"
            raise RuntimeError(
                f"No directly playable torrent found in {len(candidates)} candidate(s): {details}"
            )

        print(
            f"\nSelected playable torrent: {selected['title']}\n"
            f"Video file: #{video['index']} {video['name']} "
            f"({human_bytes(video['size'])}, {video['candidate_count']} video candidate(s))"
        )

        print("Observing real libtorrent engine progress...")
        deadline = time.monotonic() + args.progress_timeout
        saw_transfer = False
        while time.monotonic() < deadline:
            _, status = api_request(
                args.base_url, "GET", f"/api/torrents/status/{active_hash}"
            )
            current_file = status.get("video_file") or {}
            print(
                f"  state={status.get('state')} "
                f"torrent={status.get('progress', 0) * 100:6.2f}% "
                f"file={current_file.get('progress', 0) * 100:6.2f}% "
                f"downloaded={human_bytes(status.get('downloaded', 0))} "
                f"speed={human_bytes(status.get('dl_speed', 0))}/s "
                f"seeds={status.get('num_seeds', 0)}"
            )
            if status.get("downloaded", 0) > 0 or status.get("progress", 0) > 0:
                saw_transfer = True
                break
            time.sleep(2)
        if not saw_transfer:
            raise RuntimeError(
                "libtorrent engine metadata worked, but no downloaded bytes were observed before "
                "the progress timeout"
            )

        print("Lifecycle data path reached successfully; deleting torrent + data...")
        active_delete_confirmed = remove_created_torrent(
            args.base_url, active_hash, label="Cleanup"
        )
        if not active_delete_confirmed:
            raise RuntimeError("delete endpoint did not verify that the torrent disappeared")
        active_created_here = False
        active_hash = None
        print("PASS: search -> fallback -> add -> deterministic hash -> video file -> progress -> delete")
        return 0

    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if active_hash and active_created_here and not active_delete_confirmed:
            try:
                remove_created_torrent(args.base_url, active_hash)
            except Exception as cleanup_exc:
                print(f"WARNING: cleanup failed: {cleanup_exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
