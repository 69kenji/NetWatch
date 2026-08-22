import unittest
from datetime import date

from services.catalog_policy import is_explicit_content, is_indian_production, recent_origin_allowed, recent_score


class CatalogPolicyTests(unittest.TestCase):
    def test_explicit_filter_is_high_confidence_not_mature_rating_proxy(self):
        self.assertTrue(is_explicit_content(adult=True))
        self.assertTrue(is_explicit_content(keywords=["adult animation", "hentai", "romance"]))
        self.assertTrue(is_explicit_content(keywords=["softcore", "adult animation"]))
        self.assertFalse(is_explicit_content(keywords=["adult animation", "violence", "nudity"]))
        self.assertFalse(is_explicit_content(keywords=["pornography", "biography"]))
        self.assertFalse(is_explicit_content(title="Mature Thriller", keywords=["erotic thriller"]))


    def test_indian_production_filter_is_country_based_and_includes_coproductions(self):
        self.assertTrue(is_indian_production(["IN"]))
        self.assertTrue(is_indian_production(["US", "IN"]))
        self.assertFalse(is_indian_production(["JP"]))
        self.assertFalse(is_indian_production(["KR", "US"]))
        self.assertFalse(is_indian_production([]))

    def test_recent_origin_policy_keeps_international_and_jp_kr(self):
        self.assertTrue(recent_origin_allowed([]))
        self.assertTrue(recent_origin_allowed(["US"]))
        self.assertTrue(recent_origin_allowed(["FR"]))
        self.assertTrue(recent_origin_allowed(["JP"]))
        self.assertTrue(recent_origin_allowed(["KR"]))
        self.assertTrue(recent_origin_allowed(["CN", "US"]))
        self.assertFalse(recent_origin_allowed(["CN"]))
        self.assertFalse(recent_origin_allowed(["IN"]))
        self.assertFalse(recent_origin_allowed(["AE"]))
        self.assertFalse(recent_origin_allowed(["TH", "CN"]))

    def test_recent_score_does_not_require_major_vote_count(self):
        today = date(2026, 8, 14)
        fresh_indie = recent_score(
            popularity=45,
            vote_count=12,
            rating=7.8,
            release_date="2026-08-10",
            today=today,
            trending=False,
            release_types=[2],
            has_poster=True,
            has_backdrop=True,
        )
        stale_low_signal = recent_score(
            popularity=1,
            vote_count=2,
            rating=9.8,
            release_date="2026-04-20",
            today=today,
            trending=False,
            release_types=[],
            has_poster=False,
            has_backdrop=False,
        )
        self.assertGreater(fresh_indie, stale_low_signal)


if __name__ == "__main__":
    unittest.main()
