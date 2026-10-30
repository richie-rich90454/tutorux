import { RecordType, type ArchiveRecord } from "../archive/format";
import {
    makeMicrophoneCaptureChunkRecords,
    makeMicrophoneRecordingRecords,
    type CaptureSampleFormat,
    type MicrophoneArchiveSource,
} from "./microphone-recording";

const MAX_BYTES_PER_TRACK = 64 * 1024 * 1024;
const U64_MAX = 18_446_744_073_709_551_615n;

export type CaptureDurability = "default" | "maximum" | "reduced-write";

/** Capture microphone and shared audio on one Web Audio clock as separate PCM tracks. */
export class SynchronizedRecording {
    private readonly buffers: Uint8Array<ArrayBuffer>[][] = [[], []];
    private bytes = 0;
    private finished = false;
    private paused = false;
    private pauseStartedMs = 0;
    private pausedMs = 0;
    private pauseCount = 0;

    private constructor(
        private readonly context: AudioContext,
        private readonly streams: MediaStream[],
        private readonly nodes: AudioNode[],
        private readonly processor: ScriptProcessorNode,
        private readonly onLimit: () => void,
    ) {
        processor.onaudioprocess = (event) => {
            if (this.finished || this.paused) return;
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
                    view.setInt16(
                        index * 2,
                        Math.round(sample < 0 ? sample * 32768 : sample * 32767),
                        true,
                    );
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
        onEnded: (track: "microphone" | "system-audio") => void,
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
            const shared = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true,
            });
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
            for (const track of microphone.getAudioTracks())
                track.addEventListener("ended", () => onEnded("microphone"), { once: true });
            for (const track of shared.getAudioTracks())
                track.addEventListener("ended", () => onEnded("system-audio"), { once: true });
            for (const track of shared.getVideoTracks())
                track.addEventListener("ended", () => onEnded("system-audio"), { once: true });
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

    async pause(): Promise<void> {
        if (this.finished || this.paused) throw new Error("Recording cannot be paused now.");
        this.paused = true;
        this.pauseStartedMs = performance.now();
        this.pauseCount++;
        for (const stream of this.streams)
            for (const track of stream.getAudioTracks()) track.enabled = false;
        try {
            await this.context.suspend();
        } catch (error) {
            if (!this.finished) {
                this.paused = false;
                this.pauseCount--;
                for (const stream of this.streams)
                    for (const track of stream.getAudioTracks()) track.enabled = true;
            }
            throw error;
        }
    }

    async resume(): Promise<void> {
        if (this.finished || !this.paused) throw new Error("Recording cannot be resumed now.");
        await this.context.resume();
        if (this.finished) return;
        this.pausedMs += performance.now() - this.pauseStartedMs;
        for (const stream of this.streams)
            for (const track of stream.getAudioTracks()) track.enabled = true;
        this.paused = false;
    }

