# Security policy

Tutorux stores private lesson data, recordings, transcripts, and optionally credentials. Please report vulnerabilities privately.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting:

https://github.com/richie-rich90454/tutorux/security/advisories/new

Include:

- affected version or commit;
- operating system and build artifact;
- a minimal reproduction;
- impact and any known workaround;
- whether student data, credentials, or workspace files are exposed.

You can expect an acknowledgement within 7 days. Please give a reasonable window to investigate and ship a fix before public disclosure.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| Older | Best effort |

## Scope

In scope:

- workspace file handling and SQLCipher encryption;
- credential-store boundaries;
- AI request allowlists and consent checks;
- file import/export and `.tutorpkg` packages;
- calendar OAuth loopback handling;
- capture and transcription boundaries;
- cross-site scripting or injection in the desktop WebView;
- local privilege or path traversal issues.

Out of scope:

- vulnerabilities in third-party providers;
- attacks that require an already-compromised operating system account;
- denial of service from deliberately malformed local files without a security impact;
- issues that only affect an unsupported build or a modified binary.

## Security design

- No hosted workspace, account, telemetry, or background sync exists.
- Cloud AI requires a review action and uses a host allowlist in the native layer.
- AI and calendar credentials use the OS credential store.
- SQLCipher protects encrypted workspaces at rest; the key is zeroized on close.
- Workspace paths come from native dialogs, not arbitrary remote strings.
- Sanitized copies remove private content before sharing.

## Recognition

There is no paid bounty program. Responsible reports are credited in the advisory unless you ask to remain anonymous.
