# Tutorux

Definitive Product, Technical Architecture, Portable-Archive Specification, Algorithms, Performance Engineering, and Implementation Plan

C++23

Archive-only

CLI-first

Native desktop

Local-first

WASM-ready

# Tutorux: Every tutoring session, transformed into lasting knowledge.

Tutorux is a highly optimized, fully portable tutoring intelligence workstation that records lessons, transcribes conversations, captures tutor notes and supporting materials, identifies important instructional events, and produces personalized, evidence-linked study guides.

All persistent Tutorux application data lives inside directly mutable, single-file portable archives. The application discovers archives in its immediate working directory, opens an existing archive, or initializes a new one. It requires no installation, user-profile database, global application-data directory, system-wide configuration, or permanently running background service.

Specification: Tutorux 1.0 product and engineering blueprint, including advanced capabilities and release requirements.

Primary engineering objective: Deliver outstanding learning materials with minimum necessary computation, exceptional application responsiveness, low memory and CPU usage, small binaries, rigorous correctness, and code that remains easy for humans to read and maintain.

This specification preserves the previously established requirements and changes the storage architecture from directory-based working sessions to one authoritative, incrementally mutable portable archive per Tutorux workspace. All dependent storage, startup, recovery, credential, model-cache, and browser behavior is adapted accordingly.

# Part I. Non-Negotiable Requirements

## 1. Complete project requirements

| Domain                    | Binding requirement                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Name                      | Tutorux                                                                             |
| Product                   | Native tutoring-session recording and learning-guide workstation                    |
| Primary language          | Modern C++23                                                                        |
| Code quality              | Exceptionally readable, maintainable, human-written-style production code           |
| OOP                       | Encapsulation, composition, clear contracts; no application class inheritance       |
| Naming                    | Java-like, descriptive class and method names                                       |
| Namespaces                | Frequent meaningful namespace declarations and scoped `using` declarations          |
| Algorithms                | Best justified algorithms and data structures, O(1) where theoretically appropriate |
| Performance               | Extremely low CPU and memory consumption, excellent throughput                      |
| Startup                   | Minimal latency; fast cold and warm launches                                        |
| Responsiveness            | No avoidable blocking of interactive operations                                     |
| Binary size               | Aggressively minimized without removing essential capabilities                      |
| Correctness               | Zero known release-blocking defects, with extensive verification                    |
| Output quality            | No unapproved degradation, fabricated information, or silent evidence loss          |
| GUI                       | Polished, premium, productivity-oriented native interface                           |
| Qt                        | Prohibited                                                                          |
| Electron                  | Prohibited                                                                          |
| Tauri                     | Prohibited                                                                          |
| Desktop WebUI             | Prohibited                                                                          |
| Preferred GUI             | Slint with a non-Qt backend, subject to prototype qualification                     |
| CLI                       | Every application operation accessible through CLI                                  |
| GUI architecture          | Thin presentation wrapper over the authoritative command engine                     |
| Desktop operating systems | Windows, macOS, Linux                                                               |
| Desktop feature parity    | Equivalent capabilities on declared supported configurations                        |
| Distribution              | Primarily one self-contained executable per OS/CPU architecture                     |
| Archive format            | Single-file, portable, directly mutable archives only                               |
| Workspace folders         | No persistent extracted `.tutorux/` workspace                                       |
| Archive discovery         | Scan only the selected directory's immediate file level                             |
| Startup archive behavior  | Open/select existing archives; initialize one if none exists                        |
| System-wide directories   | No Tutorux-managed user-profile, AppData, XDG, global cache, or system directories  |
| Persistent settings       | Stored inside the selected portable archive                                         |
| Persistent cache          | Stored inside the selected portable archive                                         |
| Recording                 | Full-session capture, including microphone and supported system audio               |
| Transcription             | Timestamped, editable, locally capable                                              |
| Tutor notes               | Live and post-session annotations                                                   |
| Assets                    | Images, documents, audio, video, equations, code, and other files                   |
| AI workflows              | BYOK, manual external chat agent, and local inference                               |
| Provider coverage         | At least 30 target integrations                                                     |
| Model discovery           | Dynamic; no permanently hardcoded model versions                                    |
| OpenCode                  | Go and Zen adapters, with applicable usage restrictions respected                   |
| Ollama                    | Local-service model discovery and generation                                        |
| llama.cpp                 | Existing server and optionally embedded runtime                                     |
| Bundled LLM weights       | None, including small LLMs                                                          |
| Ports                     | No mandatory listening ports                                                        |
| Browser edition           | Static WebAssembly website suitable for GitHub Pages                                |
| iPad                      | Browser-compatible user experience within iPadOS security restrictions              |
| Study guides              | Personalized, editable, evidence-grounded and professionally formatted              |
| Exports                   | PDF, DOCX, HTML, Markdown, Tutorux archive and AI interchange package               |
| Privacy                   | Local-first, consent-aware, explicit cloud transmission                             |
| Maintainability           | A release-quality requirement alongside correctness and performance                 |

### 1.1 Engineering interpretation

The project should aim for world-class performance and reliability, but these goals must be established through tests and measured results.

A true guarantee of zero bugs is not possible for software of this complexity. Likewise, transcribing \\(n\\) samples or exporting \\(n\\) bytes cannot generally be O(1).

Tutorux should enforce zero known critical defects, well-defined invariants, asymptotically appropriate algorithms, measurable performance budgets, and human-reviewed quality.

The single-file requirement applies to Tutorux's managed persistent data. Native operating systems still supply graphics drivers, audio facilities, standard system libraries, permissions, and process services. Tutorux must not deliberately create global configuration or cache state, but it cannot prevent the operating system from managing its own internal files.

# Part II. The New Archive-Only Architecture

## 2. Tutorux must behave like a genuinely portable application

The expected desktop distribution is:

```
Tutorux/
├── Tutorux.exe
├── My-Tutoring.tux
├── English-Students.tux
└── Mathematics.tux
```

On macOS or Linux, the executable naturally uses the appropriate native format and name.

Each `.tux` file is a complete Tutorux archive capable of containing multiple students, tutoring sessions, recordings, transcripts, annotations, imported images, documents, AI settings, caches, learning history, and generated guides.

There must be no permanent extracted working folder.

### 2.1 What a user should be able to do

A user should be able to:

1. Place Tutorux and one or more `.tux` archives in a folder.
2. Launch Tutorux.
3. See the available archives in that folder.
4. Select an archive to open.
5. Add students, sessions, recordings, images, and notes.
6. Have all changes saved directly into that archive.
7. Close Tutorux.
8. Move the executable and archive together to another supported computer.
9. Continue using the archive without a migration or installation process.

This must remain true when the archive reaches several gigabytes.

### 2.2 Archive as a complete workspace

A `.tux` archive is not restricted to one session.

It may represent:

- A tutor's complete student library.
- One student's entire tutoring history.
- One subject.
- One school term.
- A collection of selected sessions.
- A single self-contained lesson.

The structure and available features remain the same regardless of how the user organizes archives.

Recommendation: Default to one archive containing multiple students and sessions. Users who prefer per-student or per-subject separation may create additional archives.

This preserves longitudinal learning history while keeping every workspace portable.

## 3. Exact startup and archive-discovery behavior

Tutorux must never require a global archive registry.

The directory itself is the archive registry.

### 3.1 Directory resolution

The discovery rules should be deterministic:

| Launch method                      | Discovery directory                          |
| ---------------------------------- | -------------------------------------------- |
| Double-click desktop executable    | Directory containing the executable          |
| Launch `tutorux gui` from terminal | Current working directory                    |
| CLI with `--directory PATH`        | Explicit selected directory                  |
| CLI with `--archive FILE`          | Exact specified archive                      |
| GUI Open Archive                   | User-selected archive's containing directory |

A portable-mode default should favor the executable's directory for graphical launches.

The program must not silently scan the user's home directory, Documents, Downloads, Desktop, or other directories looking for archives.

### 3.2 Immediate-level scan only

If the selected directory contains:

```
Tutorux/
├── Tutorux.exe
├── Main.tux
├── Student-A.tux
├── Notes.pdf
└── Old/
    ├── Archived.tux
    └── Another.tux
```

Tutorux discovers:

- `Main.tux`
- `Student-A.tux`

It does not discover `Old/Archived.tux` or `Old/Another.tux`.

No recursive scan should occur by default.

A user can explicitly open an archive in another directory through a file picker or `--archive`, but Tutorux must not begin traversing that directory tree.

### 3.3 Archive discovery algorithm

```
Resolve launch directory
          ↓
Enumerate immediate directory entries
          ↓
Select regular candidate .tux files
          ↓
Read bounded archive headers
          ↓
Validate magic, version, and latest commit locator
          ↓
Create in-memory archive descriptors
          ↓
Choose archive-opening behavior
```

Discovery must not decompress archives or scan complete recordings.

A typical archive descriptor contains only:

```
ArchiveDescriptor
  Path
  Archive UUID
  Display name
  Format version
  Latest committed generation
  Approximate archive size
  Student count
  Session count
  Last modification time
  Encryption state
  Health status
```

Metadata shown during discovery should come from the fixed header or latest committed lightweight archive manifest.

### 3.4 What happens when archives are found?

TUTORUX / PORTABLE ARCHIVES

## Choose your workspace

My Tutoring.tux

1 archive · multiple students

English Students.tux

Session and guide history

Mathematics.tux

Independent portable archive

&#x20;Open archive

&#x20;Create archive

Illustrative launcher screen; not a connected archive browser.

The opening policy should be:

| Archives found                  | Behavior                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| Zero                            | Initialize a new archive in the selected directory                 |
| One                             | Open it automatically                                              |
| Multiple                        | Display archive chooser                                            |
| Invalid/corrupt candidates only | Show recovery options; do not overwrite them                       |
| Explicit archive path           | Open the specified archive directly                                |
| Unsupported newer version       | Open read-only metadata if safe; otherwise explain incompatibility |

A user must always be able to choose Create New Archive, even when other archives exist.

### 3.5 Creating an archive automatically

If no `.tux` archive exists, the GUI should offer a minimal initialization screen with the proposed filename `Tutorux.tux`.

After the user confirms the archive name and location, Tutorux initializes the archive there.

For commands that inherently create persistent data, such as `session create`, the CLI may create `Tutorux.tux` automatically when no archive is found.

Read-only commands such as `tutorux --version` or `tutorux help` must not create files as a side effect.

If the selected directory is read-only, Tutorux must ask the user to choose a writable location rather than silently falling back to AppData or a home directory.

### 3.6 Archive selection must remain explicit

When multiple archives exist, Tutorux must not arbitrarily modify the first one alphabetically.

A noninteractive CLI command requiring write access should return an `ArchiveSelectionRequired` error unless an archive is explicitly selected or a documented unambiguous choice exists.

For example:

```
tutorux --archive English-Students.tux session list
```

Or:

```
tutorux --directory ./Tutoring \
  --archive English-Students.tux \
  session create --title "Rhetorical Analysis"
```

## 4. The single-file archive is authoritative

This is a fundamental change from the previous specification.

All application-managed persistent state belongs inside the selected `.tux` file.

That includes:

| Data                                                   | Inside archive?                                 |
| ------------------------------------------------------ | ----------------------------------------------- |
| Student profiles                                       | Yes                                             |
| Sessions                                               | Yes                                             |
| Recorded audio                                         | Yes                                             |
| Transcripts                                            | Yes                                             |
| Speaker information                                    | Yes                                             |
| Tutor annotations                                      | Yes                                             |
| Imported images                                        | Yes                                             |
| Imported PDFs and documents                            | Yes                                             |
| Extracted document text                                | Yes                                             |
| Waveform indexes                                       | Yes                                             |
| Thumbnail caches                                       | Yes                                             |
| Evidence graph                                         | Yes                                             |
| Learning history                                       | Yes                                             |
| Guide drafts and revisions                             | Yes                                             |
| Approved study guides                                  | Yes                                             |
| AI requests and results, subject to retention settings | Yes                                             |
| Dynamic provider/model catalog cache                   | Yes                                             |
| Application settings for that archive                  | Yes                                             |
| Encrypted saved API credentials                        | Yes, if the user enables persistent credentials |
| Job checkpoints                                        | Yes                                             |
| Crash-recovery metadata                                | Yes                                             |

No companion `.db`, `.json`, `.cache`, `.log`, `.journal`, or directory is required during normal operation.

### 4.1 Exceptions that do not violate archive-only persistence

Certain user-directed or temporary operations necessarily involve other files:

User-requested exports: A PDF or DOCX saved by the user is an intentional output, not an internal Tutorux workspace.

Imported files: Files selected by the user are read as sources and copied into the archive. Tutorux does not manage the original after importing it.

Model weights: Local LLM and Whisper weights are user-provisioned files or managed by a separately installed inference service. Tutorux does not bundle them or write them into system-wide model caches.

Atomic archive replacement: Compaction and certain recovery operations may temporarily create a same-directory `.partial` replacement archive. It must be finalized or cleaned up safely and never become a permanent second workspace.

Native OS internals: Windows, macOS, Linux, and browsers manage their own system services. Tutorux does not attempt to suppress ordinary OS behavior.

### 4.2 No global settings

There should be no Tutorux-owned equivalent of:

```
%APPDATA%/Tutorux/
~/Library/Application Support/Tutorux/
~/.config/tutorux/
~/.cache/tutorux/
~/.local/share/tutorux/
```

Tutorux must not create or manage any of these directories.

Theme preferences, model selections, recording defaults, templates, and other persistent settings live in the current archive.

When another archive is opened, its own settings apply.

A Copy Settings Between Archives command may transfer selected settings explicitly.

### 4.3 No global credential store

The previous proposal to use Windows Credential Manager, macOS Keychain, or Linux Secret Service as the default persistent credential store must be replaced because those systems create or manage user-wide state outside the archive.

Instead:

- Store credentials only in memory, by default.
- Support API keys supplied via explicit environment variables.
- Optionally store encrypted credentials inside the archive.
- Derive encryption keys from a user passphrase using an audited password-based key derivation function such as Argon2id.
- Use authenticated encryption and versioned encryption metadata.
- Never write plaintext credentials to an archive, log, or export.
- Never automatically copy credentials into shared archives or AI packages.

This preserves strict portable-state ownership.

### 4.4 No global log or crash directory

Normal diagnostics should use an in-memory bounded log buffer.

If the user enables persistent diagnostics, logs are written into the active archive with retention limits and credential redaction.

An explicit `diagnostics export` command may create a file at the user's chosen destination.

No Tutorux-managed global crash-report directory is permitted.

## 5. Directly mutable archives without extraction

A normal ZIP-style archive is unsuitable as the primary mutable storage engine.

Editing a small annotation in a multi-gigabyte ZIP can otherwise require rewriting a substantial portion of the archive.

Tutorux needs a purpose-built, append-friendly, transactional single-file container.

### 5.1 Recommended storage structure

Single-file `.tux` archive

Archive Header

Magic · Version · UUID · Format capabilities · Encryption metadata

Append-Only Record Region

Audio chunks · Assets · Transcript edits · Annotations · Evidence · Guides · Configuration

Copy-on-Write Index Pages

B+ tree indexes · Entity directories · Timestamp indexes · Content hashes

Commit Records and Checkpoints

Generation numbers · Root index pointers · Checksums · Recovery metadata

New updates append to the same file

The archive should be designed for random access and incremental updates, not repeated full-file compression.

### 5.2 Proposed format identity

Use:

- Extension: `.tux`.
- Magic identifier: a fixed Tutorux-specific byte sequence.
- Explicit major/minor archive version.
- Endianness specification.
- UUID identifying the archive.
- Feature/capability flags.
- Defined maximum record and offset ranges.
- Checksums for important records and pages.
- A forward-compatible unknown-record policy.

The exact binary field layout must be defined in a normative `Tutorux Archive Format v1` document before implementation.

### 5.3 Record model

Every appended record should include:

```
RecordHeader
  record_type
  record_version
  header_length
  payload_length
  logical_object_id
  object_revision
  codec
  checksum
  flags
```

The payload follows the record header.

Record types include:

```
StudentRecord
SessionRecord
AudioChunk
TranscriptSegment
TranscriptRevision
Annotation
AssetBlob
EvidenceNode
EvidenceEdge
GuideDocument
GuideRevision
Settings
ModelCatalogCache
JobCheckpoint
IndexPage
Commit
```

