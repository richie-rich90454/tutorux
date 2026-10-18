# Portable Static Builds

The `portable-static-*` presets build Tutorux Full and its selected third-party dependencies into
one native executable. They are available for Windows, Linux, and macOS hosts. Each preset enables
the Slint desktop interface, Whisper, PDF export, and the embedded llama.cpp runtime. The
static release profiles also build pinned FFmpeg for local FLAC, MP3, and M4A decoding. The
`portable-compact-*` presets include the same desktop features without llama.cpp. Both profiles
verify the executable's runtime dependency list after linking.

The verifier rejects unresolved libraries and shared dependencies outside the operating system's
native library locations. Windows system DLLs, Linux system libraries, and macOS system libraries
and frameworks remain provided by the target operating system. They include facilities such as
the C runtime, graphics stack, audio devices, and platform security services. Tutorux does not
bundle operating system libraries or device drivers.

## Presets

Use the preset matching the target architecture. Release presets are explicit for each native
target; Linux ARM64 also has a cross-compile preset for Linux hosts:

| Target | Full release | Compact release |
| --- | --- | --- |
| Windows x86-64 | `portable-static-windows-x64-release` | `portable-compact-windows-x64-release` |
| Windows ARM64 | `portable-static-windows-arm64-release` | `portable-compact-windows-arm64-release` |
| Linux x86-64 | `portable-static-linux-x64-release` | `portable-compact-linux-x64-release` |
| Linux ARM64 | `portable-static-linux-arm64-release` | `portable-compact-linux-arm64-release` |
| macOS Intel (x86-64) | `portable-static-macos-x64-release` | `portable-compact-macos-x64-release` |
| macOS Apple Silicon (ARM64) | `portable-static-macos-arm64-release` | `portable-compact-macos-arm64-release` |

The Linux ARM64 cross presets are `portable-static-linux-arm64-cross-release` and
`portable-compact-linux-arm64-cross-release`. They require an AArch64 compiler, archiver, Ubuntu
24.04-compatible sysroot, and static dependency prefix. Set `TUTORUX_LINUX_AARCH64_ROOT`,
`TUTORUX_LINUX_AARCH64_SYSROOT`, `TUTORUX_LINUX_AARCH64_C_COMPILER`, and
`TUTORUX_LINUX_AARCH64_CXX_COMPILER`; optionally set `TUTORUX_LINUX_AARCH64_AR`,
`TUTORUX_LINUX_AARCH64_RANLIB`, and `TUTORUX_LINUX_AARCH64_PKGCONFIG_LIBDIR`. The sysroot must
include target pkg-config metadata and the package database used for license collection.
For a source-built libsodium prefix, also set `TUTORUX_SODIUM_SOURCE_COMMIT` to the exact commit
used to produce its static archive.

Windows ARM64 uses the native MSYS2 `CLANGARM64` environment in release qualification. Its
dependency provisioning installs LLVM/Clang, CMake, Ninja, pkgconf, libsodium, curl, FreeType,
libxml2, OpenSSL, JPEG, PNG, and zlib in `/clangarm64`; the preset sets this as
`TUTORUX_WINDOWS_ARM64_PREFIX` and uses the `aarch64-pc-windows-gnullvm` Rust target. For local or
cross builds, `cmake/toolchains/windows-arm64-llvm-mingw.cmake` also accepts a standalone
LLVM-MinGW prefix. The Windows x86-64 target remains based on MSYS2 UCRT64.

The macOS presets set `CMAKE_OSX_ARCHITECTURES` to one architecture and target macOS 13.0 or newer.
Do not combine the Intel and Apple Silicon binaries into a universal executable unless their
dependency archives are separately built for both architectures.

For example, on Linux:

```sh
cmake --preset portable-static-linux-x64-release
cmake --build --preset portable-static-linux-x64-release
ctest --preset portable-static-linux-x64-release
cmake --install build-linux-static --config Release --component Runtime --prefix dist/tutorux-linux
cmake --install build-linux-static --config Release --component Development --prefix dist/tutorux-linux
```

The `Development` component contains FFmpeg's LGPL source, applied security patch, static archives,
matching headers, and relink metadata. Keep it with the matching full Tutorux GPL source release;
see [the FFmpeg relink guide](FFMPEG-LGPL-RELINK.md). Linux and macOS Runtime installation checks
the generated dependency manifest and stops when a linked archive lacks package provenance or a
redistributable license text.

