# macOS app icon

`Tutorux.iconset` is the multi-resolution source for `tutorux.icns`. Each image is rasterized from
the product mark at `frontend/assets/tutorux.svg` and follows the filenames expected by macOS
`iconutil`.

On macOS, regenerate the bundle resource with:

```sh
iconutil -c icns resources/macos/Tutorux.iconset -o resources/macos/tutorux.icns
```

Tauri references `resources/macos/tutorux.icns` for the macOS bundle. The Windows, Linux, browser,
and desktop icon assets use the same artwork.
