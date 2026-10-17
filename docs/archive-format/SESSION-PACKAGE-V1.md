# Tutorux Session Transfer Package v1

A session transfer package is a standard v1 `.tux` archive. It is directly readable by Tutorux and
does not use a sidecar folder, extraction directory, or separate interchange database.

## Package manifest

The package's settings record whose ID matches the archive header ID includes:

| Field | Value |
| --- | --- |
| `record_role` | `tutorux-session-package` |
| `package_version` | `1` |
| `source_session_id` | UUID of the session in its source archive |

The package must pass full archive verification and contain exactly one active session. It may
contain audio chunks, transcript segments, annotations, asset metadata and blobs, evidence nodes and
edges, guides, and AI jobs associated with that session. Revision chains are retained for each
included record. The student's profile is intentionally omitted so a transfer cannot silently copy
a student's archive-owned profile.

## Export and import

`session export ID --output FILE.tux` writes a temporary archive beside the destination, verifies
it, and publishes it atomically. An existing destination is preserved unless `--force` is given.

`session import FILE.tux` validates the package before writing. It assigns fresh UUIDs to imported
records, rewrites references among included records, and commits their revision chains as one archive
transaction.
If the source student exists in the destination archive, the imported session keeps that link. If
not, it uses `anonymous`; `--student-id UUID` explicitly links it to an existing destination
student. Import never overwrites a record already in the destination archive.
