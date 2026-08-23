# NetWatch network threat model

## Scope

NetWatch is a local Windows application whose Internet-facing services run inside Docker/WSL. Its primary network-security goal is simple:

> NetWatch traffic should use the inner WireGuard tunnel and fail closed when that path is unavailable.

This is a traffic-isolation design, not an anonymity system.

## Security goals

NetWatch 1.0.x is designed so that:

- During normal NetWatch runtime, Windows-side NetWatch components use localhost/IPC rather than direct Internet connections.
- Backend, torrent-engine, Prowlarr, and FlareSolverr share the VPN service's network namespace.
- Ordinary Internet traffic from that namespace leaves through `wg0`.
- WireGuard failure blocks application traffic instead of falling back to Docker's normal egress.
- DNS uses the VPN-side resolver supplied by the imported WireGuard configuration.
- IPv6 is disabled in the VPN namespace for 1.0.x.
- Host-facing APIs bind to `127.0.0.1` only.

## Non-goals

NetWatch does not claim to provide:

- anonymity;
- protection from a compromised Windows host, Docker/WSL administrator, VPN provider, or dependency;
- independent trust domains when two tunnels use the same VPN provider;
- seamless recovery across host-network/VPN changes;
- legal protection or guarantees about third-party services, indexers, trackers, peers, or metadata providers.

## Runtime topology

```text
Windows Electron / native mpv
            |
            | localhost / IPC
            v
+--------------------------------------------------+
| shared nw_vpn network namespace                  |
|                                                  |
| backend         127.0.0.1:8000                   |
| torrent-engine  127.0.0.1:8081                   |
| Prowlarr        127.0.0.1:9696                   |
| FlareSolverr    127.0.0.1:8191                   |
|                                                  |
| ordinary traffic -> wg0 -> encrypted WG -> eth0 |
+--------------------------------------------------+
                         |
                         v
                  inner VPN relay
                         |
                  [optional host VPN]
                         |
                         v
                      Internet
```

The Internet-facing application services use:

```text
network_mode: service:vpn
```

They therefore do not receive independent Docker default routes.

## Trust boundaries

### Windows desktop

Electron and mpv are local application components. Their intended network dependency is the backend on `127.0.0.1:8000`.

Loopback reduces remote exposure but is not an authentication boundary against other processes already running in the same Windows session.

First-run credential entry uses separate sandboxed Electron windows with narrow preload APIs. They do not expose generic filesystem, shell, secret-readback, or arbitrary-URL IPC.

### Installer prerequisite bootstrap

The normal-runtime egress invariant begins after WSL/Docker prerequisites exist. The Windows NSIS bootstrap is a separate trust phase: with explicit user approval it may invoke Microsoft `wsl.exe`/Windows servicing and may download Docker Desktop directly from Docker's pinned `desktop.docker.com` HTTPS endpoint before the inner VPN runtime exists. NetWatch 1.0.4 performs these actions through a fixed-purpose native helper rather than PowerShell. The Docker download is size/redirect bounded and the installer must pass Windows Authenticode validation with a Docker Inc. signer identity before execution.

This bootstrap exception does not authorize the installed Electron application, mpv, backend, torrent engine, Prowlarr, or FlareSolverr to bypass the inner VPN during normal operation.

### WSL and Docker

NetWatch relies on Windows, WSL2, and Docker Desktop to enforce process, namespace, route, capability, and published-port boundaries. A local administrator who deliberately changes those controls is outside this model.

### Inner VPN namespace

`nw_vpn` is the authoritative egress boundary. The VPN container retains the network administration capability required to configure WireGuard and firewall/routing policy; application containers do not receive independent egress networks.

### VPN profile metadata

`Generic WireGuard` and `VPNBook` use the same canonical WireGuard parser, routing, kill switch, and live verification. The selected provider label and VPNBook expiry estimate are UX metadata only and cannot make a failing tunnel pass the security gate.

