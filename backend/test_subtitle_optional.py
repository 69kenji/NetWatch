import unittest
from unittest.mock import AsyncMock, patch

from config import settings
from services.subtitles import SubtitleService


class OptionalSubtitleProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_skips_unconfigured_providers_without_calling_them(self):
        old_open = settings.OPENSUBTITLES_API_KEY
        old_subdl = settings.SUBDL_API_KEY
        settings.OPENSUBTITLES_API_KEY = ""
        settings.SUBDL_API_KEY = ""
        try:
            with patch.object(SubtitleService, "_search_opensubtitles", new=AsyncMock()) as open_search, \
                 patch.object(SubtitleService, "_search_subdl", new=AsyncMock()) as subdl_search:
                rows, providers = await SubtitleService.search(query="NetWatch", languages=["en"])
            self.assertEqual(rows, [])
            self.assertEqual(providers["opensubtitles"]["status"], "not_configured")
            self.assertEqual(providers["subdl"]["status"], "not_configured")
            self.assertFalse(providers["opensubtitles"]["configured"])
            self.assertFalse(providers["subdl"]["configured"])
            open_search.assert_not_awaited()
            subdl_search.assert_not_awaited()
        finally:
            settings.OPENSUBTITLES_API_KEY = old_open
            settings.SUBDL_API_KEY = old_subdl

    async def test_health_treats_missing_optional_providers_as_normal_state(self):
        old_open = settings.OPENSUBTITLES_API_KEY
        old_subdl = settings.SUBDL_API_KEY
        settings.OPENSUBTITLES_API_KEY = ""
        settings.SUBDL_API_KEY = ""
        try:
            status = await SubtitleService.health_check()
            for name in ("opensubtitles", "subdl"):
                self.assertEqual(status[name]["status"], "not_configured")
                self.assertFalse(status[name]["configured"])
                self.assertFalse(status[name]["connected"])
                self.assertFalse(status[name]["authenticated"])
                self.assertIsNone(status[name].get("error"))
        finally:
            settings.OPENSUBTITLES_API_KEY = old_open
            settings.SUBDL_API_KEY = old_subdl


if __name__ == "__main__":
    unittest.main()
