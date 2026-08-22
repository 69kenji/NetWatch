import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from config import settings
from services.metadata import MetadataService


def movie_item(item_id: int, title: str, *, anime: bool = False, popularity: float = 10.0, release_date: str = "2026-08-01"):
    return {
        "id": item_id,
        "title": title,
        "original_title": title,
        "release_date": release_date,
        "overview": "",
        "poster_path": "/poster.jpg",
        "backdrop_path": "/backdrop.jpg",
        "vote_average": 7.5,
        "vote_count": 100,
        "popularity": popularity,
        "adult": False,
        "original_language": "ja" if anime else "en",
        "genre_ids": [16] if anime else [18],
    }


def tv_item(item_id: int, title: str, *, anime: bool = False, popularity: float = 10.0, country=None, release_date: str = "2026-08-01"):
    return {
        "id": item_id,
        "name": title,
        "original_name": title,
        "first_air_date": release_date,
        "overview": "",
        "poster_path": "/poster.jpg",
        "backdrop_path": "/backdrop.jpg",
        "vote_average": 8.0,
        "vote_count": 100,
        "popularity": popularity,
        "adult": False,
        "original_language": "ja" if anime else "en",
        "origin_country": country if country is not None else (["JP"] if anime else ["US"]),
        "genre_ids": [16] if anime else [18],
    }


class MetadataHomeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        MetadataService._home_cache = None
        MetadataService._home_cache_expires_at = 0.0
        MetadataService._catalog_enrichment_cache = {}

    async def test_home_catalog_adds_recent_rails_and_filters_explicit_anime(self):
        trending_movie = movie_item(1, "Trending Movie", popularity=80)
        trending_india_movie = movie_item(16, "Trending India Movie", popularity=95)
        trending_tv = tv_item(2, "Trending TV", popularity=70)
        trending_india_tv = tv_item(17, "Trending India TV", popularity=95, country=["IN"])
        anime_ok = tv_item(3, "Anime TV", anime=True, popularity=60)
        anime_explicit = tv_item(4, "Explicit Anime", anime=True, popularity=90)

        recent_movie = movie_item(10, "Recent Indie", popularity=35)
        recent_china = movie_item(11, "China Only", popularity=100)
        recent_india = movie_item(18, "India Recent", popularity=130)
        recent_tv = tv_item(12, "Recent Korean TV", popularity=45, country=["KR"])
        recent_tv_china = tv_item(13, "Recent China TV", popularity=110, country=["CN"])
        recent_anime = tv_item(14, "Recent Anime", anime=True, popularity=50)
        recent_anime_explicit = tv_item(15, "Recent Explicit Anime", anime=True, popularity=120)

        async def fake_get(path, params=None):
            params = params or {}
            if path == "/trending/movie/week":
                return {"results": [trending_india_movie, trending_movie]}
            if path == "/trending/tv/week":
                return {"results": [trending_india_tv, trending_tv]}
            if path == "/discover/movie":
                return {"results": []}
            if path == "/discover/tv":
                if "first_air_date.gte" in params:
                    return {"results": [recent_anime, recent_anime_explicit]}
                return {"results": [anime_ok, anime_explicit]}
            raise AssertionError(path)

        async def fake_enrichment(media_type, item_id):
            by_id = {
                3: {"adult": False, "keywords": [], "countries": ["JP"], "release_types": []},
                4: {"adult": False, "keywords": ["hentai", "adult animation"], "countries": ["JP"], "release_types": []},
                10: {"adult": False, "keywords": [], "countries": ["US"], "release_types": [2]},
                11: {"adult": False, "keywords": [], "countries": ["CN"], "release_types": [3]},
                14: {"adult": False, "keywords": [], "countries": ["JP"], "release_types": []},
                15: {"adult": False, "keywords": ["softcore"], "countries": ["JP"], "release_types": []},
                16: {"adult": False, "keywords": [], "countries": ["IN"], "release_types": [3]},
                18: {"adult": False, "keywords": [], "countries": ["IN"], "release_types": [3]},
            }
            return by_id.get(item_id, {"adult": False, "keywords": [], "countries": ["US"], "release_types": []})

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_recent_movie_candidates", new=AsyncMock(return_value=[recent_movie, recent_china, recent_india])),
            patch.object(MetadataService, "_recent_tv_candidates", new=AsyncMock(return_value=[recent_tv, recent_tv_china])),
            patch.object(MetadataService, "_catalog_enrichment", new=AsyncMock(side_effect=fake_enrichment)),
        ):
            payload = await MetadataService.home_catalog()

        self.assertEqual([item["title"] for item in payload["movies"]], ["Trending Movie"])
        self.assertEqual([item["title"] for item in payload["tv"]], ["Trending TV"])
        self.assertEqual([item["title"] for item in payload["anime"]], ["Anime TV"])
        self.assertEqual([item["title"] for item in payload["recent_movies"]], ["Recent Indie"])
        self.assertEqual([item["title"] for item in payload["recent_tv"]], ["Recent Korean TV"])
        self.assertEqual([item["title"] for item in payload["recent_anime"]], ["Recent Anime"])

    async def test_search_catalog_filters_hentai_but_keeps_mature_anime(self):
        normal_movie = movie_item(20, "Ghost", popularity=50)
        mature_anime = tv_item(21, "Ghost Mature Anime", anime=True, popularity=60)
        explicit_anime = tv_item(22, "Ghost Explicit Anime", anime=True, popularity=80)

        async def fake_get(path, params=None):
            if path == "/search/movie":
                return {"results": [normal_movie]}
            if path == "/search/tv":
                return {"results": [mature_anime, explicit_anime]}
            raise AssertionError(path)

        async def fake_enrichment(media_type, item_id):
            if item_id == 22:
                return {"adult": False, "keywords": ["hentai", "adult animation"], "countries": ["JP"], "release_types": []}
            if item_id == 21:
                return {"adult": False, "keywords": ["adult animation", "violence"], "countries": ["JP"], "release_types": []}
            return {"adult": False, "keywords": [], "countries": ["US"], "release_types": []}

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_catalog_enrichment", new=AsyncMock(side_effect=fake_enrichment)),
        ):
            results = await MetadataService.search_catalog("Ghost")

        titles = [item["title"] for item in results]
        self.assertIn("Ghost", titles)
        self.assertIn("Ghost Mature Anime", titles)
        self.assertNotIn("Ghost Explicit Anime", titles)

    async def test_search_catalog_excludes_indian_movie_and_tv_even_when_movie_is_english(self):
        indian_movie = movie_item(30, "English Indian Film", popularity=100)
        indian_movie["original_language"] = "en"
        normal_movie = movie_item(31, "English US Film", popularity=80)
        indian_tv = tv_item(32, "Indian TV", popularity=90, country=["IN"])
        korean_tv = tv_item(33, "Korean TV", popularity=70, country=["KR"])

        async def fake_get(path, params=None):
            if path == "/search/movie":
                return {"results": [indian_movie, normal_movie]}
            if path == "/search/tv":
                return {"results": [indian_tv, korean_tv]}
            raise AssertionError(path)

        async def fake_enrichment(media_type, item_id):
            if item_id == 30:
                return {"adult": False, "keywords": [], "countries": ["IN"], "release_types": []}
            if item_id == 31:
                return {"adult": False, "keywords": [], "countries": ["US"], "release_types": []}
            return {"adult": False, "keywords": [], "countries": ["KR"], "release_types": []}

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_catalog_enrichment", new=AsyncMock(side_effect=fake_enrichment)),
        ):
            results = await MetadataService.search_catalog("English")

        titles = [item["title"] for item in results]
        self.assertNotIn("English Indian Film", titles)
        self.assertNotIn("Indian TV", titles)
        self.assertIn("English US Film", titles)
        self.assertIn("Korean TV", titles)

    async def test_media_specific_searches_apply_same_india_exclusion(self):
        indian_movie = movie_item(40, "Indian Movie", popularity=100)
        allowed_movie = movie_item(41, "Allowed Movie", popularity=80)
        indian_tv = tv_item(42, "Indian TV", popularity=90, country=["IN"])
        allowed_tv = tv_item(43, "Allowed TV", popularity=70, country=["US"])

        async def fake_get(path, params=None):
            if path == "/search/movie":
                return {"results": [indian_movie, allowed_movie]}
            if path == "/search/tv":
                return {"results": [indian_tv, allowed_tv]}
            raise AssertionError(path)

        async def fake_enrichment(media_type, item_id):
            countries = ["IN"] if item_id == 40 else ["US"]
            return {"adult": False, "keywords": [], "countries": countries, "release_types": []}

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_catalog_enrichment", new=AsyncMock(side_effect=fake_enrichment)),
        ):
            movies = await MetadataService.search_movies("test")
            tv = await MetadataService.search_series("test")

        self.assertEqual([item["title"] for item in movies], ["Allowed Movie"])
        self.assertEqual([item["title"] for item in tv], ["Allowed TV"])

    async def test_direct_movie_and_tv_details_reject_indian_productions(self):
        indian_movie = {
            "id": 50,
            "title": "Indian Detail",
            "production_countries": [{"iso_3166_1": "IN"}],
        }
        indian_tv = {
            "id": 51,
            "name": "Indian TV Detail",
            "origin_country": ["IN"],
        }

        async def fake_get(path, params=None):
            if path == "/movie/50":
                return indian_movie
            if path == "/tv/51":
                return indian_tv
            raise AssertionError(path)

        with patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)):
            with self.assertRaises(ValueError):
                await MetadataService.get_movie(50)
            with self.assertRaises(ValueError):
                await MetadataService.get_series(51)

    async def test_home_catalog_uses_persistent_cache_across_memory_reset(self):
        payload = {
            "movies": [{"id": 1, "type": "movie", "title": "Cached Movie"}],
            "recent_movies": [],
            "tv": [],
            "recent_tv": [],
            "anime": [],
            "recent_anime": [],
        }
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(settings, "NETWATCH_CACHE_DIR", temp_dir):
            cache_path = Path(temp_dir) / MetadataService.HOME_CACHE_FILENAME
            cache_path.write_text(json.dumps({
                "schema_version": MetadataService.HOME_CACHE_SCHEMA_VERSION,
                "cached_at_epoch": time.time(),
                "payload": payload,
            }), encoding="utf-8")
            MetadataService._home_cache = None
            MetadataService._home_cache_expires_at = 0.0

            with patch.object(MetadataService, "_get", new=AsyncMock(side_effect=AssertionError("TMDB should not be called"))):
                result = await MetadataService.home_catalog()

        self.assertEqual(result["movies"][0]["title"], "Cached Movie")

    async def test_expired_persistent_home_cache_is_not_used(self):
        payload = {
            "movies": [{"id": 1, "type": "movie", "title": "Stale Movie"}],
            "recent_movies": [],
            "tv": [],
            "recent_tv": [],
            "anime": [],
            "recent_anime": [],
        }
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(settings, "NETWATCH_CACHE_DIR", temp_dir):
            cache_path = Path(temp_dir) / MetadataService.HOME_CACHE_FILENAME
            cache_path.write_text(json.dumps({
                "schema_version": MetadataService.HOME_CACHE_SCHEMA_VERSION,
                "cached_at_epoch": time.time() - MetadataService.HOME_CACHE_TTL_SECS - 1,
                "payload": payload,
            }), encoding="utf-8")
            MetadataService._home_cache = None
            MetadataService._home_cache_expires_at = 0.0

            with patch.object(MetadataService, "_get", new=AsyncMock(side_effect=RuntimeError("fresh fetch attempted"))):
                with self.assertRaises(RuntimeError):
                    await MetadataService.home_catalog()



if __name__ == "__main__":
    unittest.main()
