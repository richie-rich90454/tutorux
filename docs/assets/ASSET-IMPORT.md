# Safe asset import

`asset add FILE [--session UUID]` stores a selected file as opaque bytes in the active `.tux`
archive. `asset import-folder DIR` imports regular files directly inside that folder; it does not
walk subdirectories. Symbolic links and non-regular entries are skipped. Folder imports stop with
an error above 10,000 files, and each asset is bounded below the archive record-size limit so its
metadata and content fit in one record.

Tutorux identifies common PNG, JPEG, GIF, BMP, TIFF, WebP, PDF, Office Open XML, WAV, MP3, FLAC,
Ogg, MP4, WebM, Matroska, and text formats from signatures and conservative extension checks. A
signature mismatch or unrecognized file remains `application/octet-stream`. MIME identification is
descriptive metadata; it does not parse, decompress, render, execute, or trust imported content.

Asset bytes are SHA-256 addressed and stored once per archive. Tutorux hashes the input in bounded
64 KiB reads before looking for an existing blob. When the content is new, it reads the file again
into one bounded archive record and verifies that its size and hash still match before committing
the blob and asset reference together. A source that changes during import is rejected. Each asset
record preserves the UTF-8 source filename, detected MIME type, byte count, content hash, and
optional session relationship. The source file is not modified. `asset verify ID` checks that the
referenced blob is present and matches its stored content hash; `asset extract ID --output FILE` is
an explicit user-requested export.
