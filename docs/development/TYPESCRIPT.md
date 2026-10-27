# TypeScript development guide

This guide covers the active SolidJS, Vite, Tauri, and CLI code. The older CMake workflows are kept for the migration reference and are not the build commands for the new app.

## Toolchain

- Node.js 24+
- npm 11+
- Rust stable for desktop development and packaging
- On Linux, the Tauri WebKitGTK development libraries listed in `.github/workflows/tauri-cross-platform.yml`

Use the committed `package-lock.json` for reproducible installs:

```sh
npm ci
```

## Web workflow

```sh
npm run dev
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:e2e
npm run build
npm run preview
```

The static build is written to `dist/`. Do not import `@tauri-apps/*` from a domain module or the browser adapter; Vite selects `frontend/platform/browser.ts` for the web build.

## Desktop workflow

```sh
npm run desktop:dev
npm run desktop:build
```

The desktop adapter is selected with Vite's `desktop` mode. The Rust host lives in `src-tauri/` and is intentionally limited to operating-system file access. Run `cargo check --manifest-path src-tauri/Cargo.toml` for a fast host check. Build release bundles on each target OS; Tauri's native toolchain and WebView dependencies are host-specific.

## CLI workflow

```sh
npm run cli -- --help
npm run cli -- archive init Lesson.tux --name "Algebra"
npm run cli -- archive recover Lesson.tux --json
npm run cli -- archive recover Lesson.tux --apply --json
npm run cli -- archive compact Lesson.tux --json
npm run cli -- archive compact Lesson.tux --apply --json
npm run cli -- archive repair Lesson.tux --output Lesson-repaired.tux --confirm-sensitive --json
npm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --json
npm run cli -- archive sanitize Lesson.tux --output Lesson-sanitized.tux --include-students <uuid> --confirm-sensitive --expected-generation <generation> --expected-selection <sha256> --expected-output Lesson-sanitized.tux --json
npm run cli -- --archive Lesson.tux student create --name "Maya Ortiz"
npm run cli -- --archive Lesson.tux session list --json
```

The CLI imports the same archive and domain modules as the UI. File paths are resolved by Node; archive reads are positional and bounded. Recovery is preview-only unless `--apply` is supplied, and it only publishes a complete next generation after full record verification. Compaction is also preview-only unless `--apply` is supplied; it preserves indexed history and original stored payload bytes, but does not yet prune unreferenced asset chunks or support encrypted archives. The CLI does not yet unlock encrypted archives; encrypted archive unlock, verification, and authenticated append edits are currently available in the Solid UI. Repair creates a separate `.tux` copy from the newest fully verified published generation, may fall back to an earlier generation, and requires `--confirm-sensitive` because it can contain private student records and recordings. Sanitization first reports included record counts and a selection fingerprint; confirmation must repeat the same generation, selection, and output path before an unencrypted copy is written. Student/session and recording-track filters are supported, private annotations and generation logs are opt-in, credentials are excluded, and encrypted output remains unavailable until the sanitizer supports encrypted generation writing and key handling. The CLI checkpoints bounded copy batches to a private disk-backed staging file, verifies the finished archive there, then publishes it atomically. Do not add a second archive serializer for CLI convenience.

## Encryption boundary

`frontend/archive/crypto.ts` provides the v1 Argon2id13, XChaCha20-Poly1305, and HMAC primitives through `libsodium-wrappers-sumo`. A C++-generated fixture checks key-envelope, record, manifest, index-page, and commit interoperability; fixture provenance is recorded in `tests/fixtures/README.md`. The Solid UI runs passphrase derivation in a Web Worker. Unlock authenticates the commit, all index pages, and manifest before exposing records; record AEAD is checked when records are read, and full archive verification checks each current record. The UI can append authenticated edits to unlocked encrypted archives. Encrypted archive creation, passphrase changes, CLI unlock, recovery, repair, compaction, and encrypted sanitized output remain unsupported.

## Tests and performance

Vitest tests live next to their TypeScript modules and use Node for byte-level and CLI behavior. Playwright tests live in `tests/e2e/` and exercise the browser application.

Run `npm run benchmark:archive` to measure generation creation and archive listing on the current machine. Record machine, runtime, archive size, and record count with the result. Do not compare the TypeScript numbers with old C++ release budgets until workloads and measurement methods match.

## Updating dependencies

Use npm and update the lockfile. Keep `typescript` pinned to exactly `6.0.3` as requested. Other direct dependencies use current stable versions recorded in `package.json` and `package-lock.json`; review the Vite web and Tauri desktop builds after any major update.
