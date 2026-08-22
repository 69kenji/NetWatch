from __future__ import annotations

import asyncio
import re
import time
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urljoin, urlparse

from config import settings
from services.exceptions import DependencyUnavailableError
from services.flaresolverr import FlareSolverrService
from services.prowlarr import parse_title

SOURCE_PREFIX = "nw1337x:"
MEDIA_CATEGORY_IDS = {
    # Movies
    1, 2, 3, 4, 42, 54, 55, 66, 70, 73, 76,
    # TV
    5, 6, 7, 9, 41, 71, 74, 75,
    # Anime
    28, 78, 79, 80, 81,
}
_SIZE_MULTIPLIERS = {
    "B": 1,
    "KB": 1024,
    "MB": 1024**2,
    "GB": 1024**3,
    "TB": 1024**4,
    "PB": 1024**5,
}


def _cell_kind(attrs: list[tuple[str, str | None]]) -> str | None:
    classes = next((value or "" for key, value in attrs if key == "class"), "")
    for token in classes.split():
        if token.startswith("coll-1"):
            return "title"
        if token.startswith("coll-2"):
            return "seeders"
        if token.startswith("coll-3"):
            return "leechers"
        if token.startswith("coll-4"):
            return "size"
        if token.startswith("coll-5"):
            return "uploader"
        if token.startswith("coll-date"):
            return "date"
    return None


