import { RecordType, type ArchiveRecord } from "../archive/format";
import { makeWaveImportRecords, type WaveImportResult } from "./wav";

const MAX_PCM_BYTES = 128 * 1024 * 1024;

/** Convert a consented microphone recording into the archive's normal take and PCM chunks. */
export async function makeMicrophoneRecordingRecords(options: {
  session: ArchiveRecord;
  file: File;
  knownTrackIds: readonly string[];
  startedAtUs: string;
  consentAtUs: string;
}): Promise<WaveImportResult> {
  const result = await makeWaveImportRecords(
    options.session,
    options.file,
    true,
    options.knownTrackIds,
  );
  const endedAtUs = (BigInt(Date.now()) * 1000n).toString();
  const records = result.records.map((record) => {
    if (record.type === RecordType.audioChunk) {
      const fields = new Map(record.fields);
      fields.delete("source_filename");
      return { ...record, fields };
    }
    if (
      record.type === RecordType.assetMetadata &&
      (record.id === result.trackId || record.id === result.takeId)
    ) {
      const fields = new Map(record.fields);
      fields.set("source", "microphone");
      fields.set("capture_source_backend", "web-audio");
      fields.set("capture_consent_at_us", options.consentAtUs);
      fields.set("capture_consent_policy", "1");
      fields.delete("source_filename");
      if (record.id === result.takeId) {
        fields.set("started_at_us", options.startedAtUs);
        fields.set("ended_at_us", endedAtUs);
      }
      return { ...record, fields };
    }
    if (record.type === RecordType.session && record.id === options.session.id) {
      const fields = new Map(record.fields);
      for (const key of [...fields.keys()]) {
        if (
          key.startsWith("audio_import_") ||
          key === "audio_chunks_imported" ||
          key === "audio_samples_imported"
        ) {
          const original = options.session.fields.get(key);
          if (original === undefined) fields.delete(key);
          else fields.set(key, original);
        }
      }
      if (fields.get("recording_track_id") === result.trackId) {
        fields.set("recording_source", "microphone");
        fields.set("recording_source_backend", "web-audio");
        fields.set("recording_started_at_us", options.startedAtUs);
      }
      fields.set("recording_ended_at_us", endedAtUs);
      fields.set("capture_consent_at_us", options.consentAtUs);
      fields.set("capture_consent_policy", "1");
      return { ...record, fields };
    }
    return record;
  });
  return { ...result, records };
}

/** Capture microphone PCM through Web Audio with a bounded in-memory buffer. */
export class MicrophoneRecording {
  private buffers: Uint8Array<ArrayBuffer>[] = [];
  private totalBytes = 0;
  private finished = false;

  private constructor(
    private readonly context: AudioContext,
    private readonly stream: MediaStream,
    private readonly input: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
    private readonly silentOutput: GainNode,
    private readonly onLimit: () => void,
  ) {
    processor.onaudioprocess = (event) => {
      if (this.finished) return;
      const samples = event.inputBuffer.getChannelData(0);
      const count = Math.min(samples.length, Math.floor((MAX_PCM_BYTES - this.totalBytes) / 2));
      if (count > 0) {
        const bytes = new Uint8Array(count * 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < count; index++) {
          const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
          view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
        }
        this.buffers.push(bytes);
        this.totalBytes += bytes.length;
      }
      if (this.totalBytes >= MAX_PCM_BYTES) this.onLimit();
    };
    input.connect(processor);
    processor.connect(silentOutput);
    silentOutput.gain.value = 0;
    silentOutput.connect(context.destination);
  }

  static async start(onLimit: () => void, onDeviceEnded: () => void): Promise<MicrophoneRecording> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      throw new Error("Microphone recording is unavailable in this window.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      await context.resume();
      for (const track of stream.getAudioTracks())
        track.addEventListener("ended", onDeviceEnded, { once: true });
      return new MicrophoneRecording(
        context,
        stream,
        context.createMediaStreamSource(stream),
        context.createScriptProcessor(4096, 1, 1),
        context.createGain(),
        onLimit,
      );
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<File> {
    if (this.finished) throw new Error("This recording has already stopped.");
    this.finished = true;
    this.processor.onaudioprocess = null;
    this.input.disconnect();
    this.processor.disconnect();
    this.silentOutput.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.context.close();
    if (!this.totalBytes) throw new Error("The microphone did not provide any audio.");
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i);
    };
    text(0, "RIFF");
    view.setUint32(4, this.totalBytes + 36, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.context.sampleRate, true);
    view.setUint32(28, this.context.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, this.totalBytes, true);
    const file = new File(
      [header, ...this.buffers],
      `Microphone ${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      { type: "audio/wav" },
    );
    this.buffers = [];
    return file;
  }

  async discard(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.processor.onaudioprocess = null;
    this.input.disconnect();
    this.processor.disconnect();
    this.silentOutput.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    this.buffers = [];
    await this.context.close().catch(() => undefined);
  }
}
