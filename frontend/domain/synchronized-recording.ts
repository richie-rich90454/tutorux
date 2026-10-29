import { RecordType, type ArchiveRecord } from "../archive/format";
import { makeMicrophoneRecordingRecords } from "./microphone-recording";

const MAX_BYTES_PER_TRACK = 64 * 1024 * 1024;

/** Capture microphone and shared audio on one Web Audio clock as separate PCM tracks. */
export class SynchronizedRecording {
  private readonly buffers: Uint8Array<ArrayBuffer>[][] = [[], []];
  private bytes = 0;
  private finished = false;

  private constructor(
    private readonly context: AudioContext,
    private readonly streams: MediaStream[],
    private readonly nodes: AudioNode[],
    private readonly processor: ScriptProcessorNode,
    private readonly onLimit: () => void,
  ) {
    processor.onaudioprocess = (event) => {
      if (this.finished) return;
      const length = Math.min(
        event.inputBuffer.length,
        Math.floor((MAX_BYTES_PER_TRACK - this.bytes) / 2),
      );
      for (let channel = 0; channel < 2; channel++) {
        const source = event.inputBuffer.getChannelData(channel);
        const bytes = new Uint8Array(length * 2);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < length; index++) {
          const sample = Math.max(-1, Math.min(1, source[index] ?? 0));
          view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
        }
        this.buffers[channel]!.push(bytes);
      }
      this.bytes += length * 2;
      if (this.bytes >= MAX_BYTES_PER_TRACK) this.onLimit();
    };
  }

  static async start(
    deviceId: string,
    onLimit: () => void,
    onEnded: () => void,
  ): Promise<SynchronizedRecording> {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      !navigator.mediaDevices?.getDisplayMedia ||
      typeof AudioContext === "undefined"
    ) {
      throw new Error("This window cannot capture microphone and shared audio together.");
    }
    const streams: MediaStream[] = [];
    let context: AudioContext | undefined;
    try {
      const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streams.push(shared);
      if (!shared.getAudioTracks().length)
        throw new Error(
          "The selected screen or window did not provide audio. Enable audio sharing and try again.",
        );
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streams.push(microphone);
      context = new AudioContext();
      await context.resume();
      const mic = context.createMediaStreamSource(microphone);
      const sharedSource = context.createMediaStreamSource(
        new MediaStream(shared.getAudioTracks()),
      );
      const merger = context.createChannelMerger(2);
      const processor = context.createScriptProcessor(4096, 2, 2);
      const silent = context.createGain();
      silent.gain.value = 0;
      mic.connect(merger, 0, 0);
      sharedSource.connect(merger, 0, 1);
      merger.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      for (const stream of streams)
        for (const track of stream.getTracks())
          track.addEventListener("ended", onEnded, { once: true });
      return new SynchronizedRecording(
        context,
        streams,
        [mic, sharedSource, merger, silent],
        processor,
        onLimit,
      );
    } catch (error) {
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<[File, File]> {
    if (this.finished) throw new Error("This capture has already stopped.");
    this.finished = true;
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    for (const node of this.nodes) node.disconnect();
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    await this.context.close();
    if (!this.bytes) throw new Error("The selected sources did not provide audio.");
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const text = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i);
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + this.bytes, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, this.context.sampleRate, true);
    view.setUint32(28, this.context.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, this.bytes, true);
    return [
      new File([header, ...this.buffers[0]!], "Microphone.wav", { type: "audio/wav" }),
      new File([header, ...this.buffers[1]!], "Shared audio.wav", { type: "audio/wav" }),
    ];
  }

  async discard(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.processor.onaudioprocess = null;
    this.processor.disconnect();
    for (const node of this.nodes) node.disconnect();
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.buffers[0] = [];
    this.buffers[1] = [];
    await this.context.close().catch(() => undefined);
  }
}

/** Build one legacy-shaped take containing the two synchronized tracks. */
export async function makeSynchronizedRecordingRecords(options: {
  session: ArchiveRecord;
  files: [File, File];
  knownTrackIds: readonly string[];
  startedAtUs: string;
  consentAtUs: string;
}): Promise<ArchiveRecord[]> {
  const common = {
    startedAtUs: options.startedAtUs,
    consentAtUs: options.consentAtUs,
    pauseCount: 0,
    pausedDurationUs: "0",
  };
  const microphone = await makeMicrophoneRecordingRecords({
    ...common,
    session: options.session,
    file: options.files[0],
    knownTrackIds: options.knownTrackIds,
  });
  const intermediate = microphone.records.find((record) => record.type === RecordType.session)!;
  const shared = await makeMicrophoneRecordingRecords({
    ...common,
    session: intermediate,
    file: options.files[1],
    knownTrackIds: [...options.knownTrackIds, microphone.trackId],
  });
  const records = [...microphone.records, ...shared.records].filter(
    (record) =>
      record.type !== RecordType.session &&
      !(record.type === RecordType.assetMetadata && record.id === shared.takeId),
  );
  const finalSession = shared.records.find((record) => record.type === RecordType.session)!;
  const updated = records.map((record) => {
    if (record.type !== RecordType.assetMetadata) return record;
    const fields = new Map(record.fields);
    if (record.id === microphone.takeId) {
      fields.set("track_ids", `${microphone.trackId},${shared.trackId}`);
      fields.set("source", "microphone+system-audio");
      fields.set("label", "Synchronized recording");
    } else if (record.id === shared.trackId) {
      fields.set("recording_take_id", microphone.takeId);
      fields.set("source", "system-audio");
    }
    return { ...record, fields };
  });
  const fields = new Map(finalSession.fields);
  fields.set("recording_track_mode", "synchronized-separate");
  if (fields.get("recording_track_id") === microphone.trackId)
    fields.set("recording_source", "microphone+system-audio");
  updated.push({ ...finalSession, fields });
  return updated;
}
