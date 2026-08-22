import unittest
from unittest.mock import AsyncMock, patch

from services.metadata import MetadataService


class PlayerArtworkTests(unittest.TestCase):
    def test_logo_selection_prefers_english_then_original_then_neutral(self):
        images = {
            "logos": [
                {"file_path": "/neutral.png", "iso_639_1": None},
                {"file_path": "/ja.png", "iso_639_1": "ja"},
                {"file_path": "/en.png", "iso_639_1": "en"},
            ]
        }
        self.assertEqual(MetadataService._select_logo_path(images, "ja"), "/en.png")

        no_english = {"logos": [
            {"file_path": "/neutral.png", "iso_639_1": None},
            {"file_path": "/ja.png", "iso_639_1": "ja"},
        ]}
        self.assertEqual(MetadataService._select_logo_path(no_english, "ja"), "/ja.png")

        neutral_only = {"logos": [{"file_path": "/neutral.png", "iso_639_1": None}]}
        self.assertEqual(MetadataService._select_logo_path(neutral_only, "fr"), "/neutral.png")

    def test_detailed_movie_exposes_original_backdrop_and_logo_proxy(self):
        data = {
            "id": 1,
            "title": "Example",
            "original_title": "Example",
            "release_date": "2026-01-01",
            "backdrop_path": "/backdrop.jpg",
            "poster_path": "/poster.jpg",
            "original_language": "en",
            "genres": [],
            "credits": {"cast": []},
            "external_ids": {},
            "images": {"logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]},
        }
        item = MetadataService._format_movie(data)
        self.assertEqual(item["backdrop"], "http://127.0.0.1:8000/api/metadata/image/w1280/backdrop.jpg")
        self.assertEqual(item["player_backdrop"], "http://127.0.0.1:8000/api/metadata/image/original/backdrop.jpg")
        self.assertEqual(item["logo"], "http://127.0.0.1:8000/api/metadata/image/original/logo.png")

    def test_svg_logo_is_requested_as_png_for_renderer_safety(self):
        images = {"logos": [{"file_path": "/logo.svg", "iso_639_1": "en"}]}
        self.assertEqual(MetadataService._select_logo_path(images, "en"), "/logo.png")


class PlayerArtworkRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_movie_details_request_appends_images_for_player_artwork(self):
        payload = {
            "id": 10,
            "title": "Example",
            "release_date": "2026-01-01",
            "production_countries": [{"iso_3166_1": "US"}],
            "original_language": "en",
            "genres": [],
            "credits": {"cast": []},
            "external_ids": {},
            "images": {"logos": [{"file_path": "/logo.png", "iso_639_1": "en"}]},
        }
        mocked = AsyncMock(return_value=payload)
        with patch.object(MetadataService, "_get", new=mocked):
            item = await MetadataService.get_movie(10)

        self.assertTrue(item["logo"].endswith("/original/logo.png"))
        params = mocked.await_args.args[1]
        self.assertIn("images", params["append_to_response"])
        self.assertEqual(params["include_image_language"], "en,null")


if __name__ == "__main__":
    unittest.main()
