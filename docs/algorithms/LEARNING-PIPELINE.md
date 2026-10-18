# Learning pipeline algorithms

Tutorux keeps its learning analysis in a small C++ module shared by the CLI, desktop UI, and
WebAssembly command bridge. The module is deterministic and does not make network requests.
Provider-specific tokenizers, model limits, and transcription characteristics are supplied as
runtime inputs instead of being tied to model version strings.

## Incremental transcript alignment

`TranscriptAlignmentEngine` stores cues in an ID map and a `(start time, ID)` ordered map. A cue
edit updates both entries in `O(log n)` and reports the immediate temporal neighbors whose alignment
may need reconsideration. Range queries seek to the first relevant start time and visit only nearby
cues, giving `O(log n + k)` work for `k` overlapping cues. Cue identity, revision, speaker, and
verification state remain attached to the aligned text.

## Evidence graph

Evidence nodes preserve the session, type, statement, origin, confidence, review state, and source
IDs. Edges use a closed set of relationship names and are validated against node existence and
session ownership. Contradiction edges remain explicit, so a downstream guide cannot silently turn
conflicting claims into a single fact. The graph serializes into the archive's typed evidence records.

## Context packing

`packContext` ranks tutor-authored and high-priority evidence before lower-priority background, then
uses confidence, freshness, and stable source ID to break ties. A provider can supply its tokenizer;
the included byte-based counter is only a planning estimate. Oversized candidates can be divided at
UTF-8 boundaries and paragraph or line breaks. Every fragment keeps byte offsets into its original
source. Fragments that do not fit the item or total context budget are returned with an explicit
omission reason. The packer never truncates text silently; callers must inspect `complete` and the
omission list before sending a request.

## Incremental guide dependencies

Each guide block registers the source IDs and source hashes that informed it. When a source hash
changes, only blocks depending on that source are marked stale. Stable `(guide, block)` keys make
re-registration idempotent and allow a tutor edit to retain unrelated guide sections.

## Adaptive transcription scheduling

`planTranscription` divides a track into bounded time ranges, reserves CPU threads for the user
interface and archive writer, and limits worker count by both CPU availability and the supplied
per-worker model memory estimate. Work duration is estimated from a runtime real-time factor. The
plan is intentionally free of bundled model assumptions; the transcription backend supplies model
memory and throughput estimates.

`AdaptiveTranscriptionScheduler` runs a priority queue with FIFO ordering among equal priorities.
It adapts the number of newly dispatched workers when its CPU or memory budget changes, exposes
cooperative cancellation state, and retries only work explicitly marked retryable. Its checkpoint
records use a stable ID derived from the work ID and can be written to the active archive as a batch.

## Waveform and seek indexes

`IncrementalWaveformPyramid` reduces each fixed sample window to a signed min/max pair and builds
coarser levels by merging pairs. It uses `O(n / w)` peaks at the base resolution, with geometrically
fewer peaks at higher resolutions, and appends each completed window in amortized `O(log n)` work.
Audio remains authoritative in audio chunk records; the pyramid is a rebuildable archive index.
The final partial window is included when `finish()` is called; during capture, a partial window
remains buffered until it reaches the configured resolution.

`SparseTimestampSeekIndex` retains one byte-offset anchor per configured time interval. Anchors are
monotonic, serialized as a compact versioned blob, and queried with binary search in `O(log n)`.
Decoders scan forward from the selected anchor to reach the exact requested timestamp.

## Content-addressed assets

Asset metadata includes the SHA-256 content hash and byte count. A caller can use that hash to find
an existing blob before appending new content, while preserving a separate metadata record for
each import and source relationship. The source file is read by the import workflow and is never
modified.

These structures are archive-backed records or rebuildable indexes. The archive commit remains the
authority for durable state; no global database or persistent extracted workspace is introduced.