class _SearchTableParser(HTMLParser):
    """Parse only the 1337x search-table fields NetWatch needs.

    The selectors mirror Prowlarr's current v11 1337x definition: torrent links live
    in coll-1, seeders/leechers in coll-2/coll-3, size in coll-4 and uploader in coll-5.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[dict] = []
        self._row: dict | None = None
        self._cell: str | None = None
        self._anchor: str | None = None
        self._anchor_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attrs_dict = {key: value or "" for key, value in attrs}
        if tag == "tr":
            self._row = {
                "detail_path": None,
                "title": "",
                "category_path": None,
                "seeders": "",
                "leechers": "",
                "size": "",
                "uploader": "",
                "date": "",
            }
            self._cell = None
            self._anchor = None
            self._anchor_parts = []
            return
        if self._row is None:
            return
        if tag == "td":
            self._cell = _cell_kind(attrs)
            return
        if tag == "a" and self._cell == "title":
            href = attrs_dict.get("href", "")
            if href.startswith("/torrent/"):
                self._row["detail_path"] = href
                self._anchor = "title"
                self._anchor_parts = []
            elif href.startswith("/sub/"):
                self._row["category_path"] = href

    def handle_data(self, data: str) -> None:
        if self._row is None or not data:
            return
        if self._cell in {"seeders", "leechers", "size", "uploader", "date"}:
            self._row[self._cell] += data
        if self._anchor == "title":
            self._anchor_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._row is None:
            return
        if tag == "a" and self._anchor == "title":
            title = "".join(self._anchor_parts).strip()
            if title:
                self._row["title"] = title
            self._anchor = None
            self._anchor_parts = []
            return
        if tag == "td":
            self._cell = None
            return
        if tag == "tr":
            if self._row.get("detail_path"):
                self.rows.append(self._row)
            self._row = None
            self._cell = None
            self._anchor = None
            self._anchor_parts = []


class _MagnetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.magnet: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.magnet or tag.lower() != "a":
            return
        href = next((value or "" for key, value in attrs if key == "href"), "")
        if href.lower().startswith("magnet:?"):
            self.magnet = href


def _parse_int(value: str) -> int:
    match = re.search(r"\d[\d,]*", value or "")
    if not match:
        return 0
    try:
        return int(match.group(0).replace(",", ""))
    except ValueError:
        return 0


def _parse_size(value: str) -> int:
    match = re.search(r"([\d.,]+)\s*([kmgtp]?b)\b", value or "", re.I)
    if not match:
        return 0
    number = match.group(1).replace(",", "")
    unit = match.group(2).upper()
    try:
        return int(float(number) * _SIZE_MULTIPLIERS[unit])
    except (ValueError, KeyError):
        return 0


def _category_id(category_path: str | None) -> int | None:
    if not category_path:
        return None
    match = re.search(r"/sub/(\d+)/", category_path)
    return int(match.group(1)) if match else None


def _title_from_row(title: str, detail_path: str) -> str:
    cleaned = re.sub(r"\s+", " ", title or "").strip()
    if cleaned and "..." not in cleaned:
        return cleaned

    # 1337x may abbreviate visible titles; its detail URL normally retains the full
    # slug. Prefer that to returning a visibly truncated release name.
    parts = [part for part in urlparse(detail_path).path.split("/") if part]
    if len(parts) >= 3 and parts[0].lower() == "torrent":
        slug = unquote(parts[2])
        slug = slug.replace("-", " ")
        slug = re.sub(r"\s+", " ", slug).strip()
        if slug:
            return slug
    return cleaned


class X1337Service:
    # Prowlarr's current 1337x definition declares a three-second request delay.
    # Serialize browser solves and honor that delay to avoid piling Chrome sessions up.
    _request_lock = asyncio.Lock()
    _last_request_monotonic = 0.0

    @classmethod
    async def _fetch_html(cls, url: str) -> str:
        async with cls._request_lock:
            wait_for = 3.0 - (time.monotonic() - cls._last_request_monotonic)
            if wait_for > 0:
                await asyncio.sleep(wait_for)
            try:
                return await FlareSolverrService.get_html(
                    url, timeout_seconds=settings.X1337_SOLVE_TIMEOUT_SECS
                )
            finally:
                cls._last_request_monotonic = time.monotonic()

    @classmethod
    def enabled(cls) -> bool:
        return bool(settings.X1337_ENABLED)

    @classmethod
    def base_urls(cls) -> list[str]:
        result: list[str] = []
        for raw in str(settings.X1337_BASE_URLS or "").split(","):
            value = raw.strip().rstrip("/")
            parsed = urlparse(value)
            if parsed.scheme == "https" and parsed.hostname and not parsed.path.strip("/"):
                if value not in result:
                    result.append(value)
        return result

    @staticmethod
    def _source_ref(base_index: int, detail_path: str) -> str:
        # Keep only a mirror index + relative detail path in the renderer. The backend
        # reconstructs the URL from its own allowlisted base list, preventing arbitrary
        # URLs from being smuggled through the torrent-add endpoint.
        return f"{SOURCE_PREFIX}{base_index}:{quote(detail_path, safe='/')}"

    @classmethod
    def _parse_source_ref(cls, source_ref: str) -> tuple[int, str]:
        if not source_ref.startswith(SOURCE_PREFIX):
            raise ValueError("not a NetWatch 1337x source")
        payload = source_ref[len(SOURCE_PREFIX):]
        index_text, separator, encoded_path = payload.partition(":")
        if not separator:
            raise ValueError("invalid 1337x source reference")
        try:
            base_index = int(index_text)
        except ValueError as exc:
            raise ValueError("invalid 1337x mirror index") from exc

        bases = cls.base_urls()
        if base_index < 0 or base_index >= len(bases):
            raise ValueError("1337x mirror index is out of range")
        detail_path = unquote(encoded_path)
        parsed = urlparse(detail_path)
        if (
            parsed.scheme
            or parsed.netloc
            or not parsed.path.startswith("/torrent/")
            or ".." in parsed.path.split("/")
        ):
            raise ValueError("invalid 1337x detail path")
        return base_index, parsed.path

    @classmethod
    async def search(
        cls,
        query: str,
        *,
        resolution_filter: str | None = None,
        min_seeders: int = 0,
        max_results: int = 50,
    ) -> list[dict]:
        if not cls.enabled():
            return []
        query = (query or "").strip()
        if not query:
            return []

        bases = cls.base_urls()
        if not bases:
            raise DependencyUnavailableError("1337x", "no valid 1337x base URL is configured")

        errors: list[str] = []
        for base_index, base in enumerate(bases):
            search_url = f"{base}/search/{quote(query, safe='')}/1/"
            try:
                html = await cls._fetch_html(search_url)
                return cls._parse_search_results(
                    html,
                    base_index=base_index,
                    resolution_filter=resolution_filter,
                    min_seeders=min_seeders,
                    max_results=max_results,
                )
            except DependencyUnavailableError as exc:
                errors.append(f"{urlparse(base).hostname}: {exc.message}")

        raise DependencyUnavailableError(
            "1337x",
            "; ".join(errors) if errors else "all configured 1337x mirrors failed",
        )

    @classmethod
    def _parse_search_results(
        cls,
        html: str,
        *,
        base_index: int,
        resolution_filter: str | None,
        min_seeders: int,
        max_results: int,
    ) -> list[dict]:
        parser = _SearchTableParser()
        parser.feed(html)
        parser.close()

        results: list[dict] = []
        for row in parser.rows:
            detail_path = str(row.get("detail_path") or "")
            title = _title_from_row(str(row.get("title") or ""), detail_path)
            if not title:
                continue

            category_id = _category_id(row.get("category_path"))
            # If 1337x supplied a category, keep only media categories. If category
            # markup changes and cannot be parsed, do not silently throw away a result.
            if category_id is not None and category_id not in MEDIA_CATEGORY_IDS:
                continue

            seeders = _parse_int(str(row.get("seeders") or ""))
            if seeders < min_seeders:
                continue
            parsed_title = parse_title(title)
            if resolution_filter and parsed_title["resolution"] != resolution_filter:
                continue

            source_ref = cls._source_ref(base_index, detail_path)
            results.append({
                "title": title,
                "magnet": source_ref,
                "source_url": source_ref,
                "source_type": "1337x_detail",
                "info_hash": None,
                "size": _parse_size(str(row.get("size") or "")),
                "seeders": seeders,
                "leechers": _parse_int(str(row.get("leechers") or "")),
                "indexer": "1337x",
                "indexer_id": None,
                "published": re.sub(r"\s+", " ", str(row.get("date") or "")).strip(),
                "category_id": category_id,
                "uploader": re.sub(r"\s+", " ", str(row.get("uploader") or "")).strip(),
                **parsed_title,
            })
            if len(results) >= max_results:
                break

        return results

    @classmethod
    async def resolve_torrent_source(cls, source_ref: str) -> dict:
        preferred_index, detail_path = cls._parse_source_ref(source_ref)
        bases = cls.base_urls()
        order = [preferred_index] + [idx for idx in range(len(bases)) if idx != preferred_index]
        errors: list[str] = []

        for base_index in order:
            base = bases[base_index]
            url = urljoin(f"{base}/", detail_path.lstrip("/"))
            try:
                html = await cls._fetch_html(url)
            except DependencyUnavailableError as exc:
                errors.append(f"{urlparse(base).hostname}: {exc.message}")
                continue

            parser = _MagnetParser()
            parser.feed(html)
            parser.close()
            if parser.magnet:
                return {"source_type": "magnet", "magnet": parser.magnet}
            errors.append(f"{urlparse(base).hostname}: detail page did not expose a magnet link")

        raise DependencyUnavailableError(
            "1337x",
            "; ".join(errors) if errors else "1337x detail resolution failed",
        )
