# Security policy

## Supported version

Security fixes target the current public NetWatch release and the default branch. Older development snapshots are not maintained.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow when available.

Include:

- affected version or commit;
- affected component;
- prerequisites;
- impact;
- a minimal reproduction or proof of concept.

Do not post exploit details or secrets in a public issue. Never attach API keys, tokens, `backend/.env`, private WireGuard configuration, or Prowlarr user data.

If private reporting is unavailable, open a short public issue asking for a private contact without including exploit details.

## Useful reports

Examples include:

- NetWatch traffic bypassing the inner WireGuard path;
- DNS or IPv6 bypass;
- loss of `wg0` falling back to unprotected Internet access;
- internal services becoming remotely reachable;
- credential disclosure;
- unsafe URL/redirect handling;
- path traversal, command execution, or arbitrary local-file access.

Loss of connectivity by itself is not a privacy bypass if the network fails closed.

See [`docs/network-threat-model.md`](docs/network-threat-model.md) for the intended network boundary.

## Disclosure

Please allow time to reproduce, fix, test, and publish a security update before public disclosure. NetWatch does not offer a bug bounty or guarantee a response timeline.
