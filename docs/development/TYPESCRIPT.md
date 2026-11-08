# TypeScript development

Tutorux uses SolidJS, TypeScript, Vite, and Tauri. The frontend is a desktop WebView interface; there is no production browser edition.

## Commands

```sh
pnpm run pdfium:fetch
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run test:coverage
pnpm run build
pnpm run desktop:dev
pnpm exec tauri build --no-bundle
```

## Project layout

````text
frontend/
  api/                 typed Tauri client, AI transport, Whisper bridge, calendar/OCR calls
  app/                 shell, routing, workspace provider, welcome, reminder watcher
  design-system/       primitives and shared presentation
  features/            Today, Students, Sessions, Schedule, Materials,
                       Guides, Evidence, Assistant, Archive, Settings
  shared/              formatting and shared pure helpers
  shared-ui.tsx        icon set
  theme.tsx            document theme tokens
  styles.css           Tailwind setup, font faces, motion rules
```Do not add page logic to `app/`. A feature may depend on `api`, `design-system`, `shared`, and `app/router`; features must not import another feature's internals.

## Routing

`frontend/app/router.ts` owns a hash router. The route is the source of truth for the active page and selected IDs.

```text
#/today
#/students
#/students/:id/:tab
#/sessions
#/sessions/:id/:tab
#/schedule
#/materials
#/guides
#/guides/:id/edit
#/evidence
#/assistant
#/archive
#/settings
````

Use `navigate`, `sessionPath`, `studentPath`, and `guidePath` instead of assigning `window.location.hash` directly.

## State

- `WorkspaceProvider` owns the open workspace summary, theme, Simple/Advanced mode, saved path, and unlock prompt.
- `ReminderWatcher` polls due lessons while a workspace is open and sends native notifications.
- `frontend/api/client.ts` owns all workspace, calendar, reminder, and OCR commands.
- Pages use `createResource` for reads and explicit refetch after mutations.
- The backend is the source of truth. Do not duplicate persistent data in a global client store.
- Avoid module-level mutable state except the router signal and the workspace provider.

## Components

Use `frontend/design-system/ui.tsx` primitives:

- `Button`, `IconButton`
- `TextInput`, `TextArea`, `Select`, `Field`
- `Panel`, `PanelHeader`, `PageHeader`
- `Tabs`, `Badge`, `InlineNotice`
- `EmptyState`, `ConfirmButton`

Do not introduce new one-off button, input, or dialog styles inside a feature when a primitive exists. Keep new variants in the design system.

### Visual rules

- No gradients.
- No glassmorphism, backdrop blur, or translucent content panels.
- No accent bars on the left, top, right, or bottom.
- Sentence case only; no uppercase labels.
- Use borders and surface tones for hierarchy, not stacked shadows.
- One primary action per screen.
- Keep simple mode free of provider setup and maintenance controls.

The Tailwind test rejects banned utility classes.

## Forms

- Short forms are inline panels.
- Complex editors are full pages, such as the guide editor.
- Validate at the boundary and show field-level errors.
- Use `ConfirmButton` for destructive actions.
- Do not add modal-heavy workflows; the product has moved to inline panels and full pages.

## Data types

DTOs in `frontend/api/types.ts` mirror Rust `serde` structures. When a Rust model changes, update both sides in the same change set.

Dates are Unix milliseconds. Transcript timestamps are microseconds. Use `frontend/shared/format.ts` for display and `parseTimestampUs` for input.

## Testing

- Pure helpers: Vitest.
- Router: jsdom + Vitest.
- Rust store: `cargo test --lib`.
- Local inference, OCR, calendar parsing, and audio fixtures: Rust unit tests.
- UI: runtime smoke checks through the Tauri WebView; a dedicated Playwright/Tauri harness is not part of this build.
- Before handing off, run typecheck, lint, format check, coverage, frontend build, Rust formatting, Clippy, and Rust tests.

## Accessibility

- Every icon-only button needs an accessible label.
- Page navigation focuses `#main-content`.
- Use real buttons and links.
- Keep focus visible.
- Respect reduced motion via the global stylesheet.
- The mobile drawer is labelled and closable.
