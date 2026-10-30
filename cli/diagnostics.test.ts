import { describe, expect, it } from "vitest";
import { audioDiagnosticRowsFromNativeDevices } from "./diagnostics";
import type { NativeCaptureDevice } from "./native-audio-helper";

const configuredDevice: NativeCaptureDevice = {
  id: "capture:mic",
  name: "Desk microphone",
  backend: "wasapi",
  source: "microphone",
  isDefault: true,
  sampleFormat: "F32",
  sampleRateHz: 48_000,
  channelCount: 2,
};

describe("CLI audio diagnostics", () => {
  it("reports inspected native endpoint configuration", () => {
    const [row] = audioDiagnosticRowsFromNativeDevices([configuredDevice]);
    expect(row).toMatchObject({
      device_id: "capture:mic",
      kind: "microphone",
      default: true,
      probe_state: "ready",
      sample_format: "F32",
      sample_rate_hz: "48000",
      channel_count: "2",
    });
  });

  it("keeps an explicit limitation when the helper omits configuration", () => {
    const [row] = audioDiagnosticRowsFromNativeDevices([
      {
        id: "capture:speakers",
        name: "System audio · Speakers",
        backend: "wasapi",
        source: "system-audio",
        isDefault: false,
      },
    ]);
    expect(row).toMatchObject({ kind: "playback", probe_state: "unsupported" });
    expect(row?.probe_message).toContain("rebuild the audio helper");
  });
});
