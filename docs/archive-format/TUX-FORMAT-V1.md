# Tutorux Archive Format v1

This document defines the initial `.tux` wire format used by this implementation. All integer
fields are unsigned or two's-complement signed integers encoded little-endian. Text is UTF-8.
Offsets are absolute byte offsets from the start of the file. Records are eight-byte aligned.
Readers must validate all lengths and arithmetic before allocating or seeking.

## Limits

| Item | Limit |
| --- | ---: |
| Header size | 64 bytes |
| Record header size | 64 bytes |
| Maximum ordinary record payload | 256 MiB |
| Maximum index key | 192 bytes |
| Maximum B+ tree depth | 32 pages |
| Recovery locator search window | 64 MiB from EOF |

Audio and asset data is represented by independently addressable records so a recording does not
need to be rewritten for an unrelated edit. Implementations may stream those records; they must
not allocate from an unvalidated on-disk length.

## Archive header

The first 64 bytes are immutable after initialization:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | Magic `TUTORUX\0` |
| 8 | 2 | Major version (`1`) |
| 10 | 2 | Minor version (`0`) |
| 12 | 4 | Header length (`64`) |
| 16 | 16 | Archive UUID |
| 32 | 8 | Creation time, Unix microseconds |
| 40 | 8 | Capability flags |
| 48 | 12 | Reserved, zero in v1 |
| 60 | 4 | CRC-32/IEEE of bytes 0..59 |

Capability bit `0x1` declares that protected record payloads use archive encryption. Unknown
capability bits are preserved. A reader may open a newer minor version only when all
required capability bits are understood. A newer major version is never opened for writing.

## Record framing

Each record begins at an eight-byte-aligned offset and has this 64-byte header:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | Magic `TXRC` |
| 4 | 2 | Record type |
| 6 | 2 | Record version |
| 8 | 4 | Header length (`64`) |
| 12 | 8 | Payload length |
| 20 | 16 | Logical object UUID |
| 36 | 8 | Object revision |
| 44 | 8 | Previous revision record offset, or zero |
| 52 | 1 | Codec (`0` = none) |
| 53 | 1 | Flags |
| 54 | 2 | Reserved, zero in v1 |
| 56 | 4 | CRC-32/IEEE of the payload |
| 60 | 4 | CRC-32/IEEE of bytes 0..59 |

The payload follows the header. The next record begins at `align8(offset + 64 + payload_length)`.
Padding bytes are zero and are not included in checksums. Readers reject a payload length above the
configured record limit, an overflowing end offset, an unknown codec, or a checksum mismatch.

Record types are stable 16-bit values: student `1`, session `2`, audio chunk `3`, transcript
segment `4`, annotation `5`, asset metadata `6`, asset blob `7`, evidence node `8`, evidence edge
`9`, guide `10`, settings `11`, AI job `12`, encryption metadata `13`, index page `250`, and commit
`251`. Unknown record types are skipped when framing is valid and are preserved by compaction when
reachable.

Domain metadata payloads begin with a 4-byte schema magic, a 16-bit schema version, a 16-bit field
count, then fields sorted by key. Each field is a 16-bit key length, a 32-bit value length, UTF-8
key bytes, and UTF-8 value bytes. The remainder is an opaque blob. Keys are unique within a record.

`AudioChunk` records store their encoded samples in the opaque blob. The v1 WAV importer writes
uncompressed PCM there and records `session_id`, `track_id`, `sequence_number`, `first_sample_index`,
`sample_count`, `timeline_start_us`, `timeline_end_us`, `sample_format`, `sample_rate_hz`,
`channel_count`, `channel_mask`, `codec`, and `payload_checksum` as metadata. The payload checksum is
CRC-32/IEEE over the opaque sample bytes; the enclosing record checksum protects the full metadata
and blob payload.

Writers also index each valid audio chunk by session, track, and zero-padded 20-digit sequence under
`AUDIOSESSION:<session-uuid>:<track-uuid>:<sequence>`. The session record stores
`audio_chunk_index_version=1` in the same committed transaction. This lets
recovery stream chunks in timeline order while holding only one chunk payload at a time. Readers
encountering older sessions without the marker scan the primary audio-chunk index and sort compact
chunk references before validating payloads. The secondary index is rebuilt during compaction and is
covered by full archive verification.

## Optional archive encryption

Encryption is declared by archive capability bit `0x1`. Record flag bit `0x1` marks an encrypted
record payload; other flag bits are reserved and must be zero in v1. The header, record headers,
record lengths, object UUIDs, revision links, and CRCs remain readable so readers can discover and
recover the archive structure without a passphrase.

