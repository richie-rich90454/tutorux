> **Migration reference:** This document describes the former C++/Slint application and is retained as a porting specification. See [the current migration inventory](docs/migration/feature-inventory.md) for TypeScript coverage and active commands.

# macOS app icon

`Tutorux.iconset` is the multi-resolution source for `tutorux.icns`. Each image
is rasterized from the green product mark at `ui/assets/logo.svg` and follows
the filenames expected by macOS `iconutil`.

On a Mac, regenerate the bundle resource with:

```sh
iconutil -c icns resources/macos/Tutorux.iconset -o resources/macos/tutorux.icns
```

CMake embeds that ICNS file in the GUI app bundle. The Slint window and the
Windows, Linux, browser, and PWA icon assets use the same source artwork.
