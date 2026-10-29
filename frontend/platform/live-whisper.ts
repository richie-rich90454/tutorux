import { invoke, isTauri } from "@tauri-apps/api/core";

export interface LiveWhisperSettings {
  modelPath: string;
  language: string;
  windowSeconds: number;
  threadCount: number;
  diarizeSpeakerTurns: boolean;
}

export interface LiveWhisperChunk {
  sequence: number;
  firstSampleIndex: string;
  sampleRateHz: number;
  samples: Uint8Array<ArrayBuffer>;
}

export interface LiveWhisperCue {
  sequence: string;
  startTimeUs: string;
  endTimeUs: string;
  windowStartUs: string;
  text: string;
  language: string;
  modelName: string;
  backendVersion: string;
  diarizationEnabled: boolean;
  speakerTurnNext: boolean;
}

export interface LiveWhisperPoll {
  runId: string;
  status: "loading" | "running" | "finishing" | "completed" | "failed" | "cancelled";
  error: string | null;
  modelName: string;
  backendVersion: string;
  cues: LiveWhisperCue[];
}

export async function beginLiveWhisper(options: {
  settings: LiveWhisperSettings;
  sampleRateHz: number;
  firstSampleIndex: string;
}): Promise<{ runId: string; modelName: string; backendVersion: string }> {
  if (!isTauri()) throw new Error("Live local transcription requires the Tutorux desktop app.");
  if (!options.settings.modelPath.trim()) throw new Error("Choose a local Whisper model first.");
  if (!/^(auto|[a-z-]{2,16})$/iu.test(options.settings.language.trim())) {
    throw new Error("Enter a Whisper language code, or auto.");
  }
  if (
    !Number.isSafeInteger(options.settings.windowSeconds) ||
    options.settings.windowSeconds < 1 ||
    options.settings.windowSeconds > 27
  ) {
    throw new Error("Live Whisper windows must be between 1 and 27 seconds.");
  }
  if (
    !Number.isSafeInteger(options.settings.threadCount) ||
    options.settings.threadCount < 1 ||
    options.settings.threadCount > 64
  ) {
    throw new Error("Whisper thread count must be between 1 and 64.");
  }
  return invoke<{ runId: string; modelName: string; backendVersion: string }>(
    "begin_live_whisper",
    {
      modelPath: options.settings.modelPath,
      language: options.settings.language.trim(),
      windowSeconds: options.settings.windowSeconds,
      threadCount: options.settings.threadCount,
      sampleRateHz: options.sampleRateHz,
      firstSampleIndex: options.firstSampleIndex,
      timelineBaseSampleIndex: "0",
      diarizeSpeakerTurns: options.settings.diarizeSpeakerTurns,
    },
  );
}

export async function enqueueLiveWhisperAudio(
  runId: string,
  chunk: LiveWhisperChunk,
): Promise<void> {
  await invoke("enqueue_live_whisper_audio", {
    runId,
    sequence: chunk.sequence,
    firstSampleIndex: chunk.firstSampleIndex,
    sampleRateHz: chunk.sampleRateHz,
    samples: Array.from(chunk.samples),
  });
}

export function pollLiveWhisper(runId: string): Promise<LiveWhisperPoll> {
  return invoke<LiveWhisperPoll>("poll_live_whisper", { runId });
}

export function acknowledgeLiveWhisperCues(runId: string, throughSequence: string): Promise<void> {
  return invoke("acknowledge_live_whisper_cues", { runId, throughSequence });
}

export function cancelLiveWhisper(runId: string): Promise<void> {
  return invoke("cancel_live_whisper", { runId });
}

export function finishLiveWhisper(runId: string): Promise<void> {
  return invoke("finish_live_whisper", { runId });
}

export function endLiveWhisper(runId: string): Promise<void> {
  return invoke("end_live_whisper", { runId });
}
