# Security policy

## Supported version

Security fixes target the current public NetWatch release and current default branch. Older development snapshots are not maintained releases.

## Reporting a vulnerability

Do not publish exploit details, credentials, private configuration, or sensitive logs in a public issue.

Use GitHub's private **Report a vulnerability** flow when available. Include the affected version/commit, component, prerequisites, impact, and a minimal reproduction or proof of concept.

If private reporting is unavailable, open a short public issue requesting a private contact without including exploit details.

Never attach real API keys, tokens, `backend/.env`, WireGuard private configuration, Prowlarr databases/configuration, or provider credentials.

## Useful security reports

Examples include:

- Windows-side NetWatch traffic reaching the Internet directly instead of localhost/IPC;
- backend, torrent-engine, Prowlarr, or FlareSolverr bypassing the inner WireGuard path;
- DNS or IPv6 bypass;
- loss of `wg0` falling back to unprotected Internet access;
- services that should be loopback-only becoming remotely reachable;
- credential disclosure, unsafe URL/redirect handling, path traversal, command execution, or arbitrary local-file access.

A fail-closed loss of connectivity is an availability issue, not by itself a privacy bypass.

See [`docs/network-threat-model.md`](docs/network-threat-model.md) for the intended network boundary.

## Disclosure

Please allow reasonable time to reproduce, fix, test, and publish a security update before public disclosure. NetWatch does not offer a bug bounty or guarantee a specific response timeline.
