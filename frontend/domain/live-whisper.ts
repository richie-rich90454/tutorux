import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import type { LiveWhisperCue } from "../platform/live-whisper";

export function makeLiveWhisperRecords(options: {
  cues: readonly LiveWhisperCue[];
  sessionId: string;
  trackId: string;
  runId: string;
}): ArchiveRecord[] {
  const createdAt = (BigInt(Date.now()) * 1000n).toString();
  const records: ArchiveRecord[] = [];
  let previousSequence = -1n;
  let previousStart = -1n;
  for (const cue of options.cues) {
    if (
      !/^\d+$/u.test(cue.sequence) ||
      !/^\d+$/u.test(cue.startTimeUs) ||
      !/^\d+$/u.test(cue.endTimeUs) ||
      !/^\d+$/u.test(cue.windowStartUs) ||
      !cue.text.trim() ||
      cue.text.length > 1_000_000 ||
      cue.text.includes("\0")
    ) {
      throw new Error("Live Whisper returned an invalid provisional cue.");
    }
    const sequence = BigInt(cue.sequence);
    const start = BigInt(cue.startTimeUs);
    const end = BigInt(cue.endTimeUs);
    const windowStart = BigInt(cue.windowStartUs);
    if (
      sequence <= previousSequence ||
      start < previousStart ||
      start < windowStart ||
      end <= start ||
      !cue.language ||
      !cue.modelName ||
      !cue.backendVersion
    ) {
      throw new Error("Live Whisper cues arrived out of order or with invalid timestamps.");
    }
    previousSequence = sequence;
    previousStart = start;
    const fields = new Map<string, string>([
      ["session_id", options.sessionId.toLowerCase()],
      ["start_time_us", cue.startTimeUs],
      ["end_time_us", cue.endTimeUs],
      ["text", cue.text.trim()],
      ["verification_state", "provisional"],
      ["timestamp_state", "timestamped"],
      ["origin", "local-whisper"],
      ["source_audio_track_id", options.trackId.toLowerCase()],
      ["source_model", cue.modelName],
      ["source_backend_version", cue.backendVersion],
      ["source_run_id", options.runId],
      ["source_window_start_us", cue.windowStartUs],
      ["source_mode", "live"],
      ["language", cue.language],
      ["live_cue_sequence", cue.sequence],
      ["created_at_us", createdAt],
    ]);
    if (cue.diarizationEnabled) {
      fields.set("speaker_turn_next", String(cue.speakerTurnNext));
      fields.set("speaker_identity_state", "unassigned");
      fields.set("diarization_enabled", "true");
      fields.set("diarization_scope", "experimental-speaker-turn-boundaries-only");
      fields.set("diarization_method", "whisper.cpp-tinydiarize");
      fields.set("diarization_model_requirement", "TDRZ-compatible Whisper model required");
    }
    records.push({
      type: RecordType.transcriptSegment,
      id: newUuid(),
      revision: 0n,
      previousOffset: 0n,
      blob: new Uint8Array(),
      fields,
    });
  }
  return records;
}