Use bounded, validated record lengths so malformed archives cannot trick the reader into arbitrary allocation sizes.

### 5.4 Archive updates

Suppose a tutor changes a note.

Tutorux should:

1. Validate the requested edit.
2. Append a new annotation revision.
3. Write updated index pages using copy-on-write.
4. Append a commit record referencing the new index root.
5. Flush the commit according to the durability policy.
6. Report success only after the required durability condition is met.

The existing recording, transcript, and other annotations remain untouched.

### 5.5 No in-place replacement of committed data

Previously committed records should be treated as immutable.

Updates append new versions.

This simplifies crash recovery, preserves revision history, and avoids rewriting large files.

The system must nevertheless provide a garbage-collection/compaction mechanism to reclaim unreachable obsolete records.

### 5.6 Database functionality without an external database file

The previous architecture used SQLite as the main session database. Under the new requirement, Tutorux must not create a separate SQLite database or its WAL/journal files.

The chosen design is a small transactional archive index with copy-on-write B+ tree pages stored inside `.tux`.

It should support:

- Entity-ID lookups.
- Ordered timestamp indexes.
- Secondary indexes for annotations.
- Asset-content hash lookup.
- Student-to-session relationships.
- Evidence graph adjacency.
- Guide dependency indexes.
- Prefix/range scans.
- Transactional root publication.

This is a larger implementation responsibility than ordinary SQLite integration. Consequently, its storage engine must have especially thorough tests, fuzzing, fault injection, and a documented on-disk format.

SQLite may still be used for algorithm comparisons or test fixtures, but must not create persistent companion files during normal Tutorux operation.

### 5.7 Commit consistency

A committed archive generation must reference a complete, internally consistent set of index roots and data records.

The commit record should contain:

```
CommitRecord
  generation
  previous_commit_offset
  root_index_offset
  root_index_hash
  transaction_id
  committed_record_count
  archive_format_version
  commit_checksum
```

The exact serialization and durability protocol must be verified under real filesystem failure scenarios.

Appending a checksum alone does not guarantee power-loss atomicity. Commit publication, write ordering, and flushing must be designed and tested explicitly.

### 5.8 Crash recovery

When opening an archive, Tutorux should locate the newest valid committed generation.

If the latest appended data is incomplete, it should fall back to the previous valid generation without discarding previously committed content.

Recovery should:

1. Read and validate the archive header.
2. Locate candidate commit records near the end.
3. Verify referenced index roots and integrity metadata.
4. Select the newest valid consistent generation.
5. Identify an incomplete trailing transaction.
6. Preserve recoverable uncommitted data when possible.
7. Report any unrecoverable region to the user.

Avoid scanning the entire archive on every normal startup.

Use commit locators, checkpoints, and bounded backward scanning, with a full scan reserved for recovery or diagnostics.

### 5.9 Archive locking

Multiple processes may open the same archive for reading.

Concurrent writing requires coordination.

The preferred v1 policy is:

- Multiple readers.
- One exclusive writer per archive.
- OS-backed advisory/mandatory locking as supported.
- No permanent lock sidecar.
- Worker and GUI ownership coordinated through local IPC.
- Explicit read-only opening if the archive is already in use.
- Clear stale-process recovery.

Do not allow simultaneous unsynchronized writers to corrupt the archive.

### 5.10 Compaction

Append-only updates naturally accumulate obsolete versions.

Tutorux should provide:

```
tutorux archive compact --archive My-Tutoring.tux
```

Compaction should:

1. Lock or snapshot the archive appropriately.
2. Enumerate all reachable records from the latest committed index roots.
3. Preserve selected revision history and required source data.
4. Write a new single-file archive into the same directory.
5. Validate its internal integrity.
6. Flush the replacement.
7. Atomically replace the old archive where supported.
8. Recover safely if interrupted.

A temporary same-directory replacement file is permitted only for the duration of this operation.

The original archive must remain valid until a fully verified replacement is ready.

### 5.11 Content compression

Compression should be selected per record type:

| Content                 | Strategy                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| Transcript text         | Lightweight compression if beneficial                              |
| JSON metadata           | Compact encoding or compression                                    |
| Audio                   | Lossless compressed chunks                                         |
| Images                  | Preserve original compressed formats unless explicitly transformed |
| PDFs                    | Preserve original bytes                                            |
| Video                   | Preserve compressed source where feasible                          |
| Repetitive derived data | Compress if savings exceed CPU cost                                |
| Index pages             | Prefer fast random access over maximal compression                 |

Avoid recompressing already efficiently compressed images or videos without a measured benefit.

### 5.12 Integrity checks

Each archive needs several levels of verification:

- Header validity.
- Commit-chain validity.
- Index-page checksums.
- Record payload checksums.
- Asset content hashes.
- Referential integrity.
- Timestamp-range validity.
- Schema-version compatibility.
- Revision lineage validity.

A quick verification may check the latest roots and recent records.

A full verification may scan every reachable record and verify its content.

# Part III. How the Application Actually Functions

## 6. The complete Tutorux user journey

The normal user experience remains unchanged by the archive-only requirement.

1

Open Tutorux

Discover or initialize a portable archive

2

Create a session

Select a student, subject, objectives, and recording sources

3

Record

Capture microphone/system audio directly into the archive

4

Annotate

Add timestamped notes, mistakes, instructions, and examples

5

Attach materials

Import images, essays, worksheets, PDFs, audio, and other assets

6

Review transcript

Correct words, speakers, timestamps, and evidence links

7

Analyze lesson

Identify concepts, misunderstandings, corrections, and instructions

8

Choose AI

BYOK, external chat agent, Ollama, or llama.cpp

9

Generate guide

Create structured, personalized, source-linked learning materials

10

Approve

Verify and edit the document

11

Export

Generate PDF, DOCX, HTML, Markdown, or AI interchange files

12

Continue later

Reopen the same archive on any supported computer

A user must also be able to begin at an intermediate stage.

For example, importing an already recorded lesson must not require using Tutorux's recording tools. Creating a guide from tutor notes and attached student work must not require an audio recording.

## 7. First launch and setup

The application should not ask the user to create an account, install Python, configure an external database, or connect an AI provider.

### 7.1 First-launch sequence

On GUI startup:

1. Resolve the discovery directory.
2. Scan its immediate file level for `.tux` archives.
3. Open the only valid archive, offer a choice among multiple archives, or initialize a new archive.
4. Load that archive's lightweight configuration.
5. Display the dashboard.
6. Defer heavy components until requested.

### 7.2 Archive initialization

The new-archive dialog should request:

- Archive filename.
- Optional workspace display name.
- Optional archive passphrase.
- Optional initial tutor profile.
- Optional archive description.

Everything else should use sensible defaults.

The archive should not require an AI API key, model download, or microphone permission to initialize.

### 7.3 Model onboarding

When transcription is first requested, offer the user a choice of compatible local speech models.

When AI generation is first requested, offer:

- Configure a provider/API key.
- Connect to Ollama.
- Connect to a llama.cpp server.
- Select a local GGUF model for embedded inference.
- Export a prompt for an external chat agent.

No language-model weights should ever be bundled or silently downloaded.

### 7.4 Portable model paths

Model configuration should use relative paths whenever possible.

For example:

```
Tutorux/
├── Tutorux.exe
├── My-Tutoring.tux
├── whisper-base.en.bin
└── chosen-local-model.gguf
```

The `.tux` archive stores model identifiers, relative file references, configuration, and compatibility metadata.

The model weights remain explicitly user-provisioned files. Tutorux must not automatically copy them into a system-wide model directory.

For users who want a single portable data file, models may optionally be imported as opaque blobs into the archive. However, direct inference from such blobs requires a compatible loader; Tutorux must not silently extract multi-gigabyte model files into system directories. The simpler and preferred default is an explicitly selected adjacent model file.

## 8. Student profiles and learning history

The active archive owns its student records.

Each student may have:

```
Student
  id
  displayName
  optionalGrade
  subjects
  learningObjectives
  knownDifficulties
  demonstratedImprovements
  preferredGuideTemplate
  tutorNotes
  sessionReferences
  createdAt
  updatedAt
```

Student data must not be silently shared across archives.

If the user wants to move a student or a set of sessions, Tutorux should offer an explicit cross-archive transfer operation.

### 8.1 Cross-session progress

Tutorux should distinguish between:

- A newly observed difficulty.
- A recurring difficulty.
- Partial improvement.
- Demonstrated mastery.
- Unverified improvement.
- A skill not revisited.

These classifications must be supported by source evidence and remain editable.

A student should never be marked as having mastered a skill merely because the AI produced an optimistic summary.

### 8.2 Archive-level history

All session and student history within one archive is accessible without scanning other archives.

If a user explicitly requests history spanning multiple archives, Tutorux may inspect selected archives in the immediate directory, but must not silently merge or modify them.

## 9. Creating a tutoring session

The New Session dialog asks for:

| Field                  | Requirement                                 |
| ---------------------- | ------------------------------------------- |
| Student                | Existing student, new student, or anonymous |
| Subject                | User-defined; presets optional              |
| Title                  | Optional                                    |
| Learning objectives    | Optional                                    |
| Recording source       | Microphone, system audio, both, or none     |
| Transcription language | Automatic or selected                       |
| Guide template         | General or subject-specific                 |
| Recording consent      | Explicit confirmation before recording      |

The session should be committed as a lightweight record inside the archive.

### 9.1 Session state model

Recording and processing states must be independent.

Recording states:

```
NotStarted
Initializing
Recording
Paused
Finalizing
Completed
Interrupted
Failed
```

Processing states:

```
NotProcessed
Transcribing
TranscriptReady
ReviewRequired
Analyzing
EvidenceReady
GeneratingGuide
GuideDraftReady
AwaitingApproval
Approved
```

A session may be recording while provisional transcription is running.

A session may have an approved guide and later receive additional attachments or an updated transcript. Such changes must mark affected guide content as stale without destroying the approved revision.

### 9.2 Session transaction behavior

Creating, renaming, archiving, or deleting a session updates the selected `.tux` file.

Deleting a session should create a recoverable logical deletion, with physical space reclaimed during compaction according to the selected retention policy.

Deleting a session must not modify files belonging to another archive.

## 10. Recording interface and behavior

The recording workspace should offer a distraction-free interface.

TUTORUX / LIVE SESSION

## Honors English · Rhetorical Analysis

Student A · Portable archive: My-Tutoring.tux

&#x20;RECORDING

## 00:24:18

&#x20;Pause

&#x20;Finish

UI illustration only; recording controls are not connected.

Live transcript

24:09 · Tutor

"Explain how the rhetorical choice would affect the audience, not just what the strategy is."

24:15 · Student

"So I need to say why they would respond that way?"

Tutor notes

Important correction

Connect evidence to audience response.

\+ Insert note or quick marker

### 10.1 Recording modes

Support microphone-only, microphone plus system audio, supported per-application capture, and imported recordings.

The user must also be able to disable recording and create a notes-only session.

### 10.2 Recording start

When Start is pressed:

1. Verify the archive is writable and locked for modification.
2. Confirm the selected audio devices.
3. Confirm required recording permissions.
4. Create a durable recording-session record.
5. Allocate bounded capture buffers.
6. Initialize native audio capture.
7. Begin appending audio chunks directly to the archive.
8. Start the session timer.
9. Offer optional live transcription.
10. Display device and persistence status.

Recording start must not wait for AI provider discovery or guide-generation initialization.

### 10.3 Recording independence

If transcription fails, recording continues.

If an AI provider becomes unavailable, recording continues.

If an attachment cannot be parsed, recording continues.

If a thumbnail fails to render, recording continues.

The recording subsystem must be isolated from unrelated failures.

### 10.4 Recording into the archive

The audio writer appends chunk records directly to `.tux`.

No extracted recording folder is created.

Each committed audio chunk contains:

```
AudioChunkRecord
  sessionId
  trackId
  sequenceNumber
  firstSampleIndex
  sampleCount
  timelineStartUs
  timelineEndUs
  sampleFormat
  codec
  encodedPayload
  payloadChecksum
```

Chunk records may be compressed individually with a lossless codec.

### 10.5 Durability policy

The archive should support an explicit recording durability policy.

Default: Frequently commit complete audio chunks with a bounded durability window.

Maximum durability: Commit more frequently, accepting additional storage writes.

Reduced-write mode: Permit longer commit intervals with a clear warning that more recent uncommitted audio may be lost after a power failure.

The user must not be misled by an on-screen "Saved" indicator before the relevant commit is durable.

### 10.6 Multiple tracks

Capture microphone and system audio as separate logical tracks.

This enables better speaker interpretation, audio playback, track-specific error recovery, and future processing.

Tutorux may generate a synchronized mixed playback stream, but original tracks must remain preserved.

### 10.7 Device failure

If one source fails while another remains available, Tutorux should continue the surviving source and display a clear warning.

The archive should record the failed source, time of failure, and any resulting audio gap.

It must not replace a missing segment with fabricated silence without labeling the gap appropriately.

## 11. Tutor annotations

Annotations are first-class learning evidence.

### 11.1 Categories

```
namespace tutorux::annotation {

enum class AnnotationType {
    GeneralNote,
    ImportantConcept,
    StudentMistake,
    TutorCorrection,
    ExplicitInstruction,
    WorkedExample,
    FollowUpPriority,
    StudentQuestion,
    LearningOutcome,
    Custom
};

enum class Priority {
    Low,
    Normal,
    High,
    Critical
};

}
```

### 11.2 Quick markers

Default keyboard shortcuts:

| Shortcut     | Action               |
| ------------ | -------------------- |
| Ctrl/Cmd + 1 | Important concept    |
| Ctrl/Cmd + 2 | Student mistake      |
| Ctrl/Cmd + 3 | Tutor correction     |
| Ctrl/Cmd + 4 | Explicit instruction |
| Ctrl/Cmd + 5 | Worked example       |
| Ctrl/Cmd + 6 | Follow-up priority   |
| Ctrl/Cmd + M | General marker       |

All shortcuts must be configurable.

A quick marker should be inserted without forcing the tutor to type.

### 11.3 Annotation structure

```
Annotation
  id
  sessionId
  startTimeUs
  endTimeUs
  type
  priority
  title
  content
  sourceSegmentIds
  relatedAssetIds
  origin
  createdAt
  updatedAt
  revision
```

### 11.4 Annotation operations

Support create, update, delete, prioritize, duplicate, merge, split, link/unlink evidence, and revision history.

Each operation appends a new logical revision within the same `.tux` archive.

### 11.5 Spoken instruction detection

Tutorux should recognize candidate phrases such as:

- "Remember to explain the effect on the audience."
- "This is the mistake you should avoid."
- "Next time, work on showing your reasoning."
- "Make sure you check your signs."
- "You should use this structure for the next essay."

These become candidate instruction nodes.

They should not automatically become verified tutor instructions until their provenance and wording have been evaluated.

## 12. Transcription workflow

The default local transcription backend remains whisper.cpp, which supports native execution, CPU inference, several acceleration options, and separately provisioned model weights.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



### 12.1 Transcription modes

| Mode           | Function                                       |
| -------------- | ---------------------------------------------- |
| Live           | Generate provisional segments during recording |
| Post-session   | Transcribe completed recording                 |
| Refinement     | Improve provisional transcript                 |
| Selected range | Retranscribe a chosen audio interval           |
| Imported audio | Transcribe material imported into the archive  |
| Manual import  | Accept a transcript without running ASR        |

### 12.2 Where transcription data lives

All persistent transcript records and revisions are stored inside `.tux`.

No permanent transcript JSON file or separate SQLite database is created.

Temporary inference buffers remain in memory and are released when no longer needed.

### 12.3 Transcript segment structure

```
namespace tutorux::transcription {

using SegmentId = std::uint64_t;
using SpeakerId = std::uint64_t;

struct TimeRange final {
    std::int64_t startUs;
    std::int64_t endUs;
};

struct TranscriptSegment final {
    SegmentId id;
    TimeRange range;
    std::optional<SpeakerId> speakerId;

    std::string text;

    bool isProvisional;
    bool isTutorVerified;

    std::uint64_t revision;
};

}
```

The full implementation must also track source audio, ASR model provenance, editing history, and optional confidence metadata.

### 12.4 Provisional versus verified text

Each segment has an explicit verification state:

```
MachineProvisional
MachineFinal
HumanCorrected
HumanVerified
```

A later ASR run must not silently overwrite human-verified changes.

