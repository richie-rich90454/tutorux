> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Static Release License Collection

This guide describes the license files currently installed by CMake and the additional collection
needed for complete release notices. A package inventory or an SBOM entry containing an SPDX
identifier does not include the corresponding license text.

## What CMake installs

Every native `Runtime` install includes `licenses/Tutorux/LICENSE`. With the portable static GUI
presets, CMake also installs the fetched-source notices that are wired into the install rules:

- PoDoFo's `COPYING.LGPL`, `COPYING.MPL`, and `NOTICE`;
- Slint's `LICENSE.md` and contents of its `LICENSES` directory;
- whisper.cpp's `LICENSE`;
- FFmpeg's `COPYING.LGPLv2.1` and the security patch provenance note (the pinned build enables no
  GPL or nonfree components);
- for Full builds, llama.cpp's root `LICENSE`, which covers its `ggml` subproject in the pinned
  source release.

The Windows UCRT64 MinGW Runtime additionally copies the available license directories for the
static package closure enumerated in `TUTORUX_MINGW_LICENSES` in `CMakeLists.txt`. If libcurl's
static closure includes libidn2, CMake also installs the GPL-2 license text from the UCRT64 xz
package. The installed `WINDOWS-X64-SBOM.md` documents that target's package inventory. The exact
set still depends on the configured libcurl closure and package contents; review the resulting
`licenses/` directory when preparing a release.

The WebAssembly `WebRuntime` has separate install rules for zlib, libpng, giflib, libwebp and the
WebP patent grant, as well as the Tutorux license. Those files describe the browser artifact's
bundled source dependencies; they do not describe the native desktop Runtime.

## Linux and macOS package dependencies

For Linux and macOS static Runtime builds, CMake resolves the configured libcurl, FreeType, libxml2,
PoDoFo, and ALSA archive closure, hashes each archive, and writes a per-target SBOM. Linux builds
map each archive through `dpkg-query` to its binary and source package versions and copy the package
`copyright` files. Cross builds use the sysroot's dpkg database and documentation. The pinned
source-built libsodium archive records its source commit, archive hash, and installed license text.

macOS builds resolve each archive to its Homebrew Cellar formula, record formula version, upstream
source URL, source checksum, license identifier, and archive hash, then copy the installed license
and notice files. The Homebrew SPDX identifier supplements the full text; it does not replace it.

The collector records unresolved archives in the SBOM and marks the collection incomplete if an
archive has no package owner, source metadata, or installed license text. CMake permits compilation
so developers can inspect the result, but the `Runtime` install component fails until collection is
complete. This also applies to macOS app bundles because the packaging helper copies only an installed
Runtime. Cross Linux sysroots must contain `/var/lib/dpkg` and the package documentation for the
target architecture. The installed `licenses/static-dependencies/` directory contains the complete
texts associated with its generated manifest.

The SBOM describes the configured CMake static closure and the package provenance available from
dpkg or Homebrew. The release workflow separately records package inventory and executable hash.
Keep those files with the matching artifact; do not reuse one target's SBOM for another OS or
architecture.

For FFmpeg's LGPL static relinking materials, install the separate `Development` component and
follow [the FFmpeg relink guide](FFMPEG-LGPL-RELINK.md). It includes the pinned source with the CVE
patch applied, static archives, matching headers, and build metadata.
