import unittest
from unittest.mock import AsyncMock, patch

from services.prowlarr import ProwlarrService


class ProwlarrSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_url_is_preferred_when_magnet_url_is_also_present(self):
        raw = [{
            "title": "Example Show S01E01 1080p",
            "seeders": 5,
            "leechers": 1,
            "size": 1234,
            "downloadUrl": "http://localhost:9696/api/v1/indexer/1/download?id=abc",
            "magnetUrl": "magnet:?xt=urn:btih:" + "a" * 40,
            "infoHash": "a" * 40,
            "indexer": "Example",
            "indexerId": 1,
        }]

        with patch("services.prowlarr.settings.PROWLARR_API_KEY", "test-key"), patch.object(
            ProwlarrService, "_raw_search", new=AsyncMock(return_value=raw)
        ):
            results = await ProwlarrService.search("Example Show S01E01")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source_type"], "torrent_url")
        self.assertEqual(results[0]["source_url"], raw[0]["downloadUrl"])

    async def test_magnet_is_used_when_download_url_is_absent(self):
        magnet = "magnet:?xt=urn:btih:" + "b" * 40
        raw = [{
            "title": "Example Show S01E01 720p",
            "seeders": 5,
            "leechers": 1,
            "size": 1234,
            "magnetUrl": magnet,
            "infoHash": "b" * 40,
            "indexer": "Example",
            "indexerId": 1,
        }]

        with patch("services.prowlarr.settings.PROWLARR_API_KEY", "test-key"), patch.object(
            ProwlarrService, "_raw_search", new=AsyncMock(return_value=raw)
        ):
            results = await ProwlarrService.search("Example Show S01E01")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source_type"], "magnet")
        self.assertEqual(results[0]["source_url"], magnet)


if __name__ == "__main__":
    unittest.main()
