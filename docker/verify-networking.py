#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys


def sh(*args: str) -> str:
    return subprocess.run(
        list(args),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ).stdout.strip()


def check(name: str, ok: bool, detail: str) -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    return bool(ok)


def destinations(container: dict) -> set[str]:
    return {mount.get("Destination", "") for mount in container.get("Mounts", [])}


def active_nameservers(resolv_conf: str) -> list[str]:
    """Return only active nameserver directives, ignoring comments/options."""
    servers: list[str] = []
    for raw_line in resolv_conf.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == "nameserver":
            servers.append(parts[1])
    return servers


def main() -> int:
    failures = 0
    try:
        vpn = json.loads(sh("docker", "inspect", "nw_vpn"))[0]
        engine = json.loads(sh("docker", "inspect", "nw_torrent_engine"))[0]
        backend = json.loads(sh("docker", "inspect", "nw_backend"))[0]
        prowlarr = json.loads(sh("docker", "inspect", "nw_prowlarr"))[0]
    except Exception as exc:
        raise SystemExit(f"Could not inspect running NetWatch core containers: {exc}")

    try:
        flaresolverr = json.loads(sh("docker", "inspect", "nw_flaresolverr"))[0]
    except Exception:
        flaresolverr = None

    expected = f"container:{vpn['Id']}"
    privacy_clients = [
        ("libtorrent engine", engine),
        ("backend", backend),
        ("Prowlarr", prowlarr),
    ]
    if flaresolverr is not None:
        privacy_clients.append(("FlareSolverr", flaresolverr))
    else:
        print("WARN  FlareSolverr container present: not installed/running yet; protected indexers will be unavailable")

    for name, container in privacy_clients:
        actual = container["HostConfig"]["NetworkMode"]
        failures += not check(
            f"{name} shares VPN namespace",
            actual == expected,
            actual,
        )

    for name, cmd, needle in [
        ("wg0 exists", ["docker", "exec", "nw_vpn", "wg", "show", "wg0"], "interface:"),
        ("public IPv4 route", ["docker", "exec", "nw_vpn", "sh", "-lc", "ip route get 1.1.1.1"], "dev wg0"),
        ("IPv6 disabled", ["docker", "exec", "nw_vpn", "sysctl", "-n", "net.ipv6.conf.all.disable_ipv6"], "1"),
    ]:
        try:
            out = sh(*cmd)
            failures += not check(name, needle in out, out.replace("\n", "; "))
        except Exception as exc:
            failures += 1
            check(name, False, str(exc))

    try:
        rules = sh("docker", "exec", "nw_vpn", "sh", "-lc", "iptables -S OUTPUT")
        ok = "-j REJECT" in rules and "--mark" in rules
        failures += not check(
            "killswitch OUTPUT rule",
            ok,
            "reject rule present" if ok else rules,
        )
    except Exception as exc:
        failures += 1
        check("killswitch OUTPUT rule", False, str(exc))

    port_bindings = vpn.get("HostConfig", {}).get("PortBindings", {}) or {}
    expected_ports = {"8000/tcp", "9696/tcp"}
    ports_ok = True
    detail_parts: list[str] = []
    for port in expected_ports:
        bindings = port_bindings.get(port) or []
        binding_ok = bool(bindings) and all(
            (entry.get("HostIp") or "") in {"127.0.0.1", "::1"}
            for entry in bindings
        )
        ports_ok = ports_ok and binding_ok
        detail_parts.append(f"{port}={bindings}")
    flaresolverr_exposed = bool(port_bindings.get("8191/tcp"))
    ports_ok = ports_ok and not flaresolverr_exposed
    detail_parts.append(f"8191/tcp={port_bindings.get('8191/tcp') or []} (must remain internal)")
    failures += not check(
        "host APIs bind to loopback only and FlareSolverr stays internal",
        ports_ok,
        "; ".join(detail_parts),
    )

    shared = "/tmp/netwatch" in destinations(engine) and "/tmp/netwatch" in destinations(backend)
    failures += not check("shared download path", shared, "/tmp/netwatch")

    dns_clients = [
        ("nw_torrent_engine", "torrent engine"),
        ("nw_backend", "backend"),
        ("nw_prowlarr", "Prowlarr"),
    ]
    flaresolverr_running = bool(
        flaresolverr
        and flaresolverr.get("State", {}).get("Running")
    )
    if flaresolverr_running:
        dns_clients.append(("nw_flaresolverr", "FlareSolverr"))
    elif flaresolverr is not None:
        print("WARN  FlareSolverr DNS isolation: container is stopped; no solver egress is possible")

    for container_name, label in dns_clients:
        try:
            resolv = sh("docker", "exec", container_name, "cat", "/etc/resolv.conf")
            nameservers = active_nameservers(resolv)
            bypasses_docker = bool(nameservers) and all(
                server != "127.0.0.11" for server in nameservers
            )

            route_details: list[str] = []
            routes_via_vpn = bypasses_docker
            for server in nameservers:
                route = sh(
                    "docker",
                    "exec",
                    "nw_vpn",
                    "sh",
                    "-lc",
                    f"ip route get {server}",
                )
                route_details.append(f"{server}: {route}")
                routes_via_vpn = routes_via_vpn and "dev wg0" in route

            ok = bypasses_docker and routes_via_vpn
            detail = f"nameservers={','.join(nameservers) or 'none'}"
            if route_details:
                detail += "; " + "; ".join(route_details)
            failures += not check(
                f"{label} DNS bypasses Docker resolver",
                ok,
                detail,
            )
        except Exception as exc:
            failures += 1
            check(f"{label} DNS bypasses Docker resolver", False, str(exc))

    try:
        raw = sh(
            "docker",
            "exec",
            "nw_backend",
            "python",
            "-c",
            "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8081/health',timeout=3).read().decode())",
        )
        health = json.loads(raw)
        ok = (
            health.get("engine") == "libtorrent"
            and health.get("vpn_interface_present") is True
            and health.get("listening") is True
            and health.get("connected") is True
        )
        failures += not check("backend reaches libtorrent engine inside VPN namespace", ok, raw)
    except Exception as exc:
        failures += 1
        check("backend reaches libtorrent engine inside VPN namespace", False, str(exc))

    # FlareSolverr is useful for protected indexers but is not a core playback
    # dependency. Its privacy topology is enforced above whenever it is running;
    # temporary API/browser failure is informational only.
    if flaresolverr_running:
        try:
            raw = sh(
                "docker",
                "exec",
                "nw_backend",
                "python",
                "-c",
                "import json,urllib.request; r=urllib.request.Request('http://127.0.0.1:8191/v1',data=json.dumps({'cmd':'sessions.list'}).encode(),headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(r,timeout=5).read().decode())",
            )
            health = json.loads(raw)
            ok = isinstance(health.get("sessions"), list)
            print(f"{'PASS' if ok else 'WARN'}  FlareSolverr API reachable inside VPN namespace: {raw}")
        except Exception as exc:
            print(f"WARN  FlareSolverr API reachable inside VPN namespace: {exc}")

    print()
    print(f"Networking verification {'FAILED (' + str(failures) + ' check(s))' if failures else 'PASSED'}.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