The archive owns a random 32-byte data-encryption key. The passphrase is processed with Argon2id13
using the libsodium interactive work profile. Each archive stores the selected operation and memory
limits so readers can reproduce the derivation; readers reject values outside the supported range.
The derived 32-byte key wraps the archive data key with XChaCha20-Poly1305. A fresh 16-byte salt
and 24-byte nonce are generated for each wrapping. The envelope is an `Encryption` record (type
`13`) whose UUID is the archive UUID and whose fields are `encryption_version=1`, `kdf=argon2id13`,
`aead=xchacha20-poly1305-ietf`, hex `salt`, hex `nonce`, hex `wrapped_key`, `opslimit`, and
`memlimit`. Its associated data is `TUTORUX-ARCHIVE-KEY-V1` followed by the archive UUID.

All domain record payloads are encrypted except the archive manifest (`Settings` with the archive
UUID) and the key-wrapping metadata record. A protected payload consists of a fresh 24-byte nonce,
the ciphertext, and the 16-byte Poly1305 tag. Associated data is the byte sequence
`TUTORUX-RECORD-V1`, archive UUID, record type, record UUID, revision, and previous-revision offset
in little-endian integer encoding. The record CRC covers the resulting nonce and ciphertext bytes;
authenticated decryption is required before decoding the record payload.

The plaintext manifest contains the ordinary archive display metadata and a `manifest_auth` field.
The field is a hex HMAC-SHA-256 over the serialized manifest without `manifest_auth`, prefixed by
the domain label `TUTORUX-MANIFEST-V1`. Every serialized index page is followed by a 32-byte
HMAC-SHA-256 using `TUTORUX-INDEX-PAGE-V1`; every commit payload is followed by a 32-byte
HMAC-SHA-256 using `TUTORUX-COMMIT-V1`. These tags use the archive data key. MAC comparisons are
constant-time. CRCs detect accidental damage; they do not replace the authentication tags.

Compaction and passphrase changes rewrite the archive through an atomic same-directory replacement.
Changing the passphrase rewraps the same data key with a new salt and nonce, then compacts away the
old wrapping record. A locked encrypted archive may be discovered and copied byte-for-byte, but its
records cannot be read, modified, or verified until it is unlocked.

Encryption does not conceal the archive display name and description, archive UUID, record types,
object UUIDs, revision numbers, approximate payload sizes, offsets, index keys and shape, commit
generations, file size, or update timing. Applications must not describe an encrypted archive as
metadata-private.

## Copy-on-write B+ tree pages

Index page records contain `TXPG`, a 16-bit page version (`1`), a one-byte kind (`0` leaf, `1`
internal), a one-byte reserved field, and a 16-bit entry count, followed by the page entries.
Leaf entries are `(u16 key_length, key bytes, u64 record_offset)`. Internal pages contain a first
child offset followed by `(u16 separator_length, separator bytes, u64 right_child_offset)` pairs.
Every separator is the smallest key reachable from its right child. Keys are bytewise ordered
UTF-8 and unique. A page must fit in the ordinary record size limit and contain at least one key,
except for an empty root leaf.

The index maps `TYPE:uuid` keys to the latest record offset. A tombstone is a normal latest domain
record with its `_deleted` field set to `true`; older revisions remain reachable through the
previous-revision offset. Index mutations write only the modified root-to-leaf path and any split
pages. Committed index pages and domain records are immutable.

## Commit records and locators

A commit payload is `TXCM`, version `1`, reserved `0`, generation, previous commit offset, index
root offset, 32-byte SHA-256 of the serialized root page payload, transaction UUID, committed
domain-record count, and archive version. The enclosing record CRC protects the commit payload.

After flushing the commit record, the writer appends a 32-byte locator:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 8 | Magic `TUXLOC1\0` |
| 8 | 8 | Commit record offset |
| 16 | 8 | Generation |
| 24 | 4 | CRC-32/IEEE of bytes 0..23 |
| 28 | 4 | Reserved, zero |

The locator is flushed before success is reported. Readers scan backward in the bounded recovery
window for valid locators, then validate the referenced commit and root page. If the newest
candidate is invalid, they follow the previous-commit chain and select the newest valid generation.
Full recovery may scan the file when no locator in the normal window is usable.

## Transactions, locking, and forward compatibility

One process holds an OS-backed exclusive archive lock while appending. Readers open the last
committed root and ignore the uncommitted tail. A transaction writes domain records, any new B+
tree pages, the commit, and its locator in that order. The commit and locator are both flushed before
the writer reports durable success.

An implementation must never rewrite committed records in place. Compaction writes a verified
replacement archive beside the source and publishes it atomically where the filesystem permits.
Unknown reachable record types and revisions must be retained by a preserving compactor.
