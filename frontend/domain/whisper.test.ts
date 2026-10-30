import { describe, expect, it } from "vitest";
import type { AudioPreview } from "./audio";
import { makeWhisperRecords } from "./whisper";

const preview: AudioPreview = {
  wav: new Uint8Array(44 + 32_000),
  sampleRateHz: 16_000,
  channelCount: 1,
  frameCount: 16_000,
  startFrame: 0n,
  durationUs: 1_000_000n,
};

function whisperJson(language?: string): string {
  return JSON.stringify({
    ...(language === undefined ? {} : { result: { language } }),
    transcription: [{ text: "Hello", offsets: { from: 0, to: 500 } }],
  });
}

describe("Whisper transcript records", () => {
  it("stores the language detected by whisper.cpp instead of the requested auto", () => {
    const result = makeWhisperRecords({
      json: whisperJson("fr"),
      sessionId: crypto.randomUUID(),
      trackId: crypto.randomUUID(),
      modelName: "ggml-small.bin",
      language: "auto",
      preview,
      existing: [],
    });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.fields.get("language")).toBe("fr");
  });

  it("keeps the requested language when detection is not reported", () => {
    const result = makeWhisperRecords({
      json: whisperJson(),
      sessionId: crypto.randomUUID(),
      trackId: crypto.randomUUID(),
      modelName: "ggml-small.bin",
      language: "en",
      preview,
      existing: [],
    });

    expect(result.records[0]!.fields.get("language")).toBe("en");
  });

  it("ignores malformed detected language metadata", () => {
    const result = makeWhisperRecords({
      json: whisperJson("not a language code!"),
      sessionId: crypto.randomUUID(),
      trackId: crypto.randomUUID(),
      modelName: "ggml-small.bin",
      language: "auto",
      preview,
      existing: [],
    });

    expect(result.records[0]!.fields.get("language")).toBe("auto");
  });
});
