# NetWatch prerequisite helper

Windows-only, fixed-purpose bootstrap helper used by the NSIS installer.

It replaces the former PowerShell prerequisite host. Its command surface is restricted to NetWatch's installer actions: probing the WSL/Docker prerequisites, applying the elevated WSL feature/package step, installing or initializing Ubuntu, downloading/verifying/installing Docker Desktop, and starting Docker Desktop.

Security properties:

- no PowerShell, `cmd.exe`, WMI scripting, or arbitrary shell command mode;
- fixed executable/argument construction only;
- Docker download restricted to HTTPS `desktop.docker.com` with bounded redirects and a 1.5 GiB cap;
- Docker installer execution requires a trusted Authenticode signature whose signer organization is Docker Inc.;
- only the explicit WSL servicing action is launched through Windows UAC by NSIS;
- Ubuntu first-run account creation remains interactive and NetWatch never creates or stores Linux credentials;
- state files include a heartbeat so NSIS can detect a helper that was terminated by endpoint security or another process.