    async stop(): Promise<{ files: [File, File]; pauseCount: number; pausedDurationUs: string }> {
        if (this.finished) throw new Error("This capture has already stopped.");
        this.finished = true;
        if (this.paused) this.pausedMs += performance.now() - this.pauseStartedMs;
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
        const files: [File, File] = [
            new File([header, ...this.buffers[0]!], "Microphone.wav", { type: "audio/wav" }),
            new File([header, ...this.buffers[1]!], "Shared audio.wav", { type: "audio/wav" }),
        ];
        return {
            files,
            pauseCount: this.pauseCount,
            pausedDurationUs: String(Math.round(this.pausedMs * 1000)),
        };
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

export interface SynchronizedCaptureTrackIdentity {
    source: MicrophoneArchiveSource;
    trackId: string;
    sampleRateHz: number;
    sampleFormat?: CaptureSampleFormat;
    channelCount?: number;
    label?: string;
    sourceDeviceId?: string;
    sourceBackend?: string;
    applicationName?: string;
    applicationProcessId?: number;
    applicationBundleId?: string;
}

function defaultCaptureTrackLabel(source: MicrophoneArchiveSource): string {
    switch (source) {
        case "microphone":
            return "Microphone recording";
        case "system-audio":
            return "Shared system audio";
        case "application-audio":
            return "Application audio";
    }
}

/** Create the take and every source track before native capture begins accepting samples. */
export function makeSynchronizedCaptureStartRecords(options: {
    session: ArchiveRecord;
    takeId: string;
    tracks: readonly SynchronizedCaptureTrackIdentity[];
    knownTrackIds: readonly string[];
    startedAtUs: string;
    consentAtUs: string;
    durability?: CaptureDurability;
    captureSourceBackend: string;
    consentConfirmedBy: string;
}): ArchiveRecord[] {
    if (
        options.session.type !== RecordType.session ||
        options.session.fields.get("_deleted") === "true"
    ) {
        throw new Error("Choose an active tutoring session before recording audio.");
    }
    if (options.tracks.length === 0)
        throw new Error("No native audio source is available to record.");
    assertTimestamp(options.startedAtUs, "recording start");
    assertTimestamp(options.consentAtUs, "recording consent");
    assertUuid(options.takeId, "take");
    const ids = new Set<string>();
    for (const track of options.tracks) {
        assertUuid(track.trackId, "track");
        if (ids.has(track.trackId.toLowerCase()))
            throw new Error("Native audio track IDs must be unique.");
        ids.add(track.trackId.toLowerCase());
        if (
            !Number.isSafeInteger(track.sampleRateHz) ||
            track.sampleRateHz < 8_000 ||
            track.sampleRateHz > 384_000
        ) {
            throw new Error("A native audio source returned an unsupported sample rate.");
        }
    }
    assertCaptureSession(options.session, options.tracks[0]!.sampleRateHz);

    const timestamp = options.startedAtUs;
    const durability = options.durability ?? "default";
    const takeId = options.takeId.toLowerCase();
    const takeTrackIds = options.tracks.map((track) => track.trackId.toLowerCase());
    const linkedTrackIds = mergedTrackIds(options.session, [
        ...options.knownTrackIds,
        ...takeTrackIds,
    ]);
    const source = options.tracks.map((track) => track.source).join("+");
    const tracks = options.tracks.map((identity) => {
        const trackId = identity.trackId.toLowerCase();
        const trackFields = new Map([
            ["record_role", "audio-track"],
            ["session_id", options.session.id.toLowerCase()],
            ["track_id", trackId],
            ["recording_take_id", takeId],
            ["label", identity.label ?? defaultCaptureTrackLabel(identity.source)],
            ["source", identity.source],
            ["capture_source_backend", identity.sourceBackend ?? options.captureSourceBackend],
            ["capture_consent_at_us", options.consentAtUs],
            ["capture_consent_policy", "1"],
            ["consent_confirmed_by", options.consentConfirmedBy],
            ["state", "recording"],
            ["sample_format", identity.sampleFormat ?? "pcm_s16le"],
            ["sample_rate_hz", String(identity.sampleRateHz)],
            ["channel_count", String(identity.channelCount ?? 1)],
            ["channel_mask", "0"],
            ["sample_count", "0"],
            ["timeline_sample_count", "0"],
            ["duration_us", "0"],
            ["chunk_count", "0"],
            ["byte_count", "0"],
            ["capture_pause_count", "0"],
            ["capture_paused_duration_us", "0"],
            ["durability", durability],
            ["started_at_us", timestamp],
            ["updated_at_us", timestamp],
        ]);
        if (identity.sourceDeviceId) {
            trackFields.set("source_device_id", identity.sourceDeviceId);
        }
        if (identity.applicationName) {
            trackFields.set("application_name", identity.applicationName);
        }
        if (identity.applicationProcessId !== undefined) {
            trackFields.set("application_process_id", String(identity.applicationProcessId));
        }
        if (identity.applicationBundleId) {
            trackFields.set("application_bundle_id", identity.applicationBundleId);
        }
        return makeRecord(RecordType.assetMetadata, trackId, trackFields);
    });
    const take = makeRecord(
        RecordType.assetMetadata,
        takeId,
        new Map([
            ["record_role", "recording-take"],
            ["session_id", options.session.id.toLowerCase()],
            ["label", options.tracks.length === 2 ? "Synchronized recording" : "Audio recording"],
            ["source", source],
            ["capture_source_backend", options.captureSourceBackend],
            ["capture_consent_at_us", options.consentAtUs],
            ["capture_consent_policy", "1"],
            ["consent_confirmed_by", options.consentConfirmedBy],
            ["state", "recording"],
            ["track_ids", takeTrackIds.join(",")],
            ["started_at_us", timestamp],
            ["ended_at_us", ""],
            ["duration_us", "0"],
            ["capture_pause_count", "0"],
            ["capture_paused_duration_us", "0"],
            ["durability", durability],
            ["created_at_us", timestamp],
            ["updated_at_us", timestamp],
        ]),
    );
    const primary = options.tracks[0]!;
    const fields = new Map(options.session.fields);
    fields.set("recording_track_ids", linkedTrackIds.join(","));
    fields.set("recording_track_count", String(linkedTrackIds.length));
    if (!fields.get("recording_track_id"))
        fields.set("recording_track_id", primary.trackId.toLowerCase());
    fields.set("recording_source", source);
    fields.set("recording_source_backend", options.captureSourceBackend);
    fields.set("recording_sample_format", primary.sampleFormat ?? "pcm_s16le");
    fields.set("recording_sample_rate_hz", String(primary.sampleRateHz));
    fields.set("recording_channel_count", String(primary.channelCount ?? 1));
    fields.set("recording_channel_mask", "0");
    fields.set("recording_started_at_us", timestamp);
    fields.set("recording_consent_at_us", options.consentAtUs);
    fields.set("recording_consent_policy", "1");
    fields.set("recording_consent_confirmed_by", options.consentConfirmedBy);
    fields.set("recording_durability", durability);
    fields.set(
        "recording_track_mode",
        options.tracks.length === 2 ? "synchronized-separate" : "single-source",
    );
    if (!fields.has("recording_audio_chunks")) fields.set("recording_audio_chunks", "0");
    if (!fields.has("recording_samples")) fields.set("recording_samples", "0");
    if (!fields.has("recording_timeline_samples")) fields.set("recording_timeline_samples", "0");
    if (!fields.has("recording_bytes")) fields.set("recording_bytes", "0");
    if (!fields.has("recording_duration_us")) fields.set("recording_duration_us", "0");
    fields.set("recording_state", "recording");
    fields.set("recording_error", "");
    fields.set("updated_at_us", timestamp);
    return [...tracks, take, { ...options.session, fields }];
}

/** Append a checksummed, aligned PCM batch to one synchronized source track. */
export function makeSynchronizedCaptureChunkRecords(options: {
    session: ArchiveRecord;
    track: ArchiveRecord;
    chunk: {
        sequence: number;
        firstSampleIndex: string;
        samples: Uint8Array<ArrayBuffer>;
        sampleFormat?: CaptureSampleFormat;
        channelCount?: number;
        gapBeforeSamples?: string;
        containsDeviceDiscontinuity?: boolean;
    };
    source: MicrophoneArchiveSource;
}): ArchiveRecord[] {
    const sampleRateHz = Number(options.track.fields.get("sample_rate_hz"));
    return makeMicrophoneCaptureChunkRecords({ ...options, sampleRateHz });
}

/** Persist pause/resume state on every track in the synchronized take. */
export function makeSynchronizedCaptureStateRecords(
    session: ArchiveRecord,
    tracks: readonly ArchiveRecord[],
    take: ArchiveRecord,
    state: "recording" | "paused",
    pause?: { pauseCount: number; pausedDurationUs: string },
): ArchiveRecord[] {
    const timestamp = nowUs();
    const sessionFields = new Map(session.fields);
    sessionFields.set("recording_state", state);
    sessionFields.set("updated_at_us", timestamp);
    const updatedTracks = tracks.map((track) => {
        const fields = new Map(track.fields);
        fields.set("state", state);
        if (pause) {
            fields.set("capture_pause_count", String(pause.pauseCount));
            fields.set("capture_paused_duration_us", pause.pausedDurationUs);
        }
        fields.set("updated_at_us", timestamp);
        return { ...track, fields };
    });
    const takeFields = new Map(take.fields);
    takeFields.set("state", state);
    if (pause) {
        takeFields.set("capture_pause_count", String(pause.pauseCount));
        takeFields.set("capture_paused_duration_us", pause.pausedDurationUs);
    }
    takeFields.set("updated_at_us", timestamp);
    return [
        ...updatedTracks,
        { ...take, fields: takeFields },
        { ...session, fields: sessionFields },
    ];
}

/** Finalize available tracks while retaining source-level failure reasons for recovery. */
export function makeSynchronizedCaptureFinishRecords(options: {
    session: ArchiveRecord;
    tracks: readonly ArchiveRecord[];
    take: ArchiveRecord;
    pauseCount: number;
    pausedDurationUs: string;
    failures: Partial<Record<MicrophoneArchiveSource, string>>;
}): ArchiveRecord[] {
    const timestamp = nowUs();
    const errors = Object.entries(options.failures)
        .filter((entry): entry is [MicrophoneArchiveSource, string] => Boolean(entry[1]))
        .map(([source, message]) => `${source}: ${message}`);
    const updatedTracks = options.tracks.map((track) => {
        const source = track.fields.get("source") as MicrophoneArchiveSource;
        const failure = options.failures[source] ?? "";
        const fields = new Map(track.fields);
        fields.set("state", failure ? "interrupted" : "completed");
        fields.set("capture_pause_count", String(options.pauseCount));
        fields.set("capture_paused_duration_us", options.pausedDurationUs);
        fields.set("ended_at_us", timestamp);
        fields.set("recovery_error", failure);
        fields.set("updated_at_us", timestamp);
        return { ...track, fields };
    });
    const duration = updatedTracks.reduce((longest, track) => {
        const value = parseArchiveCounter(track.fields.get("duration_us")) ?? 0n;
        return value > longest ? value : longest;
    }, 0n);
    const partial = errors.length > 0;
    const takeFields = new Map(options.take.fields);
    takeFields.set("state", partial ? "partial" : "completed");
    takeFields.set("capture_pause_count", String(options.pauseCount));
    takeFields.set("capture_paused_duration_us", options.pausedDurationUs);
    takeFields.set("ended_at_us", timestamp);
    takeFields.set("duration_us", duration.toString());
    takeFields.set("recovery_error", errors.join("\n"));
    takeFields.set("updated_at_us", timestamp);
    const sessionFields = new Map(options.session.fields);
    sessionFields.set("recording_state", partial ? "partial" : "completed");
    sessionFields.set("recording_ended_at_us", timestamp);
    sessionFields.set("recording_error", errors.join("\n"));
    sessionFields.set("recording_capture_pause_count", String(options.pauseCount));
    sessionFields.set("recording_capture_paused_duration_us", options.pausedDurationUs);
    const previousDuration =
        parseArchiveCounter(options.session.fields.get("recording_duration_us")) ?? 0n;
    sessionFields.set(
        "recording_duration_us",
        (previousDuration > duration ? previousDuration : duration).toString(),
    );
    sessionFields.set("updated_at_us", timestamp);
    return [
        ...updatedTracks,
        { ...options.take, fields: takeFields },
        { ...options.session, fields: sessionFields },
    ];
}

/** Build one legacy-shaped take from whichever synchronized sources produced audio. */
export async function makeSynchronizedRecordingRecords(options: {
    session: ArchiveRecord;
    files: [File | null, File | null];
    knownTrackIds: readonly string[];
    startedAtUs: string;
    consentAtUs: string;
    pauseCount: number;
    pausedDurationUs: string;
    captureSourceBackend?: string;
    consentConfirmedBy?: string;
    warnings?: readonly string[];
}): Promise<ArchiveRecord[]> {
    const sources = [
        { kind: "microphone" as const, file: options.files[0] },
        { kind: "system-audio" as const, file: options.files[1] },
    ].filter((source) => source.file !== null);
    if (sources.length === 0) throw new Error("Neither audio source provided a recording.");

    let session = options.session;
    const imports: Array<{
        kind: "microphone" | "system-audio";
        trackId: string;
        takeId: string;
        sampleCount: bigint;
        sampleRateHz: number;
        durationUs: bigint;
        records: ArchiveRecord[];
    }> = [];
    let knownTrackIds = [...options.knownTrackIds];
    for (const source of sources) {
        const imported = await makeMicrophoneRecordingRecords({
            session,
            file: source.file!,
            knownTrackIds,
            startedAtUs: options.startedAtUs,
            consentAtUs: options.consentAtUs,
            pauseCount: options.pauseCount,
            pausedDurationUs: options.pausedDurationUs,
            source: source.kind,
            ...(options.captureSourceBackend === undefined
                ? {}
                : { captureSourceBackend: options.captureSourceBackend }),
            ...(options.consentConfirmedBy === undefined
                ? {}
                : { consentConfirmedBy: options.consentConfirmedBy }),
        });
        session = imported.records.find((record) => record.type === RecordType.session)!;
        imports.push({
            kind: source.kind,
            trackId: imported.trackId,
            takeId: imported.takeId,
            sampleCount: imported.sampleCount,
            sampleRateHz: imported.sampleRateHz,
            durationUs: imported.durationUs,
            records: imported.records.filter((record) => record.type !== RecordType.session),
        });
        knownTrackIds = [...knownTrackIds, imported.trackId];
    }

    const takeId = imports[0]!.takeId;
    const takeTrackIds = imports.map((item) => item.trackId);
    const trackIds = mergedTrackIds(options.session, [...options.knownTrackIds, ...takeTrackIds]);
    const partial = Boolean(options.warnings?.length);
    const importedDuration = imports.reduce(
        (longest, item) => (item.durationUs > longest ? item.durationUs : longest),
        0n,
    );
    const tracksAndTake = imports.flatMap((item) =>
        item.records.filter((record) => record.id !== item.takeId || item.takeId === takeId),
    );
    const normalized = tracksAndTake.map((record) => {
        if (record.type !== RecordType.assetMetadata) return record;
        const fields = new Map(record.fields);
        const source = imports.find((item) => item.trackId === record.id);
        if (source) {
            fields.set("source", source.kind);
            fields.set("capture_source_backend", options.captureSourceBackend ?? "web-audio");
            if (source.kind === "system-audio") fields.set("label", "Shared system audio");
            fields.set("state", partial ? "partial" : "completed");
            fields.set("recording_take_id", takeId);
        } else if (record.id === takeId) {
            fields.set("track_ids", takeTrackIds.join(","));
            fields.set(
                "source",
                imports.length === 2 ? "microphone+system-audio" : imports[0]!.kind,
            );
            fields.set(
                "label",
                imports.length === 2 ? "Synchronized recording" : "Audio recording",
            );
            fields.set("state", partial ? "partial" : "completed");
            fields.set("duration_us", importedDuration.toString());
        }
        return { ...record, fields };
    });

    const sessionFields = new Map(session.fields);
    sessionFields.set("recording_track_ids", trackIds.join(","));
    sessionFields.set("recording_track_count", String(trackIds.length));
    if (!sessionFields.get("recording_track_id")) {
        sessionFields.set("recording_track_id", takeTrackIds[0]!);
    }
    sessionFields.set(
        "recording_source",
        imports.length === 2 ? "microphone+system-audio" : imports[0]!.kind,
    );
    sessionFields.set("recording_source_backend", options.captureSourceBackend ?? "web-audio");
    sessionFields.set("recording_started_at_us", options.startedAtUs);
    sessionFields.set("recording_state", partial ? "partial" : "completed");
    sessionFields.set("recording_error", options.warnings?.join("\n") ?? "");
    sessionFields.set("recording_ended_at_us", (BigInt(Date.now()) * 1000n).toString());
    sessionFields.set("recording_consent_at_us", options.consentAtUs);
    sessionFields.set("recording_consent_policy", "1");
    sessionFields.set("recording_consent_confirmed_by", options.consentConfirmedBy ?? "");
    const importedSamples = imports.reduce((sum, item) => sum + item.sampleCount, 0n);
    const previousSamples = parseCounter(options.session.fields.get("recording_samples")) ?? 0n;
    sessionFields.set("recording_samples", (previousSamples + importedSamples).toString());
    const previousDuration =
        parseCounter(options.session.fields.get("recording_duration_us")) ?? 0n;
    const recordingDuration =
        previousDuration > importedDuration ? previousDuration : importedDuration;
    sessionFields.set("recording_duration_us", recordingDuration.toString());
    const timelineSampleRate =
        parseCounter(options.session.fields.get("recording_sample_rate_hz")) ??
        BigInt(imports[0]!.sampleRateHz);
    if (timelineSampleRate > 0n) {
        const previousTimeline =
            parseCounter(options.session.fields.get("recording_timeline_samples")) ?? 0n;
        const durationTimeline = (recordingDuration * timelineSampleRate) / 1_000_000n;
        sessionFields.set(
            "recording_timeline_samples",
            (previousTimeline > durationTimeline ? previousTimeline : durationTimeline).toString(),
        );
    }
    if (imports.length === 2) sessionFields.set("recording_track_mode", "synchronized-separate");
    else sessionFields.delete("recording_track_mode");
    return [...normalized, { ...session, fields: sessionFields }];
}

function mergedTrackIds(session: ArchiveRecord, knownTrackIds: readonly string[]): string[] {
    const ids = new Set<string>();
    for (const value of [
        session.fields.get("recording_track_ids"),
        session.fields.get("recording_track_id"),
        session.fields.get("audio_import_track_id"),
    ]) {
        for (const id of (value ?? "").split(",")) {
            const normalized = id.trim().toLowerCase();
            if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized)) {
                ids.add(normalized);
            }
        }
    }
    for (const value of knownTrackIds) {
        const normalized = value.trim().toLowerCase();
        if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(normalized)) {
            ids.add(normalized);
        }
    }
    return [...ids];
}

