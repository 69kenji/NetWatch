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
    async def get_html(cls, url: str, *, timeout_seconds: float | None = None) -> str:
        """Fetch one page through FlareSolverr and return the browser-rendered HTML.

        This is deliberately a small wrapper around the documented request.get API.
        Callers still validate which hosts/paths are allowed before invoking it.
        """
        solve_timeout = max(5.0, float(timeout_seconds or settings.X1337_SOLVE_TIMEOUT_SECS))
        payload = {
            "cmd": "request.get",
            "url": url,
            "maxTimeout": int(solve_timeout * 1000),
        }
        timeout = aiohttp.ClientTimeout(total=solve_timeout + 10.0)

        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f"{cls.BASE}/v1", json=payload) as response:
                    if response.status != 200:
                        raise DependencyUnavailableError(
                            "flaresolverr", f"request.get returned HTTP {response.status}"
                        )
                    data = await response.json(content_type=None)
        except DependencyUnavailableError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            raise DependencyUnavailableError("flaresolverr", str(exc)) from exc

        if not isinstance(data, dict) or str(data.get("status") or "").lower() != "ok":
            message = data.get("message") if isinstance(data, dict) else None
            raise DependencyUnavailableError(
                "flaresolverr", str(message or "request.get returned an unexpected response")
            )

        solution = data.get("solution")
        if not isinstance(solution, dict):
            raise DependencyUnavailableError("flaresolverr", "request.get did not return a solution")
        status = int(solution.get("status") or 0)
        if status < 200 or status >= 400:
            raise DependencyUnavailableError(
                "flaresolverr", f"solved page returned HTTP {status or 'unknown'}"
            )
        html = solution.get("response")
        if not isinstance(html, str) or not html.strip():
            raise DependencyUnavailableError("flaresolverr", "solved page returned empty HTML")
        return html

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
