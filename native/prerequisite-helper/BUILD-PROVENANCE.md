# NetWatch prerequisite helper build provenance

This installer-only binary is project-owned source built from `native/prerequisite-helper/`.

- Target: Windows x86-64
- Go toolchain: Go 1.23.2
- CGO: disabled
- External Go modules: none
- Build command (from `native/prerequisite-helper/`): `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o ../../build/netwatch-prerequisites.exe .`
- Runtime role: fixed-purpose WSL/Ubuntu/Docker prerequisite probe/bootstrap for the NSIS installer

- SHA-256: `0146541890e3b676bb954591af00644d1d2e0657c549704340985e52c820e33e`
- Reproducibility check: two independent `-trimpath` builds with the toolchain above were byte-identical, and the checked-in installer helper matches them.

The checked-in helper is an unsigned reproducible development build. Distributed releases must Authenticode-sign it with the same certificate as the installer; `package:win` now fails closed otherwise.

The helper is built as a normal console-subsystem program so NSIS can hide the helper once while ordinary child processes inherit that console; captured WSL/DISM probes do not use hidden-process creation flags. Interactive Ubuntu initialization is launched with native `CreateProcessW` + `CREATE_NEW_CONSOLE` and no `STARTF_USESTDHANDLES`, so Windows provides real console input/output handles for first-run username/password creation.

The helper provides no arbitrary shell mode. NSIS extracts it to the installer plugin directory and it is not installed as part of the NetWatch application runtime.
