# Tutorux design system

## Typography

One family: Noto Sans, embedded at four weights. The approved scale is:

| Token | Size | Use |
|---|---:|---|
| caption | 12 px | metadata, labels, helper text |
| body | 14 px | normal text and controls |
| title | 16 px | section headings |
| display | 28 px | page title only |
| metric | 24 px | numeric recording/time display |

Weights are 400, 600, and 700. Interface labels use sentence case.

## Spacing

Use only 4, 8, 12, 16, 24, and 32 px. Panel padding is 24 px, compact rows use
8–12 px, controls are 36 px high, and dialogs use 24 px padding.

## Color

All colors live in `ui/theme.slint`. Light, dark, and system themes are
first-class; system follows the Windows personalization preference. The palette
is blue, black, white, and red. Success uses the accent family and warnings use
the danger family, so color is never the only carrier of meaning.

## Shape and elevation

One radius: 5 px. One hairline border: 1 px. One focus ring: 2 px. Overlays may
use a single subtle shadow. Circular status dots are the only non-5 px shape.

## Interaction states

Every control defines rest, hover, pressed, focused, disabled, busy, and
read-only states where they apply. Hover only responds while the control is
enabled and not busy. Disabled text uses the dedicated `disabled-text` token,
never `faint`.

## Motion

See `MOTION.md`. Motion animates color, opacity, and small transforms only; it
never animates layout size or position for text content.

## Text selection

Read-only output uses selectable text. The `ScrollText` component wraps a
read-only `TextInput`, so users can select and copy transcripts, logs, and
diagnostics.
