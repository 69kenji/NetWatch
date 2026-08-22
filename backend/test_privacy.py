import unittest
from unittest.mock import AsyncMock, patch

from services.privacy import PrivacyService


class PrivacyTests(unittest.IsolatedAsyncioTestCase):
    def test_trace_ip_parser(self):
        body = "fl=123\nip=185.1.2.3\ncolo=FRA\n"
        self.assertEqual(PrivacyService._trace_ip(body), "185.1.2.3")

    async def test_dns_failure_does_not_hide_verified_egress(self):
        with patch.object(PrivacyService, "_interfaces", return_value=["lo", "wg0"]), \
             patch.object(PrivacyService, "_public_ip_without_dns", new=AsyncMock(return_value=("185.1.2.3", "https://1.1.1.1/cdn-cgi/trace"))), \
             patch.object(PrivacyService, "_dns_probe", new=AsyncMock(return_value=(False, [], "temporary failure"))):
            payload = await PrivacyService.vpn_sanity()
        self.assertEqual(payload["status"], "degraded")
        self.assertTrue(payload["connected"])
        self.assertEqual(payload["public_ip"], "185.1.2.3")
        self.assertFalse(payload["dns_ok"])


if __name__ == "__main__":
    unittest.main()
