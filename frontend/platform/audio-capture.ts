import { invoke, isTauri } from "@tauri-apps/api/core";
import { MicrophoneRecording } from "../domain/microphone-recording";

const MAX_PCM_BYTES = 128 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;

export interface MicrophoneCaptureResult {
  file: File;
  pauseCount: number;
  pausedDurationUs: string;
  startedAtUs: string;
  consentAtUs: string;
  warning?: string;
}

export interface ActiveMicrophoneCapture {
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<MicrophoneCaptureResult>;
  discard(): Promise<void>;
}

interface StartOptions {
  consentConfirmed: boolean;
  consentAtUs: string;
  deviceId?: string;
  onLimit: () => void;
  onDeviceEnded: () => void;
}

interface CaptureStarted {
  captureId: string;
  startedAtUs: string;
  consentAtUs: string;
  maxBytes: number;
}

/** Start a consented microphone recording through the desktop host or browser adapter. */
export async function startMicrophoneCapture(
  options: StartOptions,
): Promise<ActiveMicrophoneCapture> {
  if (!options.consentConfirmed) {
    throw new Error("Confirm that everyone being recorded has agreed before starting capture.");
  }
  if (isTauri()) return TauriMicrophoneCapture.start(options);

  const recording = await MicrophoneRecording.start(
    options.onLimit,
    options.onDeviceEnded,
    options.deviceId,
  );
  const startedAtUs = (BigInt(Date.now()) * 1000n).toString();
  return {
    pause: () => recording.pause(),
    resume: () => recording.resume(),
    async stop() {
      const result = await recording.stop();
      return {
        ...result,
        startedAtUs,
        consentAtUs: options.consentAtUs,
      };
    },
    discard: () => recording.discard(),
  };
}

class TauriMicrophoneCapture implements ActiveMicrophoneCapture {
  private sequence = 0;
  private acceptedBytes = 0;
  private queuedBytes = 0;
  private uploadChain: Promise<void> = Promise.resolve();
  private warning = "";
  private uploadFailed = false;
  private finished = false;
  private paused = false;
  private pauseStartedMs = 0;
  private pausedMs = 0;
  private pauseCount = 0;

