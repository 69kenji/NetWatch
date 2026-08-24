import re
from typing import Annotated, Literal, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Path as ApiPath, Query, Response
from pydantic import BaseModel, Field

from services.subtitles import SubtitleProviderError, SubtitleService

router = APIRouter()


class DownloadSubtitleRequest(BaseModel):
    subtitle_id: str = Field(min_length=1, max_length=200)
    source: Literal["opensubtitles", "subdl"]
    download_ref: str = Field(min_length=1, max_length=1024)
    format: Optional[Literal["srt", "ass", "ssa", "vtt", "sub"]] = None
    file_name: Optional[str] = Field(default=None, max_length=240)


SubtitleToken = Annotated[str, ApiPath(pattern=r"^[A-Za-z0-9_-]{16,64}$")]


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
    imdb_id: Optional[str] = Query(default=None, max_length=32),
    query: Optional[str] = Query(default=None, max_length=200),
    file_name: Optional[str] = Query(default=None, max_length=240),
    languages: str = Query(default="en", max_length=80),
    season: Optional[int] = Query(default=None, ge=1, le=100),
    episode: Optional[int] = Query(default=None, ge=1, le=5000),
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

    return {
        "results": results,
        "providers": providers,
        "count": len(results),
    }


@router.post("/download")
async def download_subtitle(req: DownloadSubtitleRequest):
    download_ref = req.download_ref.strip()

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
async def subtitle_file(token: SubtitleToken):
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
async def delete_subtitle_file(token: SubtitleToken):
    removed = await SubtitleService.delete_cached(token)
    return {"removed": removed}
