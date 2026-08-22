import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import secure_config


def key(byte: int) -> str:
    return base64.b64encode(bytes([byte]) * 32).decode()


def valid_config(extra_interface: str = "", extra_peer: str = "") -> str:
    return f"""[Interface]\nPrivateKey = {key(1)}\nAddress = 10.1.2.3/32\nDNS = 10.64.0.1\n{extra_interface}[Peer]\nPublicKey = {key(2)}\nEndpoint = 198.51.100.10:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n{extra_peer}"""


class SecureConfigTests(unittest.TestCase):
    def test_valid_provider_config_canonicalizes(self):
        parsed = secure_config.parse_wireguard(valid_config(), allow_netwatch_hooks=False)
        rendered = secure_config.render_wireguard(parsed).decode()
        self.assertIn("AllowedIPs = 0.0.0.0/0", rendered)
        self.assertIn("PostUp = " + secure_config.NETWATCH_POST_UP, rendered)
        self.assertIn("Endpoint = 198.51.100.10:51820", rendered)


    def test_rejects_hostname_endpoint(self):
        text = valid_config().replace("Endpoint = 198.51.100.10:51820", "Endpoint = vpn.example.invalid:51820")
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_ENDPOINT_HOSTNAME_UNSUPPORTED")

    def test_exact_legacy_netwatch_hooks_are_accepted_for_migration(self):
        extra = (
            f"PostUp = {secure_config.NETWATCH_POST_UP}\n"
            f"PreDown = {secure_config.NETWATCH_PRE_DOWN}\n"
        )
        parsed = secure_config.parse_wireguard(valid_config(extra), allow_netwatch_hooks=True)
        rendered = secure_config.render_wireguard(parsed).decode("utf-8")
        self.assertIn("PostUp = " + secure_config.NETWATCH_POST_UP, rendered)
        self.assertIn("PreDown = " + secure_config.NETWATCH_PRE_DOWN, rendered)

    def test_modified_legacy_hook_is_still_rejected(self):
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(
                valid_config(f"PostUp = {secure_config.NETWATCH_POST_UP}; echo nope\n"),
                allow_netwatch_hooks=True,
            )
        self.assertEqual(ctx.exception.code, "WG_EXECUTABLE_DIRECTIVE")

    def test_rejects_provider_command_directive(self):
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(valid_config("PostUp = touch /tmp/pwned\n"), allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_EXECUTABLE_DIRECTIVE")

    def test_drops_optional_ipv6_entries_but_requires_ipv4(self):
        text = valid_config().replace("Address = 10.1.2.3/32", "Address = 10.1.2.3/32, fd00::1/128")
        text = text.replace("DNS = 10.64.0.1", "DNS = 10.64.0.1, fd00::53")
        text = text.replace("AllowedIPs = 0.0.0.0/0", "AllowedIPs = 0.0.0.0/0, ::/0")
        parsed = secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
        self.assertEqual(parsed["addresses"], ["10.1.2.3/32"])
        self.assertEqual(parsed["dns"], ["10.64.0.1"])

        text = valid_config().replace("Address = 10.1.2.3/32", "Address = fd00::1/128")
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_ADDRESS_INVALID")

    def test_rejects_non_full_tunnel(self):
        text = valid_config().replace("AllowedIPs = 0.0.0.0/0", "AllowedIPs = 10.0.0.0/8")
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_FULL_TUNNEL_REQUIRED")

    def test_bootstrap_repairs_sensitive_modes(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            state = secure_config.inspect_state(base)
            env = base / "config" / "backend.env"
            self.assertTrue(env.exists())
            self.assertEqual(oct(env.stat().st_mode & 0o777), "0o600")
            os.chmod(env, 0o644)
            state = secure_config.inspect_state(base)
            self.assertEqual(state["permissions"]["modes"]["backend_env"], "600")

    def test_env_secret_rejects_newline(self):
        with self.assertRaises(secure_config.ConfigError):
            secure_config.validate_secret("tmdb", "abc\ndefghijk")

    def test_rejects_all_command_directives(self):
        for directive in ("PreUp", "PostUp", "PreDown", "PostDown"):
            with self.subTest(directive=directive):
                text = valid_config(f"{directive} = echo unsafe\n")
                with self.assertRaises(secure_config.ConfigError) as ctx:
                    secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
                self.assertEqual(ctx.exception.code, "WG_EXECUTABLE_DIRECTIVE")

    def test_rejects_duplicate_fields(self):
        text = valid_config("DNS = 1.1.1.1\n")
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(text, allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_DUPLICATE_FIELD")

    def test_secret_validation_rejects_env_metacharacters(self):
        for value in ("abcdefgh\nSECOND=owned", "abcdefgh\x00tail", "abc defgh"):
            with self.subTest(value=repr(value)):
                with self.assertRaises(secure_config.ConfigError):
                    secure_config.validate_secret("api", value)

    def test_env_update_preserves_unmanaged_settings(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "backend.env"
            path.write_text("X1337_ENABLED=false\nTMDB_API_KEY=\n", encoding="utf-8")
            secure_config.update_env_keys(path, {"TMDB_API_KEY": "abcdefgh12345678"})
            text = path.read_text("utf-8")
            self.assertIn("X1337_ENABLED=false", text)
            self.assertIn("TMDB_API_KEY=abcdefgh12345678", text)
            self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")

    def test_atomic_write_preserves_existing_file_if_replace_fails(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "secret.env"
            path.write_bytes(b"original\n")
            os.chmod(path, 0o600)
            with mock.patch.object(secure_config.os, "replace", side_effect=OSError("simulated")):
                with self.assertRaises(OSError):
                    secure_config.atomic_write(path, b"replacement\n", 0o600)
            self.assertEqual(path.read_bytes(), b"original\n")
            self.assertFalse(any(item.name.startswith(".secret.env.") for item in path.parent.iterdir()))

    def test_rejects_symlink_for_managed_secret_file(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks unavailable")
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            config = base / "config"
            config.mkdir(parents=True)
            target = Path(root) / "unrelated"
            target.write_text("do-not-touch", encoding="utf-8")
            (config / "backend.env").symlink_to(target)
            with self.assertRaises(secure_config.ConfigError) as ctx:
                secure_config.inspect_state(base)
            self.assertEqual(ctx.exception.code, "PRIVATE_PATH_UNSAFE")
            self.assertEqual(target.read_text(encoding="utf-8"), "do-not-touch")

    def test_existing_invalid_managed_secret_is_not_considered_configured(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            secure_config.inspect_state(base)
            env = base / "config" / "backend.env"
            env.write_text("TMDB_API_KEY=bad value\nOPENSUBTITLES_API_KEY=abcdefgh\nSUBDL_API_KEY=abcdefgh\nPROWLARR_API_KEY=abcdefghijklmnop\n", encoding="utf-8")
            state = secure_config.inspect_state(base)
            self.assertFalse(state["env"]["parse_ok"])
            self.assertFalse(state["env"]["configured"]["tmdb"])

    def test_setup_log_mode_is_repaired(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            secure_config.log_event(base, "SETUP_STARTED")
            log_path = base / "data" / "setup.log"
            os.chmod(log_path, 0o644)
            state = secure_config.inspect_state(base)
            self.assertEqual(state["permissions"]["modes"]["setup_log"], "600")
            self.assertTrue(state["permissions"]["files_secure"])

    def test_unsupported_wireguard_field_error_does_not_echo_input(self):
        marker = "SECRET_FIELD_NAME"
        with self.assertRaises(secure_config.ConfigError) as ctx:
            secure_config.parse_wireguard(valid_config(f"{marker} = hidden\n"), allow_netwatch_hooks=False)
        self.assertEqual(ctx.exception.code, "WG_FIELD_UNSUPPORTED")
        self.assertNotIn(marker, ctx.exception.message)

    def test_pending_api_recovery_state_prevents_completion(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            secure_config.inspect_state(base)
            env = base / "config" / "backend.env"
            env.write_text(
                "TMDB_API_KEY=abcdefgh\n"
                "OPENSUBTITLES_API_KEY=abcdefgh\n"
                "SUBDL_API_KEY=abcdefgh\n"
                "PROWLARR_API_KEY=abcdefghijklmnop\n",
                encoding="utf-8",
            )
            os.chmod(env, 0o600)
            pending = base / "data" / ".setup-api-pending"
            secure_config.atomic_write(pending, b'["tmdb","opensubtitles","subdl"]', 0o600)
            state = secure_config.inspect_state(base)
            self.assertTrue(state["pending"]["api"])
            self.assertEqual(state["pending"]["api_names"], ["opensubtitles", "subdl", "tmdb"])
            self.assertFalse(state["complete"])
            self.assertEqual(state["permissions"]["modes"]["pending_api"], "600")

    def test_pending_prowlarr_recovery_state_prevents_completion(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            state = secure_config.inspect_state(base)
            pending = base / "data" / ".setup-prowlarr-pending"
            secure_config.atomic_write(pending, b"pending\n", 0o600)
            state = secure_config.inspect_state(base)
            self.assertTrue(state["pending"]["prowlarr"])
            self.assertFalse(state["complete"])
            self.assertEqual(state["permissions"]["modes"]["pending_prowlarr"], "600")

    def test_wireguard_input_limit_is_8_kib(self):
        self.assertEqual(secure_config.MAX_WG_BYTES, 8 * 1024)
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            state = secure_config.inspect_state(base)
            wg_path = base / "config" / "wireguard" / "wg_confs" / "wg0.conf"
            oversized = valid_config().encode("utf-8") + b"#" * (secure_config.MAX_WG_BYTES + 1)
            wg_path.write_bytes(oversized)
            os.chmod(wg_path, 0o600)
            state = secure_config.inspect_state(base)
            self.assertFalse(state["wg"]["valid"])
            self.assertEqual(state["wg"]["error"], "WG_TOO_LARGE")

    def test_invalid_pending_state_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / "netwatch"
            secure_config.inspect_state(base)
            pending = base / "data" / ".setup-api-pending"
            secure_config.atomic_write(pending, b'["tmdb","unexpected"]', 0o600)
            with self.assertRaises(secure_config.ConfigError) as ctx:
                secure_config.inspect_state(base)
            self.assertEqual(ctx.exception.code, "PENDING_STATE_INVALID")


if __name__ == "__main__":
    unittest.main()
