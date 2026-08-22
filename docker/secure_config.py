#!/usr/bin/env python3
from __future__ import annotations

import base64
import ipaddress
import json
import os
import re
import stat
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Secret material created by this helper must never inherit a permissive caller
# umask. Individual writes still set and verify exact modes explicitly.
os.umask(0o077)

MAX_WG_BYTES = 8 * 1024
MAX_SECRET_INPUT_BYTES = 16 * 1024
MAX_VPN_PROFILE_BYTES = 4 * 1024
VPN_PROFILE_TYPES = {"generic", "vpnbook"}
VPNBOOK_CONFIG_LIFETIME = timedelta(days=7)
API_KEYS = {
    "tmdb": "TMDB_API_KEY",
    "opensubtitles": "OPENSUBTITLES_API_KEY",
    "subdl": "SUBDL_API_KEY",
    "prowlarr": "PROWLARR_API_KEY",
}
SETUP_EVENTS = {
    "SETUP_STARTED",
    "WG_IMPORT_STARTED",
    "WG_CONFIG_VALIDATED",
    "CONFIG_PERMISSIONS_VERIFIED",
    "VPN_START_REQUESTED",
    "VPN_VERIFIED",
    "API_CREDENTIALS_SAVED",
    "API_CREDENTIALS_VALIDATED",
    "PROWLARR_READY",
    "PROWLARR_CONFIGURED",
    "SETUP_COMPLETE",
}

NETWATCH_POST_UP = (
    "DOCKER_NET=$(ip -o -4 addr show dev eth0 | awk '{print $4}'); "
    "iptables -I OUTPUT 1 -d \"$DOCKER_NET\" -j ACCEPT; "
    "iptables -I OUTPUT 2 ! -o %i -m mark ! --mark $(wg show %i fwmark) "
    "-m addrtype ! --dst-type LOCAL -j REJECT"
)
NETWATCH_PRE_DOWN = (
    "DOCKER_NET=$(ip -o -4 addr show dev eth0 | awk '{print $4}'); "
    "iptables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) "
    "-m addrtype ! --dst-type LOCAL -j REJECT; "
    "iptables -D OUTPUT -d \"$DOCKER_NET\" -j ACCEPT"
)

class ConfigError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def reject_symlink(path: Path, *, kind: str = "private path") -> None:
    # Never follow a user-controlled symlink for a NetWatch-managed secret or
    # private directory. This prevents a substituted config path from causing
    # chmod/read/write operations against an unrelated target.
    if path.is_symlink():
        raise ConfigError("PRIVATE_PATH_UNSAFE", f"NetWatch refused an unsafe {kind}.")


def fail(code: str, message: str, exit_code: int = 1) -> None:
    print(json.dumps({"ok": False, "code": code, "message": message}, separators=(",", ":")))
    raise SystemExit(exit_code)


def safe_mode(path: Path) -> str | None:
    try:
        return oct(stat.S_IMODE(path.stat().st_mode))[2:]
    except OSError:
        return None


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    reject_symlink(path, kind="private file")
    reject_symlink(path.parent, kind="private directory")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    reject_symlink(path.parent, kind="private directory")
    fd = None
    tmp_name = None
    try:
        fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb", closefd=True) as handle:
            fd = None
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
        os.chmod(path, mode)
        dir_fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if fd is not None:
            os.close(fd)
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass


def ensure_dirs(base: Path) -> dict[str, Path]:
    paths = {
        "base": base,
        "config": base / "config",
        "wireguard": base / "config" / "wireguard",
        "wg_confs": base / "config" / "wireguard" / "wg_confs",
        "data": base / "data",
        "prowlarr": base / "data" / "prowlarr",
        "backend_cache": base / "data" / "backend-cache",
    }
    for key, path in paths.items():
        reject_symlink(path, kind="private directory")
        path.mkdir(parents=True, exist_ok=True)
        reject_symlink(path, kind="private directory")
        if not path.is_dir():
            raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch private configuration path is not a directory.")
        # The entire NetWatch private tree is user-private. Docker can still bind
        # mount these paths through its privileged daemon.
        os.chmod(path, 0o700)
    return paths


def ensure_backend_env(path: Path) -> None:
    reject_symlink(path, kind="private file")
    if path.exists():
        if not path.is_file():
            raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch private environment path is not a regular file.")
        os.chmod(path, 0o600)
        return
    initial = (
        "# NetWatch private provider credentials. Managed by the secure first-run wizard.\n"
        "TMDB_API_KEY=\n"
        "OPENSUBTITLES_API_KEY=\n"
        "SUBDL_API_KEY=\n"
        "PROWLARR_API_KEY=\n"
    ).encode("utf-8")
    atomic_write(path, initial, 0o600)


def parse_env(path: Path) -> tuple[dict[str, str], bool]:
    values: dict[str, str] = {}
    if not path.exists():
        return values, True
    try:
        text = path.read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return values, False
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in raw:
            return values, False
        key, value = raw.split("=", 1)
        key = key.strip()
        if key in API_KEYS.values():
            if key in seen:
                return values, False
            seen.add(key)
            values[key] = value.strip()
    return values, True


