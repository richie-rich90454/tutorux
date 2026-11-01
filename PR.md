# PR: Repair desktop saving, move component styling to Tailwind, and ship portable builds

## Summary

This branch fixes the Windows desktop Save path and makes staged archive/export publication safe against concurrent destination changes. It moves component styling out of the legacy CSS files into Tailwind v4 utilities stored in TSX, improves page and style chunk splitting, stabilizes the recording and transcript workflow, and packages an offline Whisper model in the desktop executable. Windows release collection now includes the MSI, NSIS installer, and a one-file portable executable.

## Changes

### Save and file publication

- Publish staged desktop archive saves with a same-folder no-replace move on Windows. Other platforms use an atomic no-clobber hard link. Revalidate the destination under the exclusive archive lock before publishing so a changed or newly created external file is preserved.
- Keep the previous archive in a recovery location until the replacement lock is adopted and the opened archive state is updated. Preserve both the prior archive and staged work if safe publication or recovery fails.
- Apply the same no-replace publication rule to transcript exports and CLI audio exports.
- Add Rust regression coverage for existing-file replacement, Save As, concurrent destination creation, stale external edits, and recovery backups. Browser tests cover saving and reopening workspaces.
- Route every save entry point through the conflict-aware action, including native shortcuts, quick actions, Preferences, and Archive health. Journal autosave now raises the same conflict status when the disk changed and clears it after a successful write.

### Recording and transcription

- Embed the multilingual Whisper Base Q5_1 model (59,707,625 bytes) in the Rust executable and load it directly from memory. Desktop full-track and live transcription work offline in the MSI, NSIS installer, and portable executable without an external Whisper binary/model or model extraction.
- Keep transcript cues reviewable and provisional, support cancellation, and process bounded PCM in memory. The desktop Whisper path creates no temporary files or directories. Compressed-audio import may use and remove a flat temporary file when its decoder requires one.
- Preserve the separate CLI's external Whisper support and document its different temporary-file behavior.
- Keep recoverable audio callback underruns and device discontinuities from aborting an otherwise active recording; fatal device errors remain reported.
- Improve the Record workspace flow around choosing a session, capturing or importing audio, recovering takes, playback/waveform review, transcription, and cue export. Fix the recording waveform/control layout and test for horizontal overflow.

### Tailwind and frontend build

- Remove the 27 component CSS files. Their presentation rules now live as Tailwind v4 utility strings in per-component `.tailwind.tsx` modules and are applied from the related TSX through `frontend/tailwind.ts`. The remaining `frontend/styles.css` contains Tailwind setup/theme tokens, font faces, keyframes, print-page settings, and reduced-motion rules only.
- Preserve the existing palette, typography, component geometry, themes, state selectors, and flat backgrounds; no intentional visual redesign was introduced by the CSS migration. No linear, radial, or conic gradients are used.
- Keep the compact journal empty state in a separately scoped Tailwind utility map so it does not inherit the taller, centered welcome layout. Add regression coverage for its measured height and alignment.
- Retain accessible names for navigation controls when their visible text is collapsed on narrow screens. Keep Materials reachable in the phone navigation; exercise every workspace at 1440, 1024, 820, and 390 pixel widths and assert there is no horizontal page overflow.
- Disable Windows WebView2 general address/contact autofill suggestions so stored browser form data does not overlay app inputs. The app uses its normal Tauri/WebView2 runtime and does not spoof another browser's user agent.
- Keep the default 500 kB JavaScript chunk warning. Rolldown splits route utilities, entry code, and vendor modules; route pages and PDF/cryptography features remain lazy-loaded. The current largest JavaScript chunk is 431.01 kB, below the warning threshold.
- Keep generated source maps disabled for the Tailwind build output, avoiding broken-map warnings and reducing packaged output.

### Rust, packaging, and documentation

- Restrict `run_command_console` to crate visibility so its private desktop state type is not exposed through a public function.
- Clean up Clippy findings across the Rust targets, including a dead loop, redundant branches, checked division, duplicate map lookups, and overly complex return signatures. Keep intentional command/worker argument boundaries explicit with narrow, reasoned lint expectations.
- Collect Windows MSI, NSIS, and portable outputs together. The portable EXE embeds the frontend, native host, and Whisper model; it does not need companion application files or extract a runtime/model directory. Windows still needs the system WebView2 runtime, and the app may create per-user application state.
- Update architecture, TypeScript development, privacy, release, and `PR.md` documentation to describe the actual TSX Tailwind structure, save behavior, WebView2 autofill setting, bundled model, runtime requirements, and release artifacts.

## Verification

- `pnpm lint` — passed with no ESLint warnings or errors.
- `pnpm typecheck` — passed.
- `pnpm format:check` — passed.
- `pnpm test` — passed: 40 files and 246 tests.
- `pnpm exec playwright test --workers=1 --reporter=list` — passed: all 15 browser end-to-end tests, including the compact journal empty state, responsive workspace navigation, save/reopen, recording playback and take management, encrypted archives, workspace flows, and guide print preview.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings` — passed with warnings denied.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1` — passed: 187 tests, including archive save publication and embedded Whisper model initialization/transcription. On Windows, run with permission to create/move temporary files and bind loopback test servers.
- `pnpm build` — passed with no Babel deoptimization or JavaScript chunk-size warning. The largest JavaScript chunk was the 431.01 kB PDF vendor chunk (129.98 kB gzip).
- `pnpm desktop:build` — passed on Windows and collected both installers and the portable EXE. The Rust release build emitted no source warnings.

## Windows release artifacts

`release/` contains:

- `Tutorux_1.0.0_x64_en-US.msi` — Windows Installer package (70,483,968 bytes).
- `Tutorux_1.0.0_x64-setup.exe` — NSIS installer (65,085,546 bytes).
- `Tutorux_1.0.0_x64_portable.exe` — one-file portable desktop executable (95,210,496 bytes), copied from the release application binary.

The portable EXE and `src-tauri/target/release/tutorux-desktop.exe` have the same SHA-256 (`2A3EED943561D07A585B10C7ECBBAC7A118E0EB4826183D8AA39EA3E016CDCBB`), confirming that the portable artifact is the application binary itself. The embedded Whisper model is 59,707,625 bytes with SHA-256 `422F1AE452ADE6F30A004D7E5C6A43195E4433BC370BF23FAC9CC591F01A8898`; its source and license attribution are recorded in `resources/whisper/README.md`. GGUF models and FFmpeg remain optional user-provided resources and are not required for desktop Whisper transcription.
