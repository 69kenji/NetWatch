import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from services.exceptions import DependencyUnavailableError
from services.flaresolverr import FlareSolverrService
from services.privacy import PrivacyService
from services.prowlarr import ProwlarrService
from services.torrent_engine import TorrentEngineService
from services.subtitles import SubtitleService

router = APIRouter()


class SubtitleCredentialValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["opensubtitles", "subdl"]
    api_key: str = Field(min_length=32, max_length=49)


def _validate_subtitle_credential_shape(provider: str, api_key: str) -> str:
    cleaned = api_key.strip()
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in cleaned):
        raise HTTPException(status_code=400, detail="Credential contains unsupported control characters")
    if provider == "opensubtitles":
        if len(cleaned) != 32:
            raise HTTPException(status_code=400, detail="OpenSubtitles API key must be exactly 32 characters")
        return cleaned
    if len(cleaned) != 49 or not cleaned.startswith("subdl_") or len(cleaned[6:]) != 43:
        raise HTTPException(status_code=400, detail="SubDL API key must contain subdl_ followed by exactly 43 characters")
    return cleaned


@router.post("/subtitle-credential")
async def validate_subtitle_credential(req: SubtitleCredentialValidationRequest):
    """Validate a transient optional-provider key without persisting or returning it."""
    key = _validate_subtitle_credential_shape(req.provider, req.api_key)
    result = await SubtitleService.validate_candidate(req.provider, key)
    return {
        "provider": req.provider,
        "connected": bool(result.get("connected")),
        "authenticated": bool(result.get("authenticated")),
        "status": result.get("status"),
        "error": result.get("error"),
    }


@router.get("/torrent-engine")
async def torrent_engine_status():
    return await TorrentEngineService.health_check()


@router.get("/prowlarr")
async def prowlarr_status():
    return await ProwlarrService.health_check()


@router.get("/flaresolverr")
async def flaresolverr_status():
    return await FlareSolverrService.health_check()


@router.get("/dependencies")
async def dependency_status():
    # Keep the core startup readiness path independent from the optional browser
    # solver. FlareSolverr has a separate diagnostics endpoint below.
    engine, prowlarr = await asyncio.gather(
        TorrentEngineService.health_check(),
        ProwlarrService.health_check(),
    )
    return {
        "torrent_engine": engine,
        "prowlarr": prowlarr,
        "all_connected": bool(
            engine.get("connected") and prowlarr.get("connected")
        ),
    }


@router.get("/vpn-sanity")
async def vpn_sanity():
    try:
        return await PrivacyService.vpn_sanity()
    except DependencyUnavailableError as exc:
        return {
            "status": "error",
            "connected": False,
            "vpn_interface": "wg0",
            "vpn_interface_present": True,
            "public_ip": None,
            "dns_ok": False,
            "dns_addresses": [],
            "error": exc.message,
        }
