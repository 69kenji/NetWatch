import asyncio
import unittest

from fastapi.testclient import TestClient
from pydantic import ValidationError

from main import app
from routes.torrents import AddTorrentRequest, SearchRequest
from services.http_security import RateLimitMiddleware
from services.net_safety import PinnedResolver, resolve_public_http_target


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
