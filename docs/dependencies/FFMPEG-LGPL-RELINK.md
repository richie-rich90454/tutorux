> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# FFmpeg Development and Relink Package

Portable native builds provide two separate install components:

- `Runtime` contains the executable and runtime notices, including FFmpeg's LGPL license and
  security patch provenance.
- `Development` contains FFmpeg's static archives and matching headers, the exact pinned upstream
  source with the security patch applied, the patch itself, a source archive SHA-256 file, and
  configure/build/link metadata.

Install both components after building the matching native preset. For example, on Linux:

```sh
cmake --install build/linux-static --config Release --component Runtime --prefix dist/tutorux-linux
cmake --install build/linux-static --config Release --component Development --prefix dist/tutorux-linux
```

The Development files are under `dist/tutorux-linux/relink/`. Keep the corresponding full Tutorux
GPL source release and this relink package together. The CMake metadata records the target system,
compiler, compile flags, enabled product profile, FFmpeg pin and patch hashes, configure arguments,
static link order, and Tutorux link dependencies for that build.

## Rebuild FFmpeg and relink Tutorux

1. Extract `relink/ffmpeg/FFmpeg-9.0.2-patched-source.tar.gz`. It contains the clean source tree at
   the pinned FFmpeg commit with the shipped CVE patch already applied. The separate patch file and
   provenance note are included for review. Verify the source archive against its adjacent `.sha256`
   file.
2. Modify and rebuild that source with the same target compiler and the configure options in
   `relink/ffmpeg/ffmpeg-build-metadata.txt`. Change `--prefix` to a writable install directory.
   Retain the four static archives and matching headers from the resulting install prefix.
3. Reconfigure the matching full Tutorux source release with the same platform preset and feature
   options, but point `TUTORUX_FFMPEG_PREFIX` to the modified FFmpeg install and turn off the
   automatic FFmpeg fetch. For example:

   ```sh
   cmake --preset portable-static-linux-release \
     -DTUTORUX_FETCH_FFMPEG=OFF \
     -DTUTORUX_FFMPEG_PREFIX=/path/to/modified-ffmpeg
   cmake --build --preset portable-static-linux-release --target tutorux
   ```

   On Windows and macOS, use the corresponding platform preset shown in
   [Portable Static Builds](PORTABLE-STATIC-BUILDS.md). Keep the same compiler, architecture,
   release/debug setting, GUI, Whisper, PDF, llama.cpp and static-runtime options recorded in the
   metadata. The configured target links the replacement FFmpeg archives directly in the recorded
   order; a successful build produces the relinked executable in that build directory.

The relink configure path requires the ordinary static build prerequisites for the selected Tutorux
profile. It recompiles Tutorux from its corresponding GPL source release and links the modified
FFmpeg archives; it does not use the previously distributed executable as an opaque object.

The package contains FFmpeg's LGPL license text, source, and relinking instructions. Release owners
must still include the notices and source or source offers required for the other dependencies in
the full executable's static link closure.
