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

## Full archive copies

`archive backup` and `archive copy` duplicate the complete archive. They refuse to write unless the
command includes `--confirm-sensitive`, because a workspace can contain student histories,
recordings, private annotations, and credentials. Check the destination's access controls before
confirming. Use `session export` to transfer one session and its related records instead of copying
the complete workspace.

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

Imported assets are stored as opaque content-addressed blobs. Import records MIME metadata from file
signatures where possible, applies size and folder-count bounds, and does not execute or automatically
extract imported files. User-provided transcripts and imported work are treated as untrusted
content in AI prompts. OpenAI-compatible requests require a separate confirmation against the exact
package SHA-256. The preview displays the complete request body and endpoint before the API key is
read from its named environment variable. That environment value is not persisted by generation.
The exact raw provider response, including error or partial response bytes, is stored in the archive's
AI job record.
