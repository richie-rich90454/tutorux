# Portable privacy behavior

Tutorux writes managed workspace data to the selected `.tux` archive. It does not create a global
archive registry, application settings directory, credential store, extracted workspace, or log
directory. Operating-system services may keep their own files outside the archive.

## Recording consent

Every native recording command requires `--consent`. A recording session stores the confirmation
time, the selected audio source, the endpoint identifier, the `--confirmed-by` label, and policy
version `1`. The label defaults to `not-specified`; it can contain up to 256 bytes on one line.
This records the user's confirmation and does not determine whether recording is lawful in a given
location or circumstance.

The browser microphone recorder requires a separate checked permission confirmation. Its native
audio import records the `browser-microphone` source, confirmation time, and policy version `1` on
the session record.

## Full archive copies

`archive backup` and `archive copy` duplicate the complete archive. They refuse to write unless the
command includes `--confirm-sensitive`, because a workspace can contain student histories,
recordings, private annotations, and credentials. Check the destination's access controls before
confirming. Use `session export` to transfer one session and its related records instead of copying
the complete workspace.

`archive sanitize FILE --output COPY.tux` creates a separate portable archive using privacy-first
defaults. Credentials, recordings, private annotations, and AI generation logs are excluded unless
their `--include-*` option is selected. Student and session filters use UUID lists; excluded students
also exclude their sessions. The copy prunes links to omitted sessions, assets, annotations, evidence,
and guides, and removes audio recording state from sessions when recordings are omitted. Recordings
are selected by their track UUID, shared by all of that track's audio chunks. Use
`--include-recording-tracks UUID,...` to retain only listed tracks, or
`--exclude-recording-tracks UUID,...` to omit listed tracks while retaining the others. Either track
filter opts recordings in; `--include-recordings` retains every track in the selected sessions. The
copy prunes session track references and waveform indexes for omitted tracks. Each copied record
starts with its current live revision, so prior revisions and deleted records are not carried into the
new archive.

The first invocation is a read-only preview that reports selected record counts, the source
generation, and a selection fingerprint. Review the destination and counts, then repeat the command
with `--confirm-sensitive --expected-generation N --expected-selection SHA256 --expected-output
COPY.tux` from that preview. Confirmation fails if the source archive, generation, selection, or
destination changed. The output is written to a
temporary archive, fully verified, and published only if the destination does not already exist.
Encrypted source archives require a destination passphrase through `--new-passphrase-env`; including
credentials always requires an encrypted output. Sanitized copies are still sensitive when they
contain student work or annotations, so protect the destination accordingly.

`archive info` and archive discovery can identify a newer major archive version by reading only its
fixed header. They report `unsupported-version` and its version number without reading archive
records. Open, verify, repair, and data operations continue to reject unsupported major versions.

`archive repair FILE --output COPY.tux --confirm-sensitive` selects the newest consistent archive
generation, validates every reachable record, compacts a separate temporary copy, validates that
copy, and publishes it without replacing the source. It refuses an existing destination. A damaged
reachable record stops repair so the application does not silently discard source evidence.

## Archive encryption and credentials

Archive encryption uses a random 256-bit data key, Argon2id password derivation, and
XChaCha20-Poly1305 authenticated encryption through libsodium. Record payloads, except the public
archive manifest and key-wrapping record, are encrypted. Index pages, commit records, and the
manifest carry keyed authentication tags. Archive display name, description, record framing, index
structure, file size, and update patterns remain visible. A passphrase is required to read or change
encrypted records; the desktop app holds the entered passphrase in memory until it is forgotten or
the app closes.

The CLI reads passphrases from named environment variables, never from a literal command-line
argument. For example, set `TUTORUX_PASSPHRASE` in the current process environment and pass
`--passphrase-env TUTORUX_PASSPHRASE`. Change the passphrase with
`--new-passphrase-env TUTORUX_NEW_PASSPHRASE` as well.

Credentials remain memory-only by default. A user may explicitly store a sensitive setting with
`settings set --key provider-api-key --value-env API_KEY --store-credential`, and only in an
encrypted archive. Credential values are not returned by settings list/get commands; credential-list
returns stored key names only. Remove a saved value with
`settings credential-remove --key provider-api-key`. Plaintext settings imports and raw command-line
credential values are rejected.

## Imported files and AI data

Imported assets are stored as opaque content-addressed blobs. Import rejects symbolic links and
non-regular files when a file is selected directly; folder import skips those entries and does not
follow directory links. Import records MIME metadata from file signatures where possible, applies
size and folder-count bounds, and does not execute or automatically extract imported files.
User-provided transcripts and imported work are treated as untrusted content in AI prompts. Cloud
requests require a separate confirmation against the exact serialized request-body SHA-256,
including any attached asset bytes. The preview displays the complete request body and endpoint
before the API key is read from its named environment variable. That environment value is not
persisted by generation.
The exact raw provider response, including error or partial response bytes, is stored in the archive's
AI job record.