WireGuard replacements are staged privately and promoted on restart. The promoted tunnel must pass the normal live VPN verification before setup is considered complete.

### External services

VPN infrastructure, trackers, peers, indexers, metadata providers, subtitle providers, and other Internet endpoints are external and untrusted. NetWatch cannot guarantee their availability or correctness.

## Host-facing services

Only the services that need Windows access are published:

```text
127.0.0.1:8000 -> backend
127.0.0.1:9696 -> Prowlarr
```

Torrent-engine and FlareSolverr remain internal to the shared namespace.

## Routing and kill switch

The WireGuard namespace uses policy routing so ordinary traffic is sent through `wg0`, while WireGuard's own marked transport packets may use the underlying Docker interface to reach the VPN relay.

The kill switch rejects ordinary non-local traffic that attempts to leave outside `wg0`. The existence of a Docker `eth0` default route is therefore not by itself a bypass: it is required for the encrypted WireGuard transport.

Docker healthchecks are liveness signals, not the security boundary. The firewall/policy-routing rules provide fail-closed enforcement.

## DNS

Setup derives `~/.local/share/netwatch/config/resolv.conf` from the validated IPv4 DNS entry in the imported WireGuard configuration. Backend, torrent-engine, Prowlarr, and FlareSolverr mount that resolver.

NetWatch does not intentionally fall back to Windows DNS, Docker's embedded resolver, or a public resolver outside the tunnel. If the configured VPN-side DNS path fails, name resolution is expected to fail.

## IPv6

IPv6 is disabled in the VPN namespace for NetWatch 1.0.x. The release model therefore assumes IPv4 application traffic over WireGuard rather than maintaining a second fail-closed IPv6 routing policy.

## Optional Windows host VPN

A Windows host VPN can add defense-in-depth around the inner tunnel:

```text
Windows host VPN -> relay A
NetWatch WireGuard -> relay B
NetWatch services -> Internet
```

The inner WireGuard tunnel remains authoritative. If both layers use the same provider, they are not independent trust domains.

Use different host and inner relay endpoints. Using the exact same relay for both layers is not a supported reliability target.

Changing/disconnecting/reconnecting the host VPN while NetWatch is running can leave Docker/WSL connectivity unusable. Restart NetWatch after such a transition. The validated failure mode remained closed rather than falling back to direct Internet access.

## Release verification

The 1.0.x network model was verified with packet capture, process/socket inspection, routing/firewall inspection, and deliberate failure tests.

Observed properties included:

- Windows NetWatch/mpv sockets used the local backend rather than public TCP destinations.
- Final Internet destinations were visible on inner `wg0`.
- The VPN namespace's underlying interface carried the WireGuard relay transport rather than ordinary final destinations.
- DNS followed the VPN path.
- No IPv6 bypass was observed.

Failure testing produced the following results:

| Scenario | Result |
| --- | --- |
| Host VPN absent, inner VPN available | Inner VPN remained the NetWatch egress path |
| Inner `wg0` down | Internet/DNS failed closed |
| VPN container unavailable | Shared application networking failed closed |
| VPN-side DNS blocked | DNS failed without resolver fallback |
| Both VPN layers unavailable | No NetWatch Internet connectivity |
| Host VPN changed while NetWatch ran | No leak observed; restart may be required |
| Same exact host/inner relay | Unreliable; unsupported configuration |

These results describe the tested 1.0.x architecture, not every possible future Windows/Docker/VPN environment.

## Preserving the model

Changes to the following require a new security review and network verification:

- `network_mode: service:vpn` for Internet-facing NetWatch services;
- loopback-only host publishing;
- WireGuard policy routing and kill-switch behavior;
- VPN-routed DNS without an unprotected fallback;
- IPv6-disable behavior unless equivalent protected IPv6 routing is implemented;
- container privileges/capabilities;
- removal or replacement of the authoritative inner VPN.

`docker/verify-networking.py` provides structural runtime checks, but packet capture remains the stronger way to validate the real path after network-architecture changes.
