# Portable privacy

Tutorux is local-first. A workspace is a `.tutor` SQLite database on the user's device. Tutorux does not provide an account, a hosted service, or background synchronization.

## Data at rest

Plain workspaces are ordinary SQLite databases. When the user enables the passphrase option at creation or in Settings, the database is encrypted with SQLCipher.

- SQLCipher encrypts the database pages, indexes, and BLOBs.
- The in-memory key is zeroized when the workspace closes.
- The passphrase is never written to the database or to browser local storage.
- Encrypted backups preserve encryption.
- Losing the passphrase means losing access to the workspace; there is no recovery key server.

## Credentials

AI provider keys are stored in the operating-system credential store through `keyring`. Calendar OAuth tokens, Google/Microsoft client secrets, and CalDAV app-specific passwords use the same credential store. They are not written to the workspace file.

Local GGUF, Whisper, and OCR models stay on the device. Local generation, transcription, and OCR do not upload lesson content.

## Cloud AI

Cloud AI requests use the native Rust transport, not direct browser fetches. Before sending:

- the selected session context is assembled locally;
- the Assistant shows a request preview;
- the user must explicitly confirm that the context may leave the device;
- the endpoint must pass the provider allowlist and route validation;
- redirects are disabled and request/response sizes are bounded.

Supported cloud providers include OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Z.AI, MiniMax, Alibaba Cloud/Qwen, Moonshot, NVIDIA, Cerebras, SambaNova, Novita, Nebius, DeepInfra, SiliconFlow, and others in the provider registry. Availability depends on a valid key and provider route.

## Calendar credentials

- Google and Microsoft OAuth client secrets, access tokens, and refresh tokens are stored in the OS credential store.
- Apple Calendar uses a CalDAV app-specific password, also in the OS credential store.
- The workspace database stores calendar account IDs, provider names, email labels, and imported event metadata, not tokens.
- Calendar sync fetches only the configured account and writes imported events to the local schedule.

## OCR

OCR is fully local. The bundled detection and recognition models are embedded in the application. Images are decoded in memory, capped at 3200 pixels on the longest edge, and the extracted text is written to the workspace. No OCR request leaves the device.

## Backups

Backups are manual. The Archive screen writes a verified copy through the SQLite backup API. For encrypted workspaces the same key is applied to the destination so the backup is not silently decrypted.

## Trash and deletion

Deleted records receive a `deleted_at` timestamp and remain recoverable for 90 days. Permanent deletion removes the database rows; content-addressed BLOB rows may remain until they are no longer referenced. Workspace backups retain whatever existed when the backup was created.

## Removed surfaces

The old `.tux` parser, browser file adapter, native archive range commands, in-app command console, and standalone CLI were removed. This narrows the trusted surface to Tauri commands used by the current UI.

## Residual risks

- The operating-system account and credential store are part of the trust boundary.
- Plain workspaces are not encrypted against a user who can read the file.
- Cloud provider handling is governed by the provider's policy; Tutorux does not control it.
- Calendar OAuth is not implemented, so there are no calendar tokens to protect in this build.
