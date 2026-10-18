# Diagnostics and benchmarks

Diagnostics are explicit commands. They do not write persistent global logs or credentials.
`diagnostics report` writes a redacted JSON snapshot only to the path selected by the user.

```text
tutorux --archive Tutorux.tux diagnostics run --full
tutorux --archive Tutorux.tux diagnostics archive
tutorux diagnostics audio
tutorux diagnostics graphics
tutorux diagnostics providers
tutorux --archive Tutorux.tux diagnostics network --provider openai
tutorux --archive Tutorux.tux diagnostics report --output diagnostics.json --full
```

Archive checks use the archive verifier. Audio checks enumerate active endpoints and initialize
shared-mode probes without starting a recording stream. Provider checks list compiled adapters;
network checks require an explicitly selected provider and reuse the provider's model-list request.
The report includes process metrics, archive integrity summary, and audio endpoint count. It does
not include archive contents, file paths, API keys, or transcripts.

```text
tutorux benchmark startup
tutorux benchmark memory
tutorux benchmark cpu
tutorux benchmark audio
tutorux --archive Tutorux.tux benchmark indexing
tutorux --archive Tutorux.tux benchmark export --guide GUIDE_UUID
tutorux --archive Tutorux.tux benchmark full
```

Every benchmark reports its measured command duration and available process CPU and memory
counters. Startup reports process uptime as well; it is not a cold-start measurement. Audio timing
covers endpoint enumeration. Indexing counts representative archive record types. Export timing
covers Markdown rendering in memory and does not write a file. Rendering is reported as unavailable
from a CLI process because it does not own a desktop frame loop. Results are measurements of the
current machine and workload, not comparisons against a reference device.
