import unittest
from unittest.mock import AsyncMock, patch

from services.metadata import MetadataService


def movie_item(item_id: int, title: str, *, genre_ids=None, anime=False, release_date="2026-08-01", popularity=10.0):
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
        "genre_ids": list(genre_ids if genre_ids is not None else ([16] if anime else [18])),
    }


def tv_item(item_id: int, title: str, *, genre_ids=None, anime=False, release_date="2026-08-01", popularity=10.0):
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
        "origin_country": ["JP"] if anime else ["US"],
        "genre_ids": list(genre_ids if genre_ids is not None else ([16] if anime else [18])),
    }


async def allow_all(items, *, enrich_all=False):
    return list(items)


class MetadataDiscoverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        MetadataService._genre_cache = {}

    async def test_movie_popular_uses_tmdb_discover_and_genre(self):
        seen = []

        async def fake_get(path, params=None):
            seen.append((path, dict(params or {})))
            self.assertEqual(path, "/discover/movie")
            page = int((params or {}).get("page") or 1)
            return {"results": [movie_item(page, f"Movie {page}", genre_ids=[28])]}

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_filter_explicit_raw", new=AsyncMock(side_effect=allow_all)),
        ):
            results = await MetadataService.discover_catalog("movies", "popular", 28)

        self.assertEqual([item["title"] for item in results], ["Movie 1", "Movie 2"])
        self.assertEqual([params["page"] for _, params in seen], [1, 2])
        self.assertTrue(all(params["sort_by"] == "popularity.desc" for _, params in seen))
        self.assertTrue(all(params["with_genres"] == "28" for _, params in seen))

    async def test_anime_new_merges_movie_and_tv_and_requires_animation_japanese(self):
        seen = []

        async def fake_get(path, params=None):
            params = dict(params or {})
            seen.append((path, params))
            page = int(params.get("page") or 1)
            if path == "/discover/movie":
                return {"results": [movie_item(10 + page, f"Anime Movie {page}", genre_ids=[16, 18], anime=True, release_date=f"2026-08-0{page}")]}
            if path == "/discover/tv":
                return {"results": [tv_item(20 + page, f"Anime TV {page}", genre_ids=[16, 18], anime=True, release_date=f"2026-08-0{page + 2}")]}
            raise AssertionError(path)

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_filter_explicit_raw", new=AsyncMock(side_effect=allow_all)),
        ):
            results = await MetadataService.discover_catalog("anime", "new", 18)

        self.assertEqual(len(results), 4)
        self.assertTrue(all(item["is_anime"] for item in results))
        self.assertEqual(results[0]["title"], "Anime TV 2")
        self.assertTrue(all(params["with_original_language"] == "ja" for _, params in seen))
        self.assertTrue(all(params["with_genres"] == "16,18" for _, params in seen))
        self.assertTrue(all("release_date.lte" in " ".join(params.keys()) or "first_air_date.lte" in params for _, params in seen))

    async def test_featured_uses_trending_and_applies_genre_locally(self):
        async def fake_get(path, params=None):
            self.assertEqual(path, "/trending/tv/week")
            return {
                "results": [
                    tv_item(1, "Drama", genre_ids=[18], popularity=100),
                    tv_item(2, "Comedy", genre_ids=[35], popularity=90),
                ]
            }

        with (
            patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)),
            patch.object(MetadataService, "_filter_explicit_raw", new=AsyncMock(side_effect=allow_all)),
        ):
            results = await MetadataService.discover_catalog("tv", "featured", 35)

        self.assertEqual([item["title"] for item in results], ["Comedy"])

    async def test_anime_genres_merge_movie_and_tv_without_animation(self):
        async def fake_get(path, params=None):
            if path == "/genre/movie/list":
                return {"genres": [{"id": 16, "name": "Animation"}, {"id": 28, "name": "Action"}]}
            if path == "/genre/tv/list":
                return {"genres": [{"id": 16, "name": "Animation"}, {"id": 18, "name": "Drama"}]}
            raise AssertionError(path)

        with patch.object(MetadataService, "_get", new=AsyncMock(side_effect=fake_get)):
            genres = await MetadataService.discover_genres("anime")

        self.assertEqual(genres, [{"id": 28, "name": "Action"}, {"id": 18, "name": "Drama"}])

    async def test_invalid_discover_values_fail_closed(self):
        with self.assertRaises(ValueError):
            await MetadataService.discover_catalog("channels", "popular")
        with self.assertRaises(ValueError):
            await MetadataService.discover_catalog("movies", "regional")
        with self.assertRaises(ValueError):
            await MetadataService.discover_catalog("movies", "popular", 0)


if __name__ == "__main__":
    unittest.main()
