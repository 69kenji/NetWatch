import unittest
from unittest.mock import AsyncMock, patch

from routes.metadata import (
    _media_aliases,
    _movie_payload,
    _movie_release_identity_matches,
    _series_release_identity_matches,
    episode_stream_options,
)


class ReleaseIdentityTests(unittest.IsolatedAsyncioTestCase):
    def test_obsession_series_accepts_exact_identity(self):
        self.assertTrue(_series_release_identity_matches(
            "Obsession.2023.S01E01.1080p.WEB-DL.x265",
            ["Obsession"],
            "2023",
            1,
            1,
        ))
        self.assertTrue(_series_release_identity_matches(
            "Obsession.S01E01.1080p.WEB-DL.x265",
            ["Obsession"],
            "2023",
            1,
            1,
        ))

    def test_obsession_series_rejects_keyword_only_false_positives(self):
        false_positives = [
            "Secret.Obsession.S01E01.1080p.WEBRip",
            "Obsession.Dark.Desires.S01E01.720p.HDTV",
            "My.Obsession.S01E01.1080p.WEB-DL",
            "Obsession.2014.S01E01.1080p.WEB-DL",
        ]
        for title in false_positives:
            with self.subTest(title=title):
                self.assertFalse(_series_release_identity_matches(
                    title, ["Obsession"], "2023", 1, 1
                ))

    def test_series_region_disambiguator_is_allowed(self):
        self.assertTrue(_series_release_identity_matches(
            "The.Office.US.S01E01.720p.WEB-DL",
            ["The Office"],
            "2005",
            1,
            1,
        ))

    def test_punctuated_acronym_title_can_match_compacted_release(self):
        self.assertTrue(_series_release_identity_matches(
            "SWAT.S07E01.1080p.WEB-DL",
            ["S.W.A.T."],
            "2017",
            7,
            1,
        ))

    def test_compacted_acronym_run_with_remaining_title_can_match(self):
        self.assertTrue(_series_release_identity_matches(
            "911.Lone.Star.S05E01.1080p.WEB-DL",
            ["9-1-1: Lone Star"],
            "2020",
            5,
            1,
        ))

    def test_colon_subtitle_acronym_can_match_release(self):
        self.assertTrue(_series_release_identity_matches(
            "Law.and.Order.SVU.S25E01.1080p.WEB-DL",
            ["Law & Order: Special Victims Unit"],
            "1999",
            25,
            1,
        ))

    def test_movie_identity_rejects_longer_title_and_wrong_year(self):
        aliases = ["Obsession"]
        self.assertTrue(_movie_release_identity_matches(
            "Obsession.2023.1080p.WEB-DL", aliases, "2023"
        ))
        self.assertFalse(_movie_release_identity_matches(
            "Secret.Obsession.2019.1080p.WEB-DL", aliases, "2023"
        ))
        self.assertFalse(_movie_release_identity_matches(
            "Obsession.2015.1080p.WEB-DL", aliases, "2023"
        ))

    async def test_movie_payload_filters_unrelated_keyword_matches(self):
        movie = {
            "title": "Obsession",
            "original_title": "Obsession",
            "year": "2023",
            "imdb_id": "tt0000001",
            "is_anime": False,
        }
        raw = [
            {"title": "Obsession.2023.1080p.WEB-DL"},
            {"title": "Secret.Obsession.2019.1080p.WEB-DL"},
        ]
        with patch(
            "routes.metadata.MetadataService.get_movie",
            new=AsyncMock(return_value=movie),
        ), patch(
            "routes.metadata.ReleaseSearchService.search",
            new=AsyncMock(return_value=raw),
        ):
            payload = await _movie_payload(1, 1)
        self.assertEqual([item["title"] for item in payload["results"]], [raw[0]["title"]])

    async def test_episode_stream_options_filters_unrelated_obsession_titles(self):
        series = {
            "title": "Obsession",
            "original_title": "Obsession",
            "year": "2023",
            "imdb_id": "tt0000002",
            "is_anime": False,
        }
        episode = {"season_number": 1, "episode_number": 1, "name": "Episode 1"}
        raw = [
            {"title": "Obsession.2023.S01E01.1080p.WEB-DL"},
            {"title": "Obsession.Dark.Desires.S01E01.720p.HDTV"},
            {"title": "Secret.Obsession.S01E01.1080p.WEBRip"},
        ]
        with patch(
            "routes.metadata.MetadataService.get_series",
            new=AsyncMock(return_value=series),
        ), patch(
            "routes.metadata.MetadataService.get_episode",
            new=AsyncMock(return_value=episode),
        ), patch(
            "routes.metadata.ReleaseSearchService.search",
            new=AsyncMock(return_value=raw),
        ):
            payload = await episode_stream_options(1, 1, 1, min_seeders=1, anime=False)
        self.assertEqual([item["title"] for item in payload["results"]], [raw[0]["title"]])

    def test_aliases_include_original_title_without_duplicates(self):
        self.assertEqual(
            _media_aliases({"title": "Dark", "original_title": "Dunkel"}),
            ["Dark", "Dunkel"],
        )
        self.assertEqual(
            _media_aliases({"title": "Obsession", "original_title": "obsession"}),
            ["Obsession"],
        )


if __name__ == "__main__":
    unittest.main()
