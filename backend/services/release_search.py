from __future__ import annotations

import re
from typing import Optional

from services.prowlarr import ProwlarrService
from services.release_refs import ReleaseReferenceStore

_RESOLUTION_ORDER = {"2160p": 0, "1080p": 1, "720p": 2, "480p": 3, "Unknown": 4}
_SOURCE_PREFERENCE = {"torrent_url": 2, "magnet": 1}


def _dedupe_key(item: dict) -> tuple[str, int]:
    title = re.sub(r"[^a-z0-9]+", "", str(item.get("title") or "").lower())
    return title, int(item.get("size") or 0)


def _known_info_hash(item: dict) -> str:
    return str(item.get("info_hash") or "").strip().lower()


def _can_dedupe(candidate: dict, current: dict) -> bool:
    """Return whether two title/size matches are safe to treat as one release.

    Different Prowlarr indexers can publish the same display title and byte size
    for different swarms. If both results expose hashes and those hashes differ,
    keep both choices so a stale swarm cannot hide a viable alternative.
    """
    candidate_hash = _known_info_hash(candidate)
    current_hash = _known_info_hash(current)
    return not (candidate_hash and current_hash and candidate_hash != current_hash)


def _prefer(candidate: dict, current: dict) -> bool:
    # Prefer a Prowlarr grab URL because it may yield a .torrent with metadata
    # immediately. Redirects to magnets are handled by the resolver at add time.
    candidate_rank = _SOURCE_PREFERENCE.get(str(candidate.get("source_type") or ""), 0)
    current_rank = _SOURCE_PREFERENCE.get(str(current.get("source_type") or ""), 0)
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    return int(candidate.get("seeders") or 0) > int(current.get("seeders") or 0)


class ReleaseSearchService:
    @classmethod
    async def search(
        cls,
        query: str,
        imdb_id: Optional[str] = None,
        category: Optional[int] = None,
        resolution_filter: Optional[str] = None,
        min_seeders: int = 0,
        max_results: int = 50,
    ) -> list[dict]:
        # Prowlarr is NetWatch's sole indexer abstraction. Provider-specific
        # indexers (including Cloudflare-protected ones) belong in Prowlarr,
        # which may use the bundled FlareSolverr service as an indexer proxy.
        raw = await ProwlarrService.search(
            query=query,
            imdb_id=imdb_id,
            category=category,
            resolution_filter=resolution_filter,
            min_seeders=min_seeders,
            max_results=max_results,
        )

        merged: dict[tuple[str, int], list[dict]] = {}
        for item in raw:
            key = _dedupe_key(item)
            bucket = merged.setdefault(key, [])
            match_index = next(
                (index for index, existing in enumerate(bucket) if _can_dedupe(item, existing)),
                None,
            )
            if match_index is None:
                bucket.append(item)
            elif _prefer(item, bucket[match_index]):
                bucket[match_index] = item

        results = [item for bucket in merged.values() for item in bucket]
        results.sort(key=lambda item: (
            _RESOLUTION_ORDER.get(str(item.get("resolution") or "Unknown"), 4),
            -int(item.get("seeders") or 0),
        ))

        # Provider download URLs stay backend-only. Prowlarr grab URLs can carry
        # its API key in the query string, so never serialize source_url/magnet
        # into a response consumed by Electron/React.
        serialized: list[dict] = []
        for item in results[:max_results]:
            source_url = str(item.get("source_url") or "").strip()
            if not source_url:
                continue
            release_ref = ReleaseReferenceStore.issue(source_url, _known_info_hash(item) or None)
            safe_item = {
                key: value
                for key, value in item.items()
                if key not in {"source_url", "magnet"}
            }
            safe_item["release_ref"] = release_ref
            serialized.append(safe_item)
        return serialized
