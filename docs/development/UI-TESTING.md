> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# UI testing

## Headless layout gate

`tests/ui/layout_test.cpp` renders the real `MainWindow` with the Slint testing
backend. It checks the minimum 900×560, 1024×768, 1280×800, 1440×900, 1600×1000,
and 1920×1200 in light and dark themes:

- the navigator, content pane, transport, and status line exist;
- the content pane keeps a usable width and stays inside the window;
- the transport and status line stay reachable at the bottom;
- the inspector is present with a selected session at 1280 and wider;
- the notebook never renders under the inspector;
- the inspector collapses on narrow windows;
- Journal, Guides, and Settings render as pages inside the content pane.

Run it with:

```text
ctest --test-dir build/dev -R ui_layout_matrix --output-on-failure
```

The test needs `TUTORUX_SLINT_TESTING=ON` so the Slint compiler emits element
debug information. Release builds keep this feature off.

## Other gates

- `bounded_task_executor` checks the pool never grows past four workers and does
  not retain completed work.
- `typed_workspace_overview` checks the service reads students, sessions, and
  journals from one archive open, without the command dispatcher.
- `binary_size_budget` checks the executable against the profile limit (45 MB
  for the base profile, 65 MB for the full build).
- `tests/ui/screenshot_tool.cpp` renders exact logical sizes at 125% and 150%
  scale (`SLINT_SCALE_FACTOR`) for DPI inspection.
