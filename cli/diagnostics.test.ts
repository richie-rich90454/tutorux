import { describe, expect, it } from "vitest";
import { audioDiagnosticRowsFromNativeDevices, enumerateAudioDiagnostics } from "./diagnostics";
import type {
  NativeApplicationAudioDevice,
  NativeCaptureDevice,
  NativeCaptureProbe,
} from "./native-audio-helper";

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

  it("probes capture and application streams and reports explicit failures", async () => {
    const application: NativeApplicationAudioDevice = {
      id: "app:42",
      name: "Lesson player",
      backend: "wasapi",
      processId: 42,
    };
    const result = await enumerateAudioDiagnostics(undefined, {
      listCaptureDevices: async () => ({ helper: "helper", devices: [configuredDevice] }),
      listApplicationDevices: async () => ({ helper: "helper", devices: [application] }),
      probeCaptureDevice: async () => probe(configuredDevice, "microphone"),
      probeApplicationDevice: async () => {
        throw new Error("application refused capture");
      },
    });

    expect(result).toMatchObject({
      available: true,
      samples_retained: false,
      network_checked: false,
    });
    expect(result.rows.map((row) => [row.kind, row.probe_state])).toEqual([
      ["microphone", "ready"],
      ["application", "failed"],
    ]);
    expect(result.rows[0]).toMatchObject({
      signal_detected: "true",
      sample_format: "pcm_f32le",
      sample_rate_hz: "48000",
      channel_count: "2",
    });
    expect(result.rows[1]?.application_process_id).toBe("42");
    expect(result.rows[1]?.probe_message).toContain("application refused capture");
  });

  it("reports a capture probe failure without retaining samples", async () => {
    const result = await enumerateAudioDiagnostics(undefined, {
      listCaptureDevices: async () => ({ helper: "helper", devices: [configuredDevice] }),
      listApplicationDevices: async () => ({ helper: "helper", devices: [] }),
      probeCaptureDevice: async () => {
        throw new Error("device busy");
      },
    });
    expect(result.rows[0]).toMatchObject({ probe_state: "failed" });
    expect(result.rows[0]?.probe_message).toContain("device busy");
    expect(result.samples_retained).toBe(false);
  });
});

function probe(
  device: NativeCaptureDevice,
  source: "microphone" | "application",
): NativeCaptureProbe {
  return {
    id: device.id,
    name: device.name,
    backend: device.backend,
    source,
    sampleFormat: "pcm_f32le",
    sampleRateHz: 48_000,
    channelCount: 2,
    sampleCount: 86_400,
    durationMs: 1_800,
    rms: 0.02,
    peak: 0.1,
    dbfs: -34,
    signalDetected: true,
    probe: "native-stream-opened-and-signal-measured",
  };
}