def configured_secret(value: str | None) -> bool:
    value = (value or "").strip()
    return bool(value and not value.lower().startswith("your_"))


def parse_optional_utc_timestamp(value: object) -> datetime | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile timestamp is invalid.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile timestamp is invalid.") from exc
    if parsed.tzinfo is None:
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile timestamp must include a timezone.")
    return parsed.astimezone(timezone.utc)


def normalize_vpn_profile_payload(payload: object, *, now: datetime | None = None) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile metadata is invalid.")
    allowed = {"profile_type", "imported_at", "source_created_at", "source_modified_at"}
    if any(key not in allowed for key in payload):
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile metadata contains an unsupported field.")
    profile_type = payload.get("profile_type", "generic")
    if profile_type not in VPN_PROFILE_TYPES:
        raise ConfigError("VPN_PROFILE_INVALID", "VPN profile type is invalid.")
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    imported = parse_optional_utc_timestamp(payload.get("imported_at"))
    created = parse_optional_utc_timestamp(payload.get("source_created_at"))
    modified = parse_optional_utc_timestamp(payload.get("source_modified_at"))
    # File metadata is only an estimate. Ignore timestamps implausibly far in the future
    # rather than letting a bad filesystem clock create a misleading long-lived profile.
    future_limit = now + timedelta(minutes=5)
    if created and created > future_limit:
        created = None
    if modified and modified > future_limit:
        modified = None
    return {
        "profile_type": profile_type,
        "imported_at": imported.isoformat() if imported else None,
        "source_created_at": created.isoformat() if created else None,
        "source_modified_at": modified.isoformat() if modified else None,
    }


def vpn_profile_view(profile: dict[str, object] | None) -> dict[str, object]:
    if not profile:
        return {
            "profile_type": "generic",
            "imported_at": None,
            "source_created_at": None,
            "source_modified_at": None,
            "estimated_created_at": None,
            "estimated_expires_at": None,
            "expiry_basis": None,
        }
    normalized = normalize_vpn_profile_payload(profile)
    imported = parse_optional_utc_timestamp(normalized.get("imported_at"))
    created = parse_optional_utc_timestamp(normalized.get("source_created_at"))
    modified = parse_optional_utc_timestamp(normalized.get("source_modified_at"))
    candidates = [item for item in (created, modified, imported) if item is not None]
    estimated_created = min(candidates) if candidates else None
    estimated_expires = None
    expiry_basis = None
    if normalized["profile_type"] == "vpnbook" and estimated_created is not None:
        estimated_expires = estimated_created + VPNBOOK_CONFIG_LIFETIME
        if estimated_created == created:
            expiry_basis = "file_creation_time"
        elif estimated_created == modified:
            expiry_basis = "file_modification_time"
        else:
            expiry_basis = "import_time"
    return {
        **normalized,
        "estimated_created_at": estimated_created.isoformat() if estimated_created else None,
        "estimated_expires_at": estimated_expires.isoformat() if estimated_expires else None,
        "expiry_basis": expiry_basis,
    }


def read_vpn_profile(path: Path) -> dict[str, object] | None:
    if not path.exists():
        return None
    reject_symlink(path, kind="private VPN profile metadata file")
    if not path.is_file() or path.stat().st_size > MAX_VPN_PROFILE_BYTES:
        return None
    os.chmod(path, 0o600)
    try:
        payload = json.loads(path.read_text("utf-8"))
        return normalize_vpn_profile_payload(payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ConfigError):
        return None


def write_vpn_profile(path: Path, profile: dict[str, object]) -> None:
    normalized = normalize_vpn_profile_payload(profile)
    atomic_write(path, (json.dumps(normalized, separators=(",", ":")) + "\n").encode("utf-8"), 0o600)


def update_env_keys(path: Path, updates: dict[str, str]) -> None:
    existing = path.read_text("utf-8") if path.exists() else ""
    lines = existing.splitlines()
    targets = set(updates)
    seen: set[str] = set()
    output: list[str] = []
    for raw in lines:
        if "=" not in raw or raw.lstrip().startswith("#"):
            output.append(raw)
            continue
        key, _ = raw.split("=", 1)
        normalized = key.strip()
        if normalized in targets:
            if normalized in seen:
                raise ConfigError("ENV_DUPLICATE_KEY", "The private environment file contains duplicate managed keys.")
            seen.add(normalized)
            output.append(f"{normalized}={updates[normalized]}")
        else:
            output.append(raw)
    for key in targets:
        if key not in seen:
            output.append(f"{key}={updates[key]}")
    atomic_write(path, ("\n".join(output).rstrip() + "\n").encode("utf-8"), 0o600)


