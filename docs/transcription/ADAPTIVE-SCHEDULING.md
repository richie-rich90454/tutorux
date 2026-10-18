# Adaptive transcription scheduling

Inspect the work plan without starting transcription:

```text
tutorux --archive Tutorux.tux transcript plan --session SESSION_UUID
tutorux --archive Tutorux.tux transcript plan --session SESSION_UUID \
  --threads 2 --model-memory-mb 2048 --available-memory-mb 8192 --json
```

Tutorux reads the selected session's audio chunk index and groups work by track. Plans use bounded
time windows, reserve a CPU thread for the application, and cap workers from the supplied memory
budget. When model memory or available memory is unknown, the plan uses one worker. If the stated
model footprint exceeds available memory, Tutorux reports that the plan cannot run within that
budget. The real-time factor defaults to `1.0` in the API and can be calibrated by the transcription
backend as it learns model performance.

Applications can feed plan items to `AdaptiveTranscriptionScheduler`. It dispatches higher priority
items first, preserves FIFO order within a priority, supports cooperative cancellation and explicit
retry, and can save work state as archive-backed checkpoint records. Scheduling does not download
models or run a background service.
