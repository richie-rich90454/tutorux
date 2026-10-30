# Archive fixtures

## `encrypted-v1.tux`

This 3,080-byte fixture was produced by the original C++ archive implementation using
`archive encrypt`. It contains synthetic data for one student named `Interop Student`.
The fixture passphrase is `Tutorux cross-language fixture phrase 2026`; it is test-only and must
not be reused for real archives. Its SHA-256 digest is
`d34bacb56ac1a5fcc12f8aec43c021749c1ec96b78f923bedfc5a188d89bdc9f`.

The original implementation has been removed, so this file is retained unchanged as a
compatibility fixture. The crypto interoperability test unwraps it, verifies its manifest,
index-page, and commit MACs, and decrypts the student record written by that implementation.

## Audio fixtures

`tone-997hz.flac`, `tone-997hz.mp3`, and `tone-997hz.m4a` are synthetic tone files used by
import, playback, and FFmpeg-decoding tests.
