# Tutorux Rust Core Port Plan

Status: proposed, not started.

## Goal

Move the shared Tutorux logic into Rust, then build two thin adapters over it:

1. **CLI adapter**: the standalone `tutorux` command, with no Node runtime.
2. **Desktop adapter**: the Tauri host, including an in-process command console that calls the same Rust command router.

The desktop application must remain a single executable with no runtime extraction, no Node dependency, and no bundled helper sidecars. The in-app console must reach full CLI parity by running the Rust CLI adapter in-process.

## Why this shape

The current CLI and GUI are not separate systems. They share the TypeScript archive, crypto, domain, AI, and audio code:

- GUI: SolidJS -> `frontend/platform/tauri.ts` -> Tauri/Rust native host
- CLI: Node entry point -> `cli/*` -> shared `frontend/*` modules -> Node I/O

Porting only `cli/*` to Rust would duplicate roughly 61k lines of shared logic. The port therefore starts with the core, then adds adapters.

## Target architecture

```text
                +----------------------+
                |   tutorux-core       |
                |  archive / crypto    |
                |  domain / guides     |
                |  AI / audio / search |
                +----------+-----------+
                           |
             +-------------+-------------+
             |                           |
     +-------v--------+          +-------v---------+
     | CLI adapter    |          | Desktop adapter |
     | argv, stdio,   |          | Tauri commands, |
     | OS filesystem  |          | events, native  |
     +----------------+          | backends        |
                                 +-----------------+
```

Core rules:

- Core has no Tauri, SolidJS, Node, or platform UI dependency.
- Core talks to the outside through narrow ports: byte source, filesystem, clock, secret store, media/transcription/AI backends.
- Adapters own platform concerns and presentation.
- The CLI command router is a library function, not just a binary. The desktop console calls that function in-process and streams its output.

## Feature parity invariant

No capability may exist only in the CLI or only in the GUI. Every core capability must be reachable from both adapters:

- Every CLI command and flag has an equivalent desktop action or console command.
- Every desktop action has an equivalent CLI command, including interactive workflows such as archive maintenance, sanitized copies, recording control, transcription, AI generation, diagnostics, and settings changes.
- Batch and scripting capabilities exposed by the CLI must also be available through the desktop adapter, either as a GUI workflow or through the in-process console.
- Presentation differences are allowed; capability gaps are not. Drag-and-drop, native pickers, and visual review are UI conveniences over capabilities that must still exist in the other adapter.
- Platform-specific capabilities are exposed by both adapters on platforms where the capability exists; unsupported platforms return a consistent capability error rather than hiding the feature.

Enforce the invariant with a capability registry in the core:

- Each capability has a stable identifier, required ports, CLI command mapping, and desktop command/UI mapping.
- The registry drives adapter coverage tests.
- CI fails if a registered capability has no CLI mapping, no desktop mapping, or no integration test.
- The parity harness runs the same capability scenarios through both adapters and compares semantic results.

## Package layout

Keep one first-party Rust package in `src-tauri/Cargo.toml`:

```text
src-tauri/
  Cargo.toml
  src/
    lib.rs                 # exports tutorux-core
    core/
      archive/
      crypto/
      domain/
      ai/
      audio/
      ports.rs
    main.rs                # desktop adapter
    bin/
      tutorux-cli/main.rs  # CLI adapter
      tutorux-audio-helper/ # feature-gated developer helper
```

Feature flags:

- `desktop` (default): Tauri host and in-process console command
- `cli`: standalone Rust CLI binary
- `audio-helper`: standalone developer audio helper

The CLI binary must be feature-gated so Tauri does not bundle it into installers.

## Contract sources

The TypeScript implementation and tests are the specification until the Rust port reaches parity:

- `tests/cli/` — command behavior, exit codes, JSON contracts, legacy aliases
- `tests/frontend/archive/` — format, verification, recovery, compaction, sanitization
- `tests/fixtures/encrypted-v1.tux` — encrypted archive interoperability
- `tests/fixtures/tone-997hz.*` — audio import/export fixtures
- `tests/e2e/` — browser and desktop behavior

Add a golden-output corpus under `tests/rust-parity/` containing command arguments, expected exit codes, expected stdout/stderr, and expected semantic JSON.

## Phases

### Phase 0: Freeze contracts and build the parity harness

- Enumerate every CLI command, flag, alias, env var, exit code, and JSON shape from `cli/` and `tests/cli/`.
- Build the capability registry and require a CLI mapping and a desktop/UI mapping for every entry.
- Build a harness that runs the TypeScript CLI and the Rust CLI against disposable archive copies.
- Compare exit codes, stderr, and JSON semantically; compare archive output by reopening both and verifying records.
- Keep the TypeScript CLI operational until Rust parity is proven.

Exit criteria: the harness runs the existing TypeScript suite commands and records a baseline.

### Phase 1: Archive primitives

Port:

- Header, record frames, CRC-32, payload bounds
- LZ4 block handling and BLOB encoding
- Encrypted envelopes and key envelopes
- Commit, locator, primary B+ tree, secondary indexes
- u64 and bigint-equivalent handling

Exit criteria: fixtures read and verify; byte-for-byte archive creation matches the TypeScript writer where the format is deterministic.

