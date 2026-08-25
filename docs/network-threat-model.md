# NetWatch network threat model

## Goal

NetWatch's Internet-facing services must use the inner WireGuard tunnel. If that path is unavailable, NetWatch should lose connectivity rather than fall back to normal Docker or Windows egress.

This is a traffic-isolation model, not an anonymity guarantee.

## Runtime layout

```text
Windows Electron / mpv
        |
        | localhost / IPC
        v
+---------------------------------------------+
| shared VPN network namespace                |
|                                             |
| backend         :8000                       |
| torrent-engine  :8081                       |
| Prowlarr        :9696                       |
| FlareSolverr    :8191                       |
|                                             |
| ordinary traffic -> wg0                     |
| wg0 peers -> control ports -> REJECT        |
+---------------------+-----------------------+
                      |
                      v
               WireGuard relay
                      |
              [optional host VPN]
                      |
                      v
                   Internet
```

Backend, torrent-engine, Prowlarr, and FlareSolverr use `network_mode: service:vpn`, so they share the VPN service's network namespace instead of receiving independent Docker egress paths.

## Enforced boundaries

- Ordinary application traffic leaves the shared namespace through `wg0`.
- WireGuard transport packets may use the namespace's Docker interface to reach the VPN relay.
- The kill switch rejects ordinary non-local traffic that tries to leave outside `wg0`.
- DNS uses the IPv4 resolver from the imported WireGuard profile.
- IPv6 is disabled in the VPN namespace for NetWatch 1.0.x.
- Windows publishes only `127.0.0.1:8000` (backend) and `127.0.0.1:9696` (Prowlarr).
- Torrent-engine and FlareSolverr are not published to Windows.
- The namespace firewall rejects WireGuard-peer access to control ports `8000`, `8081`, `8191`, and `9696`.

The backend and torrent-engine listen on all IPv4 interfaces inside the shared namespace because Docker's Windows port publication is DNATed to that namespace. Their listener address is not the remote-access boundary; the host bindings and namespace firewall are.

## Trust boundaries

### Windows app

Electron and mpv are local components. Their intended network dependency is the backend on `127.0.0.1:8000`.

Loopback limits remote exposure but does not protect against another process already running in the same Windows user session.

Credential-entry windows use sandboxed Electron renderers with narrow preload/IPC surfaces. Stored credentials are not exposed back to the renderer.

### Installer bootstrap

Before WSL/Docker exists, the installer may use Windows servicing tools and download Docker Desktop directly from Docker's `desktop.docker.com` HTTPS endpoint. The project-owned prerequisite helper verifies the Docker installer with Windows Authenticode and requires a Docker Inc. signer before running it.

This exception applies only to prerequisite installation. Normal NetWatch provider, metadata, subtitle, indexer, and torrent traffic still uses the inner VPN runtime.

### WSL and Docker

NetWatch relies on Windows, WSL2, and Docker Desktop to enforce process, namespace, route, capability, and published-port boundaries. A local administrator who deliberately changes those controls is outside this model.

NetWatch-owned backend and torrent-engine containers run as UID 1000 with Linux capabilities dropped and `no-new-privileges`. Prowlarr and FlareSolverr use their upstream container startup models; `docker/verify-networking.py` checks the effective application-process UID and fails if those processes run as root.

### VPN profiles

Generic WireGuard and VPNBook profiles use the same parser, routing, kill switch, DNS handling, and live verification. The provider label and VPNBook expiry estimate are UI metadata only.

Replacement profiles are staged and applied on restart. The new tunnel must pass the normal VPN checks before NetWatch proceeds.

### External services

VPN infrastructure, trackers, peers, indexers, metadata providers, and subtitle providers are external and untrusted. NetWatch does not guarantee their availability or correctness.

## DNS and IPv6

Setup writes the validated WireGuard DNS address to:

```text
~/.local/share/netwatch/config/resolv.conf
```

Backend, torrent-engine, Prowlarr, and FlareSolverr use that resolver. NetWatch does not intentionally fall back to Windows DNS, Docker's embedded resolver, or a public resolver outside the tunnel.

IPv6 is disabled in the VPN namespace for 1.0.x instead of maintaining a separate protected IPv6 route.

## Optional Windows host VPN

A Windows host VPN can add another layer, but the inner WireGuard tunnel remains NetWatch's required path.

If both are used, choose different relay endpoints. Changing or reconnecting the host VPN while NetWatch is running can interrupt Docker/WSL networking; restart NetWatch afterward.

## Verified behavior

The 1.0.x architecture has been checked with packet capture, socket inspection, route/firewall inspection, and deliberate failure tests.

Verified behavior includes:

- Windows NetWatch/mpv traffic uses local services rather than direct provider/torrent connections.
- final Internet destinations appear on inner `wg0`;
- the underlying Docker interface carries WireGuard transport rather than ordinary final destinations;
- DNS follows the protected path;
- no IPv6 bypass was observed;
- loss of `wg0`, the VPN container, or VPN-side DNS causes loss of connectivity rather than fallback egress.

`docker/verify-networking.py` checks the expected runtime structure. Packet capture remains the stronger verification method after network changes.

## Non-goals

NetWatch does not claim to provide:

- anonymity;
- protection from a compromised Windows host, Docker/WSL administrator, VPN provider, or dependency;
- independent trust domains when two tunnels use the same VPN provider;
- uninterrupted service during host-network/VPN changes;
- legal protection or guarantees about third-party services.