function parseCounter(value: string | undefined): bigint | undefined {
    if (value === undefined || !/^\d+$/u.test(value)) return undefined;
    try {
        const parsed = BigInt(value);
        return parsed <= U64_MAX ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function assertCaptureSession(session: ArchiveRecord, sampleRateHz: number): void {
    if (session.type !== RecordType.session || session.fields.get("_deleted") === "true") {
        throw new Error("Choose an active tutoring session before recording audio.");
    }
    if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 384_000) {
        throw new Error("A native audio source returned an unsupported sample rate.");
    }
    if (
        ["initializing", "recording", "paused", "finalizing"].includes(
            session.fields.get("recording_state") ?? "",
        )
    ) {
        throw new Error("Stop or recover the active recording before starting another take.");
    }
}

function assertTimestamp(value: string, label: string): void {
    if (!/^\d+$/u.test(value) || BigInt(value) > U64_MAX) {
        throw new Error(`The synchronized recording ${label} timestamp is invalid.`);
    }
}

function assertUuid(value: string, label: string): void {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value)) {
        throw new Error(`The synchronized recording ${label} ID is invalid.`);
    }
}

function makeRecord(
    type: number,
    id: string,
    fields: ReadonlyMap<string, string>,
    blob = new Uint8Array(),
): ArchiveRecord {
    return { type, id: id.toLowerCase(), revision: 0n, previousOffset: 0n, fields, blob };
}

function parseArchiveCounter(value: string | undefined): bigint | undefined {
    if (value === undefined || !/^\d+$/u.test(value)) return undefined;
    try {
        const parsed = BigInt(value);
        return parsed <= U64_MAX ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function nowUs(): string {
    return (BigInt(Date.now()) * 1_000n).toString();
}
