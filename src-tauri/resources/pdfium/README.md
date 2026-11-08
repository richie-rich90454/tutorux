# PDFium runtime

Tutorux uses PDFium to render scanned PDF pages for local OCR. The runtime is
embedded into the application executable, so the portable build has no separate
DLL.

The Windows runtime is committed for reproducible Windows builds. On macOS and
Linux, run:

```sh
pnpm run pdfium:fetch
```

The script downloads the platform build from
[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries)
at the pinned Chromium/PDFium release and places the shared library in this
directory so it can be embedded at compile time.

Supported layouts:

- Windows: `pdfium.dll`
- macOS: `libpdfium.dylib`
- Linux: `libpdfium.so`

PDFium is licensed under BSD-3-Clause. See `LICENSE` in this directory and the
credits in the repository README.
