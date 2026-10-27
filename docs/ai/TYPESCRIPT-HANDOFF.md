# TypeScript AI handoff

The Solid AI workspace currently ports the no-key manual guide handoff. Choose a session and a
built-in or active custom guide structure, prepare a package, inspect its complete JSON, and
explicitly confirm before saving it as an archive-backed AI job. Saved jobs can be exported as
JSON. Preparing and saving do not contact a provider.

The versioned `tutorux-ai-package-v1` payload follows the former application schema. It includes the
selected session, that session's transcript cues, observations, evidence, and asset metadata, plus
the selected guide structure and generation and verification instructions. Asset payload bytes and
private tutor notes are excluded. When a student is linked, the package includes only learning
difficulties, demonstrated improvements, and progress classifications. Each progress citation is
validated against the selected student's archive evidence; valid cross-session evidence is included
so the cited claims can be checked. Invalid citations remain labeled as failed and unverified.

Packages are capped at 8 MiB. The archive job stores the exact JSON bytes and matching SHA-256
values. Workspace loading reads AI job metadata only; the full package bytes are loaded only when
the user opens the JSON preview or exports a saved package.

Provider configuration, encrypted credential management, outbound request review and confirmation,
provider execution, response import, local model jobs, and the CLI AI command group are still
unported. The migration inventory tracks those remaining areas.
