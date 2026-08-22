from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import diagnostics, metadata, subtitles, torrents
from services.torrent_engine import TorrentEngineService

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Keep API startup independent from optional local services.

    The torrent engine and Prowlarr are intentionally *not* contacted here. This makes
    /api/health available even when Docker services are stopped, misconfigured,
    or still starting. Torrent-engine HTTP sessions are opened lazily by torrent actions
    and closed here if one was created during the process lifetime.
    """
    logger.info("NetWatch API started; external dependencies are lazy")
    try:
        yield
    finally:
        await TorrentEngineService.close()


app = FastAPI(title="NetWatch API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "app://netwatch"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Local-only liveness check. Never reaches the torrent engine, Prowlarr, TMDB, etc.
@app.get("/api/health", tags=["health"])
async def health():
    return {
        "status": "ok",
        "service": "netwatch-api",
        "dependencies_checked": False,
    }


# External dependency checks are deliberately separate from liveness.
app.include_router(diagnostics.router, prefix="/api/diagnostics", tags=["diagnostics"])

# Feature routers.
app.include_router(metadata.router, prefix="/api/metadata")
app.include_router(torrents.router, prefix="/api/torrents")
app.include_router(subtitles.router, prefix="/api/subtitles")
