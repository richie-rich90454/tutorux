# GitHub repository setup

Use this checklist to keep the public repository presentation aligned with the product.

## About

**Description**

> A private, local-first tutoring workspace in one portable file. Lesson capture, transcripts, OCR, evidence, and progress reports. Tauri + Rust + SQLite.

**Website**

> https://github.com/richie-rich90454/tutorux#readme

## Topics

Add these in **Settings → General → Topics**:

```text
tutoring
tutor
teaching
local-first
privacy
tauri
rust
solidjs
sqlite
desktop-app
education
study-tools
teacher-tools
whisper
ocr
ai
offline-first
portable-app
```

## Social preview

Upload `docs/assets/social-preview.png` in **Settings → General → Social preview**.

The image is 1280 × 640, 8-bit sRGB with metadata stripped, and contains no student data. If GitHub rejects it, upload `docs/assets/social-preview.jpg` instead, which is the same card as a baseline JPEG. Remove any broken preview first, hard-refresh the settings page, then upload a fresh file.

## Releases

Pushing a `v*` tag builds the desktop packages on Windows, macOS, and Linux in CI and attaches them to the GitHub release:

- Windows: `.msi`, NSIS `-setup.exe`, portable `.exe`
- macOS: `.dmg`, `Tutorux.app.tar.gz`
- Linux: `.AppImage`, `.deb`, `.rpm`
- `SHA256SUMS.txt`

Signing and notarization are optional. When the certificate secrets are absent the workflow publishes unsigned artifacts instead of failing; adding the secrets signs the same builds without a workflow change.

To rebuild the assets for an existing tag, run the workflow manually with `release_tag` set to that tag. The workflow creates the release if it does not exist and overwrites matching assets.

Release notes should state:

- the three supported platforms;
- that the portable EXE embeds the PDFium runtime;
- the local-first privacy model;
- which qualifications remain environment-gated.

## Repository features

- Enable **Discussions** for workflow ideas and qualification reports.
- Enable **Private vulnerability reporting** in Security settings.
- Pin one issue that explains the environment-gated qualifications in [HANDOFF.md](../HANDOFF.md).
- Keep the README screenshots current when the UI changes.
- Add a `good first issue` label for small, well-scoped contributions.

## Launch checklist

- [ ] Description and topics set.
- [ ] Social preview uploaded.
- [ ] Release published with the three artifacts.
- [ ] README screenshots reviewed on a narrow screen.
- [ ] Security advisory link works.
- [ ] Issue templates render correctly.
- [ ] `pnpm run desktop:build` produced exactly three files in `release/`.
