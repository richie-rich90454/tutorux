# Dependency advisory audit

Date: 2026-11-04. This audit did not install global tools. JavaScript dependencies were checked with `pnpm audit`; Rust packages in `src-tauri/Cargo.lock` were checked against the OSV batch API.

## Results

`pnpm audit --audit-level high`: no known vulnerabilities.

OSV query for 623 locked Rust packages returned seven advisories:

| Package | Advisory | Scope | Assessment |
| --- | --- | --- | --- |
| `glib 0.18.5` | RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g | Linux GTK dependency, not compiled on Windows | Fixed in `glib 0.20`; blocked by the upstream Tauri/GTK dependency line. The affected `VariantStrIter` iterator is not used by Tutorux code. Re-evaluate on the Linux release host. |
| `proc-macro-error 1.0.4` | RUSTSEC-2024-0370 | Build-time proc-macro dependency | Unmaintained, no known code-execution or data-integrity defect. Remove when the upstream dependency chain drops it. |
| `ringbuf 0.4.8` | RUSTSEC-2026-0293 | `flexaudio-core 0.8.1` on all targets | The double-free requires an element `Drop` implementation to panic between the drop and read-index advance. Tutorux passes plain PCM buffers with infallible drops. Fixed in `ringbuf 0.5.2`, but `flexaudio-core` requires `0.4`; no local workaround is applied. Re-check when flexaudio updates. |
| `zbus_names 4.3.5` | RUSTSEC-2026-0371 | Linux D-Bus dependency, not compiled on Windows | Unmaintained standalone crate merged into `zbus 6`. Re-evaluate on the Linux release host. |
| `zvariant 5.15.1` | RUSTSEC-2026-0370 | Linux D-Bus dependency, not compiled on Windows | Unmaintained standalone crate merged into `zbus 6`. Re-evaluate on the Linux release host. |
| `zvariant_derive 5.15.1` | RUSTSEC-2026-0372 | Linux D-Bus build-time dependency, not compiled on Windows | Unmaintained standalone crate merged into `zbus 6`. Re-evaluate on the Linux release host. |

## Classification

No Windows runtime path uses the Linux GTK/D-Bus advisories. `proc-macro-error` is build-time only. `ringbuf` is reachable in the Windows audio path, but the published double-free trigger requires a panicking element destructor, which the PCM element type does not have. This is a defensive-classification, not a claim that the advisory is harmless in every embedding.

## Follow-up

- Upgrade the flexaudio dependency when it supports `ringbuf >= 0.5.2`.
- Upgrade the Tauri/GTK and keyring/D-Bus dependencies on the Linux release runner.
- Re-run the OSV batch check after each lockfile change.
