import { invoke, isTauri } from "@tauri-apps/api/core";
import {
    MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES,
    MicrophoneRecording,
} from "../domain/microphone-recording";

const MAX_PCM_BYTES = 128 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const LIVE_CHUNK_BYTES = 32 * 1024;
const MAX_LIVE_QUEUED_BYTES = 512 * 1024;

export interface MicrophoneCaptureResult {
    file?: File;
    pauseCount: number;
    pausedDurationUs: string;
    startedAtUs: string;
    consentAtUs: string;
    sampleRateHz?: number;
    sampleCount?: string;
    archiveCommitted?: true;
    warning?: string;
}

export interface ActiveMicrophoneCapture {
    readonly durability: "archive" | "memory";
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(interruptedReason?: string): Promise<MicrophoneCaptureResult>;
    discard(): Promise<void>;
}

export interface CapturedPcmChunk {
    sequence: number;
    firstSampleIndex: string;
    sampleRateHz: number;
    samples: Uint8Array<ArrayBuffer>;
}

export interface MicrophoneArchiveCaptureHooks {
    onStarted(capture: CaptureStarted): Promise<ArchiveCaptureCursor | void>;
    onChunk(chunk: CapturedPcmChunk): Promise<void>;
    isLiveEnabled?(): boolean;
    onLiveChunk?(chunk: CapturedPcmChunk): Promise<void>;
    onLiveFailure?(message: string): void;
    onPaused(): Promise<void>;
    onResumed(): Promise<void>;
    onFinished(capture: {
        sampleRateHz: number;
        sampleCount: string;
        pauseCount: number;
        pausedDurationUs: string;
        interruptedReason?: string;
    }): Promise<void>;
    onDiscard(): Promise<void>;
}

export interface ArchiveCaptureCursor {
    sequence: number;
    firstSampleIndex: string;
}

interface StartOptions {
    consentConfirmed: boolean;
    consentAtUs: string;
    sampleRateHz?: number;
    deviceId?: string;
    onLimit: () => void;
    onDeviceEnded: () => void;
    archive?: MicrophoneArchiveCaptureHooks;
}

export interface CaptureStarted {
    captureId: string;
    startedAtUs: string;
    consentAtUs: string;
    maxBytes: number;
    sampleRateHz: number;
}

interface CaptureFinished {
    byteCount: number;
    sampleCount: number;
}

