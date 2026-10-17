# Dependency Pins

The release presets fetch version tags and verify the resulting Git commit before configuring a
dependency. A moved or unexpected tag stops configuration.

| Dependency | Version | Verified commit |
| --- | --- | --- |
| PoDoFo | 1.1.2 | `e91d8b727763724f3efd96c589c8033f4333c68c` |
| Slint | 1.18.1 | `372cf0ee5577c3dfec309a45e7b778ba4e81b734` |
| Corrosion | 0.6.1 | `1499b14e4906a2890f5cee1547c8848db261753d` |
| whisper.cpp | 1.9.5 | `d1be6fde11ac6e0407606b4e42fe72d34add8037` |

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

For Windows static GUI builds, CMake applies the documented `TUTORUX_STATIC_SLINT` import
compatibility patch to Slint 1.18.1's C++ configuration header. It removes DLL import annotations
from the C++ declarations so they bind to the pinned static Rust library. Configuration fails if
the pinned header shape changes and the patch cannot be safely applied.
