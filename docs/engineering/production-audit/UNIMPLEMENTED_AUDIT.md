# Unimplemented and disconnected functionality audit

Audit date: 2026-11-04.

## Search scope

- Rust: `todo!`, `unimplemented!`, `unreachable!`, `panic!`, `unwrap`, `expect`, placeholder returns, empty bodies, suppressed errors, conditional compilation paths.
- TypeScript/TSX: `TODO`, `FIXME`, `HACK`, `XXX`, stub/placeholder text, empty handlers, ignored promises, disconnected controls, fake success messages, obsolete native references.
- Tauri: every `invoke` name compared with `generate_handler!`, argument names checked against command signatures, event names checked against emitters.

## Result

- No `todo!`, `unimplemented!`, `TODO`, `FIXME`, `HACK`, or `XXX` markers in first-party Rust or frontend code.
- All 51 frontend `invoke` names resolve to registered Tauri commands. No command is registered but unreachable from the UI.
- `unreachable!` appears only in already-validated guide scope matches; the surrounding code exhaustively checks the scope first.
- `unwrap`/`expect` in production code is limited to proven invariants (fixed-width commit payloads, valid internal UUIDs, HMAC key length, internal index page structure). Tests use them freely.
- The in-app console previously accepted `record start --detach`, which could only reopen the GUI. It now rejects console recording with a clear message; the standalone CLI still supports detached capture.
- Ollama model discovery was implemented but blocked by the desktop CSP. The CSP now permits loopback connections.
- No advertised button or route was found without an action. The save-copy label mismatch is recorded as D-17 in the defect ledger and fixed.
- No legacy C++/Slint runtime, build script, or command dependency remains in the active application.

## Remaining external limitations

- Real microphone, system-audio, and application-capture hardware were not exercised; deterministic fakes cover the state machines and native probe code.
- macOS and Linux runtime behavior was not executed on this Windows host. Their code paths compile under conditional compilation and are covered by shared Rust logic where possible.
- Installer signing/notarization requires repository secrets and was not performed.
- No release publication or deployment was performed.
