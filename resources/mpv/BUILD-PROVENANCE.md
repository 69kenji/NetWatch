# Bundled mpv build provenance

NetWatch redistributes an unmodified GPL-enabled Windows mpv runtime and controls it through mpv's JSON IPC interface.

## Bundled files

| File | SHA-256 |
| --- | --- |
| `mpv.exe` | `46b8c1d0018e218fcbe0c0f927d50df2a120d9a5870b209955daad74ad7d4eab` |
| `mpv.com` | `834ad358dfdf562db2215144035e1ca911d61f85853317af86f49132f3c1feb3` |
| `d3dcompiler_43.dll` | `4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345` |

Bundled mpv version:

```text
mpv v0.41.0-922-gf4d13e1c2
```

mpv source revision:

```text
f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47
```

Source:

```text
https://github.com/mpv-player/mpv/tree/f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47
```

## Windows build

The bundled runtime is from Zhongfly's `mpv-winbuild` release:

```text
Release: 2026-08-13-f4d13e1c2c
Asset: mpv-x86_64-v3-20260813-git-f4d13e1c2c.7z
Zhongfly build-repository revision: ec05635
GitHub Actions build: 31698098358
Compiler: clang
```

Release/build projects:

```text
https://github.com/zhongfly/mpv-winbuild/releases/tag/2026-08-13-f4d13e1c2c
https://github.com/zhongfly/mpv-winbuild
https://github.com/shinchiro/mpv-winbuild-cmake
```

The build has mpv's GPL feature enabled and is therefore distributed under GPL-2.0-or-later. See `Copyright.txt` and `LICENSE.GPL-2.0` in this directory.

## Corresponding source

A distributor of the NetWatch binary package must satisfy the GPL corresponding-source requirements for this mpv build and its covered linked components.

For the public NetWatch release, preserve or publish the source/build materials needed to reproduce the bundled runtime, including at minimum:

- mpv revision `f4d13e1c2c91f3a56e589aef9cb44cbc02e26e47`;
- Zhongfly build revision `ec05635`;
- any additional corresponding source required by the licenses of covered linked components.

Do not rely solely on continued availability of the third-party binary release as the long-term compliance mechanism.

## Microsoft D3DCompiler

`d3dcompiler_43.dll` is the legacy Microsoft DirectX D3DCompiler runtime included with the Windows mpv build. It remains proprietary Microsoft software and is not relicensed by NetWatch.