def validate_secret(label: str, value: object, *, minimum: int = 8, maximum: int = 256) -> str:
    if not isinstance(value, str):
        raise ConfigError("SECRET_INVALID", f"{label} must be text.")
    if any(ch in value for ch in ("\n", "\r", "\x00")):
        raise ConfigError("SECRET_INVALID", f"{label} contains unsupported control characters.")
    cleaned = value.strip()
    if len(cleaned) < minimum or len(cleaned) > maximum:
        raise ConfigError("SECRET_INVALID", f"{label} has an unexpected length.")
    if not re.fullmatch(r"[A-Za-z0-9._~+/=:@%-]+", cleaned):
        raise ConfigError("SECRET_INVALID", f"{label} contains unsupported characters.")
    return cleaned


def existing_secret_is_valid(name: str, value: str | None) -> bool:
    if not configured_secret(value):
        return False
    try:
        minimum = 16 if name == "prowlarr" else 8
        validate_secret(name, value, minimum=minimum, maximum=256)
        return True
    except ConfigError:
        return False


def validate_wg_key(value: str, label: str) -> str:
    value = value.strip()
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise ConfigError("WG_KEY_INVALID", f"{label} is not a valid WireGuard key.") from exc
    if len(decoded) != 32:
        raise ConfigError("WG_KEY_INVALID", f"{label} is not a valid WireGuard key.")
    return value