/** Start a consented microphone recording through the desktop host or browser adapter. */
export async function startMicrophoneCapture(
    options: StartOptions,
): Promise<ActiveMicrophoneCapture> {
    if (!options.consentConfirmed) {
        throw new Error("Confirm that everyone being recorded has agreed before starting capture.");
    }
    if (isTauri()) {
        if (!options.archive) {
            throw new Error(
                "Desktop microphone capture requires an unlocked archive recovery target.",
            );
        }
        return TauriMicrophoneCapture.start(options);
    }

    const recording = await MicrophoneRecording.start(
        options.onLimit,
        options.onDeviceEnded,
        options.deviceId,
    );
    const startedAtUs = (BigInt(Date.now()) * 1000n).toString();
    return {
        durability: "memory",
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
    readonly durability = "archive" as const;
    private sequence = 0;
    private acceptedBytes = 0;
    private queuedBytes = 0;
    private uploadChain: Promise<void> = Promise.resolve();
    private uploadError = "";
    private warning = "";
    private uploadFailed = false;
    private archiveBuffers: Uint8Array<ArrayBuffer>[] = [];
    private archiveBufferedBytes = 0;
    private archiveQueuedBytes = 0;
    private archiveChain: Promise<void> = Promise.resolve();
    private archiveError = "";
    private archiveSequence = 0;
    private archiveSampleIndex = 0n;
    private archiveCommittedSamples = 0n;
    private finished = false;
    private paused = false;
    private pauseStartedMs = 0;
    private pausedMs = 0;
    private pauseCount = 0;
    private liveBuffers: Uint8Array<ArrayBuffer>[] = [];
    private liveBufferedBytes = 0;
    private liveBufferedFirstSampleIndex = 0n;
    private liveQueuedBytes = 0;
    private liveSequence = 0;
    private liveSampleIndex = 0n;
    private liveChain: Promise<void> = Promise.resolve();
    private liveDisabled = false;

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
        private readonly archive: MicrophoneArchiveCaptureHooks,
        initialArchiveCursor: ArchiveCaptureCursor,
    ) {
        this.archiveSequence = initialArchiveCursor.sequence;
        this.archiveSampleIndex = BigInt(initialArchiveCursor.firstSampleIndex);
        this.liveSampleIndex = BigInt(initialArchiveCursor.firstSampleIndex);
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
                view.setInt16(
                    index * 2,
                    Math.round(sample < 0 ? sample * 32768 : sample * 32767),
                    true,
                );
            }

            if (
                this.archive.onLiveChunk &&
                !this.liveDisabled &&
                this.archive.isLiveEnabled?.() === false
            ) {
                this.clearLiveBuffers();
            } else if (this.archive.onLiveChunk && !this.liveDisabled) {
                const liveBytes = bytes.slice();
                if (this.liveBufferedBytes === 0)
                    this.liveBufferedFirstSampleIndex = this.liveSampleIndex;
                this.liveBuffers.push(liveBytes);
                this.liveBufferedBytes += liveBytes.byteLength;
                this.liveSampleIndex += BigInt(count);
                if (this.liveQueuedBytes + this.liveBufferedBytes > MAX_LIVE_QUEUED_BYTES) {
                    this.failLive(
                        "Live transcription fell behind the microphone. Transcription stopped; recording continues and remains saved.",
                    );
                } else if (this.liveBufferedBytes >= LIVE_CHUNK_BYTES) {
                    this.queueLiveChunk();
                }
            }

            if (this.queuedBytes + bytes.length > MAX_QUEUED_BYTES) {
                this.warning =
                    "Audio transfer fell behind; the committed portion is being preserved.";
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
                    this.uploadError = `The desktop audio transfer stopped: ${errorMessage(error)}`;
                    this.warning = this.uploadError;
                    this.onLimit();
                })
                .finally(() => {
                    this.queuedBytes -= bytes.length;
                });

            this.archiveBuffers.push(bytes);
            this.archiveBufferedBytes += bytes.length;
            if (this.archiveBufferedBytes >= MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES) {
                if (this.archiveQueuedBytes + this.archiveBufferedBytes > MAX_QUEUED_BYTES) {
                    this.warning =
                        "Archive writing fell behind; stopping and preserving committed audio.";
                    this.onLimit();
                } else {
                    this.queueArchiveChunk();
                }
            }

            if (count < samples.length || this.acceptedBytes + this.queuedBytes >= this.maxBytes) {
                this.warning = "The microphone recording reached its 128 MiB archive limit.";
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
            context = options.sampleRateHz
                ? new AudioContext({ sampleRate: options.sampleRateHz })
                : new AudioContext();
            await context.resume();
            const started = await invoke<CaptureStarted>("begin_audio_capture", {
                consentConfirmed: options.consentConfirmed,
                consentAtUs: options.consentAtUs,
                sampleRateHz: context.sampleRate,
            });
            captureId = started.captureId;
            const archiveCursor = (await options.archive!.onStarted(started)) ?? {
                sequence: 0,
                firstSampleIndex: "0",
            };
            if (!Number.isSafeInteger(archiveCursor.sequence) || archiveCursor.sequence < 0) {
                throw new Error("The microphone archive recovery sequence is invalid.");
            }
            if (!/^\d+$/u.test(archiveCursor.firstSampleIndex)) {
                throw new Error("The microphone archive recovery sample position is invalid.");
            }
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
                options.archive!,
                archiveCursor,
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
            await this.flushArchiveChunk();
            await this.archiveChain;
            this.flushLiveChunk();
            await this.liveChain;
            await invoke("pause_audio_capture", { captureId: this.captureId });
            await this.archive.onPaused();
        } catch (error) {
            if (!this.finished) {
                await invoke("resume_audio_capture", { captureId: this.captureId }).catch(
                    () => undefined,
                );
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
        try {
            await this.archiveChain;
            await invoke("resume_audio_capture", { captureId: this.captureId });
            await this.context.resume();
            await this.archive.onResumed();
        } catch (error) {
            await invoke("pause_audio_capture", { captureId: this.captureId }).catch(
                () => undefined,
            );
            await this.context.suspend().catch(() => undefined);
            await this.archive.onPaused().catch(() => undefined);
            throw error instanceof Error ? error : new Error(errorMessage(error));
        }
        if (this.finished) return;
        this.pausedMs += performance.now() - this.pauseStartedMs;
        for (const track of this.stream.getAudioTracks()) track.enabled = true;
        this.paused = false;
    }

    async stop(interruptedReason = ""): Promise<MicrophoneCaptureResult> {
        if (this.finished) throw new Error("This recording has already stopped.");
        this.finished = true;
        if (this.paused) this.pausedMs += performance.now() - this.pauseStartedMs;
        await this.closeInput();
        await this.uploadChain;
        await this.archiveChain;
        if (!this.archiveError) {
            try {
                await this.flushArchiveChunk();
                await this.archiveChain;
            } catch (error) {
                this.archiveError = `Could not commit microphone audio to the archive: ${errorMessage(error)}`;
            }
        } else {
            this.clearArchiveBuffers();
        }
        this.flushLiveChunk();
        await this.liveChain;
        if (this.uploadError) this.warning ||= this.uploadError;
        const committedSampleCount = this.archiveCommittedSamples;
        if (committedSampleCount === 0n) {
            await invoke("discard_audio_capture", { captureId: this.captureId }).catch(
                () => undefined,
            );
            await this.archive.onDiscard();
            throw new Error("The microphone did not provide any audio.");
        }
        let hostFinishWarning = "";
        try {
            const finished = await invoke<CaptureFinished>("finish_audio_capture", {
                captureId: this.captureId,
            });
            if (BigInt(finished.sampleCount) !== committedSampleCount)
                hostFinishWarning =
                    "The capture host confirmed a different sample count than the archive.";
        } catch (error) {
            hostFinishWarning = `The capture host ended early: ${errorMessage(error)}`;
        }
        if (hostFinishWarning) this.warning ||= hostFinishWarning;
        const pausedDurationUs = String(Math.round(this.pausedMs * 1000));
        const finalReason = interruptedReason || this.archiveError || this.warning;
        await this.archive.onFinished({
            sampleRateHz: this.context.sampleRate,
            sampleCount: committedSampleCount.toString(),
            pauseCount: this.pauseCount,
            pausedDurationUs,
            ...(finalReason ? { interruptedReason: finalReason } : {}),
        });
        return {
            pauseCount: this.pauseCount,
            pausedDurationUs,
            startedAtUs: this.startedAtUs,
            consentAtUs: this.consentAtUs,
            sampleRateHz: this.context.sampleRate,
            sampleCount: committedSampleCount.toString(),
            archiveCommitted: true,
            ...(this.warning ? { warning: this.warning } : {}),
        };
    }

    async discard(): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        await this.closeInput();
        await this.uploadChain;
        await this.archiveChain;
        this.clearLiveBuffers();
        await this.liveChain;
        await invoke("discard_audio_capture", { captureId: this.captureId }).catch(() => undefined);
        this.clearArchiveBuffers();
        await this.archive.onDiscard();
    }

    private async closeInput(): Promise<void> {
        this.processor.onaudioprocess = null;
        this.input.disconnect();
        this.processor.disconnect();
        this.silentOutput.disconnect();
        for (const track of this.stream.getTracks()) track.stop();
        await this.context.close().catch(() => undefined);
    }

    private queueArchiveChunk(): void {
        if (!this.archiveBufferedBytes) return;
        const samples = joinBuffers(this.archiveBuffers, this.archiveBufferedBytes);
        this.archiveBuffers = [];
        this.archiveBufferedBytes = 0;
        this.archiveQueuedBytes += samples.byteLength;
        const firstSampleIndex = this.archiveSampleIndex.toString();
        this.archiveSampleIndex += BigInt(samples.byteLength / 2);
        const sequence = this.archiveSequence++;
        this.archiveChain = this.archiveChain
            .then(async () => {
                if (this.archiveError) return;
                await this.archive.onChunk({
                    sequence,
                    firstSampleIndex,
                    sampleRateHz: this.context.sampleRate,
                    samples,
                });
                this.archiveCommittedSamples += BigInt(samples.byteLength / 2);
            })
            .catch((error: unknown) => {
                this.archiveError = `Could not commit microphone audio to the archive: ${errorMessage(error)}`;
                this.warning = this.archiveError;
                this.onLimit();
            })
            .finally(() => {
                this.archiveQueuedBytes -= samples.byteLength;
                samples.fill(0);
            });
    }

    private async flushArchiveChunk(): Promise<void> {
        if (this.archiveError) throw new Error(this.archiveError);
        if (!this.archiveBufferedBytes) return;
        if (this.archiveQueuedBytes + this.archiveBufferedBytes > MAX_QUEUED_BYTES) {
            await this.archiveChain;
        }
        if (this.archiveError) throw new Error(this.archiveError);
        this.queueArchiveChunk();
    }

    private clearArchiveBuffers(): void {
        for (const buffer of this.archiveBuffers) buffer.fill(0);
        this.archiveBuffers = [];
        this.archiveBufferedBytes = 0;
    }

    private queueLiveChunk(): void {
        if (this.liveDisabled || !this.archive.onLiveChunk || !this.liveBufferedBytes) return;
        const samples = joinBuffers(this.liveBuffers, this.liveBufferedBytes);
        this.liveBuffers = [];
        this.liveBufferedBytes = 0;
        const sequence = this.liveSequence++;
        const firstSampleIndex = this.liveBufferedFirstSampleIndex.toString();
        this.liveQueuedBytes += samples.byteLength;
        this.liveChain = this.liveChain
            .then(async () => {
                if (this.liveDisabled) return;
                await this.archive.onLiveChunk!({
                    sequence,
                    firstSampleIndex,
                    sampleRateHz: this.context.sampleRate,
                    samples,
                });
            })
            .catch((error: unknown) => {
                this.failLive(
                    `Live transcription stopped: ${errorMessage(error)}. The recording continues and remains saved.`,
                );
            })
            .finally(() => {
                this.liveQueuedBytes -= samples.byteLength;
                samples.fill(0);
            });
    }

    private flushLiveChunk(): void {
        if (this.liveDisabled) {
            this.clearLiveBuffers();
            return;
        }
        this.queueLiveChunk();
    }

    private failLive(message: string): void {
        if (this.liveDisabled) return;
        this.liveDisabled = true;
        this.clearLiveBuffers();
        this.archive.onLiveFailure?.(message);
    }

    private clearLiveBuffers(): void {
        for (const buffer of this.liveBuffers) buffer.fill(0);
        this.liveBuffers = [];
        this.liveBufferedBytes = 0;
    }
}

function joinBuffers(
    buffers: readonly Uint8Array<ArrayBuffer>[],
    totalBytes: number,
): Uint8Array<ArrayBuffer> {
    const joined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const buffer of buffers) {
        joined.set(buffer, offset);
        offset += buffer.byteLength;
        buffer.fill(0);
    }
    return joined;
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