### 12.5 Transcript editing

The tutor can:

- Correct text.
- Split segments.
- Merge segments.
- Reassign speakers.
- Adjust timestamps.
- Search the transcript.
- Navigate to the original audio.
- Add annotations.
- Highlight content.
- Undo and redo.
- Compare revisions.

### 12.6 Speaker diarization

Speaker diarization is separate from transcription.

Tutorux should allow optional local diarization, manual speaker labels, unknown speakers, and overlapping speech where supported.

It must not present uncertain speaker assignment as verified identity.

### 12.7 Audio navigation

Clicking a transcript timestamp should seek into the archive's indexed audio chunk records.

The application should not extract the complete audio file merely to play ten seconds.

## 13. Multimodal asset support

Tutorux must support drag-and-drop import at any time.

### 13.1 Supported files

| Category               | Examples                            |
| ---------------------- | ----------------------------------- |
| Images                 | PNG, JPEG, WebP, GIF                |
| Documents              | PDF, DOCX, TXT, Markdown            |
| Audio                  | WAV, FLAC, MP3, M4A                 |
| Video                  | MP4, WebM, MOV                      |
| Code                   | C++, Python, Java, JS, Rust         |
| Mathematical documents | LaTeX, MathML                       |
| Structured data        | CSV, JSON                           |
| Other attachments      | Preserved as opaque blobs when safe |

### 13.2 Import behavior

When a user drops `essay.png` into Tutorux:

1. Validate the file and size.
2. Stream its bytes through a content hash.
3. Check whether identical content already exists in the archive.
4. Append the asset only if needed.
5. Create a logical asset reference.
6. Generate a thumbnail if appropriate.
7. Store thumbnail/cache records inside the same archive.
8. Link the asset to the active session.
9. Allow association with transcript segments and annotations.

The original file is not modified.

### 13.3 Content addressing

Use a strong, efficient hash such as BLAKE3.

Store logical asset metadata separately from immutable content blobs.

Two sessions may reference the same asset bytes within one archive without storing duplicate copies.

Deduplication across separate archives must not require a global content registry.

### 13.4 Model-specific capabilities

An asset is not automatically compatible with every AI model.

Tutorux must inspect the selected model's supported modalities.

If a vision-capable model is selected, images may be sent directly.

If a text-only model is selected, the user may choose a supported extraction/OCR route or explicitly exclude the image.

If the selected model cannot process video, Tutorux must not claim that the video was analyzed.

### 13.5 Source relationships

An imported essay screenshot may be linked to a transcript segment, tutor annotation, identified mistake, corrected example, and guide paragraph.

Those references are stored as relationships inside the same archive.

## 14. Session review and approval workflow

At the end of the lesson, Tutorux should show a compact review dashboard:

```
Session Overview
  Duration: 75 minutes
  Audio tracks: 2
  Transcript status: Ready
  Tutor annotations: 14
  Imported assets: 3
  Important instructions: 5 candidates
  Student difficulties: 4 candidates
  Unverified source items: 2

Actions
  Review transcript
  Review teaching points
  Generate study guide
  Save and exit
```

Counts in this illustration are examples, not actual session data.

### 14.1 The review interface

The user can inspect:

- Entire timeline.
- Tutor annotations.
- Extracted evidence.
- Speaker attribution.
- Imported student work.
- Uncertain transcript regions.
- Contradictions.
- Pending corrections.

### 14.2 Review is not mandatory for every item

To keep the workflow efficient, Tutorux should prioritize high-impact uncertainty.

For example, a low-confidence proper noun may require correction, while an unimportant filler phrase does not warrant interrupting the tutor.

Tutorux should surface issues according to instructional significance.

### 14.3 Safe save-and-exit

A user must be able to stop after recording, close Tutorux, and return to the archive later.

All committed state remains inside `.tux`.

No separate session folder must be copied or preserved.

# Part IV. The Study-Guide Product

## 15. The final student-facing document

Tutorux must produce a document that functions independently of the original lesson.

TUTORUX · EXAMPLE STUDY GUIDE

# Rhetorical Analysis

Honors English · Session 04

What You Learned

Today's lesson focused on moving beyond identifying rhetorical choices and explaining how those choices influence an audience.

Your Main Area for Improvement

Explain why a rhetorical choice matters.

Naming a device is only the first step. Effective commentary explains the intended audience response and how that response advances the author's purpose.

What Your Tutor Told You To Do

- Identify the rhetorical choice.
- Explain the audience's likely response.
- Connect that response to the author's purpose.
- Use specific commentary rather than generic statements.

Before and After Example

BEFORE

"The author uses pathos to convince readers."

AFTER

"By describing the emotional consequences of the policy, the author encourages readers to consider its human impact, thereby making the argument more personally relevant to the intended audience."

What to Focus on Next

Practice connecting rhetorical choices, audience response, and authorial purpose in your commentary.

Illustrative guide only. An actual Tutorux guide must derive claims from a real session and undergo tutor review.

### 15.1 Required configurable guide sections

| Section                         | Purpose                                           |
| ------------------------------- | ------------------------------------------------- |
| Session overview                | Briefly explain what the lesson addressed         |
| Learning objectives             | Identify intended skills                          |
| Key concepts                    | Preserve subject matter taught                    |
| Detailed explanations           | Make difficult ideas independently understandable |
| Terminology                     | Explain important terms                           |
| Student misconceptions          | Identify what the student misunderstood           |
| Errors and corrections          | Explain mistakes and proper solutions             |
| Tutor instructions              | Preserve explicit directions                      |
| Worked examples                 | Demonstrate corrected techniques                  |
| Important notices               | Emphasize warnings and reminders                  |
| Supporting materials            | Include relevant images/documents                 |
| Practice recommendations        | Suggest useful exercises                          |
| Progress since previous lessons | Present evidence-backed improvements              |
| Next-session priorities         | Identify what deserves attention next             |
| Sources                         | Link important claims to their evidence           |

Not every session must produce every section.

A short session should generate a concise guide without filler.

### 15.2 Subject-specific guide templates

The default template system should include:

English: Argumentative writing, rhetorical analysis, commentary, grammar, evidence integration, revision examples.

Mathematics: Concepts, formulas, derivations, step-by-step solutions, misconceptions, practice problems.

Science: Definitions, relationships, experiments, reasoning, calculations, scientific limitations.

Programming: Errors, debugging steps, algorithm explanations, code samples, alternative implementations, complexity.

Language learning: Vocabulary, pronunciation notes, grammar, usage, corrections, practice.

General tutoring: Concepts, explanations, corrections, instructions, examples, next steps.

Templates must remain user-editable and are stored inside the archive.

### 15.3 Output provenance

Tutorux must distinguish:

- Tutor-authored instruction.
- Directly observed student difficulty.
- Tutor explanation.
- Verified example from the session.
- AI-generated example.
- AI-generated recommendation.
- Uncertain interpretation.

AI-generated examples may be useful, but they must not be falsely described as examples that actually occurred during the lesson.

### 15.4 Guide editing

The tutor can:

- Rewrite paragraphs.
- Rearrange sections.
- Insert and remove examples.
- Add images.
- Add formulas.
- Edit tables.
- Regenerate one section.
- Verify source citations.
- Compare document revisions.
- Approve the final guide.

Approved manual edits must not be silently overwritten by later AI generation.

### 15.5 Export behavior

Tutorux should export:

- PDF.
- DOCX.
- HTML.
- Markdown.
- Native structured guide data.
- AI interchange package.

The editable guide itself remains inside the `.tux` archive.

An exported PDF or DOCX is intentionally written to the user-selected destination, defaulting to the current archive directory.

This does not create a second internal application workspace.

### 15.6 Equations and technical content

The document model should preserve:

- LaTeX and structured mathematics.
- Unicode.
- Code blocks.
- Tables.
- Figures.
- Images.
- Numbered examples.
- Technical notation.

Avoid rasterizing mathematical text merely for implementation convenience.

PDF exports should preserve selectable text, correct pagination, appropriate embedded fonts, and accessible document structure where the backend supports it.

# Part V. The CLI-First C++23 Application Architecture

## 16. One application, two desktop interfaces

Tutorux should remain a modular monolith.

Its architecture is:

Native GUI

Slint presentation

Terminal CLI

Scriptable commands

Typed Command Dispatcher

Validation · Transactions · Progress · Cancellation · Authorization

Platform-independent C++23 Core

Archive Engine

Students & Sessions

Audio & Transcription

Annotations & Assets

Evidence & Learning

AI Orchestration

Document Editor & Export

Scheduler & Recovery

OS Adapters

Audio · Graphics · File handles · IPC

AI Adapters

Cloud · Ollama · llama.cpp · Manual

The core must not depend on Slint, terminal rendering, or any particular AI provider.

The archive engine replaces the previous separate workspace filesystem and SQLite persistence modules.

## 17. Complete CLI architecture

Every core operation exposed by the GUI must have a corresponding CLI command.

The command system should include:

```
tutorux
│
├── gui
├── help
├── version
│
├── archive
│   ├── discover
│   ├── init
│   ├── list
│   ├── open
│   ├── info
│   ├── verify
│   ├── recover
│   ├── compact
│   ├── copy
│   ├── rename
│   ├── encrypt
│   ├── unlock
│   ├── change-passphrase
│   ├── backup
│   └── migrate
│
├── student
│   ├── create
│   ├── list
│   ├── show
│   ├── update
│   ├── delete
│   ├── history
│   └── progress
│
├── session
│   ├── create
│   ├── list
│   ├── show
│   ├── update
│   ├── clone
│   ├── archive
│   ├── delete
│   ├── verify
│   ├── recover
│   ├── export
│   └── import
│
├── record
│   ├── devices
│   ├── test
│   ├── configure
│   ├── start
│   ├── pause
│   ├── resume
│   ├── stop
│   └── status
│
├── transcript
│   ├── generate
│   ├── refine
│   ├── show
│   ├── search
│   ├── correct
│   ├── split
│   ├── merge
│   ├── speaker
│   ├── verify
│   └── export
│
├── annotation
│   ├── add
│   ├── list
│   ├── show
│   ├── update
│   ├── remove
│   ├── link
│   ├── unlink
│   └── prioritize
│
├── asset
│   ├── add
│   ├── import-folder
│   ├── list
│   ├── show
│   ├── preview
│   ├── extract
│   ├── link
│   ├── unlink
│   ├── verify
│   └── remove
│
├── evidence
│   ├── extract
│   ├── list
│   ├── show
│   ├── review
│   ├── approve
│   ├── reject
│   ├── link
│   └── verify
│
├── ai
│   ├── providers
│   ├── models
│   ├── capabilities
│   ├── configure
│   ├── test
│   ├── package
│   ├── estimate
│   ├── generate
│   ├── import
│   ├── jobs
│   └── cancel
│
├── model
│   ├── list
│   ├── inspect
│   ├── select
│   ├── verify
│   └── remove-reference
│
├── guide
│   ├── create
│   ├── generate
│   ├── show
│   ├── edit
│   ├── section
│   ├── move-section
│   ├── regenerate
│   ├── compare
│   ├── validate
│   ├── approve
│   └── export
│
├── template
│   ├── list
│   ├── create
│   ├── update
│   ├── import
│   ├── export
│   └── delete
│
├── settings
│   ├── list
│   ├── get
│   ├── set
│   ├── reset
│   ├── copy-to-archive
│   └── import
│
├── diagnostics
│   ├── run
│   ├── archive
│   ├── audio
│   ├── graphics
│   ├── providers
│   ├── network
│   └── report
│
└── benchmark
    ├── startup
    ├── memory
    ├── cpu
    ├── audio
    ├── indexing
    ├── rendering
    ├── export
    └── full
```

`session archive` means marking a tutoring session as historically archived inside `.tux`. It does not mean extracting it to a directory.

### 17.1 Complete archive commands

Discover:

```
tutorux archive discover --directory .
```

Initialize:

```
tutorux archive init My-Tutoring.tux
```

Open the GUI with a specific archive:

```
tutorux gui --archive My-Tutoring.tux
```

Inspect:

```
tutorux archive info My-Tutoring.tux --json
```

Verify:

```
tutorux archive verify My-Tutoring.tux --full
```

Compact:

```
tutorux archive compact My-Tutoring.tux
```

Create a backup:

```
tutorux archive backup My-Tutoring.tux \
  --output My-Tutoring-backup.tux
```

A backup is another complete portable archive, not a separate folder tree.

### 17.2 Session commands

```
tutorux --archive My-Tutoring.tux \
  session create \
  --student-id student_001 \
  --subject "Honors English" \
  --title "Rhetorical Analysis"
```

List:

```
tutorux --archive My-Tutoring.tux session list
```

### 17.3 Recording commands

```
tutorux --archive My-Tutoring.tux \
  record start \
  --session session_001 \
  --microphone default \
  --system-audio \
  --detach
```

Status:

```
tutorux --archive My-Tutoring.tux \
  record status \
  --session session_001
```

Stop:

```
tutorux --archive My-Tutoring.tux \
  record stop \
  --session session_001
```

### 17.4 Transcription

```
tutorux --archive My-Tutoring.tux \
  transcript generate \
  --session session_001 \
  --backend whisper \
  --model ./whisper-model.bin
```

### 17.5 Annotation

```
tutorux --archive My-Tutoring.tux \
  annotation add \
  --session session_001 \
  --type explicit-instruction \
  --priority high \
  --at 00:16:10 \
  --text "Explain how rhetorical choices affect the audience."
```

### 17.6 Asset import

```
tutorux --archive My-Tutoring.tux \
  asset add student-essay.png \
  --session session_001
```

The image is copied into the archive as a content-addressed asset.

### 17.7 AI preparation

```
tutorux --archive My-Tutoring.tux \
  ai package \
  --session session_001 \
  --mode manual \
  --output session-ai-prompt.md
```

### 17.8 BYOK generation

```
tutorux --archive My-Tutoring.tux \
  ai generate \
  --session session_001 \
  --provider openrouter \
  --model "provider/model-id"
```

### 17.9 Local AI generation

```
tutorux --archive My-Tutoring.tux \
  ai generate \
  --session session_001 \
  --provider ollama \
  --model "installed-model-id"
```

### 17.10 Study-guide export

```
tutorux --archive My-Tutoring.tux \
  guide export \
  --session session_001 \
  --format pdf \
  --output study-guide.pdf
```

The exported PDF is a user-requested file. The authoritative guide remains inside the `.tux` archive.

## 18. GUI and CLI equivalence

The GUI should not launch a new process for each button click.

Both interfaces invoke a shared command executor.

```
GUI button
     ↓
Typed command request
     ↓
Command dispatcher
     ↓
Domain service
     ↓
Archive transaction
     ↓
Structured result
     ↓
GUI update
```

```
CLI arguments
     ↓
Typed command request
     ↓
Same command dispatcher
     ↓
Same domain service
     ↓
Same archive transaction
     ↓
Structured result
     ↓
Terminal output
```

### 18.1 Command definitions

Each command must declare:

```
CommandDefinition
  canonicalName
  arguments
  options
  validationRules
  requiredArchiveState
  permissions
  transactionPolicy
  cancellationPolicy
  progressSchema
  resultSchema
  errorCodes
```

Command definitions should be the source for CLI help, GUI bindings where practical, automated documentation, and parity tests.

### 18.2 Machine-readable output

Standard options include:

```
--json
--quiet
--verbose
--timeout
--no-color
--output
--dry-run
--progress=jsonl
```

A CLI command must return a meaningful exit code and a documented result.

### 18.3 Detached recording

A CLI command must be able to start a recording and exit while recording continues.

The same Tutorux executable runs in a dedicated worker mode.

The worker retains the archive write lease and appends audio directly to `.tux`.

Other Tutorux processes communicate with the worker through native local IPC:

| Platform | IPC                 |
| -------- | ------------------- |
| Windows  | Named pipes         |
| macOS    | Unix-domain sockets |
| Linux    | Unix-domain sockets |

No TCP listening port is required.

The worker terminates after recording finishes.

### 18.4 Writer ownership

Because the archive permits only one active writer, GUI and CLI operations must coordinate through the archive owner.

If a recording worker owns the archive, other commands should submit write requests through authenticated local IPC rather than opening another unsynchronized writer.

Read-only operations may use a valid committed snapshot.

The system must never compromise archive consistency to satisfy CLI concurrency.

## 19. Modular C++23 architecture

