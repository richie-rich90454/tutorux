> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Quick guide

Watch the [20-second Tutorux walkthrough](quick-guide.mp4). It uses the
application's actual Slint screens and on-screen captions, with no narration or
soundtrack.

## Chapters

| Time | Topic |
| --- | --- |
| 00:00 | Start a lesson and use its notebook |
| 00:04 | Record takes and manage synchronized tracks |
| 00:08 | Use the journal to review progress across lessons |
| 00:12 | Keep worksheets and audio with a lesson |
| 00:16 | Reuse and refine a study guide |

The demonstration uses generated example data. It does not open or include a
personal archive.

## Rebuild the video

Build `tutorux_ui_screenshot`, install FFmpeg with H.264 support, then run:

```powershell
pwsh scripts/build-quick-guide-video.ps1
```

The script captures the named views from the Slint testing backend and encodes
the captioned video to this directory.
