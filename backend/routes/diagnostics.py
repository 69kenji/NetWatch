import asyncio

from fastapi import APIRouter

from services.exceptions import DependencyUnavailableError
from services.flaresolverr import FlareSolverrService
from services.privacy import PrivacyService
from services.prowlarr import ProwlarrService
from services.torrent_engine import TorrentEngineService

router = APIRouter()


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