Tutorux should be structured as one modular native application.

Native GUI

Slint

CLI

Terminal

Command Application Layer

Validation, orchestration, transactions, cancellation

C++23 Core

Archive Storage

Students/Sessions

Recording

Transcription

Annotations/Assets

Evidence/Learning

AI Providers

Guide Compilation

Scheduling

Diagnostics

Platform

Windows · macOS · Linux · WASM

Inference

Cloud · Ollama · llama.cpp

### 19.1 Module ownership

| Module          | Responsibilities                                    |
| --------------- | --------------------------------------------------- |
| `core`          | IDs, errors, time, cancellation, common types       |
| `command`       | Typed command registry and dispatch                 |
| `archive`       | File format, indexes, commits, recovery, compaction |
| `student`       | Student profiles                                    |
| `session`       | Session state and lifecycle                         |
| `audio`         | Capture, encoding, playback, synchronization        |
| `transcription` | ASR, segments, speaker metadata                     |
| `annotation`    | Tutor notes and markers                             |
| `asset`         | Import, hashing, previews, extraction               |
| `evidence`      | Concepts, instructions, corrections, source graph   |
| `learning`      | Longitudinal skill tracking                         |
| `ai`            | Providers, models, generation, interchange          |
| `document`      | Guide AST, editor, exports                          |
| `scheduler`     | Worker pools, priorities, job control               |
| `platform`      | Native OS adapters                                  |
| `gui`           | Presentation only                                   |
| `cli`           | Terminal interface only                             |

Dependencies must follow a directed, acyclic module graph.

### 19.2 No unnecessary processes

Do not split the application into microservices.

Normal GUI/CLI operations should execute in-process.

Separate processes are justified for detached recording, optional dangerous parser isolation, and explicitly configured external inference services.

## 20. C++23 coding rules

The code should resemble high-quality, carefully organized Java in readability while retaining C++ efficiency.

### 20.1 Style

Use descriptive classes:

```
ArchiveManager
ArchiveReader
ArchiveWriter
ArchiveTransaction
SessionManager
RecordingController
TranscriptRepository
EvidenceGraph
AiProviderRegistry
StudyGuideCompiler
```

Use descriptive methods:

```
openArchive()
createSession()
startRecording()
addAnnotation()
getTranscriptSegment()
generateStudyGuide()
exportDocument()
```

Avoid unnecessary abbreviations and hidden behavior.

### 20.2 Namespace policy

Use meaningful namespace boundaries frequently:

```
namespace tutorux::core {}
namespace tutorux::archive {}
namespace tutorux::session {}
namespace tutorux::audio {}
namespace tutorux::transcription {}
namespace tutorux::annotation {}
namespace tutorux::asset {}
namespace tutorux::evidence {}
namespace tutorux::ai {}
namespace tutorux::document {}
namespace tutorux::platform {}
```

Use selectively scoped imports:

```
namespace tutorux::archive {

using std::expected;
using std::optional;
using std::span;
using std::string;
using std::vector;

}
```

Using `namespace std;` indiscriminately, especially in public headers, is prohibited because it creates name collisions and hurts maintainability.

Broader using directives may be allowed within narrow implementation scopes when they measurably improve readability.

### 20.3 No application inheritance

Use composition, C++ concepts, value types, and explicit runtime dispatch.

Avoid abstract base-class hierarchies.

Example:

```
namespace tutorux::archive {

class ArchiveManager final {
public:
    ArchiveManager(
        ArchiveReader& reader,
        ArchiveWriter& writer,
        ArchiveValidator& validator
    );

    [[nodiscard]]
    auto openArchive(const ArchivePath& path)
        -> std::expected<ArchiveHandle, ArchiveError>;

    [[nodiscard]]
    auto createArchive(const ArchivePath& path)
        -> std::expected<ArchiveHandle, ArchiveError>;

private:
    ArchiveReader& reader_;
    ArchiveWriter& writer_;
    ArchiveValidator& validator_;
};

}
```

The production implementation must ensure these borrowed dependencies outlive `ArchiveManager`.

### 20.4 Compile-time concepts

```
namespace tutorux::archive {

template<typename T>
concept RecordReader = requires(
    T& reader,
    RecordId id
) {
    { reader.readRecord(id) }
        -> std::same_as<
            std::expected<Record, ArchiveError>
        >;
};

}
```

Use concepts only where compile-time contracts meaningfully improve correctness and readability.

### 20.5 Runtime polymorphism

Where dynamic selection is required, such as AI providers, use type erasure, function tables, or tagged variants.

Do not introduce inheritance simply because multiple providers exist.

### 20.6 Memory ownership

Mandatory rules:

- RAII.
- No raw owning pointers.
- Minimal shared ownership.
- Explicit borrowed references.
- Move semantics for transferable resources.
- `std::expected` for recoverable failures.
- Immutable data where practical.
- Structured concurrency and cancellation.
- No hidden global mutable state.

### 20.7 Human readability

A developer should quickly understand:

- What the function does.
- What it modifies.
- What it owns.
- What may fail.
- Which thread may call it.
- Whether it blocks.
- Which invariants it relies on.
- Why an optimization exists.

Avoid both enormous monolithic functions and unnecessary wrapper abstractions.

# Part VI. AI Provider Independence, Local AI, and Manual Generation

## 21. Three first-class AI workflows

Tutorux must support all three modes through the same underlying pipeline.

Bring Your Own Key

The user selects a compatible provider/model. Tutorux constructs the request, transmits the approved material, streams the response, validates it, and creates an editable guide.

Manual external chat agent

Tutorux creates the complete session prompt and attachment package. The user runs it through their preferred chat agent, then imports the response.

Local AI

Tutorux connects to Ollama or a llama.cpp server, or uses an optional embedded llama.cpp inference runtime with user-supplied model weights.

All three modes must consume one canonical Tutorux AI input representation and produce the same structured guide-document model.

## 22. Target provider catalog

At least 30 integrations should be supported. The target catalog remains the following 36 services.

| Group                     | Providers                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- |
| Major frontier APIs       | OpenAI, Anthropic, Google Gemini, xAI                                         |
| Aggregators               | OpenRouter, Together AI, Fireworks AI, DeepInfra, Novita AI, Nebius           |
| High-throughput inference | Groq, Cerebras, SambaNova, NVIDIA NIM                                         |
| Other model APIs          | DeepSeek, Mistral, Cohere, AI21, Perplexity                                   |
| Model platforms           | Hugging Face, Replicate, Cloudflare Workers AI                                |
| Regional providers        | Moonshot AI, Z.AI, MiniMax, SiliconFlow                                       |
| Cloud platforms           | Amazon Bedrock, Azure OpenAI, Alibaba Cloud, Baidu, Tencent Cloud, Volcengine |
| OpenCode                  | OpenCode Go, OpenCode Zen                                                     |
| Local services            | Ollama, LM Studio                                                             |

Additionally, support:

- llama.cpp server.
- Embedded llama.cpp.
- Arbitrary user-configured OpenAI-compatible endpoints.

These are intended integrations. Every provider must have independently tested functionality; appearing in the selector is not proof of compatibility.

### 22.1 OpenCode Go restrictions

OpenCode Go's current documentation states that it is designed for OpenCode and similar coding-agent traffic. It also documents stable session identifiers and particular endpoint formats.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.opencode.ai\&sz=32)

OpenCode



Tutorux should support the protocol adapter while respecting the provider's permitted-use conditions.

It must not disguise tutoring traffic as coding-agent traffic.

If ordinary tutoring guide generation is not permitted by a provider, that functionality must be disabled or clearly restricted for that provider rather than falsely advertised as universally compatible.

## 23. Runtime model discovery

No model versions should be permanently hardcoded into Tutorux.

Provider identity, authentication mechanisms, protocol definitions, and catalog discovery rules may be part of the application.

Model lists must be retrieved dynamically.

### 23.1 Discovery hierarchy

1. Official provider model-list endpoint.
2. Account-specific model/deployment endpoint.
3. Official provider metadata feed.
4. Maintained third-party catalog such as Models.dev.
5. Previously cached catalog.
6. Manual custom model ID.

### 23.2 Model selector behavior

When the user opens a provider:

1. Read the latest cached catalog from the active `.tux` archive.
2. Display it immediately.
3. Check the cache timestamp.
4. Refresh asynchronously when required.
5. Validate and merge new metadata.
6. Show the updated list.
7. Commit the updated catalog back into the same archive.

Tutorux must not create a global model metadata cache elsewhere.

### 23.3 Model metadata

```
ModelDescriptor
  providerId
  modelId
  displayName
  protocolFamily
  contextWindow
  maximumOutputTokens
  inputModalities
  outputModalities
  structuredOutputSupport
  streamingSupport
  toolSupport
  tokenizerInformation
  pricingInformation
  availabilityStatus
  verificationStatus
  metadataSource
  retrievedAt
```

Capabilities must be represented as supported, unsupported, unknown, or conditional rather than relying on a few unreliable booleans.

### 23.4 Model freshness

The user should be able to refresh catalogs on demand.

A configurable short-lived cache can improve responsiveness and avoid unnecessary requests.

If offline, Tutorux should show the last known catalog with a visible freshness indicator.

Discovering a model does not prove that the user's account can access it.

### 23.5 Compatibility probes

Support optional, user-triggered tests for:

- Authentication.
- Basic generation.
- Streaming.
- Structured output.
- Multimodal input.
- Cancellation.
- Response usage reporting.

Probes that may incur API costs must not be run silently.

## 24. Provider protocol architecture

Different providers expose different request and streaming formats.

Tutorux should support:

| Protocol family         | Function                                             |
| ----------------------- | ---------------------------------------------------- |
| OpenAI Responses        | Responses-style generation                           |
| OpenAI Chat Completions | Compatible chat-generation APIs                      |
| Anthropic Messages      | Anthropic-style messages                             |
| Gemini GenerateContent  | Gemini-specific multimodal requests                  |
| Ollama Native           | Local inference and model discovery                  |
| llama.cpp server        | Local compatible APIs                                |
| Provider-specific       | Specialized authentication, deployments, and routing |
| Embedded inference      | Direct native C++ calls without networking           |

A provider may use different protocol families for different models.

### 24.1 Canonical generation request

```
namespace tutorux::ai {

struct GenerationRequest final {
    ProviderId providerId;
    ModelId modelId;

    std::vector<ContentPart> content;

    std::uint32_t maximumOutputTokens;

    bool requireStructuredOutput;
    bool enableStreaming;
};

}
```

In production, `ContentPart` should use a type-safe tagged representation for text, images, audio, documents, and other modalities.

### 24.2 Networking

Use outbound HTTPS with:

- TLS verification.
- Request timeouts.
- Cancellation.
- Streaming response decoding.
- Rate-limit handling.
- Bounded retries.
- Exponential backoff.
- `Retry-After` support.
- Proxy settings.
- Redacted logs.
- Usage accounting.
- Typed error classification.

Do not retry requests blindly when the server may already have processed them.

### 24.3 Provider client instances

Provider clients should be created lazily.

Only the selected provider needs an active client for a normal generation operation.

Idle Tutorux should not maintain dozens of provider threads or repeatedly check every service.

## 25. Ollama integration

Tutorux must support Ollama as a local inference service.

### 25.1 Required behavior

When selected:

1. Read the configured Ollama endpoint from the archive.
2. Test connectivity.
3. Discover installed models.
4. Inspect the selected model's metadata.
5. Determine known capabilities.
6. Prepare the generation request.
7. Stream the response.
8. Validate and save the result inside `.tux`.

Ollama exposes `/api/tags` for listing locally available models.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



### 25.2 No automatic system-level modifications

Tutorux must not install Ollama automatically.

It must not modify Ollama's global configuration or model directories.

An existing Ollama service is an external dependency controlled by the user.

Tutorux may connect to that service, but the service's own storage behavior is outside Tutorux's portable-data guarantees.

### 25.3 Inference settings

Support configurable:

- Endpoint.
- Model.
- Context size.
- Generation parameters.
- Request timeout.
- Streaming.
- Concurrency.
- Optional keep-alive where supported.

Settings persist inside the archive.

## 26. llama.cpp integration

Tutorux must support both server-based and embedded llama.cpp inference.

### 26.1 Existing server

Use the existing server's supported endpoints.

The upstream project documents OpenAI-compatible API routes and multimodal functionality, though availability depends on the model and runtime configuration.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



### 26.2 Embedded inference

The full desktop build should optionally include an embedded llama.cpp runtime.

The user selects a GGUF model.

Tutorux then:

1. Validates model format.
2. Inspects model metadata.
3. Estimates memory requirements.
4. Checks available system resources.
5. Configures threads and acceleration.
6. Loads the model when generation is requested.
7. Performs inference.
8. Releases or retains the model according to policy.

This requires no HTTP service or network port.

### 26.3 Model weights remain external

No LLM weights, including small or quantized models, are bundled.

A user may place a model beside the executable or explicitly select another accessible path.

Tutorux must not automatically search global model directories.

### 26.4 Multimodal local models

Support image/audio/video inputs only where the actual model and backend support them.

Some multimodal llama.cpp configurations require additional projector files or other model-specific resources.

If those are unavailable, Tutorux should explain the missing capability rather than silently dropping the asset.

### 26.5 Memory policy

Large model contexts must be loaded lazily.

Support:

- Explicit unloading.
- Automatic unload after inactivity, where configured.
- Memory-pressure handling.
- Configurable GPU offload.
- Bounded concurrency.
- Cancellation.
- Safe cleanup after failure.

## 27. The no-API-key external-agent workflow

The user should be able to generate a study guide without providing Tutorux an API key.

### 27.1 Exact workflow

The user selects External Chat Agent.

Tutorux:

1. Reads the selected session from the archive.
2. Selects the transcript and notes.
3. Includes important tutor instructions.
4. Adds evidence references.
5. Includes selected assets or attachment instructions.
6. Applies the guide template.
7. Creates a complete generation prompt.
8. Validates source completeness.
9. Allows copying or exporting the package.
10. Waits for the user to import the response.

The user may process the package with ChatGPT, Claude, Gemini, or another suitable agent.

### 27.2 Canonical AI interchange package

```
Tutorux-AI-Package
  manifest.json
  session.json
  transcript.json
  annotations.json
  evidence.json
  assets-manifest.json
  generation-instructions.md
  verification-instructions.md
  guide-response.schema.json
```

Inside the authoritative Tutorux archive, this is stored as a structured generation package.

When explicitly exported, it may be serialized as:

- One Markdown prompt.
- A JSON package.
- A portable ZIP archive.
- Multiple ordered text parts for large sessions.

These are explicit interchange exports, not extracted Tutorux working sessions.

### 27.3 Long sessions

When a transcript exceeds the target model context window, Tutorux should generate a multi-part workflow.

For example:

```
Prompt 1: Analyze transcript section A.
Prompt 2: Analyze transcript section B.
Prompt 3: Analyze transcript section C.
Prompt 4: Consolidate evidence without losing instructions.
Prompt 5: Generate final structured study guide.
```

The actual split points should respect topic and sentence boundaries.

### 27.4 External response import

Tutorux must:

- Preserve the original imported response.
- Parse supported structures.
- Validate the document schema.
- Resolve source IDs.
- Flag missing evidence.
- Flag malformed fields.
- Present a preview.
- Allow correction.
- Save a new guide revision into `.tux`.

An invalid response must not overwrite an approved guide.

# Part VII. Evidence, Learning Analysis, and Guide Generation

## 28. Tutorux must understand teaching events

A generic AI meeting summary is insufficient.

Tutorux should identify:

- Concepts taught.
- Explanations.
- Questions.
- Student misconceptions.
- Errors.
- Corrections.
- Explicit tutor instructions.
- Worked examples.
- Demonstrated learning.
- Follow-up priorities.
- AI-generated recommendations.
- Uncertainties.

### 28.1 Evidence graph

```
Student mistake
      ↓ corrected_by
Tutor explanation
      ↓ supports
Explicit instruction
      ↓ demonstrated_by
Worked example
      ↓ included_in
Study-guide section
      ↓ references
Original transcript/audio
```

### 28.2 Evidence node model

```
EvidenceNode
  id
  sessionId
  type
  title
  content
  priority
  origin
  sourceSegmentIds
  sourceAnnotationIds
  sourceAssetIds
  extractionJobId
  verificationState
  revision
```

### 28.3 Relationship types

