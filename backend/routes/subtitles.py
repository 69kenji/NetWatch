import re
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from services.subtitles import SubtitleProviderError, SubtitleService

router = APIRouter()


class DownloadSubtitleRequest(BaseModel):
    subtitle_id: str
    source: str
    download_ref: Optional[str] = None
    # Backwards-compatible field used by the unfinished panel implementation.
    file_id: Optional[str] = None
    format: Optional[str] = None
    file_name: Optional[str] = None


def _provider_http_error(exc: SubtitleProviderError) -> HTTPException:
    status = exc.status if exc.status in {400, 401, 403, 404, 406, 429, 503} else 502
    if status in {401, 403}:
        status = 502
    return HTTPException(
        status_code=status,
        detail={"provider": exc.provider, "error": exc.message},
    )


@router.get("/providers")
async def subtitle_providers():
    """Validate provider credentials without returning any secret material."""
    return await SubtitleService.health_check()


@router.get("/search")
async def search_subtitles(
    imdb_id: Optional[str] = None,
    query: Optional[str] = None,
    file_name: Optional[str] = None,
    languages: str = Query(default="en"),
    season: Optional[int] = Query(default=None, ge=1),
    episode: Optional[int] = Query(default=None, ge=1),
):
    language_codes = [part.strip() for part in languages.split(",") if part.strip()]
    try:
        results, providers = await SubtitleService.search(
            imdb_id=imdb_id,
            query=query,
            file_name=file_name,
            languages=language_codes,
            season=season,
            episode=episode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Keep `download_url` as a compatibility alias while the frontend moves to
    # the less misleading `download_ref` field. Neither value contains an API key.
    serialized = [
        {**row, "download_url": row.get("download_ref")}
        for row in results
    ]
    return {
        "results": serialized,
        "providers": providers,
        "count": len(serialized),
    }


@router.post("/download")
async def download_subtitle(req: DownloadSubtitleRequest):
    download_ref = (req.download_ref or req.file_id or "").strip()
    if not download_ref:
        raise HTTPException(status_code=400, detail="download_ref is required")

    try:
        cached = await SubtitleService.download(
            subtitle_id=req.subtitle_id,
            source=req.source,
            download_ref=download_ref,
            preferred_format=req.format,
            file_name=req.file_name,
        )
    except SubtitleProviderError as exc:
        raise _provider_http_error(exc) from exc

    return {
        "token": cached.token,
        "url": f"http://127.0.0.1:8000/api/subtitles/file/{quote(cached.token, safe='')}",
        "path": f"http://127.0.0.1:8000/api/subtitles/file/{quote(cached.token, safe='')}",
        "filename": cached.filename,
        "source": cached.source,
    }


@router.get("/file/{token}")
async def subtitle_file(token: str):
    cached = await SubtitleService.get_cached(token)
    if not cached:
        raise HTTPException(status_code=404, detail="Subtitle is no longer available")

    safe_filename = cached.filename.replace('"', "_")
    ascii_filename = re.sub(r"[^A-Za-z0-9._ -]", "_", safe_filename) or "subtitle.srt"
    encoded_filename = quote(safe_filename, safe="")
    return Response(
        content=cached.content,
        media_type=cached.content_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f"inline; filename=\"{ascii_filename}\"; filename*=UTF-8''{encoded_filename}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/file/{token}")
async def delete_subtitle_file(token: str):
    removed = await SubtitleService.delete_cached(token)
    return {"removed": removed}
