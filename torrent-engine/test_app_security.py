import unittest

from fastapi.testclient import TestClient
from pydantic import ValidationError

from app import AddTorrentRequest, app


class EngineApiSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app, base_url="http://127.0.0.1")

    def test_add_model_rejects_http_source_and_invalid_hash(self):
        with self.assertRaises(ValidationError):
            AddTorrentRequest(source="https://example.com/a.torrent", media_name="Movie")
        with self.assertRaises(ValidationError):
            AddTorrentRequest(source="magnet:?xt=urn:btih:" + "a" * 40, media_name="Movie", expected_hash="bad")

    def test_invalid_hash_path_is_rejected_before_engine_lookup(self):
        response = self.client.get("/torrents/..%2Fbad/progress")
        self.assertIn(response.status_code, {404, 422})
        response = self.client.get("/torrents/not-a-hash/progress")
        self.assertEqual(response.status_code, 422)

    def test_dns_rebinding_host_header_is_rejected(self):
        response = self.client.get("/health", headers={"Host": "attacker.example"})
        self.assertEqual(response.status_code, 400)

    def test_oversized_body_is_rejected_before_json_decode(self):
        response = self.client.post(
            "/torrents/add",
            content=b"x" * (25 * 1024 * 1024 + 1),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(response.status_code, 413)


if __name__ == "__main__":
    unittest.main()