```
namespace tutorux::evidence {

enum class RelationshipType {
    Explains,
    Corrects,
    Demonstrates,
    Supports,
    Contradicts,
    References,
    DependsOn,
    Reinforces,
    Recommends,
    DerivedFrom
};

}
```

### 28.4 Source provenance

Every significant extracted claim must retain a link to its original supporting evidence.

The interface should allow the tutor to click a generated instruction and navigate to the corresponding transcript/audio timestamp.

### 28.5 Contradictions

If a tutor corrects an earlier explanation, the graph must preserve the correction relationship.

It should not merge contradictory statements into one falsely authoritative claim.

### 28.6 AI suggestions

AI-generated practice advice should be labeled as a suggestion, not as something the tutor explicitly said.

The tutor remains the final authority for approving student-facing documents.

## 29. Guide-generation pipeline

1

Normalize

Validate transcripts, timestamps, notes, and assets

2

Extract

Identify learning concepts, mistakes, corrections, and instructions

3

Link

Associate extracted claims with source evidence

4

Consolidate

Merge genuine duplicates while preserving distinct instructions

5

Organize

Group learning content by topic and skill

6

Plan

Prepare model-compatible context and asset inputs

7

Generate

Create typed guide sections

8

Validate

Check structure, sources, contradictions, completeness

9

Review

Tutor edits, verifies, and approves

10

Export

Render professional documents

### 29.1 Extraction

Produce structured teaching-point candidates with source references.

### 29.2 Consolidation

Repeated explanations may be combined, but distinct instructions cannot be removed merely because they appear similar.

### 29.3 Organization

Arrange concepts by educational relationship rather than conversation order.

### 29.4 Context planning

Respect model context limits, tutor priorities, attachments, and mandatory evidence coverage.

### 29.5 Generation

Generate typed sections that are editable and source-aware.

### 29.6 Validation

Run three kinds of checks:

Structural: Required fields, correct types, valid document tree.

Provenance: Source IDs resolve to actual records.

Semantic: Statements are consistent with cited evidence.

Structural and ID validity can be checked deterministically.

Semantic support may require additional analysis or tutor review.

### 29.7 No silent truncation

If a model cannot process all required evidence at once, Tutorux must use an explicit multi-pass strategy or report the limitation.

It must not silently discard important transcript sections, notes, or attachments.

### 29.8 Incremental regeneration

Editing one paragraph or source segment should not automatically force the entire document to be regenerated.

Tutorux should track which guide sections depend on which evidence records.

When evidence changes, affected sections become stale. The tutor chooses whether to regenerate them.

## 30. Structured guide document model

The guide should not be stored as one unstructured Markdown string.

Use a typed document tree:

```
GuideDocument
  metadata
  templateId
  title
  sections
    heading
    paragraph
    list
    table
    image
    equation
    codeBlock
    workedExample
    instruction
    sourceReference
  revision
  approvalState
```

### 30.1 Guide revision behavior

- Tutor edits create a new revision.
- AI regeneration creates a proposed revision.
- Approved sections remain protected.
- Concurrent modifications are detected.
- Previous revisions remain recoverable according to policy.
- Physical obsolete-record cleanup occurs during archive compaction.

### 30.2 Export

Supported:

| Format                     | Requirement                                                  |
| -------------------------- | ------------------------------------------------------------ |
| PDF                        | Correct pagination, text selection, images, fonts, equations |
| Markdown                   | Readable, portable source                                    |
| HTML                       | Semantic, accessible document                                |
| DOCX                       | Editable word-processing document                            |
| Native structured document | Preserved inside `.tux`                                      |
| AI interchange             | Versioned structured generation package                      |

### 30.3 Export transaction

When exporting:

1. Validate the guide AST.
2. Resolve all required assets from the archive.
3. Apply document layout.
4. Write a temporary file beside the user-selected export destination.
5. Validate the result.
6. Publish it atomically where supported.
7. Preserve the approved guide inside the archive.

User-requested exports are the only routine reason to create standalone document files.

# Part VIII. Algorithms and Extreme Performance Engineering

## 31. Fundamental optimization philosophy

Tutorux must optimize the entire system, not merely individual functions.

Practical performance depends on:

\\[ \text{Performance} = f(\text{algorithmic complexity}, \text{memory locality}, \text{allocation cost}, \text{I/O}, \text{concurrency}, \text{unnecessary work}) \\]

O(1) operations should be used where appropriate, but reading and processing \\(n\\) bytes cannot generally require less than \\(\Omega(n)\\) total work.

An efficient implementation should select algorithms based on the actual data, access patterns, and hardware.

### 31.1 Optimization priorities

1. Correctness and data preservation.
2. GUI responsiveness.
3. Recording reliability.
4. Idle CPU efficiency.
5. Memory efficiency.
6. Startup latency.
7. Active processing throughput.
8. Storage I/O.
9. Binary size.
10. Long-term maintainability.

None of these objectives may be used to justify silent loss of instructional content.

## 32. Data structures and complexity targets

| Operation                       | Strategy                         | Target complexity                              |
| ------------------------------- | -------------------------------- | ---------------------------------------------- |
| Discover archives               | Scan immediate directory entries | O(number of entries)                           |
| Read archive metadata           | Fixed header + indexed manifest  | O(1) fixed header, plus bounded/indexed access |
| Find session by ID              | B+ tree                          | O(log_B n)                                     |
| List sessions                   | Ordered index traversal          | O(log_B n + results)                           |
| Append archive record           | Sequential append                | Amortized O(1) metadata, O(payload bytes)      |
| Commit archive transaction      | Copy-on-write index updates      | Proportional to modified index paths           |
| Seek audio by timestamp         | Sparse timestamp/B+ tree index   | O(log_B n)                                     |
| Retrieve annotation by ID       | In-memory hash index             | Expected O(1)                                  |
| Insert timestamped annotation   | Ordered index                    | O(log n)                                       |
| Append transcript segment       | Segmented storage                | Amortized O(1)                                 |
| Edit long text                  | Piece table or rope              | Approximately O(log n + k)                     |
| Search indexed transcript       | Inverted index                   | Lookup plus results                            |
| Detect duplicate asset          | Content hash + indexed lookup    | Expected O(1) after hashing                    |
| Hash imported content           | Streaming hash                   | O(file size)                                   |
| Update simple progress counters | Incremental aggregates           | O(1)                                           |
| Invalidate guide dependencies   | Graph traversal                  | Proportional to affected subgraph              |
| Render visible transcript       | Virtualized rows                 | O(visible items + layout)                      |
| Render waveform                 | Multi-resolution summary         | Proportional to visible pixel buckets          |
| Export guide                    | Streaming serializer             | O(output size)                                 |
| Compact archive                 | Reachable-record traversal       | O(live data size)                              |
| Transcribe audio                | Speech-model inference           | Model/input dependent                          |

Here \\(B\\) is the index page's effective branching factor, and \\(k\\) is the amount of text copied or modified during an edit.

### 32.1 Avoid unnecessary O(n) operations

The following patterns are prohibited without justification:

- Scanning the whole archive when opening one session.
- Rewriting the archive after editing one note.
- Rebuilding the complete transcript index after changing one segment.
- Decoding an entire recording to draw a small waveform.
- Regenerating every guide section after a minor source edit.
- Rehashing all imported assets at startup.
- Loading every session's complete data for the dashboard.
- Copying all transcript text into several redundant in-memory representations.

These are often more damaging than using an ordinary O(log n) data structure.

## 33. Tutorux-specific algorithms

These are proposed internal algorithms, not claims of previously established research inventions.

### 33.1 ITAE — Incremental Transcript Alignment Engine

Purpose: Keep transcript segments aligned with audio, speaker information, annotations, and evidence after editing.

Structures:

- Stable segment identifiers.
- Ordered timestamp index.
- Revision lineage.
- Audio range mappings.
- Optional interval index.

When a tutor edits a segment, the source audio remains unchanged.

When a segment splits or merges, the graph records which new segments replace the old version.

Target: Indexed operations proportional to the affected segments, rather than a full transcript rebuild.

### 33.2 EAIG — Evidence-Aware Instruction Graph

Purpose: Represent the educational meaning of events.

Nodes include concepts, explanations, misconceptions, errors, corrections, instructions, examples, and learning outcomes.

Relationships include explains, corrects, supports, demonstrates, contradicts, references, and depends on.

Use compact adjacency indexes inside the archive and materialize only relevant portions in memory.

Target: Graph operations proportional to affected/visited nodes and edges.

### 33.3 CBAMP — Context-Budget-Aware Multimodal Packer

Purpose: Construct efficient model requests without losing critical material.

Process:

1. Identify mandatory tutor instructions.
2. Reserve model instructions and output budget.
3. Group source evidence by topic.
4. Account for model modality capabilities.
5. Estimate input token cost.
6. Eliminate genuinely redundant representations.
7. Add relevant context.
8. Split into multiple passes when necessary.
9. Record the sources included in every pass.

The objective is educational completeness and relevance, not simply maximal token compression.

### 33.4 IGDE — Incremental Guide Dependency Engine

Purpose: Avoid unnecessary generation.

A source revision marks related evidence nodes and guide sections as stale.

Unrelated sections remain unchanged.

Dependency keys should include source revision IDs, processor/model versions, and generation configuration.

Target: Work proportional to affected dependencies.

### 33.5 ATS — Adaptive Transcription Scheduler

Purpose: Balance recording, transcription, GUI responsiveness, and local inference.

Inputs:

- Audio backlog.
- CPU load.
- GPU utilization.
- Available RAM.
- Inference throughput.
- Power profile.
- Recording state.

It adjusts job concurrency and priorities.

It may delay transcription, but must never discard original audio merely to keep inference current.

### 33.6 IWP — Incremental Waveform Pyramid

Purpose: Render hours of audio efficiently.

Maintain multi-resolution min/max waveform summaries inside `.tux`.

When zoomed out, use coarse summaries.

When zoomed in, read finer summaries or source chunks.

Target: Rendering cost approximately proportional to visible waveform buckets rather than complete recording length.

### 33.7 STSI — Sparse Timestamp Seek Index

Purpose: Efficient transcript and audio seeking.

Maintain timestamp checkpoints and indexed segment offsets.

Seeking locates a nearby checkpoint, then searches a small local range.

Do not claim constant-time worst-case lookup without a fixed bounded local-density guarantee.

### 33.8 CASS — Content-Addressed Asset Storage

Purpose: Deduplicate assets within the archive.

For each asset:

1. Stream its bytes through a hash.
2. Look up that hash in the archive index.
3. Reuse an existing immutable blob if valid.
4. Otherwise append the new blob.
5. Add a logical asset reference.

Hashing remains O(n) in input size; only the subsequent indexed lookup is expected near O(1) in memory or logarithmic in the persistent B+ tree.

### 33.9 ACRI — Archive Commit and Recovery Index

Purpose: Locate recent valid archive generations without scanning the complete archive.

Maintain a validated commit chain with periodic checkpoints and index roots.

On ordinary open, read recent commit locators.

On corruption, fall back to earlier valid generations or perform a full recovery scan.

Target: Fast normal opening, with recovery work proportional to the damaged/uncommitted region where possible.

### 33.10 ALC — Archive Live-Record Compactor

Purpose: Reclaim obsolete archive records without destroying history required by policy.

Traverse the latest committed graph of reachable records.

Copy live records into a new single-file archive while preserving stable IDs and referential integrity.

Validate the new archive before publication.

This algorithm necessarily processes live data; O(1) total compaction is impossible.

### 33.11 All custom algorithms require proof of value

Each algorithm must have:

- A simple reference implementation.
- Documented invariants.
- Complexity analysis.
- Differential tests.
- Benchmarks.
- Memory profile.
- Failure tests.
- Maintainability review.

Complexity for its own sake is explicitly prohibited.

## 34. Memory architecture

Use workload-specific allocation strategies.

| Component          | Strategy                              |
| ------------------ | ------------------------------------- |
| Audio callback     | Fixed preallocated buffers            |
| Audio chunk writer | Reusable streaming buffers            |
| Archive index      | Bounded page cache                    |
| Metadata parsing   | Arena allocation where beneficial     |
| Transcript storage | Segmented structures                  |
| Document editor    | Piece table or rope                   |
| Image previews     | Lazy decode, bounded cache            |
| AI serialization   | Streaming                             |
| Network requests   | Bounded buffers                       |
| LLM inference      | Explicit contexts and model unloading |
| GUI lists          | Virtualization                        |
| Waveforms          | Multi-resolution indexed summaries    |

### 34.1 No unnecessary transcript duplication

Tutorux should not maintain the entire transcript simultaneously as:

- A full document string.
- A separate GUI string tree.
- A full prompt string.
- A JSON tree.
- A separate search copy.

Instead, use one canonical representation and construct lightweight views or streaming serializers.

### 34.2 Archive page cache

The archive engine should use a bounded page cache with:

- Configurable capacity.
- Explicit eviction policy.
- Dirty/clean page state.
- Generation-aware invalidation.
- Memory-pressure response.
- Thread-safety rules.
- Instrumentation.

Persistent cached pages and indexes remain embedded in `.tux`; the runtime cache is in memory only.

### 34.3 Memory pressure response

When memory pressure increases:

1. Evict thumbnails and disposable decoded assets.
2. Shrink archive page caches within safe bounds.
3. Reduce background worker concurrency.
4. Pause nonessential processing jobs.
5. Unload unused inference contexts.
6. Preserve capture buffer capacity.
7. Warn before starting an excessively large job.

Do not sacrifice recording reliability to preserve an image thumbnail or AI model cache.

## 35. CPU efficiency

The application should be event-driven.

Avoid:

- Continuous polling.
- Unnecessary idle rendering.
- Repeated full-directory scans.
- Provider discovery at every startup.
- Rebuilding unchanged waveform indexes.
- Reprocessing unchanged assets.
- Recomputing guide dependencies on each frame.

### 35.1 Rendering

The GUI should not render continuously while nothing changes.

During recording, update the visible waveform and timer at a reasonable display frequency.

The audio capture callback must never interact directly with GUI rendering.

### 35.2 Worker pools

Use bounded worker concurrency.

The scheduler should support:

- High-priority audio processing.
- Responsive GUI interaction.
- Storage transactions.
- Background transcription.
- Asset processing.
- AI generation.
- Document export.
- Archive compaction.

Compaction should normally be deferred during active recording because it competes for disk bandwidth and archive ownership.

### 35.3 Performance profiles

| Profile     | Behavior                                 |
| ----------- | ---------------------------------------- |
| Efficiency  | Reduced concurrency and power use        |
| Balanced    | Default responsiveness/efficiency        |
| Performance | Higher throughput where resources permit |

These profiles may change processing speed but must not silently reduce educational output completeness.

## 36. Startup performance

### 36.1 Critical path

```
Process entry
      ↓
Parse launch arguments
      ↓
Resolve archive directory
      ↓
Scan immediate directory level
      ↓
Read bounded archive headers
      ↓
Open/select/init archive
      ↓
Read latest committed manifest
      ↓
Create native GUI
      ↓
Render dashboard
```

Do not initialize heavyweight inference or decode recordings during this path.

### 36.2 Lazy initialization

| Resource                  | Load when                                |
| ------------------------- | ---------------------------------------- |
| Audio engine              | Recording screen accessed                |
| Whisper runtime           | Transcription requested                  |
| Whisper weights           | Actual transcription begins              |
| Provider client           | Provider operation begins                |
| Model catalog             | Model selector opens                     |
| llama.cpp runtime         | Embedded inference selected              |
| GGUF weights              | Generation begins                        |
| Document exporter         | Export requested                         |
| PDF parser                | Relevant PDF imported                    |
| Waveform data             | Timeline viewed                          |
| Full archive verification | User requests it or recovery requires it |

### 36.3 CLI fast paths

The following should not open archives unnecessarily:

```
tutorux --version
tutorux help
tutorux diagnostics --build-info
```

The following should inspect only lightweight archive metadata:

```
tutorux archive discover
tutorux archive list
tutorux archive info My-Tutoring.tux
```

This separation is essential for extremely fast command-line startup.

## 37. Initial performance budgets

PROPOSED ENGINEERING TARGETS, NOT VERIFIED RESULTS

Cold GUI startup

# ≤500 ms

Warm GUI startup

# ≤150 ms

Idle RAM

# ≤50 MB

Idle CPU

# ≤0.2%

Ordinary UI action

# ≤50 ms

Compact executable stretch

