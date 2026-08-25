# Bundled mpv runtime

NetWatch includes a GPL-enabled Windows mpv runtime. End users do not need to install mpv separately.

Required runtime files in this directory:

- `mpv.exe`
- `mpv.com`
- DLLs distributed with the build

Runtime lookup order:

1. `NETWATCH_MPV_PATH` developer override
2. packaged `resources/mpv/mpv.exe` / `mpv.com`
3. repository `resources/mpv/mpv.exe` / `mpv.com`
4. `mpv.exe` / `mpv.com` on `PATH` for development

## Version and hashes

Bundled version: `mpv v0.41.0-922-gf4d13e1c2`

| File | SHA-256 |
| --- | --- |
| `mpv.exe` | `46b8c1d0018e218fcbe0c0f927d50df2a120d9a5870b209955daad74ad7d4eab` |
| `mpv.com` | `834ad358dfdf562db2215144035e1ca911d61f85853317af86f49132f3c1feb3` |
| `d3dcompiler_43.dll` | `4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345` |

mpv source revision: `f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`

Source: `https://github.com/mpv-player/mpv/tree/f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`

## Windows build

The bundled runtime is from Zhongfly's `mpv-winbuild` release:

- Release: `2026-08-13-f4d13e1c2c`
- Asset: `mpv-x86_64-v3-20260813-git-f4d13e1c2c.7z`
- Zhongfly build-repository revision: `ec05635`
- GitHub Actions build: `31698098358`
- Compiler: clang

Build projects:

```text
https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-13-f4d13e1c2c
https://github.com/zhongfly/mpv-winbuild
https://github.com/shinchiro/mpv-winbuild-cmake
```

## License and corresponding source

This mpv build has GPL features enabled and is distributed under GPL-2.0-or-later. `Copyright.txt` contains upstream licensing/copyright notes and `LICENSE.GPL-2.0` contains the GPL version 2 text. NetWatch's GPL-3.0-only license does not replace third-party licenses.

A distributor of the NetWatch binary package must satisfy the corresponding-source requirements for this mpv build and its covered linked components. Preserve or publish the source/build material needed to reproduce the bundled runtime, including at minimum:

- mpv revision `f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`;
- Zhongfly build revision `ec05635`;
- any additional corresponding source required by the licenses of covered linked components.

Do not rely solely on continued availability of the third-party binary release as the long-term compliance mechanism.

## Microsoft D3DCompiler

`d3dcompiler_43.dll` is the legacy Microsoft DirectX D3DCompiler runtime included with the Windows mpv build. It remains proprietary Microsoft software and is not relicensed by NetWatch.
