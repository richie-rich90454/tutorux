# Dependency Pins

The release presets fetch version tags and verify the resulting Git commit before configuring a
dependency. A moved or unexpected tag stops configuration.

Dependabot checks GitHub Actions references weekly. Its pull requests enter the static release
qualification workflow, which builds the configured native and WebAssembly targets and runs the
repository tests where enabled. The separate weekly FetchContent monitor checks that configured
pins still resolve to the expected commits and reports newer GitHub releases for manual review.
It does not modify CMake pins or open runtime dependency update pull requests. The monitor cannot
check remote reachability for the SourceForge giflib repository, and it does not discover
un-pinned package-manager dependencies or produce an SBOM. Package-manager dependency upgrades
remain an explicit release-owner change followed by qualification and SBOM review.

| Dependency | Version | Verified commit |
| --- | --- | --- |
| PoDoFo | 1.1.2 | `e91d8b727763724f3efd96c589c8033f4333c68c` |
| Slint | 1.18.1 | `372cf0ee5577c3dfec309a45e7b778ba4e81b734` |
| Corrosion | 0.6.1 | `1499b14e4906a2890f5cee1547c8848db261753d` |
| whisper.cpp | 1.9.5 | `d1be6fde11ac6e0407606b4e42fe72d34add8037` |
| FFmpeg | 9.0.2 | `946fcce07b6dcd0331c8cc609192aeff5e1924f8` |
| llama.cpp | 0.6.0 | `d812350` |

Linux audio capture uses ALSA's system PCM library and can optionally use PipeWire 0.3.60 or newer
for microphone, sink-monitor, and application-output capture. Dynamic builds link the selected
system packages. Portable static Linux builds require `libasound.a`; PipeWire is included only when
its static library and static dependency metadata are available.

libcurl 7.85 or newer is required for HTTPS requests. The static release links the selected
platform's static libcurl and its static dependency closure; the exact Windows package version is
recorded in the SBOM. TLS certificate verification is enabled for every provider request.

libsodium is required at version 1.0.22 and its version is checked from the selected headers during
configuration. The Windows UCRT64 static archive used for the current release build has SHA-256:

```text
D2DB1DF1CDD4DB9C51F6DCBF9C6FA7D83BBB75D9B00B65814490853B098D59F6  libsodium.a
```

The remaining Windows static-link package versions and license identifiers are listed in
[`WINDOWS-X64-SBOM.md`](WINDOWS-X64-SBOM.md). Other platforms must record the package-manager
versions and artifact hashes used for their release builds in their platform-specific SBOM.
The static WebAssembly CI job uses Emscripten SDK 4.0.10; its build report records the SDK manager
repository revision and the installed package inventory.

FFmpeg's pinned static build applies the upstream fixes for CVE-2026-107678 documented in
[`FFMPEG-CVE-2026-107678.md`](FFMPEG-CVE-2026-107678.md). It uses the LGPLv2.1-or-later
configuration with GPL, version-3-only,
nonfree, network, and shared-library support disabled. Its configured decoder set covers FLAC and
MP3 files and AAC/ALAC audio in M4A containers. The source license text is installed with each
native Runtime package.

For Windows static GUI builds, CMake applies the documented `TUTORUX_STATIC_SLINT` import
compatibility patch to Slint 1.18.1's C++ configuration header. It removes DLL import annotations
from the C++ declarations so they bind to the pinned static Rust library. Configuration fails if
the pinned header shape changes and the patch cannot be safely applied.
