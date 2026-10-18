# Document editor engine

`include/tutorux/document/editor.hpp` provides a piece-table text buffer for archive-backed
documents. The original text stays in an immutable buffer; new text is appended to an additions
buffer, and pieces refer to ranges in either buffer. Edits therefore avoid copying the complete
document on every keystroke.

`DocumentEditTransaction` groups insertions and replacements with an expected archive revision and
selection state. Applying a transaction validates UTF-8 and range boundaries before publishing the
candidate buffer. The editor records inverse operations for undo and redo and reports the paragraph
range whose layout needs refreshing. Search returns byte ranges, and cursor helpers move between
UTF-8 code points. Find and replace skips matches that start inside a code point and applies all
replacements as one undoable transaction.

The desktop guide editor loads one structured guide block into the piece table. Saving checks the
guide record revision, applies the edit transaction, and writes the block through the shared guide
command. This creates an archive revision while preserving block kind and source IDs. A stale block
becomes reviewable only after the tutor explicitly saves its reviewed text.

The current buffer measures positions in UTF-8 bytes and provides code-point movement. A grapheme
segmentation layer, structured-operation coalescing for typing, and partial GUI layout integration
remain part of the full editor qualification work. The widget continues to provide text selection,
IME input, and bidirectional layout.
