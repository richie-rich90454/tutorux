# Tutorux motion

| Interaction | Duration |
|---|---:|
| Hover | 120 ms |
| Press | 80 ms |
| Selection | 160 ms |
| Expander | 180 ms |
| Overlay | 180 ms |
| Page switch | 180 ms, opacity only |

Easing is ease-out. A reduce-motion preference collapses every duration to zero
except essential progress indicators. Motion never hides a slow data path and
never animates width, height, or layout position for content that contains text.

Tokens live in `ui/theme.slint` as `motion-hover`, `motion-press`,
`motion-selection`, `motion-expander`, and `motion-overlay`.
