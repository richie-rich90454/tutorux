# Archive-backed WAV import

`record import --session UUID --input FILE.wav` imports existing audio directly into the selected
`.tux` archive. It does not extract a working copy or alter the source file.

## Accepted input

The importer accepts little-endian RIFF/WAVE files containing PCM 8/16/24/32-bit integer samples or
32-bit IEEE floating-point samples. It accepts WAVE extensible containers for those two subformats,
one or more `data` chunks, one `fmt ` chunk, 1–8 channels, and sample rates from 8 kHz through
384 kHz. Compressed WAV, RF64, and other container formats remain unsupported by this importer.

## Archive records and durability

Audio is stored as interleaved sample frames in `AudioChunk` records, with a maximum raw payload of
1 MiB per chunk. Each record stores a track UUID, sequence number, first sample index, sample count,
sample format, rate, channel count, microsecond range, and payload checksum. The archive's record
checksum also protects the encoded record payload.

Chunks and session progress are committed together in batches of up to eight complete chunks. If a
read or archive write fails, already committed chunks remain available and the session is marked
interrupted. `record recover --session UUID` validates each durable chunk's order, sample range,
format, length, checksum, and expected total. It marks the import completed only when all expected
chunks and samples are present; otherwise it keeps the valid prefix and marks the session
interrupted.

Newly indexed sessions store a secondary archive index by session, track, and sequence number.
Recovery reads and validates one audio chunk at a time, so a multi-gigabyte recording does not need
to be loaded into memory. Older archives without that index use a bounded-memory compatibility scan.
