# Windows x64 Static Release Software Bill of Materials

This inventory describes the UCRT64 Windows x64 static release. Tutorux links its third-party
libraries into the executable. The post-link verifier rejects shared dependencies outside the
Windows system directories. Windows system DLLs, graphics facilities, audio endpoints, and device
drivers remain supplied by the operating system.

Dependency versions and license identifiers below come from the MSYS2 UCRT64 package metadata
used by this build. The fetched source dependencies are pinned by version tag and verified Git
commit.

## Tutorux dependencies

| Component | Version | Linkage | License metadata |
| --- | --- | --- | --- |
| libsodium | 1.0.22 | Static | ISC |
| libcurl | 8.21.0 | Static | curl license |
| PoDoFo | 1.1.2 | Static | LGPL-2.0-or-later OR MPL-2.0 for the library |
| Slint | 1.18.1 | Static | GPL-3.0-only, Slint Royalty-free 2.0, or commercial license |
| whisper.cpp and ggml | 1.9.5 | Static | MIT |

PoDoFo is built in library-only mode with AFDKO and TIFF support disabled. Both library license
texts and its upstream notice are installed with the runtime package. The source commit is
`e91d8b727763724f3efd96c589c8033f4333c68c`:
[PoDoFo licensing](https://github.com/podofo/podofo#licensing).

The source commits for Slint and whisper.cpp are
`372cf0ee5577c3dfec309a45e7b778ba4e81b734` and
`d1be6fde11ac6e0407606b4e42fe72d34add8037`, respectively. Slint's About dialog exposes the
`AboutSlint` widget and the package includes Slint's license files. The repository does not yet
select Tutorux's own license or a Slint redistribution route; both remain required before publishing
this package:
[Slint license terms](https://slint.dev/terms-and-conditions).

## Statically linked UCRT64 libraries

| Package | Version | SPDX/license metadata |
| --- | --- | --- |
| Brotli | 1.2.0 | MIT |
| bzip2 | 1.0.8 | Custom |
| FreeType | 2.14.3 | GPL-2.0-or-later OR FTL |
| GCC runtime | 16.2.0 | GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later |
| Gettext runtime | 1.0 | GPL-3.0-or-later AND LGPL-2.1-or-later |
| GLib | 2.88.3 | LGPL-2.1-or-later |
| Graphite2 | 1.3.15 | LGPL-2.1-or-later |
| HarfBuzz | 14.3.1 | MIT |
| GNU libiconv | 1.19 | LGPL-2.1-or-later |
| GNU libidn2 | 2.3.8 | GPL-2.0-or-later |
| libjpeg-turbo | 3.2.0 | BSD-like |
| libpng | 1.6.58 | Custom |
| libpsl | 0.21.5 | MIT |
| libssh2 | 1.11.1 | BSD-3-Clause |
| libunistring | 1.4.2 | LGPL-3.0-or-later OR GPL-3.0-or-later |
| MinGW winpthreads | 14.0.0.r302.gd7f3c5201 | MIT AND BSD-3-Clause-Clear |
| libxml2 | 2.15.3 | MIT |
| nghttp2 | 1.70.0 | MIT |
| nghttp3 | 1.18.0 | MIT |
| ngtcp2, including the OpenSSL crypto adapter | 1.25.0 | MIT |
| OpenSSL | 3.6.3 | Apache-2.0 |
| PCRE2 | 10.47 | BSD-3-Clause |
| zlib | 1.3.2 | Zlib |
| Zstandard | 1.5.7 | BSD-3-Clause OR GPL-2.0-or-later |

The `Runtime` install component includes the dependency license texts and source notices alongside
the executable. The UCRT64 libidn2 package does not install its GPL text, so CMake includes the
standard GPL-2.0 text shipped with the UCRT64 xz license bundle when libidn2 is in libcurl's static
dependency closure. This inventory records the configured release inputs; it is not a substitute
for reviewing the packaged license files. Release qualification also requires a selected Tutorux
license and a recorded Slint licensing route.
