# Portable Static Builds

The `portable-static-*` presets build Tutorux Full and its selected third-party dependencies into
one native executable. They are available for Windows, Linux, and macOS hosts. Each preset enables
the Slint desktop interface, Whisper, PDF export, and the embedded llama.cpp runtime. The
`portable-compact-*` presets include the same desktop features without llama.cpp. Both profiles
verify the executable's runtime dependency list after linking.

The verifier rejects unresolved libraries and shared dependencies outside the operating system's
native library locations. Windows system DLLs, Linux system libraries, and macOS system libraries
and frameworks remain provided by the target operating system. They include facilities such as
the C runtime, graphics stack, audio devices, and platform security services. Tutorux does not
bundle operating system libraries or device drivers.

## Presets

Use the preset matching the machine on which the executable will run:

| Host | Release | Debug |
| --- | --- | --- |
| Windows | `portable-static-release` / `portable-compact-release` | `portable-static-debug` / `portable-compact-debug` |
| Linux | `portable-static-linux-release` / `portable-compact-linux-release` | `portable-static-linux-debug` / `portable-compact-linux-debug` |
| macOS | `portable-static-macos-release` / `portable-compact-macos-release` | `portable-static-macos-debug` / `portable-compact-macos-debug` |

For example, on Linux:

```sh
cmake --preset portable-static-linux-release
cmake --build --preset portable-static-linux-release
ctest --preset portable-static-linux-release
cmake --install build-linux-static --config Release --component Runtime --prefix dist/tutorux-linux
```

On macOS, use the corresponding `portable-static-macos-release` preset and `build-macos-static`
directory. The original Windows preset expects a UCRT64 MinGW toolchain with the pinned static
dependencies described in [the Windows SBOM](WINDOWS-X64-SBOM.md).

## Third-party inputs

Static Linux builds also require the ALSA development headers and a static `libasound` archive.
The executable is linked with the platform C++ runtime and native libraries statically; operating
system APIs remain external. Static macOS builds use the system CoreAudio frameworks.

Static Linux and macOS builds require static development archives for libsodium 1.0.22, libcurl
7.85 or newer and its TLS/protocol dependencies, FreeType, and libxml2. CMake builds pinned
PoDoFo, Slint, whisper.cpp, llama.cpp (Full only), and Corrosion from source. `pkg-config` must report the static
dependency closure for libcurl, FreeType, and libxml2. Provide package-manager prefixes through
`CMAKE_PREFIX_PATH` and/or `PKG_CONFIG_PATH` when those packages are not in standard locations.
The build fails when a required static archive or pinned dependency is unavailable.

Run the release build on each target operating system and architecture. Record exact package
versions and hashes in a platform-specific SBOM before distributing that build. A build produced
on one operating system is not a cross-compiled binary for the others.

Static linkage does not select Tutorux's product license or the license route for Slint. Those
decisions are still required before publication; see [the Windows SBOM](WINDOWS-X64-SBOM.md) for
the current Windows dependency inventory.

The Full profile contains the inference runtime but no model weights. Users select GGUF files
explicitly, and Tutorux resolves relative model paths beside the active archive. Compact keeps
external Ollama and llama.cpp server workflows. The macOS Full preset enables llama.cpp Metal;
CUDA and Vulkan can be enabled for supported toolchains with `TUTORUX_LLAMA_CUDA` and
`TUTORUX_LLAMA_VULKAN`.