# ≤20 MB

These budgets require reference hardware, specific workloads, and consistent measurement methods. Loaded model weights, OS-shared pages, GPU allocations, and browser memory must be reported separately.

Additional targets:

| Operation                  | Initial goal                                               |
| -------------------------- | ---------------------------------------------------------- |
| Archive discovery          | Under 100 ms for a typical small directory                 |
| Open valid archive         | Under 100 ms for indexed metadata on reference SSD         |
| Open new session           | Under 100 ms after archive initialization                  |
| Add annotation             | Under 20 ms to visible UI confirmation                     |
| Search indexed transcript  | Under 100 ms for ordinary queries                          |
| Cached model selector      | Under 50 ms                                                |
| Seek indexed recording     | Under 150 ms, excluding slow storage                       |
| Recording startup          | Preferably under 250 ms after permissions/device readiness |
| Audio drops                | Zero under defined supported-load tests                    |
| Save completed transaction | Explicit durability acknowledgement                        |
| Full archive compaction    | Throughput measured against live archive size              |

The 20 MB executable target is especially ambitious for a GUI, codecs, exporters, speech inference, and embedded LLM runtime. It must remain a measured stretch target, not a justification for cutting required functionality.

# Part IX. Native GUI, Text Editing, and Portability

## 38. Native GUI framework

The preferred GUI remains Slint with a non-Qt backend.

Slint supports native C++ integration, and its official build documentation describes its Winit backend and configurable renderers.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.slint.dev\&sz=32)

Slint C++ API

+1



Tutorux must not enable Qt.

The rendering backend should be selected through prototypes and benchmarks, not merely because it produces the smallest binary.

### 38.1 GUI qualification requirements

Slint must be tested for:

- Polished rendering.
- Long-form text editing.
- Unicode/IME.
- Accessibility.
- Screen reader support.
- High DPI.
- Keyboard navigation.
- Drag-and-drop.
- Native file dialogs.
- Startup time.
- Memory footprint.
- Binary size.
- Windows/macOS/Linux behavior.

If it cannot meet essential text-editing or accessibility requirements, the UI framework decision must be reconsidered without changing the core architecture.

## 39. Tutorux visual design

Tutorux must resemble a premium productivity application, not a simulation dashboard.

Its visual language should include:

- Spacious typography.
- Neutral surfaces.
- Focused content layouts.
- Clear navigation.
- Subtle accents.
- Comfortable reading widths.
- Light and dark themes.
- Resizable panes.
- Minimal distracting animation.
- Keyboard-first workflows.
- High contrast and accessible focus states.

### 39.1 Main screens

| Screen              | Primary function                              |
| ------------------- | --------------------------------------------- |
| Archive launcher    | Discover/open/create `.tux`                   |
| Dashboard           | Sessions, students, outstanding work          |
| Student directory   | Profiles and learning history                 |
| Recording workspace | Capture and live notes                        |
| Transcript editor   | Text, timestamps, speaker correction          |
| Asset browser       | Images/documents linked to lessons            |
| Evidence inspector  | Teaching-point provenance                     |
| AI workspace        | Provider/model/asset selection and generation |
| Guide editor        | Structured writing and source verification    |
| Export              | Document configuration and output             |
| Settings            | Archive-specific preferences                  |
| Diagnostics         | Archive, audio, AI, performance tests         |

### 39.2 Archive status

The application should always show the current archive name and whether it is:

```
Read/Write
Read-only
Locked
Recovering
Compacting
Encrypted
Awaiting durable commit
```

The user should never confuse unsaved in-memory changes with committed archive data.

## 40. Specialized long-form text editor

A lightweight GUI toolkit should not be forced to manage the complete document-editing model.

Tutorux should implement an independent C++ document engine.

### 40.1 Requirements

- Efficient insertion and deletion.
- UTF-8.
- Unicode grapheme navigation.
- Bidirectional text.
- IME support.
- Multi-paragraph selection.
- Undo/redo.
- Find/replace.
- Inline source references.
- Code syntax highlighting.
- Equations.
- Images.
- Tables.
- Keyboard accessibility.
- Copy/paste.
- Partial layout invalidation.

### 40.2 Candidate text data structures

Benchmark:

Piece table: Efficient editing while preserving original text and a record of insertions.

Rope: Efficient editing of large documents using balanced hierarchical storage.

Select the simpler structure meeting performance and feature targets.

### 40.3 Archive-backed editing

Edits should initially update the in-memory document state for immediate responsiveness.

The document engine then commits transactions into `.tux`.

Do not rewrite the entire guide on each keystroke.

### 40.4 Transaction model

```
DocumentEditTransaction
  documentId
  expectedRevision
  operations
  selectionState
  cursorState
  origin
```

Committed changes produce a new document revision.

Undo/redo should use structured operations rather than whole-document copies.

### 40.5 Partial layout

When the tutor changes one paragraph, invalidate only affected paragraph and pagination regions where practical.

A full-document layout may be necessary for final export, but must not run synchronously for every keystroke.

## 41. Native distribution

Tutorux should produce separate native artifacts:

| Platform            | Target                     |
| ------------------- | -------------------------- |
| Windows x86-64      | Portable `.exe`            |
| Windows ARM64       | Native ARM64 `.exe`        |
| macOS Apple Silicon | Signed native application  |
| macOS Intel         | Signed native application  |
| Linux x86-64        | Portable native executable |
| Linux ARM64         | Portable native executable |

Each binary should contain the application code, required runtime components, GUI, essential codecs, command system, provider adapters, and document functionality.

Model weights remain external.

### 41.1 No installed application state

The application must not require an installer to register services, populate AppData, or create a user-level configuration directory.

The executable may be moved or copied.

The `.tux` archive may be moved or copied.

Relative model paths should continue to work when the entire folder is moved.

### 41.2 macOS packaging caveat

macOS signing, notarization, and permissions often require an application bundle.

A signed `.app` containing the executable is acceptable as a native distribution wrapper, but it must not create a Tutorux-owned global workspace.

### 41.3 Linux portability caveat

Linux systems differ in audio and graphics services.

Tutorux must define supported compatibility baselines and test them.

Do not claim that a statically linked executable automatically supports every Linux distribution.

## 42. Full and Compact builds

The default functional reference distribution should be Tutorux Full.

It includes all tutoring features and an embedded llama.cpp runtime, but no LLM weights.

An optional Tutorux Compact build removes the embedded llama.cpp runtime to reduce executable size while keeping external Ollama and llama.cpp integration.

| Capability            | Full | Compact |
| --------------------- | ---- | ------- |
| Sessions and archives | Yes  | Yes     |
| Recording             | Yes  | Yes     |
| Transcription         | Yes  | Yes     |
| Annotations           | Yes  | Yes     |
| Asset imports         | Yes  | Yes     |
| Evidence analysis     | Yes  | Yes     |
| BYOK                  | Yes  | Yes     |
| Manual AI packages    | Yes  | Yes     |
| Ollama                | Yes  | Yes     |
| llama.cpp server      | Yes  | Yes     |
| Embedded llama.cpp    | Yes  | No      |
| Guide editing/export  | Yes  | Yes     |
| Bundled LLM weights   | No   | No      |

This preserves the core product functionality without imposing the embedded inference runtime's size on users who do not need it.

## 43. Static WebAssembly edition

The web edition should share the same C++ core logic where practical.

However, the browser interface should be implemented separately using lightweight HTML/CSS/TypeScript.

Slint's current documentation explicitly describes its WASM integration as Rust-only and cautions against relying on its canvas-based web output for ordinary accessible web applications.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.slint.dev\&sz=32)

Slint Docs



### 43.1 Static deployment

```
tutorux-web/
├── index.html
├── tutorux.css
├── tutorux.js
├── tutorux-core.wasm
├── manifest.webmanifest
└── assets/
```

Deployable through GitHub Pages, with no custom backend.

### 43.2 Portable archive behavior in browsers

The browser edition also uses `.tux` archives as the only authoritative workspace format.

The user should be able to:

- Open a local `.tux` file.
- Create a new `.tux` archive.
- Add notes, assets, and transcript information.
- Generate and edit guides.
- Save the updated `.tux` archive.
- Export a PDF or another selected document.

There should be no alternative permanent application workspace represented by a collection of unrelated browser database records.

### 43.3 Browser storage implementation

Where a browser supports writable user-selected file handles, Tutorux should update the selected archive directly.

Where direct persistent file handles are unavailable, use a browser-managed temporary representation of the single archive file, with explicit save/export and recovery controls.

Safari/WebKit's origin-private filesystem is supported, but its storage is managed inside the browser and may not correspond to a normal user-visible file; it is subject to browser storage policies.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://webkit.org\&sz=32)

WebKit



Therefore, the web edition must provide explicit archive download/backup and must not pretend browser-managed storage is equivalent to a native filesystem archive.

### 43.4 GitHub Pages and threads

Emscripten pthreads require `SharedArrayBuffer` and appropriate cross-origin isolation configuration.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



A default static build should therefore not require pthreads.

Use a single-thread-capable WASM core plus standard browser Web Workers where supported.

Optional multithreaded builds may target hosting environments with the necessary headers.

### 43.5 iPad support

Tutorux Web should support:

- Touch-friendly navigation.
- Microphone capture where permitted.
- Imported recordings.
- Notes.
- Image uploads.
- Local or remote transcription where technically available.
- BYOK where browser CORS permits.
- Manual chat-agent workflows.
- Guide editing.
- Archive save/export.
- PDF/HTML/Markdown output.

### 43.6 Browser limitations

A static iPad website cannot guarantee unrestricted capture of audio from unrelated apps or unrestricted background execution.

Some AI providers may not permit direct browser-origin API requests.

In those cases, Tutorux should show the limitation and offer the manual AI-package workflow.

The web edition must not secretly require a hosted proxy.

# Part X. Privacy, Security, and Reliability

## 44. Strict portable-state privacy

Tutorux must not create or use app-managed system-wide data directories.

The default security model is:

```
Tutorux executable
       ↓
Selected .tux archive
       ↓
Local recording, notes, and files
       ↓
Optional user-authorized AI processing
```

No mandatory account, cloud storage, license server, or hosted database.

### 44.1 Consent

Recording should require an explicit consent confirmation.

The archive should preserve consent metadata such as:

```
ConsentRecord
  sessionId
  confirmationTime
  selectedSources
  confirmedBy
  policyVersion
```

A checkbox does not guarantee compliance with all applicable recording or student-privacy laws.

Tutorux should provide an adaptable consent workflow rather than asserting universal legality.

### 44.2 Outbound transmission disclosure

Before sending a cloud AI request, show exactly which content will leave the device.

For example:

```
Provider: OpenRouter
Model: Selected model ID

Included:
  Transcript
  Tutor annotations
  Selected images
  Session objectives

Excluded:
  Raw recording
  Other students' sessions
  Saved credentials
```

The user should be able to change the selection.

### 44.3 Archive-level encryption

Tutorux should support optional authenticated encryption of archive content.

The encryption design should use audited cryptographic libraries and algorithms.

A recommended conceptual design is:

- Random data-encryption key per archive.
- Password-derived key-encryption key using Argon2id.
- Authenticated encryption for protected records.
- Fresh nonces as required by the chosen construction.
- Authenticated metadata and integrity checks.
- Explicit key rotation and passphrase-change procedures.

Encryption must not rely on a custom cryptographic algorithm.

### 44.4 Credential persistence

Persistent API keys may be stored in an encrypted credential section inside `.tux`.

The user must explicitly enable this.

The default should be memory-only keys or environment-variable input.

An archive's ordinary passphrase-based encryption settings should not be confused with API-key authentication.

### 44.5 Sharing archives safely

Because a `.tux` file may contain complete student histories, recordings, and AI credentials, Tutorux must show a warning before the user shares or exports a complete archive.

Provide an explicit sanitized-copy operation that could:

- Exclude credentials.
- Exclude selected students.
- Exclude selected recordings.
- Exclude private annotations.
- Include only chosen sessions.
- Remove unnecessary generation logs.
- Preserve the selected evidence references.

The sanitized copy should itself remain one portable `.tux` archive.

### 44.6 No global logs

Diagnostics should use a bounded in-memory log.

Optional persistent diagnostics may be embedded in the selected archive.

A debug export should be written only to an explicitly selected destination, with sensitive information redacted.

### 44.7 System interactions

Tutorux will still interact with OS APIs, system libraries, native permission dialogs, graphics drivers, and TLS facilities.

These do not mean Tutorux is managing system-wide application files.

However, no application can guarantee that the operating system itself never writes permissions, crash reports, security metadata, or other OS-managed state.

The requirement is that Tutorux intentionally owns and persists its own data only in its portable archives.

## 45. Safe handling of imported assets

Students may attach malformed, corrupt, or malicious files.

The import pipeline must include:

- File-size validation.
- MIME/signature checks.
- Bounded allocations.
- Decompression limits.
- Safe path handling.
- Symbolic-link policy.
- Parser timeouts where feasible.
- Fuzz-tested format parsers.
- Clear distinction between imported content and executable commands.

### 45.1 Archive record validation

The single-file storage format itself is an untrusted input format.

On opening an archive:

- Validate header lengths.
- Validate record offsets.
- Validate integer arithmetic.
- Check checksum integrity.
- Reject overlapping or invalid payload spans.
- Bound decompression.
- Validate index-page structure.
- Detect cycles in structures expected to be acyclic.
- Reject malformed record references.

Do not allocate memory directly from an untrusted length without checking limits.

### 45.2 Prompt injection

Imported student work and transcripts may contain malicious instructions intended for AI models.

Tutorux must label them as untrusted source content.

They must not be allowed to issue Tutorux CLI commands or access unrelated archive records.

AI-generated output must be parsed as data rather than executed.

### 45.3 Provider error handling

API failures should never corrupt session state.

If a provider returns malformed JSON, Tutorux should retain the original response in the archive according to retention settings and offer validation or repair.

Previously approved guides must remain unchanged.

## 46. Crash recovery and correctness

Tutorux should use a zero-known-critical-defect release policy.

It must never knowingly release with reproducible critical recording loss, archive corruption, credential exposure, or source-evidence fabrication under supported conditions.

### 46.1 Failure conditions to test

| Failure                          | Required behavior                                 |
| -------------------------------- | ------------------------------------------------- |
| Process crash during recording   | Recover committed chunks                          |
| Power loss during commit         | Open latest consistent committed generation       |
| Disk full                        | Preserve previous committed data                  |
| Corrupt archive header           | Enter recovery/diagnostic mode                    |
| Damaged latest commit            | Fall back to previous valid generation            |
| Interrupted compaction           | Preserve original or recover verified replacement |
| Malformed asset                  | Reject or preserve safely without executing       |
| Lost audio device                | Continue surviving sources where possible         |
| Network outage                   | Preserve session and generation request state     |
| Model out of memory              | Cancel inference cleanly                          |
| Simultaneous writers             | Enforce one-writer policy                         |
| GUI crash with detached recorder | Worker continues if healthy                       |
| Stale model catalog              | Use labeled cache or manual model entry           |
| Invalid AI output                | Preserve previous approved guide                  |
| Archive moved between computers  | Reopen without global registry                    |

### 46.2 Commit fault injection

Test deliberate interruption after every significant write boundary:

```
Record header written
Payload partly written
Payload fully written
Checksum written
Index page written
Commit record partly written
Commit record fully written
Flush requested
Commit made visible
```

For each failure point, verify that the archive either opens at a valid committed generation or reports an explicit recoverable/corrupt state.

### 46.3 Archive verification

Provide two levels:

Quick verification: Recent commit chain and core index roots.

Full verification: Every reachable record, asset checksum, evidence reference, and relevant index invariant.

Example:

```
tutorux archive verify My-Tutoring.tux --quick
tutorux archive verify My-Tutoring.tux --full
```

### 46.4 Archive repair

Repair must operate conservatively.

Tutorux should:

1. Identify the last consistent generation.
2. Preserve the original archive.
3. Offer a repaired copy.
4. Clearly report inaccessible or unrecoverable records.
5. Avoid silently discarding source evidence.
6. Require explicit confirmation before replacing a damaged archive.

The repaired result remains a `.tux` file.

# Part XI. Testing and Verification

## 47. Comprehensive test strategy

