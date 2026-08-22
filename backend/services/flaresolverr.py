import asyncio

import aiohttp

from config import settings
from services.exceptions import DependencyUnavailableError


class FlareSolverrService:
    BASE = settings.FLARESOLVERR_URL.rstrip("/")

    @classmethod
    def _timeout(cls) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(total=max(6.0, settings.DEPENDENCY_TIMEOUT_SECS))

    @staticmethod
    def _valid_sessions_payload(data: object) -> bool:
        return isinstance(data, dict) and isinstance(data.get("sessions"), list)


    @classmethod
    async def health_check(cls) -> dict:
        result = {
            "service": "flaresolverr",
            "url": cls.BASE,
            "connected": False,
        }

        try:
            async with aiohttp.ClientSession(timeout=cls._timeout()) as session:
                async with session.post(f"{cls.BASE}/v1", json={"cmd": "sessions.list"}) as response:
                    if response.status != 200:
                        result["status"] = "unavailable"
                        result["error"] = f"sessions.list returned HTTP {response.status}"
                        return result
                    data = await response.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            result["status"] = "unavailable"
            result["error"] = str(exc)
            return result

        if not cls._valid_sessions_payload(data):
            result["status"] = "unavailable"
            result["error"] = "unexpected sessions.list response"
            return result

        result["connected"] = True
        result["status"] = "ok"
        result["session_count"] = len(data["sessions"])
        return result
