import unittest
from unittest.mock import AsyncMock, patch

from services.x1337 import X1337Service


SEARCH_HTML = """
<table>
  <tr>
    <td class="coll-1 name">
      <a href="/sub/42/0/">Movies HD</a>
      <a href="/torrent/12345/Interstellar-2014-1080p-BluRay-x264-GROUP/">Interstellar 2014 1080p BluRay x264-GROUP</a>
    </td>
    <td class="coll-2 seeds">1,234</td>
    <td class="coll-3 leeches">56</td>
    <td class="coll-date">7:31pm</td>
    <td class="coll-4 size">2.50 GB</td>
    <td class="coll-5 uploader">ExampleUploader</td>
  </tr>
  <tr>
    <td class="coll-1 name">
      <a href="/sub/18/0/">Apps</a>
      <a href="/torrent/99999/Interstellar-Fake-App/">Interstellar Fake App</a>
    </td>
    <td class="coll-2 seeds">999</td>
    <td class="coll-3 leeches">1</td>
    <td class="coll-4 size">50 MB</td>
  </tr>
</table>
"""

DETAIL_HTML = """
<html><body><ul><li><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Interstellar">Magnet</a></li></ul></body></html>
"""


class X1337ParserTests(unittest.IsolatedAsyncioTestCase):
    def test_search_parser_normalizes_media_row(self):
        results = X1337Service._parse_search_results(
            SEARCH_HTML,
            base_index=0,
            resolution_filter=None,
            min_seeders=1,
            max_results=20,
        )
        self.assertEqual(len(results), 1)
        row = results[0]
        self.assertEqual(row["indexer"], "1337x")
        self.assertEqual(row["resolution"], "1080p")
        self.assertEqual(row["seeders"], 1234)
        self.assertEqual(row["leechers"], 56)
        self.assertEqual(row["size"], int(2.5 * 1024**3))
        self.assertEqual(row["source_type"], "1337x_detail")
        self.assertTrue(row["source_url"].startswith("nw1337x:0:/torrent/"))

    def test_source_reference_rejects_external_url(self):
        with self.assertRaises(ValueError):
            X1337Service._parse_source_ref("nw1337x:0:https%3A//example.com/torrent/1/x/")

    async def test_detail_resolution_extracts_magnet(self):
        source = X1337Service._source_ref(0, "/torrent/12345/Interstellar-2014/")
        with patch(
            "services.x1337.FlareSolverrService.get_html",
            new=AsyncMock(return_value=DETAIL_HTML),
        ):
            resolved = await X1337Service.resolve_torrent_source(source)
        self.assertEqual(resolved["source_type"], "magnet")
        self.assertTrue(resolved["magnet"].startswith("magnet:?xt=urn:btih:"))


if __name__ == "__main__":
    unittest.main()