| Test category        | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| Unit tests           | Individual functions and domain logic                 |
| Property-based tests | General invariants across generated inputs            |
| Differential tests   | Optimized algorithms versus reference implementations |
| Fuzz testing         | Malformed archive and asset inputs                    |
| Integration tests    | Module interactions                                   |
| CLI tests            | Command arguments, output, exit codes                 |
| GUI parity tests     | GUI commands produce equivalent core effects          |
| Audio tests          | Capture, timing, drops, device errors                 |
| Transcription tests  | Segment consistency and revisions                     |
| Archive tests        | Appends, indexes, commits, compaction                 |
| Recovery tests       | Crash/power-failure scenarios                         |
| Encryption tests     | Key handling and authenticated-record validation      |
| AI protocol tests    | Provider-specific requests and responses              |
| Document tests       | Structured outputs and export fidelity                |
| Cross-platform tests | Windows/macOS/Linux behavior                          |
| Performance tests    | CPU, RAM, startup, throughput, binary size            |
| Accessibility tests  | Keyboard, focus, screen readers, IME                  |

### 47.1 Sanitizers

Use AddressSanitizer, UndefinedBehaviorSanitizer, LeakSanitizer where available, and ThreadSanitizer on supported configurations.

Combine sanitizers with strict static analysis and clear ownership rules.

### 47.2 Fuzzing

Prioritize the highest-risk entry points:

- `.tux` archive parser.
- Index-page decoder.
- Commit-chain validation.
- Compressed-record decoder.
- PDF/document import.
- Image/audio/video parsing.
- AI response parsing.
- Schema migrations.
- Path resolution.

### 47.3 Archive model-based testing

Maintain a simple reference storage model used exclusively in tests.

Generate random sequences of operations:

```
Create session
Add audio chunk
Add annotation
Edit transcript
Attach image
Delete annotation
Commit
Crash
Reopen
Verify
Compact
Reopen
```

After each operation, compare the archive's visible logical state against the reference model.

This is particularly important because a custom transactional container is harder to get right than ordinary use of an established database engine.

### 47.4 Concurrency testing

Test:

- Multiple read-only archive handles.
- Writer plus concurrent readers.
- GUI and detached worker interactions.
- Recording while notes are added.
- Transcription while recording continues.
- Model generation while a transcript is edited.
- Worker cancellation during archive commit.
- Compaction during attempted read/write operations.

### 47.5 Portability testing

Copy the same archive among Windows, macOS, and Linux.

Verify that:

- Records are interpreted identically.
- Unicode filenames and text survive.
- Timestamps remain correct.
- Record checksums match.
- Audio plays correctly.
- Assets remain accessible.
- Evidence references resolve.
- Guides render consistently.
- Relative model references behave predictably.
- No system-wide Tutorux data directory is created.

### 47.6 Read-only media

Tutorux should be able to inspect archives from read-only storage.

Attempting to modify such an archive must produce a clear error or offer an explicit Save Editable Copy operation.

It must not silently redirect changes to a hidden AppData workspace.

## 48. Educational output quality testing

Performance is not enough.

Tutorux must demonstrate that its guides are more educationally useful than ordinary meeting summaries.

### 48.1 Evaluation corpus

Use consented or synthetic tutoring sessions across:

- English writing.
- Mathematics.
- Science.
- Programming.
- Foreign languages.
- General academic tutoring.

Include short and long sessions, ambiguous audio, multiple speakers, and multimodal attachments.

### 48.2 Human-labeled evidence

For each session, reviewers identify:

- Explicit tutor instructions.
- Important student errors.
- Concepts taught.
- Tutor corrections.
- Worked examples.
- Observed improvements.
- Uncertain claims.
- Expected next-session priorities.

### 48.3 Guide quality metrics

| Metric                 | Meaning                                      |
| ---------------------- | -------------------------------------------- |
| Instruction recall     | Important tutor instructions preserved       |
| Instruction precision  | Extracted instructions actually supported    |
| Misconception coverage | Important difficulties addressed             |
| Source validity        | Referenced source IDs exist                  |
| Semantic grounding     | Claims genuinely supported by cited evidence |
| Actionability          | Student understands what to practice         |
| Readability            | Wording suits the student                    |
| Mathematical accuracy  | Equations and solutions remain correct       |
| Export fidelity        | Approved formatting survives export          |
| Tutor editing time     | Time needed for an acceptable final document |
| Regeneration stability | Unrelated approved content remains unchanged |

### 48.4 Initial quality targets

Proposed controlled-benchmark targets:

- At least 95% recall of explicitly marked high-priority tutor instructions.
- No accepted citation to a nonexistent source ID.
- No silent dropping of selected source attachments.
- No overwriting of approved human edits.
- Demonstrably reduced tutor editing time compared with manual preparation.
- Consistent performance across the supported subjects.

These are targets to establish through empirical evaluation, not existing achieved results.

# Part XII. Repository Organization

## 49. Recommended project layout

The storage architecture is updated to use the single-file archive engine.

```
Tutorux/
│
├── CMakeLists.txt
├── CMakePresets.json
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── SECURITY.md
├── .clang-format
├── .clang-tidy
│
├── cmake/
│   ├── CompilerOptions.cmake
│   ├── Dependencies.cmake
│   ├── Sanitizers.cmake
│   ├── Optimization.cmake
│   ├── Platforms.cmake
│   └── Packaging.cmake
│
├── include/
│   └── tutorux/
│       ├── core/
│       ├── command/
│       ├── archive/
│       ├── student/
│       ├── session/
│       ├── audio/
│       ├── transcription/
│       ├── annotation/
│       ├── asset/
│       ├── evidence/
│       ├── learning/
│       ├── ai/
│       ├── document/
│       ├── scheduler/
│       └── platform/
│
├── src/
│   ├── application/
│   ├── core/
│   ├── command/
│   │
│   ├── archive/
│   │   ├── format/
│   │   ├── reader/
│   │   ├── writer/
│   │   ├── records/
│   │   ├── indexes/
│   │   ├── transactions/
│   │   ├── recovery/
│   │   ├── compaction/
│   │   ├── encryption/
│   │   └── verification/
│   │
│   ├── student/
│   ├── session/
│   ├── audio/
│   │   ├── capture/
│   │   ├── buffering/
│   │   ├── encoding/
│   │   ├── playback/
│   │   └── synchronization/
│   ├── transcription/
│   ├── annotation/
│   ├── asset/
│   │   ├── import/
│   │   ├── parsing/
│   │   ├── previews/
│   │   └── extraction/
│   ├── evidence/
│   ├── learning/
│   │
│   ├── ai/
│   │   ├── providers/
│   │   ├── protocols/
│   │   ├── discovery/
│   │   ├── local/
│   │   ├── generation/
│   │   └── interchange/
│   │
│   ├── document/
│   │   ├── model/
│   │   ├── editing/
│   │   ├── layout/
│   │   ├── templates/
│   │   └── export/
│   │
│   ├── algorithms/
│   │   ├── transcript_alignment/
│   │   ├── evidence_graph/
│   │   ├── context_packing/
│   │   ├── guide_dependencies/
│   │   ├── audio_scheduling/
│   │   ├── waveform_indexing/
│   │   └── archive_indexes/
│   │
│   ├── scheduler/
│   ├── platform/
│   │   ├── windows/
│   │   ├── macos/
│   │   ├── linux/
│   │   └── wasm/
│   ├── cli/
│   └── gui/
│
├── ui/
│   ├── app.slint
│   ├── design-system/
│   ├── components/
│   ├── screens/
│   └── dialogs/
│
├── web/
│   ├── index.html
│   ├── src/
│   ├── styles/
│   └── assets/
│
├── schemas/
│   ├── archive/
│   ├── command/
│   ├── session/
│   ├── evidence/
│   ├── ai/
│   └── document/
│
├── templates/
│   ├── general/
│   ├── english/
│   ├── mathematics/
│   ├── science/
│   └── programming/
│
├── resources/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── property/
│   ├── differential/
│   ├── fuzz/
│   ├── archive/
│   ├── recovery/
│   ├── audio/
│   ├── provider/
│   ├── document/
│   ├── security/
│   └── platform/
│
├── benchmarks/
│   ├── startup/
│   ├── memory/
│   ├── cpu/
│   ├── audio/
│   ├── archive/
│   ├── algorithms/
│   ├── rendering/
│   └── full_session/
│
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── algorithms/
│   ├── command-api/
│   ├── archive-format/
│   ├── ai-protocols/
│   ├── providers/
│   ├── performance/
│   ├── security/
│   └── development/
│
├── tools/
├── scripts/
├── third_party/
│
└── .github/
    └── workflows/
```

The repository structure describes source code and development tooling. It does not imply that the released application creates equivalent directories beside the user's archive.

## 50. Dependency management

Use pinned, reviewed dependency versions and reproducible builds.

Maintain:

- Dependency hashes.
- License inventory.
- Software bill of materials.
- Security advisory monitoring.
- Automated update testing.
- Binary-size regression reports.
- Cross-platform CI.

Runtime AI model discovery remains dynamic; build dependencies remain controlled.

### 50.1 GUI licensing

Slint offers GPLv3, royalty-free, and commercial licensing routes, with conditions depending on the chosen route.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub



Tutorux's own license should be selected after reviewing the exact GUI and third-party dependency combination.

MIT or Apache-2.0 may be appropriate for a permissively licensed project, but the distributed combined product must satisfy the actual licenses of its dependencies.

# Part XIII. Implementation Roadmap and Acceptance Criteria

## 51. Development phases

The development process must prioritize high-risk architectural decisions before investing heavily in secondary features.

1. Phase 0 — Architecture qualification

   Prototype the native Slint GUI without Qt, long-document editing, cross-platform audio capture, startup performance, portable packaging, and Emscripten compilation.

   Exit criterion: No unresolved framework limitation threatens usability, accessibility, or platform requirements.
2. Phase 1 — Single-file archive engine

   Implement archive initialization, record serialization, append-only writes, copy-on-write indexes, durable commits, read-only access, locking, and recovery.

   Test crashes at every transaction boundary.

   Exit criterion: The `.tux` archive remains consistent after extensive randomized, fuzz, and fault-injection testing.
3. Phase 2 — CLI and domain core

   Implement typed commands, student management, sessions, settings, errors, transactions, progress events, and archive discovery.

   Exit criterion: Tutorux can initialize, discover, open, modify, inspect, and verify archives entirely through CLI.
4. Phase 3 — Cross-platform recording

   Implement WASAPI, Core Audio/ScreenCaptureKit, PipeWire, capture buffers, timestamp synchronization, archive-backed chunk writing, detached recording workers, and native IPC.

   Exit criterion: Recording reliability tests pass on Windows, macOS, and Linux without permanent companion data files.
5. Phase 4 — Transcription and transcript editing

   Add whisper.cpp, user-selected model provisioning, live/post-session ASR, speaker correction, text editing, timestamp indexes, audio seek, and revision history.

   Exit criterion: Multi-hour recordings can be transcribed and navigated without loading the complete archive into memory.
6. Phase 5 — Annotations and multimodal assets

   Add quick markers, tutor notes, image/document/audio/video imports, content-addressed blobs, previews, extraction, and source associations.

   Exit criterion: All persistent session materials remain inside `.tux`, while original imported files remain untouched.
7. Phase 6 — AI provider infrastructure

   Implement canonical requests, dynamic model discovery, protocol adapters, credential handling, streaming, cancellation, and compatibility testing.

   Begin with representative protocol families, then expand to the 30+ provider target catalog.

   Exit criterion: Provider integrations pass documented capability and compatibility tests.
8. Phase 7 — Local and manual AI workflows

   Add Ollama, llama.cpp server, embedded llama.cpp, manual AI-package generation, prompt splitting, clipboard/export support, and response import.

   Exit criterion: Guide generation works through BYOK, local inference, and external chat-agent workflows without bundled LLM weights.
9. Phase 8 — Evidence and learning intelligence

   Implement instruction extraction, misconception analysis, typed evidence graph, provenance verification, context packing, and historical skill tracking.

   Exit criterion: Important teaching points preserve source references and pass educational quality benchmarks.
10. Phase 9 — Guide editor and professional exports

    Implement structured guide documents, templates, source inspection, rich text, equations, revisions, approvals, and PDF/DOCX/HTML/Markdown output.

    Exit criterion: Tutors can produce and approve professional learning guides without an external editor.
11. Phase 10 — Complete native GUI

    Build the archive launcher, dashboard, recording interface, transcript editor, asset explorer, AI workspace, evidence inspector, and guide editor over the shared command system.

    Exit criterion: All core GUI operations have corresponding CLI commands and automated parity tests.
12. Phase 11 — Advanced optimization

    Profile startup, CPU, RAM, archive indexing, recording, search, rendering, inference scheduling, exports, and binary size.

    Implement benchmark-justified improvements.

    Exit criterion: Performance budgets are met or deviations are measured and documented without sacrificing functionality.
13. Phase 12 — Static WASM edition

    Compile the portable core, add browser archive adapters, implement the static frontend, and validate iPad-specific behavior.

    Exit criterion: The website works on GitHub Pages without a custom backend and uses the same portable archive format.
14. Phase 13 — Security and release qualification

    Complete archive fuzzing, recovery tests, real hardware audio tests, provider compatibility checks, privacy review, accessibility tests, dependency audits, packaging, and documentation.

    Exit criterion: No known release-blocking defect remains, and all advertised functionality has supporting test evidence.

## 52. Incremental development milestones

For an individual developer, the first useful implementation should appear well before the entire provider catalog is complete.

| Milestone | Demonstrable outcome                                  |
| --------- | ----------------------------------------------------- |
| M1        | Initialize and inspect a `.tux` archive with CLI      |
| M2        | Create and manage sessions inside the archive         |
| M3        | Record audio directly into the archive                |
| M4        | Recover a deliberately interrupted recording          |
| M5        | Transcribe and edit a session                         |
| M6        | Add tutor notes, images, and student documents        |
| M7        | Export a complete manual AI prompt                    |
| M8        | Import an AI-generated response and compile a guide   |
| M9        | Add BYOK cloud providers and dynamic model discovery  |
| M10       | Add Ollama and llama.cpp                              |
| M11       | Build the polished native GUI                         |
| M12       | Add complete evidence-linked guide generation         |
| M13       | Qualify all three desktop platforms                   |
| M14       | Complete performance optimization and release testing |
| M15       | Deliver the static WASM edition                       |

The portable archive engine, recording reliability, and excellent guide generation should be proven before significantly expanding secondary features.

## 53. Release acceptance checklist

Tutorux 1.0 release gates

0 / 31

Executable runs without installing a programming runtime or separate Tutorux service

GUI contains no Qt, Electron, Tauri, or embedded browser

Every core GUI operation is accessible through CLI

Code follows the C++23 composition/no-application-inheritance standard

Archive discovery scans only the immediate selected directory

No archive causes initialization of a new portable .tux workspace

One archive opens directly; multiple archives offer explicit selection

All persistent Tutorux workspace data is inside single-file .tux archives

No persistent extracted workspace, sidecar database, or global configuration is required

No application-managed AppData, XDG, home, global cache, or system directory is created

Archive updates do not rewrite unrelated complete recordings

Archive recovery passes interrupted-write and power-failure simulations

Archive compaction preserves all required live records and revision history

Windows, macOS, and Linux pass the defined feature matrix

Full-session audio recording and recovery tests pass

Local transcription works with user-provisioned models

Tutor annotations remain timestamped and editable

Image, document, audio, and video assets import safely

Evidence records preserve valid source relationships

BYOK generation supports tested provider protocols and dynamic models

External chat-agent prompt export and response import work without an API key

Ollama and llama.cpp are supported without bundled LLM weights

Model/asset compatibility is checked before requests

Guides distinguish explicit tutor instructions from AI recommendations

Guide editing, revisions, source inspection, and approval work

PDF, DOCX, HTML, and Markdown exports pass fidelity tests

Idle CPU, memory, startup, binary size, and responsiveness are benchmarked

Security tests cover archives, credentials, imported assets, and AI output

No known critical data-loss, security, or memory-safety defects remain

Static WASM edition operates without a mandatory backend

Documentation covers commands, formats, algorithms, security, and limitations

&#x20;Copy release criteria

# Part XIV. Final Architectural Decision Register

## 54. Final system decisions

