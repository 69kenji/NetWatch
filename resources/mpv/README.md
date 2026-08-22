# Bundled mpv runtime

The Windows package expects the mpv runtime in this directory before building:

- `mpv.exe`
- `mpv.com`
- DLLs distributed with that build

Runtime lookup order:

1. `NETWATCH_MPV_PATH` (developer override)
2. packaged `resources/mpv/mpv.com` / `mpv.exe`
3. repository `resources/mpv/mpv.com` / `mpv.exe`
4. `mpv.com` / `mpv.exe` on `PATH` (development fallback)

End users do not need to install mpv separately.

## License and provenance

The bundled runtime is GPL-enabled and is distributed under GPL-2.0-or-later.

See:

- `Copyright.txt` — upstream mpv licensing/copyright notes
- `LICENSE.GPL-2.0` — GPL version 2 text
- `BUILD-PROVENANCE.md` — exact binary hashes, source/build revisions, and corresponding-source requirements

NetWatch's GPL-3.0-only license does not replace third-party licenses.