The legacy OS-only preset names remain for existing local workflows. The Windows x86-64 preset
expects the UCRT64 MinGW toolchain and static dependencies described in
[the Windows SBOM](WINDOWS-X64-SBOM.md).

After installing the macOS runtime, create an unsigned `.app` bundle with the packaging helper:

```sh
cmake \
  -DTUTORUX_RUNTIME_DIR=dist/macos-runtime \
  -DTUTORUX_APP_BUNDLE_DIR=dist/Tutorux.app \
  -DTUTORUX_APP_VERSION=1.0.0 \
  -P cmake/PackageMacOSApp.cmake
```

The bundle includes `Info.plist` privacy descriptions for microphone and system-audio access and
copies the installed license notices into `Contents/Resources`. The helper leaves the bundle
unsigned by default. To sign, pass `-DTUTORUX_CODESIGN_IDENTITY="Developer ID Application: …"` and
have that signing identity available in the macOS keychain; the helper runs `codesign` and verifies
the result. Signing does not notarize the app. `TUTORUX_MIN_MACOS_VERSION` is optional because the
release minimum still needs to be selected; without it, the helper does not assert an OS baseline.

## Qualification status

The proposed compatibility baselines are Windows 10 22H2 (x86-64), Windows 11 24H2 (ARM64), macOS
13 Ventura (both architectures), and Ubuntu 24.04 with glibc 2.39 or newer (x86-64 and ARM64).
These are release targets, not validation claims. The preset matrix and cross-toolchain hooks have
not yet been qualified on all six native OS/architecture combinations. Windows ARM64 now has a
native `windows-11-arm` CLANGARM64 Full and Compact workflow job; it fails unless the output is an
ARM64 PE executable and the package license tree is present. A configured workflow is not
qualification evidence until its run passes. The macOS CI artifact is unsigned; signing requires an
installed Developer ID identity, and notarization is not automated. The separate static WebAssembly
job records a successful build package when it passes, but does not run CTest or a browser
compatibility suite.

## Third-party inputs

Static Linux builds also require the ALSA development headers and a static `libasound` archive.
PipeWire capture is included when a static `libpipewire-0.3` library and its static dependency
closure are available; otherwise the build retains ALSA capture. The PipeWire service remains an
operating-system prerequisite when that backend is used. The executable is linked with the platform
C++ runtime and native libraries statically; operating system APIs remain external. Static macOS
builds use the system CoreAudio frameworks.

Static Linux and macOS builds require static development archives for libsodium 1.0.22, libcurl
7.85 or newer and its TLS/protocol dependencies, FreeType, and libxml2. CMake builds pinned
PoDoFo, Slint, whisper.cpp, FFmpeg, llama.cpp (Full only), and Corrosion from source. FFmpeg is
configured with a static, file-only decoder set for FLAC, MP3, and AAC/ALAC inside M4A containers;
network protocols, GPL components, and nonfree components are disabled. `pkg-config` must report the static
dependency closure for libcurl, FreeType, and libxml2. Provide package-manager prefixes through
`CMAKE_PREFIX_PATH` and/or `PKG_CONFIG_PATH` when those packages are not in standard locations.
The build fails when a required static archive or pinned dependency is unavailable.

Run the release build on each target operating system and architecture. The CI artifact records
the runner, package-manager inventory, executable size, and SHA-256. Linux and macOS Runtime
installation also collects package ownership, source package or formula metadata, static archive
hashes, and full license/copyright texts. A build produced on one operating system is not a
cross-compiled binary for the others.

Tutorux is GPL-3.0-only, and the pinned Slint desktop interface uses its GPLv3 licensing route.
Runtime installers include the Tutorux license and the third-party license files configured for
that build. The Windows UCRT64 Runtime also installs the license directories for its enumerated
static package closure. Linux and macOS Runtime installation is blocked when package ownership or
license texts cannot be collected; see [the release license collection guide](STATIC-RELEASE-LICENSE-COLLECTION.md). See
[the Windows SBOM](WINDOWS-X64-SBOM.md) for the verified Windows dependency inventory.

The Full profile contains the inference runtime but no model weights. Users select GGUF files
explicitly, and Tutorux resolves relative model paths beside the active archive. Compact keeps
external Ollama and llama.cpp server workflows. The macOS Full preset enables llama.cpp Metal;
CUDA and Vulkan can be enabled for supported toolchains with `TUTORUX_LLAMA_CUDA` and
`TUTORUX_LLAMA_VULKAN`.
