from __future__ import annotations

import asyncio
import re
from typing import Optional

from services.exceptions import DependencyUnavailableError
from services.prowlarr import ProwlarrService
from services.x1337 import X1337Service

_RESOLUTION_ORDER = {"2160p": 0, "1080p": 1, "720p": 2, "480p": 3, "Unknown": 4}
DIRECT_1337X_SEARCH_BUDGET_SECS = 12.0
_SOURCE_PREFERENCE = {"torrent_url": 3, "magnet": 2, "1337x_detail": 1}


def _dedupe_key(item: dict) -> tuple[str, int]:
    title = re.sub(r"[^a-z0-9]+", "", str(item.get("title") or "").lower())
    return title, int(item.get("size") or 0)


def _known_info_hash(item: dict) -> str:
    return str(item.get("info_hash") or "").strip().lower()


def _can_dedupe(candidate: dict, current: dict) -> bool:
    """Return whether two title/size matches are safe to treat as one release.

    Indexers can publish the same display title and byte size for different
    swarms. If both results expose hashes and those hashes differ, keeping both
    choices is safer than allowing a stale/dead swarm from one indexer to hide a
    viable alternative. When either side lacks a hash (for example direct 1337x
    search rows before detail resolution), retain the established title/size
    fallback so obvious duplicates are still collapsed.
    """
    candidate_hash = _known_info_hash(candidate)
    current_hash = _known_info_hash(current)
    return not (candidate_hash and current_hash and candidate_hash != current_hash)


def _prefer(candidate: dict, current: dict) -> bool:
    # Prefer the source with the best expected startup path. A Prowlarr grab URL
    # may yield a .torrent with metadata immediately; a magnet is next-best; a
    # direct 1337x detail reference requires another browser solve before it can
    # even become a magnet. Redirecting grab URLs are handled later by the resolver.
    candidate_rank = _SOURCE_PREFERENCE.get(str(candidate.get("source_type") or ""), 0)
    current_rank = _SOURCE_PREFERENCE.get(str(current.get("source_type") or ""), 0)
    if candidate_rank != current_rank:
        return candidate_rank > current_rank
    return int(candidate.get("seeders") or 0) > int(current.get("seeders") or 0)


async def _search_1337x_with_budget(**kwargs) -> list[dict]:
    try:
        return await asyncio.wait_for(
            X1337Service.search(**kwargs),
            timeout=DIRECT_1337X_SEARCH_BUDGET_SECS,
        )
    except asyncio.TimeoutError as exc:
        raise DependencyUnavailableError(
            "1337x",
            f"search exceeded the {DIRECT_1337X_SEARCH_BUDGET_SECS:g}s interactive time budget",
        ) from exc


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
        *,
        include_1337x: bool = True,
    ) -> list[dict]:
        tasks: list[tuple[str, object]] = [
            (
                "prowlarr",
                ProwlarrService.search(
                    query=query,
                    imdb_id=imdb_id,
                    category=category,
                    resolution_filter=resolution_filter,
                    min_seeders=min_seeders,
                    max_results=max_results,
                ),
            )
        ]
        if include_1337x and X1337Service.enabled():
            tasks.append((
                "1337x",
                _search_1337x_with_budget(
                    query=query,
                    resolution_filter=resolution_filter,
                    min_seeders=min_seeders,
                    max_results=min(max_results, 20),
                ),
            ))

        gathered = await asyncio.gather(
            *(awaitable for _name, awaitable in tasks),
            return_exceptions=True,
        )

        successful_sources = 0
        errors: list[str] = []
        merged: dict[tuple[str, int], list[dict]] = {}
        for (name, _awaitable), value in zip(tasks, gathered):
            if isinstance(value, Exception):
                if isinstance(value, DependencyUnavailableError):
                    errors.append(f"{name}: {value.message}")
                else:
                    errors.append(f"{name}: {value}")
                continue
            successful_sources += 1
            for item in value:
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

        if successful_sources == 0:
            raise DependencyUnavailableError(
                "release-search",
                "; ".join(errors) if errors else "all release sources failed",
            )

        results = [item for bucket in merged.values() for item in bucket]
        results.sort(key=lambda item: (
            _RESOLUTION_ORDER.get(str(item.get("resolution") or "Unknown"), 4),
            -int(item.get("seeders") or 0),
        ))
        return results[:max_results]
