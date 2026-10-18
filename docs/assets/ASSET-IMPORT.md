# Safe asset import

`asset add FILE [--session UUID]` stores a selected file as opaque bytes in the active `.tux`
archive. `asset import-folder DIR` imports regular files directly inside that folder; it does not
walk subdirectories. Symbolic links and non-regular entries are skipped. Folder imports stop with
an error above 10,000 files. Individual files are limited to 1 TiB and stored as bounded archive
chunks so large source assets do not need to fit in memory or in one archive record.

Tutorux identifies common PNG, JPEG, GIF, BMP, TIFF, WebP, PDF, Office Open XML, WAV, MP3, FLAC,
Ogg, MP4, WebM, Matroska, and text formats from signatures and conservative extension checks. A
signature mismatch or unrecognized file remains `application/octet-stream`. MIME identification is
descriptive metadata; it does not parse, decompress, render, execute, or trust imported content.

Asset bytes are SHA-256 addressed and stored once per archive. Tutorux hashes the input in bounded
64 KiB reads before looking for an existing blob. New content is read a second time in 8 MiB chunks,
hashed as it is appended, and rejected if the source changed. Chunk records are committed in small
batches; the manifest and logical asset reference are published only after every chunk is present.
An interrupted import can leave unreferenced immutable chunks, which archive compaction reclaims.
Each asset record preserves the UTF-8 source filename, detected MIME type, byte count, content hash,
and optional session relationship. `asset verify ID` streams and checks every chunk and the complete
SHA-256. `asset extract ID --output FILE` streams verified content to a temporary sibling file and
publishes it only after validation. Legacy v1 archives containing one-record asset blobs remain
readable.
