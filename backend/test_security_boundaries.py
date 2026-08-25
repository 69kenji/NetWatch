import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from pydantic import ValidationError

from main import app
from routes.torrents import AddTorrentRequest, SearchRequest
from services.http_security import RateLimitMiddleware
from services.net_safety import PinnedResolver, ResolvedHttpTarget, resolve_public_http_target
from services.subtitles import SubtitleProviderError, SubtitleService


class RequestModelSecurityTests(unittest.TestCase):
    def test_direct_http_torrent_source_is_rejected(self):
        with self.assertRaises(ValidationError):
            AddTorrentRequest(magnet="https://evil.example/a.torrent", media_name="Movie")

    def test_invalid_expected_hash_is_rejected(self):
        with self.assertRaises(ValidationError):
            AddTorrentRequest(magnet="magnet:?xt=urn:btih:" + "a" * 40, media_name="Movie", expected_hash="../bad")

    def test_search_fields_are_bounded_and_resolution_is_allowlisted(self):
        with self.assertRaises(ValidationError):
            SearchRequest(query="x" * 201)
        with self.assertRaises(ValidationError):
            SearchRequest(query="Movie", resolution_filter="4320p")
        with self.assertRaises(ValidationError):
            SearchRequest(query="Movie", min_seeders=-1)


class NetSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_literal_address_is_rejected(self):
        with self.assertRaises(ValueError):
            await resolve_public_http_target("http://127.0.0.1/private")

    async def test_public_literal_address_can_be_pinned(self):
        target = await resolve_public_http_target("https://1.1.1.1/test")
        self.assertEqual(target.addresses, ("1.1.1.1",))
        resolver = PinnedResolver(target.hostname, target.addresses)
        rows = await resolver.resolve("1.1.1.1", 443)
        self.assertEqual(rows[0]["host"], "1.1.1.1")
        with self.assertRaises(OSError):
            await resolver.resolve("different.example", 443)




class _FakeResponse:
    def __init__(self, status: int, headers: dict[str, str] | None = None):
        self.status = status
        self.headers = headers or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeSession:
    responses: list[_FakeResponse] = []
    calls: list[dict] = []

    def __init__(self, **kwargs):
        self.headers = dict(kwargs.get("headers") or {})

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get(self, url, **kwargs):
        type(self).calls.append({
            "url": url,
            "headers": dict(self.headers),
            "params": kwargs.get("params"),
            "allow_redirects": kwargs.get("allow_redirects"),
        })
        return type(self).responses.pop(0)


class SubtitleDownloadSecurityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _FakeSession.responses = []
        _FakeSession.calls = []

    async def test_subdl_private_redirect_is_rejected_before_second_request(self):
        _FakeSession.responses = [_FakeResponse(302, {"Location": "https://127.0.0.1/private"})]
        public = ResolvedHttpTarget(
            "https://dl.subdl.com/file.srt", "https", "dl.subdl.com", 443, ("1.1.1.1",)
        )
        with patch("services.subtitles.resolve_public_http_target", new=AsyncMock(
            side_effect=[public, ValueError("Download URL resolves to a non-public network address")]
        )), patch("services.subtitles.pinned_connector", return_value=object()), patch(
            "services.subtitles.aiohttp.ClientSession", _FakeSession
        ):
            with self.assertRaises(SubtitleProviderError):
                await SubtitleService._download_subdl_file(
                    "https://dl.subdl.com/file.srt",
                    credential_headers={"x-api-key": "secret"},
                    initial_params={"api_key": "secret"},
                )
        self.assertEqual(len(_FakeSession.calls), 1)
        self.assertFalse(_FakeSession.calls[0]["allow_redirects"])

    async def test_subdl_cross_origin_redirect_does_not_forward_credentials(self):
        _FakeSession.responses = [
            _FakeResponse(302, {"Location": "https://cdn.example/file.srt"}),
            _FakeResponse(200, {"Content-Disposition": 'attachment; filename="file.srt"'}),
        ]
        targets = [
            ResolvedHttpTarget(
                "https://dl.subdl.com/file.srt", "https", "dl.subdl.com", 443, ("1.1.1.1",)
            ),
            ResolvedHttpTarget(
                "https://cdn.example/file.srt", "https", "cdn.example", 443, ("8.8.8.8",)
            ),
        ]
        with patch("services.subtitles.resolve_public_http_target", new=AsyncMock(side_effect=targets)), patch(
            "services.subtitles.pinned_connector", return_value=object()
        ), patch("services.subtitles.aiohttp.ClientSession", _FakeSession), patch(
            "services.subtitles.read_response_limited", new=AsyncMock(return_value=b"subtitle")
        ):
            content, name = await SubtitleService._download_subdl_file(
                "https://dl.subdl.com/file.srt",
                credential_headers={"x-api-key": "secret"},
                initial_params={"api_key": "secret"},
            )
        self.assertEqual(content, b"subtitle")
        self.assertEqual(name, "file.srt")
        self.assertEqual(_FakeSession.calls[0]["headers"].get("x-api-key"), "secret")
        self.assertEqual(_FakeSession.calls[0]["params"], {"api_key": "secret"})
        self.assertNotIn("x-api-key", _FakeSession.calls[1]["headers"] )
        self.assertIsNone(_FakeSession.calls[1]["params"] )
        self.assertFalse(_FakeSession.calls[1]["allow_redirects"])


