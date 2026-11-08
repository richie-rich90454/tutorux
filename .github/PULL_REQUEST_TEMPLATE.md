## What changed

Describe the user-facing change and why it matters.

## How to verify

List the checks you ran and any manual steps a reviewer should repeat.

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run format:check`
- [ ] `pnpm run test:coverage`
- [ ] `pnpm run build`
- [ ] `cargo fmt --check`
- [ ] `cargo clippy --all-targets --all-features -- -D warnings`
- [ ] `cargo test --lib`
- [ ] `pnpm run desktop:build`

## Privacy and data safety

- [ ] This change does not upload lesson data, recordings, transcripts, credentials, or workspace files.
- [ ] New persistence uses a schema migration and preserves existing `.tutor` files.
- [ ] New third-party assets have attribution.

## Screenshots

Add before/after images for visible UI changes. Remove student data first.
