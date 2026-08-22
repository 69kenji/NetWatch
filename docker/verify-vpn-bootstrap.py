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


def active_nameservers(resolv_conf: str) -> list[str]:
    servers: list[str] = []
    for raw_line in resolv_conf.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[0].lower() == "nameserver":
            servers.append(parts[1])
    return servers


def require(ok: bool, message: str) -> None:
    if not ok:
        raise RuntimeError(message)


def main() -> int:
    try:
        vpn = json.loads(sh("docker", "inspect", "nw_vpn"))[0]
        backend = json.loads(sh("docker", "inspect", "nw_backend"))[0]
        expected = f"container:{vpn['Id']}"
        require(backend["HostConfig"]["NetworkMode"] == expected, "backend is not attached to the VPN namespace")

        wg = sh("docker", "exec", "nw_vpn", "wg", "show", "wg0")
        require("interface:" in wg, "wg0 is not active")

        rules = sh("docker", "exec", "nw_vpn", "ip", "-4", "rule", "show")
        require("lookup 51820" in rules and "fwmark" in rules, "WireGuard policy routing is missing")

        table = sh("docker", "exec", "nw_vpn", "ip", "-4", "route", "show", "table", "51820")
        require("default dev wg0" in table, "WireGuard default policy route is missing")

        fwmark = sh("docker", "exec", "nw_vpn", "wg", "show", "wg0", "fwmark")
        require(fwmark and fwmark != "off", "WireGuard fwmark is missing")

        output_rules = sh("docker", "exec", "nw_vpn", "iptables", "-S", "OUTPUT")
        require("-j REJECT" in output_rules and "--mark" in output_rules, "VPN kill-switch OUTPUT rule is missing")

        ipv6 = sh("docker", "exec", "nw_vpn", "sysctl", "-n", "net.ipv6.conf.all.disable_ipv6")
        require(ipv6 == "1", "IPv6 is not disabled in the VPN namespace")

        port_bindings = vpn.get("HostConfig", {}).get("PortBindings", {}) or {}
        for port in ("8000/tcp", "9696/tcp"):
            bindings = port_bindings.get(port) or []
            require(bool(bindings), f"{port} is not published")
            require(all((entry.get("HostIp") or "") == "127.0.0.1" for entry in bindings), f"{port} is not loopback-only")
        require(not port_bindings.get("8191/tcp"), "FlareSolverr must not be exposed to the host")

        resolv = sh("docker", "exec", "nw_backend", "cat", "/etc/resolv.conf")
        nameservers = active_nameservers(resolv)
        require(bool(nameservers), "backend has no configured DNS resolver")
        require(all(server != "127.0.0.11" for server in nameservers), "backend is using Docker's embedded resolver")
        for server in nameservers:
            route = sh("docker", "exec", "nw_vpn", "ip", "route", "get", server)
            require("dev wg0" in route, f"DNS resolver {server} does not route through wg0")

        print("VPN_BOOTSTRAP_STRUCTURE_OK")
        return 0
    except Exception as exc:
        print(f"VPN_BOOTSTRAP_STRUCTURE_FAILED: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
