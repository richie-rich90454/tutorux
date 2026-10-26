> **Migration reference:** This document describes behavior, implementation, or build details from the former C++/Slint application. It remains useful as a porting specification; current TypeScript coverage is tracked in [the feature inventory](../migration/feature-inventory.md). Historical build commands are not the active TypeScript workflow.

# Guide PDF export

`guide export ID --format pdf --output FILE.pdf` produces an A4 PDF from the guide's current
revision. The export includes the guide title, session reference, template and review state, section
headings, paragraphs, list items, quotations, and source IDs. A running page number appears in each
footer. The output is written to a temporary file beside the destination, flushed, and published
atomically. On POSIX systems Tutorux synchronizes the destination directory before it reports
success; Windows publication uses write-through replacement.

PoDoFo lays out and writes the PDF. Its font manager searches installed system fonts and embeds the
selected font subset in the document. Font selection checks every character used by the guide before
rendering; export returns a clear error when no available font covers the complete text. On Windows,
the search prefers Microsoft YaHei, Yu Gothic, Meiryo, Malgun Gothic, and Noto CJK families. On
macOS it prefers PingFang and Hiragino; on Linux it prefers Noto CJK, Noto Sans, and DejaVu Sans.
If Windows font-family lookup is unavailable, the exporter checks the standard Fonts directory for
Microsoft YaHei and Noto Sans SC font files. The error includes the font families that were tried.

Builds use PoDoFo 1.1.2 and its runtime dependencies. PDF export does not download fonts
or write application-managed font files. The PDF contains its own embedded fonts, so it remains
readable when moved to another computer.

The rendered document preserves Unicode text, uses source IDs as readable references, and keeps
guide wording intact. It does not claim PDF/UA accessibility conformance. Visual fidelity for
equations and inline rich text is limited by the current guide model, which stores text blocks rather
than structured math or rich-text runs.
