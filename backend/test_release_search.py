import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from services.exceptions import DependencyUnavailableError
from services.release_search import ReleaseSearchService


class ReleaseSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_direct_1337x_survives_prowlarr_failure(self):
        direct = [{
            "title": "Interstellar 2014 1080p",
            "size": 10,
            "seeders": 20,
            "resolution": "1080p",
            "source_type": "1337x_detail",
        }]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(side_effect=DependencyUnavailableError("prowlarr", "timeout")),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=True,
        ), patch(
            "services.release_search.X1337Service.search",
            new=AsyncMock(return_value=direct),
        ):
            results = await ReleaseSearchService.search("Interstellar")
        self.assertEqual(results, direct)

    async def test_slow_direct_1337x_does_not_hold_prowlarr_results_indefinitely(self):
        prowlarr = [{
            "title": "Interstellar 2014 1080p",
            "size": 10,
            "seeders": 4,
            "resolution": "1080p",
            "source_type": "torrent_url",
        }]

        async def slow_direct(**_kwargs):
            await asyncio.sleep(10)
            return []

        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=True,
        ), patch(
            "services.release_search.X1337Service.search",
            new=AsyncMock(side_effect=slow_direct),
        ), patch(
            "services.release_search.DIRECT_1337X_SEARCH_BUDGET_SECS",
            0.01,
        ):
            results = await ReleaseSearchService.search("Interstellar")
        self.assertEqual(results, prowlarr)

    async def test_direct_1337x_failure_is_nonfatal_when_prowlarr_succeeds(self):
        prowlarr = [{
            "title": "Interstellar 2014 1080p",
            "size": 10,
            "seeders": 4,
            "resolution": "1080p",
            "source_type": "torrent_url",
        }]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=True,
        ), patch(
            "services.release_search.X1337Service.search",
            new=AsyncMock(side_effect=DependencyUnavailableError("1337x", "down")),
        ):
            results = await ReleaseSearchService.search("Interstellar")
        self.assertEqual(results, prowlarr)

    async def test_duplicate_prefers_torrent_url_over_direct_1337x_detail(self):
        prowlarr = [{
            "title": "Interstellar 2014 1080p",
            "size": 10,
            "seeders": 4,
            "resolution": "1080p",
            "source_type": "torrent_url",
            "source_url": "http://prowlarr/download/1",
        }]
        direct = [{
            "title": "Interstellar 2014 1080p",
            "size": 10,
            "seeders": 400,
            "resolution": "1080p",
            "source_type": "1337x_detail",
            "source_url": "nw1337x:0:/torrent/1/interstellar/",
        }]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=True,
        ), patch(
            "services.release_search.X1337Service.search",
            new=AsyncMock(return_value=direct),
        ):
            results = await ReleaseSearchService.search("Interstellar")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source_type"], "torrent_url")
        self.assertEqual(results[0]["source_url"], "http://prowlarr/download/1")

    async def test_same_title_size_different_known_hashes_are_preserved(self):
        prowlarr = [
            {
                "title": "Breaking Bad S05E16 720p HDTV x264 IMMERSE[rartv]",
                "size": 10,
                "seeders": 12810,
                "resolution": "720p",
                "source_type": "torrent_url",
                "source_url": "http://prowlarr/download/dead",
                "info_hash": "1" * 40,
            },
            {
                "title": "Breaking Bad S05E16 720p HDTV x264 IMMERSE[rartv]",
                "size": 10,
                "seeders": 2,
                "resolution": "720p",
                "source_type": "magnet",
                "source_url": "magnet:?xt=urn:btih:" + "2" * 40,
                "info_hash": "2" * 40,
            },
        ]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=False,
        ):
            results = await ReleaseSearchService.search("Breaking Bad S05E16")

        self.assertEqual(len(results), 2)
        self.assertEqual({item["info_hash"] for item in results}, {"1" * 40, "2" * 40})

    async def test_same_hash_duplicate_still_uses_source_preference(self):
        shared_hash = "a" * 40
        prowlarr = [
            {
                "title": "Interstellar 2014 1080p",
                "size": 10,
                "seeders": 4,
                "resolution": "1080p",
                "source_type": "magnet",
                "source_url": "magnet:?xt=urn:btih:" + shared_hash,
                "info_hash": shared_hash,
            },
            {
                "title": "Interstellar 2014 1080p",
                "size": 10,
                "seeders": 1,
                "resolution": "1080p",
                "source_type": "torrent_url",
                "source_url": "http://prowlarr/download/1",
                "info_hash": shared_hash,
            },
        ]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=False,
        ):
            results = await ReleaseSearchService.search("Interstellar")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source_type"], "torrent_url")

    async def test_both_sources_failure_raises(self):
        failure = DependencyUnavailableError("source", "down")
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(side_effect=failure),
        ), patch(
            "services.release_search.X1337Service.enabled",
            return_value=True,
        ), patch(
            "services.release_search.X1337Service.search",
            new=AsyncMock(side_effect=failure),
        ):
            with self.assertRaises(DependencyUnavailableError):
                await ReleaseSearchService.search("Interstellar")


if __name__ == "__main__":
    unittest.main()
