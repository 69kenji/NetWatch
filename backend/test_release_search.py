import unittest
from unittest.mock import AsyncMock, patch

from services.exceptions import DependencyUnavailableError
from services.release_search import ReleaseSearchService
from services.release_refs import ReleaseReferenceStore


class ReleaseSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_prowlarr_failure_propagates(self):
        failure = DependencyUnavailableError("prowlarr", "down")
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(side_effect=failure),
        ):
            with self.assertRaises(DependencyUnavailableError) as ctx:
                await ReleaseSearchService.search("Interstellar")
        self.assertEqual(ctx.exception.service, "prowlarr")

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
        ):
            results = await ReleaseSearchService.search("Breaking Bad S05E16")

        self.assertEqual(len(results), 2)
        self.assertEqual({item["info_hash"] for item in results}, {"1" * 40, "2" * 40})

    async def test_same_hash_duplicate_prefers_torrent_url(self):
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
        ):
            results = await ReleaseSearchService.search("Interstellar")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["source_type"], "torrent_url")

    async def test_same_source_rank_prefers_higher_seeder_count(self):
        shared_hash = "b" * 40
        prowlarr = [
            {
                "title": "Example Movie 2026 1080p",
                "size": 20,
                "seeders": 3,
                "resolution": "1080p",
                "source_type": "magnet",
                "source_url": "magnet:?xt=urn:btih:" + shared_hash,
                "info_hash": shared_hash,
                "indexer": "Indexer A",
            },
            {
                "title": "Example Movie 2026 1080p",
                "size": 20,
                "seeders": 9,
                "resolution": "1080p",
                "source_type": "magnet",
                "source_url": "magnet:?xt=urn:btih:" + shared_hash,
                "info_hash": shared_hash,
                "indexer": "Indexer B",
            },
        ]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ):
            results = await ReleaseSearchService.search("Example Movie")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["indexer"], "Indexer B")

    async def test_results_are_sorted_by_resolution_then_seeders(self):
        prowlarr = [
            {"title": "A 720p", "size": 1, "seeders": 100, "resolution": "720p", "source_type": "magnet", "source_url": "magnet:?xt=urn:btih:" + "a" * 40},
            {"title": "B 1080p", "size": 2, "seeders": 2, "resolution": "1080p", "source_type": "magnet", "source_url": "magnet:?xt=urn:btih:" + "b" * 40},
            {"title": "C 1080p", "size": 3, "seeders": 8, "resolution": "1080p", "source_type": "magnet", "source_url": "magnet:?xt=urn:btih:" + "c" * 40},
        ]
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=prowlarr),
        ):
            results = await ReleaseSearchService.search("Example")

        self.assertEqual([item["title"] for item in results], ["C 1080p", "B 1080p", "A 720p"])


    async def test_provider_url_and_api_key_never_cross_search_boundary(self):
        source = "http://127.0.0.1:9696/api/v1/indexer/1/download?apikey=SUPERSECRET&link=x"
        raw = [{
            "title": "Secret Boundary 1080p",
            "size": 1,
            "seeders": 1,
            "resolution": "1080p",
            "source_type": "torrent_url",
            "source_url": source,
            "info_hash": "d" * 40,
        }]
        ReleaseReferenceStore.clear()
        with patch(
            "services.release_search.ProwlarrService.search",
            new=AsyncMock(return_value=raw),
        ):
            results = await ReleaseSearchService.search("Secret Boundary")

        self.assertEqual(len(results), 1)
        self.assertNotIn("source_url", results[0])
        self.assertNotIn("magnet", results[0])
        self.assertNotIn("SUPERSECRET", repr(results[0]))
        stored = ReleaseReferenceStore.resolve(results[0]["release_ref"])
        self.assertIsNotNone(stored)
        self.assertEqual(stored.source_url, source)
        ReleaseReferenceStore.clear()


if __name__ == "__main__":
    unittest.main()