  private constructor(
    private readonly captureId: string,
    private readonly startedAtUs: string,
    private readonly consentAtUs: string,
    private readonly maxBytes: number,
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly input: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode,
    private readonly silentOutput: GainNode,
    private readonly onLimit: () => void,
    private readonly onDeviceEnded: () => void,
  ) {
    processor.onaudioprocess = (event) => {
      if (this.finished || this.paused || this.warning) return;
      const samples = event.inputBuffer.getChannelData(0);
      const remaining = this.maxBytes - this.acceptedBytes - this.queuedBytes;
      const count = Math.min(samples.length, Math.floor(remaining / 2));
      if (count <= 0) {
        this.warning = "The microphone recording reached its memory limit.";
        this.onLimit();
        return;
      }

      const bytes = new Uint8Array(count * 2);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < count; index++) {
        const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
        view.setInt16(index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
      }

      if (this.queuedBytes + bytes.length > MAX_QUEUED_BYTES) {
        this.warning = "Audio transfer fell behind; the captured portion is being saved.";
        this.onLimit();
        return;
      }
      const sequence = this.sequence++;
      this.queuedBytes += bytes.length;
      this.uploadChain = this.uploadChain
        .then(async () => {
          if (this.uploadFailed) return;
          await invoke("append_audio_capture_chunk", {
            captureId: this.captureId,
            sequence,
            samples: Array.from(bytes),
          });
          this.acceptedBytes += bytes.length;
        })
        .catch((error: unknown) => {
          this.uploadFailed = true;
          this.warning = `The desktop audio transfer stopped: ${errorMessage(error)}`;
          this.onLimit();
        })
        .finally(() => {
          this.queuedBytes -= bytes.length;
        });

      if (count < samples.length || this.acceptedBytes + this.queuedBytes >= this.maxBytes) {
        this.warning = "The microphone recording reached its memory limit.";
        this.onLimit();
      }
    };
    input.connect(processor);
    processor.connect(silentOutput);
    silentOutput.gain.value = 0;
    silentOutput.connect(context.destination);
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", onDeviceEnded, { once: true });
    }
  }

  static async start(options: StartOptions): Promise<TauriMicrophoneCapture> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      throw new Error("Microphone recording is unavailable in this window.");
    }

    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: options.deviceId ? { deviceId: { exact: options.deviceId } } : true,
      })
      .catch((error: unknown) => {
        throw new Error(microphoneErrorMessage(error));
      });
    let context: AudioContext | undefined;
    let captureId: string | undefined;
    try {
      context = new AudioContext();
      await context.resume();
      const started = await invoke<CaptureStarted>("begin_audio_capture", {
        consentConfirmed: options.consentConfirmed,
        consentAtUs: options.consentAtUs,
        sampleRateHz: context.sampleRate,
      });
      captureId = started.captureId;
      const capture = new TauriMicrophoneCapture(
        started.captureId,
        started.startedAtUs,
        started.consentAtUs,
        Math.min(started.maxBytes, MAX_PCM_BYTES),
        stream,
        context,
        context.createMediaStreamSource(stream),
        context.createScriptProcessor(4096, 1, 1),
        context.createGain(),
        options.onLimit,
        options.onDeviceEnded,
      );
      return capture;
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => undefined);
      if (captureId) {
        await invoke("discard_audio_capture", { captureId }).catch(() => undefined);
      }
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  }

  async pause(): Promise<void> {
    if (this.finished || this.paused) throw new Error("Recording cannot be paused now.");
    this.paused = true;
    this.pauseStartedMs = performance.now();
    this.pauseCount++;
    for (const track of this.stream.getAudioTracks()) track.enabled = false;
    try {
      await this.context.suspend();
      await this.uploadChain;
      await invoke("pause_audio_capture", { captureId: this.captureId });
    } catch (error) {
      if (!this.finished) {
        await this.context.resume().catch(() => undefined);
        this.paused = false;
        this.pauseCount--;
        for (const track of this.stream.getAudioTracks()) track.enabled = true;
      }
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
  }

  async resume(): Promise<void> {
    if (this.finished || !this.paused) throw new Error("Recording cannot be resumed now.");
    await this.context.resume();
    if (this.finished) return;
    try {
      await invoke("resume_audio_capture", { captureId: this.captureId });
    } catch (error) {
      await this.context.suspend().catch(() => undefined);
      throw error instanceof Error ? error : new Error(errorMessage(error));
    }
    this.pausedMs += performance.now() - this.pauseStartedMs;
    for (const track of this.stream.getAudioTracks()) track.enabled = true;
    this.paused = false;
  }

  async stop(): Promise<MicrophoneCaptureResult> {
    if (this.finished) throw new Error("This recording has already stopped.");
    this.finished = true;
    if (this.paused) this.pausedMs += performance.now() - this.pauseStartedMs;
    await this.closeInput();
    await this.uploadChain;
    const wav = await invoke<ArrayBuffer>("finish_audio_capture", { captureId: this.captureId });
    if (wav.byteLength <= 44) throw new Error("The microphone did not provide any audio.");
    const file = new File([wav], `Microphone ${new Date().toISOString().replace(/[:.]/g, "-")}.wav`, {
      type: "audio/wav",
    });
    return {
      file,
      pauseCount: this.pauseCount,
      pausedDurationUs: String(Math.round(this.pausedMs * 1000)),
      startedAtUs: this.startedAtUs,
      consentAtUs: this.consentAtUs,
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  async discard(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.closeInput();
    await this.uploadChain;
    await invoke("discard_audio_capture", { captureId: this.captureId }).catch(() => undefined);
  }

  private async closeInput(): Promise<void> {
    this.processor.onaudioprocess = null;
    this.input.disconnect();
    this.processor.disconnect();
    this.silentOutput.disconnect();
    for (const track of this.stream.getTracks()) track.stop();
    await this.context.close().catch(() => undefined);
  }
}

function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied. Allow microphone access in system settings and try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone device is available.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is busy or unavailable.";
  }
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