### Phase 2: Archive engine

Port:

- Open snapshots and bounded range reads
- Create, append, save, and atomic publication
- Full semantic verification
- Unpublished-generation recovery, missing-locator recovery, tail discard
- Repair copies
- Compaction and index rebuild
- Sanitized copies and selection filters
- Backup, encryption, and passphrase rotation

Exit criteria: recovery, repair, compaction, and sanitized-copy tests pass against the existing fixtures.

### Phase 3: Domain core

Port the shared domain modules:

- Students, sessions, journal entries, document blocks
- Annotations, transcripts, assets, evidence, guides, templates
- Trash, revisions, relationships, and reference-safe deletion
- Settings and archive metadata
- Transcript parsing/export and guide export validation
- Search and filters

Exit criteria: domain unit tests and CLI JSON parity tests pass.

### Phase 4: CLI adapter

Port `cli/main.ts` and `cli/commands/`:

- Argument parser, global flags, env-var passphrases
- Output formatting and JSON contracts
- Exit codes and error messages
- All command families and legacy aliases
- Archive locks through the core port

Expose:

```rust
pub fn execute_cli(
    arguments: &[String],
    output: &mut dyn CliOutput,
    cancellation: &dyn Cancellation,
) -> i32;
```

Exit criteria: the Rust CLI passes the full `tests/cli/` parity matrix, and every registered capability has a CLI mapping.

### Phase 5: Desktop adapter and in-app console

- Replace the disabled console host with a Tauri command that calls `execute_cli` in-process.
- Stream stdout/stderr through the existing console event channel.
- Preserve cancellation, output caps, passphrase fields, and archive-change refresh.
- Move GUI archive/domain calls from TypeScript to the Rust core incrementally, starting with archive maintenance, verification, and settings.
- Keep the UI responsive by running long commands on a blocking worker and emitting bounded output chunks.

Exit criteria: the console runs every CLI command with no Node, no extraction, and no helper sidecar. Every registered capability has both a CLI mapping and a desktop mapping.

### Phase 6: Native backends

Reuse or complete the existing Rust native modules:

- Synchronized audio capture and device probing
- Whisper full-track and live transcription
- Local GGUF inference
- Cloud AI transport and credential storage
- Diagnostics, process metrics, and benchmark commands
- Media import/export paths

Exit criteria: the Rust CLI covers recording, transcription, AI, diagnostics, and benchmark commands.

### Phase 7: Packaging and qualification

- Build the desktop exe with the console included in-process.
- Build the feature-gated Rust CLI.
- Verify installers contain only the desktop executable.
- Verify no runtime cache, Node dependency, or helper extraction.
- Run Windows packaging, TypeScript parity, and cross-platform CI.

Exit criteria:

- One desktop executable contains the GUI and console.
- `cargo test` covers core, CLI, and desktop adapters.
- No TypeScript core remains on the CLI or desktop execution path.
- macOS and Linux package builds pass CI.

## Parity harness

For each command:

1. Copy the same fixture archive into two temporary directories.
2. Run the TypeScript CLI against one copy and the Rust CLI against the other.
3. Compare exit code, stderr, and semantic stdout.
4. Reopen both archives and compare records, revisions, indexes, and verification results.
5. Compare encrypted outputs by unlocking both and comparing records; ciphertext need not be byte-identical.

Keep commands with non-deterministic output (timestamps, UUIDs, process metrics) in a normalized JSON mode.

## Risks and mitigations

- **Crypto parity**: Argon2id, XChaCha20-Poly1305, and HMAC must match existing encrypted archives. Mitigate with the existing encrypted fixture and cross-implementation open/write tests.
- **LZ4 and BLOB edge cases**: port the exact bounded rules and fuzz with existing fixtures.
- **u64 precision**: use `u64` in Rust; never route through JSON numbers where the TypeScript contract expects strings.
- **Export formats**: Word/PDF/HTML exports currently depend on browser libraries. Keep the browser export path until a Rust implementation is proven, then move it behind the core port.
- **Recording orchestration**: the GUI already has native capture; the CLI adapter must call the same native backend rather than spawning helpers.
- **Native addons**: `sharp` and `node-llama-cpp` disappear from the CLI path; image and GGUF work move to Rust.
- **Cross-platform links**: keep the vendored whisper symbol-prefix build and verify macOS/Linux CI.

## Definition of done

- The in-app command console works with no Node runtime and no extraction.
- The standalone `tutorux` CLI is a Rust binary with the full command surface.
- Every core capability is available through both the CLI adapter and the desktop adapter; no feature is CLI-only or GUI-only.
- The GUI and CLI use the same Rust core.
- Existing archive fixtures remain readable and writable.
- TypeScript parity tests and Rust tests pass.
- The desktop installers contain only the desktop executable.
- macOS and Linux builds pass CI.

## Immediate next steps

1. Generate the command/flag/JSON parity matrix from `tests/cli/`.
2. Define the capability registry and require both adapter mappings.
3. Scaffold `src-tauri/src/lib.rs` and the `core` module tree.
4. Port archive header, frames, CRC-32, and source traits first.
5. Add the parity harness before porting command behavior.