class RateLimitSecurityTests(unittest.TestCase):
    def setUp(self):
        self.middleware = RateLimitMiddleware(lambda scope, receive, send: None)

    def test_tmdb_detail_routes_share_one_bucket(self):
        movie = self.middleware._rule_for("GET", "/api/metadata/movies/101")
        series = self.middleware._rule_for("GET", "/api/metadata/series/202")
        season = self.middleware._rule_for("GET", "/api/metadata/series/202/seasons/3")
        self.assertEqual(movie, ("metadata-details", 90, 60.0))
        self.assertEqual(series, movie)
        self.assertEqual(season, movie)

    def test_stream_option_routes_share_one_bucket_across_ids(self):
        movie = self.middleware._rule_for("GET", "/api/metadata/movies/101/stream-options")
        episode = self.middleware._rule_for(
            "GET", "/api/metadata/series/202/episodes/3/4/stream-options"
        )
        self.assertEqual(movie, ("metadata-stream-options", 60, 60.0))
        self.assertEqual(episode, movie)

    def test_metadata_status_is_rate_limited(self):
        self.assertEqual(
            self.middleware._rule_for("GET", "/api/metadata/status"),
            ("metadata-status", 30, 60.0),
        )

    def test_credential_validation_is_rate_limited(self):
        self.assertEqual(
            self.middleware._rule_for("POST", "/api/diagnostics/subtitle-credential"),
            ("credential-validation", 12, 60.0),
        )

    def test_static_search_variants_share_provider_bucket(self):
        rules = {
            self.middleware._rule_for("GET", "/api/metadata/search"),
            self.middleware._rule_for("GET", "/api/metadata/movies/search"),
            self.middleware._rule_for("GET", "/api/metadata/series/search"),
            self.middleware._rule_for("GET", "/api/metadata/anime/search"),
        }
        self.assertEqual(rules, {("metadata-search", 60, 60.0)})

    def test_images_are_not_put_in_detail_bucket(self):
        self.assertIsNone(
            self.middleware._rule_for("GET", "/api/metadata/image/w500/poster.jpg")
        )


class ApiBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="http://127.0.0.1")

    def test_dns_rebinding_host_header_is_rejected(self):
        response = self.client.get("/api/health", headers={"Host": "attacker.example"})
        self.assertEqual(response.status_code, 400)

    def test_oversized_json_is_rejected_before_route_parsing(self):
        response = self.client.post(
            "/api/torrents/search",
            content=b'{"query":"' + (b"x" * (257 * 1024)) + b'"}',
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)

    def test_optional_subtitle_candidate_shape_is_rejected_before_provider_call(self):
        with patch("routes.diagnostics.SubtitleService.validate_candidate", new=AsyncMock()) as validate:
            bad_open = self.client.post(
                "/api/diagnostics/subtitle-credential",
                json={"provider": "opensubtitles", "api_key": "o" * 31},
            )
            bad_subdl = self.client.post(
                "/api/diagnostics/subtitle-credential",
                json={"provider": "subdl", "api_key": "x" * 49},
            )
            self.assertEqual(bad_open.status_code, 422)
            self.assertEqual(bad_subdl.status_code, 400)
            validate.assert_not_awaited()

    def test_optional_subtitle_candidate_is_transient_and_not_echoed(self):
        key = "o" * 32
        result = {"status": "ok", "connected": True, "authenticated": True}
        with patch("routes.diagnostics.SubtitleService.validate_candidate", new=AsyncMock(return_value=result)) as validate:
            response = self.client.post(
                "/api/diagnostics/subtitle-credential",
                json={"provider": "opensubtitles", "api_key": key},
            )
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()["authenticated"])
            self.assertNotIn(key, response.text)
            validate.assert_awaited_once_with("opensubtitles", key)

    def test_packaged_origin_is_allowed_but_random_origin_is_not(self):
        allowed = self.client.options(
            "/api/torrents/search",
            headers={
                "Origin": "app://netwatch",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "app://netwatch")

        denied = self.client.options(
            "/api/torrents/search",
            headers={
                "Origin": "https://attacker.example",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertNotEqual(denied.headers.get("access-control-allow-origin"), "https://attacker.example")


if __name__ == "__main__":
    unittest.main()