| Domain                          | Final specification                                                             |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Product                         | Tutorux tutoring-session intelligence workstation                               |
| Core language                   | C++23                                                                           |
| Code philosophy                 | Readable, Java-like naming, composition, no application inheritance             |
| Namespaces                      | Frequent meaningful namespaces, scoped standard-library imports                 |
| GUI                             | Slint native frontend, qualified against accessibility and editing requirements |
| CLI                             | Complete authoritative command interface                                        |
| Core                            | Modular monolith                                                                |
| Archive extension               | `.tux`                                                                          |
| Archive model                   | One directly mutable, append-friendly portable file per workspace               |
| Archive discovery               | Immediate directory only                                                        |
| No archives                     | Initialize new archive                                                          |
| One archive                     | Open automatically                                                              |
| Multiple archives               | Archive chooser                                                                 |
| Persistent application settings | Inside active `.tux`                                                            |
| Persistent caches               | Inside active `.tux`                                                            |
| Persistent credentials          | Optional encrypted archive records                                              |
| Global application directories  | None created or managed                                                         |
| Archive storage                 | Append-only records, copy-on-write indexes, commits                             |
| Archive recovery                | Validated committed generations                                                 |
| Archive compaction              | Temporary same-directory replacement, safely published                          |
| Archive writer model            | Single writer, multiple readers                                                 |
| Native distribution             | Self-contained executable per OS/CPU architecture                               |
| Recording                       | Native audio, recoverable chunks appended to archive                            |
| Transcription                   | whisper.cpp, user-provisioned models                                            |
| Annotations                     | Timestamped, prioritized, revision-aware                                        |
| Assets                          | Multimodal, content-addressed, stored inside archive                            |
| AI cloud                        | 30+ provider integration targets                                                |
| Model discovery                 | Runtime official/catalog lookup, cache inside archive                           |
| Local AI                        | Ollama, llama.cpp server, embedded llama.cpp                                    |
| Bundled LLM weights             | None                                                                            |
| No-key AI                       | Complete manual interchange package                                             |
| Evidence                        | Typed source-linked graph                                                       |
| Guide generation                | Structured, personalized, validated                                             |
| Guide editing                   | Full tutor review and revision                                                  |
| Exports                         | PDF, DOCX, HTML, Markdown, `.tux`, AI packages                                  |
| Performance                     | Low CPU, low memory, fast startup, measured complexity                          |
| Algorithms                      | Standard proven algorithms plus justified specialized ones                      |
| Networking                      | No required listening ports                                                     |
| Browser edition                 | Static WASM with shared C++ core                                                |
| iPad                            | Browser-compatible archive workflow                                             |
| Security                        | Local-first, consent, encryption options, safe imports                          |
| Testing                         | Sanitizers, fuzzing, fault injection, real hardware tests                       |
| Release standard                | Zero known release-blocking defects                                             |
| Maintainability                 | Mandatory quality requirement                                                   |

## 55. What makes this architecture unusually strong?

The portable archive decision improves Tutorux in several important ways.

First, the application becomes genuinely movable. A tutor may copy one `.tux` file to another machine and preserve complete student histories, recordings, notes, assets, guides, and configuration without searching through hidden folders.

Second, storage becomes consistent with the CLI-first philosophy. Every command operates against an explicit archive, rather than relying on invisible global databases or changing environment state.

Third, privacy becomes easier to understand. Student information is contained inside known, user-owned archives. Backups, deletion, transfer, and selective sharing become concrete file operations.

Fourth, the application can avoid expensive full-file rewrites. The append-friendly archive engine is designed so that one new annotation or transcript revision does not require repacking gigabytes of audio.

Fifth, the architecture maintains complete portability without sacrificing the sophisticated learning features. Session history, multimodal evidence, AI generation, and guide revisions all operate on the same portable data model.

The main additional engineering challenge is the transactional single-file archive engine. It is important enough that its correctness, recovery behavior, and long-term format compatibility should receive more scrutiny than ordinary application features.

## 56. Final engineering philosophy

Tutorux should be governed by the following rule:

> Perform the minimum necessary work to produce the complete, correct result, using the fastest maintainable implementation supported by evidence, while ensuring that every student's learning material remains accurate, traceable, portable, and under the tutor's control.

The goal is not to maximize complexity, lines of code, or the number of custom algorithms. It is to create an application whose design remains understandable, efficient, reliable, and genuinely useful even as its features grow.

The definitive Tutorux architecture is therefore:

C++23 + native Slint GUI + complete CLI command engine + directly mutable single-file `.tux` archives + native recording + whisper.cpp transcription + evidence-linked guide generation + dynamically discovered cloud/local AI providers + optional static WASM frontend.

No global Tutorux state, no persistent extracted workspace, no mandatory server, no bundled LLM weights, and no silent reduction in application or educational output quality.

The first implementation contract to formalize should be Tutorux Archive Format v1, covering exact binary layouts, commit publication, copy-on-write indexes, audio streaming, encryption, compaction, versioning, crash recovery, and cross-platform compatibility. That subsystem is the foundation on which every other feature depends.
# Tutorux — Journal Architecture and UX Specification 0.6

Product architecture · Interaction design · C++23 · Slint · WebAssembly

The three journal decisions are now finalized. Tutorux should be built around a simple principle:

Every tutoring session becomes part of a living journal entry, and every journal entry becomes a useful, editable record of teaching.

The interface should make the most common tasks effortless while retaining the depth expected of a serious professional desktop application. The ambition is world-class UX, but that standard must be demonstrated through reliability, interaction quality, accessibility, and real-world usability testing, not merely through appearance.

## 1. Final product structure

Tutorux journal

One portable archive

Collections

Optional organization

Journal entry

Structured notes document

Chronological session timeline

Recordings and transcripts

Study guides and attachments

Tags and source references

### The three finalized decisions

| Area                 | Final behavior                                                          |
| -------------------- | ----------------------------------------------------------------------- |
| Journal organization | Chronological entries, newest first, with optional collections and tags |
| Starting a session   | Choose audio recording, notes-only, or import an existing recording     |
| Multiple sessions    | Displayed as a chronological timeline inside the journal entry          |

Collections should not behave like filesystem directories. An entry may belong to several collections without duplication, and tags should support lightweight cross-cutting categorization.

An entry without any collection or tag remains perfectly valid.

## 2. Journal navigation: no dashboard

The default application view should be a journal, not an analytics page.

English tutoring

# Journal

New entry

Search entries

October 2026

Argumentative writing

18 Oct

Evidence, commentary, and argumentative structure

2 sessions · English language

Rhetorical analysis

16 Oct

Analyzing rhetorical choices and audience effects

1 session · Writing

Thesis development

12 Oct

Preparing examples and exercises

Notes only

This view should support immediate keyboard navigation, incremental search, sorting, filtering, and direct entry creation.

The entry list must not reload or jump to the top whenever the tutor returns from an open document.

### Chronology and organization

By default, entries are ordered by creation date, newest first. An entry's displayed date should be editable independently of its internal creation timestamp.

Collections and tags should be accessible from a small sidebar or filter menu. A tutor might maintain collections such as "English Language," "Exam preparation," and "Writing practice," while using tags such as "Thesis," "Evidence," and "Revision."

Search should work across titles, notes, transcripts, and guide contents, with filters for collection, tag, date, and whether an entry contains sessions.

## 3. Entry workspace: a continuous academic journal

A journal entry should open as a coherent document workspace, with its notes at the center and its session timeline available without navigating away.

Journal

Argumentative writing

Sunday, 18 October 2026

# Argumentative writing

English Language

·

Evidence

·

Commentary

### Session observations

The student understands how to identify relevant evidence but needs more practice developing commentary that connects the evidence to the thesis.

### Session timeline

Session 2

18 Oct

48 minutes · Audio and transcript

Review recording

Session 1

12 Oct

52 minutes · Notes and transcript

Open session

New session

The timeline should be a native part of the entry, not a disconnected activity feed.

Each session item expands to reveal its summary, recording, transcript, markers, and linked notes. Opening a session should preserve the surrounding journal context.

The timeline should use explicit timestamps and dates, not vague labels such as "Recently" or "Earlier" when exact information is available.

## 4. Starting a session: three equally valid workflows

A tutor should choose the appropriate session type without being forced through a long setup wizard.

## New tutoring session

Choose how you would like to begin.

Record audio

Create a session and begin capturing audio after checking the microphone and permissions.

Take notes only

Start a session with a structured notes document. Recording may be added later.

Import a recording

Attach an existing audio file and prepare it for transcription and review.

Before recording

Tutorux will verify microphone access and display the input level. Recording starts only after explicit confirmation.

Cancel

Continue to microphone check

The session type should not permanently constrain the session. A notes-only session may later receive a recording, and an imported recording may be supplemented with manually written notes.

A recording session must remain open to writing and annotation. Starting audio capture should not redirect the user into an interface where note-taking becomes inconvenient.

## 5. Session timeline and lifecycle

A session should have a small, explicit state machine.

Session lifecycle

Audio capture is optional

Created

Active

Recording

Paused / resumed

Completed

Reviewed

Recording and session states must be separate. A session can remain active while recording is paused or stopped. A notes-only session is not considered incomplete merely because it lacks audio.

The tutor should be able to resume work on a completed session without silently restarting audio capture.

### Session timeline behavior

The timeline should support chronological ordering, date navigation, expanding and collapsing sessions, seeking to markers, and opening transcript passages.

If a session contains multiple recording segments, those segments remain individually identifiable while appearing as part of the same session.

Deleting a session should present the scope of the deletion, including associated audio, transcripts, and references. References from other documents should never silently become dangling links.

## 6. The journal editor and timeline should cooperate

The main notes editor and session timeline should be linked, but not fused into one fragile document structure.

I recommend storing them separately and composing them in the entry view.

This gives us a stable structure:

```
Journal
  id
  metadata
  collections[]
  tags[]
  entries[]

Entry
  id
  title
  date
  collection_ids[]
  tag_ids[]
  notes_document_id
  session_ids[]
  study_guide_ids[]
  attachment_ids[]

Session
  id
  entry_id
  title
  started_at
  ended_at
  state
  recording_ids[]
  transcript_id
  notes_document_id
  marker_ids[]

Recording
  id
  session_id
  audio_chunks[]
  format
  duration
  metadata

Transcript
  id
  session_id
  segments[]
  speakers[]
  revisions[]

Document
  id
  blocks[]
  revisions[]
  references[]
```

The entry view may visually interleave notes and session information, but the underlying objects remain independently addressable.

This is important for editing correctness, archive compaction, search indexing, and cross-references.

## 7. World-class UX requirements

I would add a formal interaction-quality specification, not merely a visual style guide.

### Principle A: every common action has a short path

| User goal                | Target interaction                                      |
| ------------------------ | ------------------------------------------------------- |
| Create an entry          | One click or keyboard shortcut                          |
| Start notes-only session | New session → Notes only → Create                       |
| Start recording          | New session → Record audio → Confirm device and consent |
| Find an old entry        | Focus search → type → open result                       |
| Add a timestamped note   | Shortcut while recording → type                         |
| Correct a transcript     | Select segment → edit directly                          |
| Add a passage to notes   | Select passage → Add to notes                           |
| Generate a guide         | Open guide → choose source scope → review draft         |
| Export a guide           | Export → select format and destination                  |
| Return to journal        | One navigation action, with scroll state preserved      |

These are interaction targets. They should be verified through actual testing rather than assumed to be optimal.

### Principle B: state must be visible and truthful

The user should always understand whether Tutorux is recording, saving, transcribing, generating, exporting, or idle.

The application must not report "Saved" until the relevant archive transaction has committed successfully.

Progress indicators should be used for operations with meaningful progress. Indeterminate indicators should not invent percentages.

Errors should remain visible until acknowledged or resolved, with sufficient detail for recovery.

### Principle C: the interface never steals focus unnecessarily

Creating an entry focuses the title. Starting a recording should preserve the current editing context once capture begins.

Transcription completion should not suddenly switch tabs. AI generation should not overwrite the selected text without review.

Dialogs should appear only for decisions that genuinely require user attention.

### Principle D: expert workflows remain discoverable

Keyboard shortcuts should be consistent across Windows, macOS, Linux, and browser, with platform-specific modifier conventions where necessary.

Menus should expose the same operations as the command palette and contextual controls.

The interface should support keyboard-only operation for all major workflows, with focus states that are visible against the white background.

### Principle E: no artificial complexity

Tutorux should not have a dashboard, activity feed, AI conversation home screen, onboarding carousel, or separate "workspace manager" unless a concrete user need justifies it.

Collections and tags should be optional. The simplest journal should remain a chronological list of entries.

## 8. Reliability and persistence

The one-file journal model makes archive correctness central to the user experience.

I recommend an append-oriented, versioned archive with immutable committed records, a recoverable transaction journal inside the file, indexed object lookup, and periodic compaction.

Recording data should be written in bounded chunks. Document edits should be committed incrementally rather than rewriting the archive.

The archive should distinguish between a logical document edit, a durable archive commit, and an exported student-facing document.

The application should maintain stable identifiers for entries, sessions, transcript segments, and document nodes.

### Crash recovery

On opening an archive after an interruption, Tutorux should validate the latest committed state and offer recovery of any complete, uncommitted records where safe.

It should not silently discard recoverable work, nor should it pretend partially written audio is valid without verification.

Compaction should use a carefully designed replacement procedure and never destroy the last known-good journal before the replacement has been validated.

### Privacy

Journal contents may contain recordings of minors and other sensitive educational material.

By default, Tutorux should keep everything local, request microphone permission explicitly, and disclose when AI processing would transmit selected content to an external provider.

Student-facing exports should exclude raw recordings, private tutor notes, API keys, and unrelated journal entries unless the tutor explicitly chooses otherwise.

## 9. Engineering architecture

The implementation should remain modular and CLI-first.

| Module        | Responsibilities                                        |
| ------------- | ------------------------------------------------------- |
| `journal`     | Entries, collections, tags, chronology, navigation      |
| `document`    | Structured WYSIWYG model, editing transactions, history |
| `session`     | Session lifecycle, timeline, markers                    |
| `audio`       | Capture, playback, device handling, streaming           |
| `transcript`  | Segments, speakers, corrections, synchronization        |
| `archive`     | Serialization, indexing, transactions, recovery         |
| `search`      | Full-text indexing and query processing                 |
| `ai`          | Provider adapters, manual workflow, proposed changes    |
| `export`      | PDF, HTML, Markdown, text, document packaging           |
| `application` | Commands, queries, events, permissions                  |
| `ui`          | Slint components, windows, dialogs, workspaces          |
| `cli`         | Complete headless command interface                     |

The C++23 core should use composition, RAII, explicit error handling, and well-defined ownership. The GUI remains a thin client of the application command layer.

The browser should reuse the Slint UI definitions and as much of the underlying core as is practical through a carefully tested WASM boundary. Browser-specific file and microphone adapters should be isolated from domain logic.

The application should remain portable and not require a local HTTP server, WebView, system-wide installation, or persistent hidden application directories.

## 10. Quality gates

I would establish measurable release criteria across five dimensions.

Visual craftsmanship

All custom components obey the 5 px radius, Noto Sans, sentence-case labels, and strict white/black/blue/red palette. No unexplained visual inconsistencies.

Interaction quality

Common workflows require few actions, preserve focus and context, provide reliable undo, and behave consistently with keyboard and pointer input.

Performance

Large journals open without loading all media, long transcripts scroll smoothly, typing remains responsive, and recording uses bounded memory.

Reliability

Crash-injection, archive corruption, recording interruption, partial-write, and recovery tests pass. Data loss is treated as a release-blocking defect.

Cross-platform parity

Desktop and browser use the same component system and document semantics, with documented differences only where platform capabilities require them.

For a product aspiring to world-class quality, the final acceptance process should include usability studies with real tutors, accessibility audits, performance profiling, and extensive regression testing. An interface that looks excellent but loses a recording or mishandles text selection is not a successful design.

## 11. What I would build first

The next implementation milestone should be a fully interactive journal shell using Slint, backed by a minimal real archive engine rather than mock data.

It should support opening and creating `.tux` journals, adding and editing entries, chronological navigation, collections and tags, creating notes-only sessions, and displaying the session timeline.

At the same time, a separate editor prototype should validate the difficult structured WYSIWYG behaviors, especially Unicode editing, selection, undo, and cross-platform rendering.

Only after those foundations work reliably should recording and transcription be integrated.

The most important architectural decision is now settled: Tutorux is a journal that supports tutoring sessions, not a session recorder with a journal added afterward.

That distinction should guide every future design and engineering choice.&#x20;