def parse_list(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def validate_endpoint(value: str) -> str:
    value = value.strip()
    if not value or any(ch.isspace() for ch in value):
        raise ConfigError("WG_ENDPOINT_INVALID", "The WireGuard endpoint is invalid.")
    # NetWatch 1.0 intentionally supports IPv4 transport only. Bracketed IPv6
    # endpoints are therefore rejected rather than silently changing semantics.
    if value.startswith("["):
        raise ConfigError("WG_IPV6_UNSUPPORTED", "NetWatch 1.0 supports IPv4 WireGuard configurations only.")
    host, sep, port_text = value.rpartition(":")
    if not sep or not host or not port_text.isdigit():
        raise ConfigError("WG_ENDPOINT_INVALID", "The WireGuard endpoint must include a host and UDP port.")
    port = int(port_text)
    if port < 1 or port > 65535:
        raise ConfigError("WG_ENDPOINT_INVALID", "The WireGuard endpoint port is invalid.")
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError as exc:
        # NetWatch 1.0 requires a literal IPv4 relay endpoint. Resolving a
        # provider hostname before wg0 exists would introduce bootstrap DNS
        # outside the authoritative inner tunnel and weaken the DNS invariant.
        raise ConfigError(
            "WG_ENDPOINT_HOSTNAME_UNSUPPORTED",
            "NetWatch 1.0 requires a literal IPv4 WireGuard endpoint.",
        ) from exc
    if parsed.version != 4:
        raise ConfigError("WG_IPV6_UNSUPPORTED", "NetWatch 1.0 supports IPv4 WireGuard configurations only.")
    return f"{parsed}:{port}"


def parse_wireguard(text: str, *, allow_netwatch_hooks: bool) -> dict[str, object]:
    section: str | None = None
    interface: dict[str, str] = {}
    peers: list[dict[str, str]] = []
    current_peer: dict[str, str] | None = None

    allowed_interface = {"privatekey", "address", "dns", "mtu"}
    allowed_peer = {"publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive"}
    hooks = {"postup": NETWATCH_POST_UP, "predown": NETWATCH_PRE_DOWN}

    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            name = line[1:-1].strip().lower()
            if name == "interface":
                if section is not None:
                    raise ConfigError("WG_SECTION_INVALID", "WireGuard configuration must contain one Interface section followed by one Peer section.")
                section = "interface"
            elif name == "peer":
                if section not in {"interface", "peer"}:
                    raise ConfigError("WG_SECTION_INVALID", "WireGuard configuration contains an invalid section order.")
                section = "peer"
                current_peer = {}
                peers.append(current_peer)
            else:
                raise ConfigError("WG_SECTION_INVALID", "WireGuard configuration contains an unsupported section.")
            continue
        if section is None or "=" not in line:
            raise ConfigError("WG_SYNTAX_INVALID", "WireGuard configuration syntax is invalid.")
        key, value = [part.strip() for part in line.split("=", 1)]
        key_l = key.lower()
        if not value:
            raise ConfigError("WG_SYNTAX_INVALID", "WireGuard configuration contains an empty value.")
        target = interface if section == "interface" else current_peer
        if target is None:
            raise ConfigError("WG_SYNTAX_INVALID", "WireGuard configuration syntax is invalid.")
        if key_l in {"preup", "postup", "predown", "postdown"}:
            if allow_netwatch_hooks and key_l in hooks and value == hooks[key_l]:
                target[key_l] = value
                continue
            raise ConfigError("WG_EXECUTABLE_DIRECTIVE", "Provider WireGuard command directives are not accepted by NetWatch.")
        allowed = allowed_interface if section == "interface" else allowed_peer
        if key_l not in allowed:
            raise ConfigError("WG_FIELD_UNSUPPORTED", "WireGuard configuration contains an unsupported field.")
        if key_l in target:
            raise ConfigError("WG_DUPLICATE_FIELD", "WireGuard configuration contains a duplicate field.")
        target[key_l] = value

    if not interface or len(peers) != 1:
        raise ConfigError("WG_STRUCTURE_INVALID", "WireGuard configuration must contain exactly one Interface and one Peer.")
    peer = peers[0]
    for required in ("privatekey", "address", "dns"):
        if required not in interface:
            raise ConfigError("WG_REQUIRED_FIELD", f"WireGuard Interface is missing {required}.")
    for required in ("publickey", "endpoint", "allowedips"):
        if required not in peer:
            raise ConfigError("WG_REQUIRED_FIELD", f"WireGuard Peer is missing {required}.")

    private_key = validate_wg_key(interface["privatekey"], "PrivateKey")
    public_key = validate_wg_key(peer["publickey"], "PublicKey")
    preshared_key = None
    if "presharedkey" in peer:
        preshared_key = validate_wg_key(peer["presharedkey"], "PresharedKey")

    addresses: list[str] = []
    for item in parse_list(interface["address"]):
        try:
            parsed = ipaddress.ip_interface(item)
        except ValueError as exc:
            raise ConfigError("WG_ADDRESS_INVALID", "WireGuard Address contains an invalid CIDR.") from exc
        if parsed.version == 4:
            addresses.append(str(parsed))
    if not addresses:
        raise ConfigError("WG_ADDRESS_INVALID", "WireGuard Address must include an IPv4 CIDR.")

    dns: list[str] = []
    for item in parse_list(interface["dns"]):
        try:
            parsed = ipaddress.ip_address(item)
        except ValueError as exc:
            raise ConfigError("WG_DNS_INVALID", "WireGuard DNS must contain literal IPv4 resolver addresses.") from exc
        if parsed.version == 4:
            dns.append(str(parsed))
    if not dns:
        raise ConfigError("WG_DNS_INVALID", "WireGuard DNS must include at least one IPv4 resolver.")
    dns = dns[:3]

    allowed_ips: list[str] = []
    for item in parse_list(peer["allowedips"]):
        try:
            parsed = ipaddress.ip_network(item, strict=False)
        except ValueError as exc:
            raise ConfigError("WG_ALLOWED_IPS_INVALID", "WireGuard AllowedIPs contains an invalid CIDR.") from exc
        if parsed.version == 4:
            allowed_ips.append(str(parsed))
    if "0.0.0.0/0" not in allowed_ips:
        raise ConfigError("WG_FULL_TUNNEL_REQUIRED", "NetWatch requires WireGuard AllowedIPs to include 0.0.0.0/0.")

    endpoint = validate_endpoint(peer["endpoint"])
    mtu = None
    if "mtu" in interface:
        if not interface["mtu"].isdigit() or not 576 <= int(interface["mtu"]) <= 9000:
            raise ConfigError("WG_MTU_INVALID", "WireGuard MTU is invalid.")
        mtu = int(interface["mtu"])
    keepalive = None
    if "persistentkeepalive" in peer:
        if not peer["persistentkeepalive"].isdigit() or not 0 <= int(peer["persistentkeepalive"]) <= 65535:
            raise ConfigError("WG_KEEPALIVE_INVALID", "WireGuard PersistentKeepalive is invalid.")
        keepalive = int(peer["persistentkeepalive"])

    return {
        "private_key": private_key,
        "addresses": addresses,
        "dns": dns,
        "mtu": mtu,
        "public_key": public_key,
        "preshared_key": preshared_key,
        "endpoint": endpoint,
        "keepalive": keepalive,
    }


def render_wireguard(config: dict[str, object]) -> bytes:
    lines = [
        "# Generated by NetWatch from a validated provider WireGuard configuration.",
        "# Provider command directives are never copied into this file.",
        "",
        "[Interface]",
        f"PrivateKey = {config['private_key']}",
        f"Address = {', '.join(config['addresses'])}",
        f"DNS = {', '.join(config['dns'])}",
    ]
    if config.get("mtu") is not None:
        lines.append(f"MTU = {config['mtu']}")
    lines.extend([
        f"PostUp = {NETWATCH_POST_UP}",
        f"PreDown = {NETWATCH_PRE_DOWN}",
        "",
        "[Peer]",
        f"PublicKey = {config['public_key']}",
    ])
    if config.get("preshared_key"):
        lines.append(f"PresharedKey = {config['preshared_key']}")
    lines.extend([
        f"Endpoint = {config['endpoint']}",
        "AllowedIPs = 0.0.0.0/0",
    ])
    if config.get("keepalive") is not None:
        lines.append(f"PersistentKeepalive = {config['keepalive']}")
    return ("\n".join(lines).rstrip() + "\n").encode("utf-8")


def render_resolv(dns: list[str]) -> bytes:
    lines = [
        "# Generated by NetWatch from the validated WireGuard DNS configuration.",
        "# NetWatch clients mount this file so DNS follows the same wg0 fail-closed path.",
    ]
    lines.extend(f"nameserver {server}" for server in dns)
    lines.append("options timeout:2 attempts:2")
    return ("\n".join(lines) + "\n").encode("utf-8")


def remove_private_file(path: Path) -> None:
    reject_symlink(path, kind="private setup state file")
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def pending_wireguard_paths(paths: dict[str, Path]) -> dict[str, Path]:
    return {
        "wg": paths["wg_confs"] / "wg0.pending.conf",
        "profile": paths["data"] / "vpn-profile.pending.json",
        "marker": paths["data"] / ".setup-vpn-pending",
    }


def promote_pending_wireguard(base: Path) -> None:
    paths = ensure_dirs(base)
    pending = pending_wireguard_paths(paths)
    if not pending["wg"].exists():
        # A profile sidecar without a staged config is never authoritative.
        remove_private_file(pending["profile"])
        return
    reject_symlink(pending["wg"], kind="pending WireGuard file")
    if not pending["wg"].is_file() or pending["wg"].stat().st_size > MAX_WG_BYTES:
        raise ConfigError("WG_SOURCE_INVALID", "Pending WireGuard configuration is invalid.")
    raw = pending["wg"].read_bytes()
    try:
        parsed = parse_wireguard(raw.decode("utf-8"), allow_netwatch_hooks=True)
    except (UnicodeDecodeError, ConfigError) as exc:
        raise ConfigError("WG_SOURCE_INVALID", "Pending WireGuard configuration is invalid.") from exc
    staged_profile = read_vpn_profile(pending["profile"]) or {
        "profile_type": "generic",
        "imported_at": None,
        "source_created_at": None,
        "source_modified_at": None,
    }
    atomic_write(paths["wg_confs"] / "wg0.conf", render_wireguard(parsed), 0o600)
    atomic_write(paths["config"] / "resolv.conf", render_resolv(list(parsed["dns"])), 0o600)
    write_vpn_profile(paths["data"] / "vpn-profile.json", staged_profile)
    # Keep this marker until the promoted tunnel passes the normal live VPN gate.
    atomic_write(pending["marker"], b"pending\n", 0o600)
    remove_private_file(pending["wg"])
    remove_private_file(pending["profile"])


def read_pending_api(path: Path) -> list[str]:
    if not path.exists():
        return []
    reject_symlink(path, kind="private setup state file")
    if not path.is_file() or path.stat().st_size > 1024:
        raise ConfigError("PENDING_STATE_INVALID", "NetWatch setup recovery state is invalid.")
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigError("PENDING_STATE_INVALID", "NetWatch setup recovery state is invalid.") from exc
    if (
        not isinstance(payload, list) or not payload or
        any(not isinstance(name, str) or name not in {"tmdb", "opensubtitles", "subdl"} for name in payload) or
        len(set(payload)) != len(payload)
    ):
        raise ConfigError("PENDING_STATE_INVALID", "NetWatch setup recovery state is invalid.")
    return sorted(payload)


def inspect_state(base: Path) -> dict[str, object]:
    paths = ensure_dirs(base)
    backend_env = paths["config"] / "backend.env"
    wg_path = paths["wg_confs"] / "wg0.conf"
    resolv_path = paths["config"] / "resolv.conf"
    setup_log = paths["data"] / "setup.log"
    pending_api_path = paths["data"] / ".setup-api-pending"
    pending_prowlarr_path = paths["data"] / ".setup-prowlarr-pending"
    vpn_profile_path = paths["data"] / "vpn-profile.json"
    vpn_pending_path = paths["data"] / ".setup-vpn-pending"
    staged_paths = pending_wireguard_paths(paths)
    ensure_backend_env(backend_env)
    os.chmod(backend_env, 0o600)

    env_values, env_parse_ok = parse_env(backend_env)
    configured = {
        name: existing_secret_is_valid(name, env_values.get(env_key))
        for name, env_key in API_KEYS.items()
    }
    # A non-empty managed value that fails the same strict validation used for
    # newly entered secrets is malformed existing state. Do not silently treat
    # it as configured or overwrite it.
    for name, env_key in API_KEYS.items():
        value = env_values.get(env_key)
        if configured_secret(value) and not configured[name]:
            env_parse_ok = False

    wg_exists = wg_path.exists()
    wg_valid = False
    wg_error = None
    dns_count = 0
    if wg_exists:
        try:
            reject_symlink(wg_path, kind="private WireGuard file")
            if not wg_path.is_file():
                raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch WireGuard path is not a regular file.")
            os.chmod(wg_path, 0o600)
            raw = wg_path.read_bytes()
            if len(raw) > MAX_WG_BYTES:
                raise ConfigError("WG_TOO_LARGE", "WireGuard configuration exceeds the NetWatch size limit.")
            parsed = parse_wireguard(raw.decode("utf-8"), allow_netwatch_hooks=True)
            wg_valid = True
            dns = list(parsed["dns"])
            dns_count = len(dns)
            atomic_write(resolv_path, render_resolv(dns), 0o600)
        except (OSError, UnicodeDecodeError, ConfigError) as exc:
            wg_error = exc.code if isinstance(exc, ConfigError) else "WG_READ_FAILED"
    if resolv_path.exists():
        reject_symlink(resolv_path, kind="private resolver file")
        if not resolv_path.is_file():
            raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch resolver path is not a regular file.")
        os.chmod(resolv_path, 0o600)
    if setup_log.exists():
        reject_symlink(setup_log, kind="private setup log")
        if not setup_log.is_file():
            raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch setup log path is not a regular file.")
        os.chmod(setup_log, 0o600)

    vpn_profile = read_vpn_profile(vpn_profile_path)
    vpn_profile_state = vpn_profile_view(vpn_profile)
    staged_vpn_profile = read_vpn_profile(staged_paths["profile"]) if staged_paths["profile"].exists() else None
    staged_vpn = staged_paths["wg"].exists()

    pending_api_names = read_pending_api(pending_api_path)
    pending_api = bool(pending_api_names)
    pending_prowlarr = pending_prowlarr_path.exists()
    pending_vpn = vpn_pending_path.exists()
    if pending_api:
        os.chmod(pending_api_path, 0o600)
    if pending_prowlarr:
        reject_symlink(pending_prowlarr_path, kind="private setup state file")
        if not pending_prowlarr_path.is_file() or pending_prowlarr_path.stat().st_size > 64:
            raise ConfigError("PENDING_STATE_INVALID", "NetWatch setup recovery state is invalid.")
        os.chmod(pending_prowlarr_path, 0o600)
    if pending_vpn:
        reject_symlink(vpn_pending_path, kind="private setup state file")
        if not vpn_pending_path.is_file() or vpn_pending_path.stat().st_size > 64:
            raise ConfigError("PENDING_STATE_INVALID", "NetWatch setup recovery state is invalid.")
        os.chmod(vpn_pending_path, 0o600)

    modes = {
        "config_dir": safe_mode(paths["config"]),
        "wireguard_dir": safe_mode(paths["wireguard"]),
        "wg_confs_dir": safe_mode(paths["wg_confs"]),
        "backend_env": safe_mode(backend_env),
        "wg0_conf": safe_mode(wg_path) if wg_exists else None,
        "resolv_conf": safe_mode(resolv_path) if resolv_path.exists() else None,
        "setup_log": safe_mode(setup_log) if setup_log.exists() else None,
        "pending_api": safe_mode(pending_api_path) if pending_api else None,
        "pending_prowlarr": safe_mode(pending_prowlarr_path) if pending_prowlarr else None,
        "vpn_profile": safe_mode(vpn_profile_path) if vpn_profile_path.exists() else None,
        "pending_vpn": safe_mode(vpn_pending_path) if pending_vpn else None,
        "staged_wg": safe_mode(staged_paths["wg"]) if staged_paths["wg"].exists() else None,
        "staged_vpn_profile": safe_mode(staged_paths["profile"]) if staged_paths["profile"].exists() else None,
    }
    dirs_secure = all(modes[key] == "700" for key in ("config_dir", "wireguard_dir", "wg_confs_dir"))
    files_secure = (
        modes["backend_env"] == "600"
        and (not wg_exists or modes["wg0_conf"] == "600")
        and (not wg_valid or modes["resolv_conf"] == "600")
        and (not setup_log.exists() or modes["setup_log"] == "600")
        and (not pending_api or modes["pending_api"] == "600")
        and (not pending_prowlarr or modes["pending_prowlarr"] == "600")
        and (not vpn_profile_path.exists() or modes["vpn_profile"] == "600")
        and (not pending_vpn or modes["pending_vpn"] == "600")
        and (not staged_paths["wg"].exists() or modes["staged_wg"] == "600")
        and (not staged_paths["profile"].exists() or modes["staged_vpn_profile"] == "600")
    )

    return {
        "ok": True,
        "wg": {
            "exists": wg_exists,
            "valid": wg_valid,
            "error": wg_error,
            "dns_count": dns_count,
        },
        "env": {
            "exists": backend_env.exists(),
            "parse_ok": env_parse_ok,
            "configured": configured,
        },
        "vpn_profile": vpn_profile_state,
        "vpn_replacement": {
            "staged": staged_vpn,
            "profile": vpn_profile_view(staged_vpn_profile) if staged_vpn else None,
        },
        "permissions": {
            "dirs_secure": dirs_secure,
            "files_secure": files_secure,
            "modes": modes,
        },
        "pending": {
            "api": pending_api,
            "api_names": pending_api_names,
            "prowlarr": pending_prowlarr,
            "vpn": pending_vpn,
        },
        "complete": bool(
            wg_valid and env_parse_ok and all(configured.values()) and dirs_secure and files_secure
            and not pending_api and not pending_prowlarr and not pending_vpn
        ),
    }


def read_payload() -> dict[str, object]:
    raw = sys.stdin.buffer.read(MAX_SECRET_INPUT_BYTES + 1)
    if len(raw) > MAX_SECRET_INPUT_BYTES:
        raise ConfigError("PAYLOAD_TOO_LARGE", "Setup credential payload exceeds the size limit.")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConfigError("PAYLOAD_INVALID", "Setup credential payload is invalid.") from exc
    if not isinstance(payload, dict):
        raise ConfigError("PAYLOAD_INVALID", "Setup credential payload is invalid.")
    return payload


def log_event(base: Path, event: str) -> None:
    if event not in SETUP_EVENTS:
        raise ConfigError("EVENT_INVALID", "Setup diagnostic event is invalid.")
    paths = ensure_dirs(base)
    log_path = paths["data"] / "setup.log"
    timestamp = datetime.now(timezone.utc).isoformat()
    existing = b""
    if log_path.exists():
        reject_symlink(log_path, kind="private setup log")
        if not log_path.is_file():
            raise ConfigError("PRIVATE_PATH_UNSAFE", "NetWatch setup log path is not a regular file.")
        try:
            existing = log_path.read_bytes()[-128 * 1024:]
        except OSError:
            existing = b""
    atomic_write(log_path, existing + f"{timestamp} {event}\n".encode("utf-8"), 0o600)


def main() -> int:
    if len(sys.argv) < 3:
        fail("USAGE", "secure-config.py requires an action and NetWatch base directory.", 2)
    action = sys.argv[1]
    base = Path(sys.argv[2]).expanduser()
    if not base.is_absolute():
        fail("BASE_INVALID", "NetWatch base directory must be absolute.", 2)
    try:
        if action == "bootstrap":
            promote_pending_wireguard(base)
            state = inspect_state(base)
            print(json.dumps(state, separators=(",", ":")))
            return 0

        if action == "inspect":
            state = inspect_state(base)
            print(json.dumps(state, separators=(",", ":")))
            return 0

        if action == "stage-wireguard":
            if len(sys.argv) != 6:
                raise ConfigError("WG_SOURCE_INVALID", "WireGuard replacement request is invalid.")
            profile_type = sys.argv[3]
            source_created_at = sys.argv[4]
            source_modified_at = sys.argv[5]
            profile = normalize_vpn_profile_payload({
                "profile_type": profile_type,
                "source_created_at": source_created_at or None,
                "source_modified_at": source_modified_at or None,
                "imported_at": datetime.now(timezone.utc).isoformat(),
            })
            raw = sys.stdin.buffer.read(MAX_WG_BYTES + 1)
            if not raw:
                raise ConfigError("WG_TOO_LARGE", "The selected WireGuard file is empty.")
            if len(raw) > MAX_WG_BYTES:
                raise ConfigError("WG_TOO_LARGE", "The selected WireGuard file exceeds 8 KiB.")
            try:
                parsed = parse_wireguard(raw.decode("utf-8"), allow_netwatch_hooks=True)
            except UnicodeDecodeError as exc:
                raise ConfigError("WG_ENCODING_INVALID", "The selected WireGuard file is not UTF-8 text.") from exc
            paths = ensure_dirs(base)
            pending = pending_wireguard_paths(paths)
            remove_private_file(pending["wg"])
            remove_private_file(pending["profile"])
            atomic_write(pending["wg"], render_wireguard(parsed), 0o600)
            write_vpn_profile(pending["profile"], profile)
            print(json.dumps({"ok": True, "vpn_profile": vpn_profile_view(profile)}, separators=(",", ":")))
            return 0

        if action == "import-wireguard":
            if len(sys.argv) not in {3, 6}:
                raise ConfigError("WG_SOURCE_INVALID", "WireGuard import request is invalid.")
            profile_type = sys.argv[3] if len(sys.argv) == 6 else "generic"
            source_created_at = sys.argv[4] if len(sys.argv) == 6 else ""
            source_modified_at = sys.argv[5] if len(sys.argv) == 6 else ""
            profile = normalize_vpn_profile_payload({
                "profile_type": profile_type,
                "source_created_at": source_created_at or None,
                "source_modified_at": source_modified_at or None,
                "imported_at": datetime.now(timezone.utc).isoformat(),
            })
            raw = sys.stdin.buffer.read(MAX_WG_BYTES + 1)
            if not raw:
                raise ConfigError("WG_TOO_LARGE", "The selected WireGuard file is empty.")
            if len(raw) > MAX_WG_BYTES:
                raise ConfigError("WG_TOO_LARGE", "The selected WireGuard file exceeds 8 KiB.")
            try:
                parsed = parse_wireguard(raw.decode("utf-8"), allow_netwatch_hooks=True)
            except UnicodeDecodeError as exc:
                raise ConfigError("WG_ENCODING_INVALID", "The selected WireGuard file is not UTF-8 text.") from exc
            paths = ensure_dirs(base)
            profile_path = paths["data"] / "vpn-profile.json"
            # Clear old UX metadata before replacing the config so an interrupted update
            # can never leave a new tunnel profile carrying a stale provider label/timer.
            remove_private_file(profile_path)
            atomic_write(paths["wg_confs"] / "wg0.conf", render_wireguard(parsed), 0o600)
            atomic_write(paths["config"] / "resolv.conf", render_resolv(list(parsed["dns"])), 0o600)
            write_vpn_profile(profile_path, profile)
            print(json.dumps({"ok": True, "dns_count": len(parsed["dns"]), "vpn_profile": vpn_profile_view(profile)}, separators=(",", ":")))
            return 0

        if action == "set-vpn-profile-type":
            payload = read_payload()
            if set(payload) != {"profile_type"}:
                raise ConfigError("VPN_PROFILE_INVALID", "VPN profile type request is invalid.")
            profile_type = payload.get("profile_type")
            if profile_type not in VPN_PROFILE_TYPES:
                raise ConfigError("VPN_PROFILE_INVALID", "VPN profile type is invalid.")
            paths = ensure_dirs(base)
            profile_path = paths["data"] / "vpn-profile.json"
            current = read_vpn_profile(profile_path) or {
                "profile_type": "generic",
                "imported_at": None,
                "source_created_at": None,
                "source_modified_at": None,
            }
            current["profile_type"] = profile_type
            write_vpn_profile(profile_path, current)
            print(json.dumps({"ok": True, "vpn_profile": vpn_profile_view(current)}, separators=(",", ":")))
            return 0

        if action == "mark-vpn-validated":
            paths = ensure_dirs(base)
            remove_private_file(paths["data"] / ".setup-vpn-pending")
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "set-api":
            payload = read_payload()
            updates: dict[str, str] = {}
            for name in ("tmdb", "opensubtitles", "subdl"):
                if name not in payload:
                    continue
                updates[API_KEYS[name]] = validate_secret(name, payload[name], minimum=8, maximum=256)
            if not updates:
                raise ConfigError("API_EMPTY", "No API credentials were supplied.")
            paths = ensure_dirs(base)
            env_path = paths["config"] / "backend.env"
            ensure_backend_env(env_path)
            values, parse_ok = parse_env(env_path)
            if not parse_ok:
                raise ConfigError("ENV_INVALID", "The private environment file is malformed.")
            for env_key in updates:
                if configured_secret(values.get(env_key)):
                    raise ConfigError("SECRET_ALREADY_CONFIGURED", "An existing configured credential would be overwritten.")
            updated_names = sorted(name for name in ("tmdb", "opensubtitles", "subdl") if API_KEYS[name] in updates)
            pending_path = paths["data"] / ".setup-api-pending"
            atomic_write(pending_path, json.dumps(updated_names, separators=(",", ":")).encode("utf-8"), 0o600)
            try:
                update_env_keys(env_path, updates)
            except Exception:
                remove_private_file(pending_path)
                raise
            print(json.dumps({"ok": True, "updated": updated_names}, separators=(",", ":")))
            return 0

        if action == "clear-api":
            payload = read_payload()
            names = payload.get("names")
            if not isinstance(names, list) or not names or any(name not in {"tmdb", "opensubtitles", "subdl"} for name in names):
                raise ConfigError("API_CLEAR_INVALID", "Credential reset request is invalid.")
            paths = ensure_dirs(base)
            env_path = paths["config"] / "backend.env"
            ensure_backend_env(env_path)
            update_env_keys(env_path, {API_KEYS[name]: "" for name in names})
            remove_private_file(paths["data"] / ".setup-api-pending")
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "mark-api-validated":
            paths = ensure_dirs(base)
            remove_private_file(paths["data"] / ".setup-api-pending")
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "set-prowlarr":
            payload = read_payload()
            key = validate_secret("prowlarr", payload.get("prowlarr"), minimum=16, maximum=256)
            paths = ensure_dirs(base)
            env_path = paths["config"] / "backend.env"
            ensure_backend_env(env_path)
            values, parse_ok = parse_env(env_path)
            if not parse_ok:
                raise ConfigError("ENV_INVALID", "The private environment file is malformed.")
            if configured_secret(values.get(API_KEYS["prowlarr"])):
                raise ConfigError("SECRET_ALREADY_CONFIGURED", "An existing Prowlarr credential would be overwritten.")
            pending_path = paths["data"] / ".setup-prowlarr-pending"
            atomic_write(pending_path, b"pending\n", 0o600)
            try:
                update_env_keys(env_path, {API_KEYS["prowlarr"]: key})
            except Exception:
                remove_private_file(pending_path)
                raise
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "clear-prowlarr":
            paths = ensure_dirs(base)
            env_path = paths["config"] / "backend.env"
            ensure_backend_env(env_path)
            update_env_keys(env_path, {API_KEYS["prowlarr"]: ""})
            remove_private_file(paths["data"] / ".setup-prowlarr-pending")
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "mark-prowlarr-validated":
            paths = ensure_dirs(base)
            remove_private_file(paths["data"] / ".setup-prowlarr-pending")
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        if action == "log-event":
            if len(sys.argv) != 4:
                raise ConfigError("EVENT_INVALID", "A setup diagnostic event is required.")
            log_event(base, sys.argv[3])
            print(json.dumps({"ok": True}, separators=(",", ":")))
            return 0

        raise ConfigError("ACTION_INVALID", "Unsupported secure configuration action.")
    except ConfigError as exc:
        fail(exc.code, exc.message)
    except Exception:
        # Never echo arbitrary exception values here: file contents and provider
        # material must not leak through setup error handling.
        fail("CONFIG_INTERNAL_ERROR", "NetWatch could not safely update its private configuration.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
