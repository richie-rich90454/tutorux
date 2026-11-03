import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES,
    MicrophoneRecording,
    makeMicrophoneCaptureChunkRecords,
    makeMicrophoneCaptureFinishRecords,
    makeMicrophoneCaptureStartRecords,
    makeMicrophoneCaptureStateRecords,
    makeMicrophoneRecordingRecords,
} from "../../../frontend/domain/microphone-recording";

const SAMPLE_RATE = 16_000;
const TIMESTAMP = "1700000000000000";
const U64_MAX = 18_446_744_073_709_551_615n;

class FakeNode {
    readonly connections: { target: unknown; output: number; input: number }[] = [];
    disconnected = false;

    connect(target: unknown, output = 0, input = 0): void {
        this.connections.push({ target, output, input });
    }

    disconnect(): void {
        this.disconnected = true;
    }
}

class FakeProcessor extends FakeNode {
    onaudioprocess: ((event: unknown) => void) | null = null;
}

class FakeGain extends FakeNode {
    readonly gain = { value: 1 };
}

class FakeTrack {
    enabled = true;
    stopCount = 0;
    private readonly listeners: (() => void)[] = [];

    constructor(readonly kind: "audio" | "video") {}

    addEventListener(_type: string, listener: () => void): void {
        this.listeners.push(listener);
    }

    stop(): void {
        this.stopCount++;
    }

    ended(): void {
        for (const listener of this.listeners) listener();
    }
}

class FakeStream {
    constructor(
        readonly audioTracks: FakeTrack[],
        readonly videoTracks: FakeTrack[] = [],
    ) {}

    getAudioTracks(): FakeTrack[] {
        return this.audioTracks;
    }

    getVideoTracks(): FakeTrack[] {
        return this.videoTracks;
    }

    getTracks(): FakeTrack[] {
        return [...this.audioTracks, ...this.videoTracks];
    }
}

class FakeAudioContext {
    static readonly instances: FakeAudioContext[] = [];

    sampleRate = 48_000;
    resumeImpl: () => Promise<void> = async () => undefined;
    suspendImpl: () => Promise<void> = async () => undefined;
    closeImpl: () => Promise<void> = async () => undefined;
    readonly destination = new FakeNode();
    readonly sources: FakeNode[] = [];
    readonly processors: FakeProcessor[] = [];
    readonly gains: FakeGain[] = [];
    readonly mergers: FakeNode[] = [];

    constructor() {
        FakeAudioContext.instances.push(this);
    }

    resume(): Promise<void> {
        return this.resumeImpl();
    }

    suspend(): Promise<void> {
        return this.suspendImpl();
    }

    close(): Promise<void> {
        return this.closeImpl();
    }

    createMediaStreamSource(): FakeNode {
        const node = new FakeNode();
        this.sources.push(node);
        return node;
    }

    createChannelMerger(): FakeNode {
        const node = new FakeNode();
        this.mergers.push(node);
        return node;
    }

    createScriptProcessor(): FakeProcessor {
        const processor = new FakeProcessor();
        this.processors.push(processor);
        return processor;
    }

    createGain(): FakeGain {
        const gain = new FakeGain();
        this.gains.push(gain);
        return gain;
    }
}

interface FakeMediaDevices {
    getUserMedia: (constraints: unknown) => Promise<FakeStream>;
    getDisplayMedia?: (constraints: unknown) => Promise<FakeStream>;
}

const realNavigator = globalThis.navigator;
const realAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

function installBrowser(mediaDevices: Partial<FakeMediaDevices>): void {
    Object.defineProperty(globalThis, "navigator", {
        value: { mediaDevices },
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, "AudioContext", {
        value: FakeAudioContext,
        configurable: true,
        writable: true,
    });
}

function restoreBrowser(): void {
    Object.defineProperty(globalThis, "navigator", {
        value: realNavigator,
        configurable: true,
        writable: true,
    });
    if (realAudioContext === undefined) {
        delete (globalThis as { AudioContext?: unknown }).AudioContext;
    } else {
        Object.defineProperty(globalThis, "AudioContext", {
            value: realAudioContext,
            configurable: true,
            writable: true,
        });
    }
}

function makeSession(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.session,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["recording_state", "completed"], ...Object.entries(fields)]),
        blob: new Uint8Array(),
    };
}

function startFixture(
    options: {
        source?: "microphone" | "system-audio" | "application-audio";
        sampleRateHz?: number;
        session?: ArchiveRecord;
        identity?: Partial<Parameters<typeof makeMicrophoneCaptureStartRecords>[1]>;
        knownTrackIds?: readonly string[];
    } = {},
): {
    session: ArchiveRecord;
    track: ArchiveRecord;
    take: ArchiveRecord;
    trackId: string;
} {
    const session = options.session ?? makeSession();
    const trackId = crypto.randomUUID();
    const records = makeMicrophoneCaptureStartRecords(
        session,
        {
            trackId,
            takeId: crypto.randomUUID(),
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            sampleRateHz: options.sampleRateHz ?? SAMPLE_RATE,
            ...options.identity,
        },
        options.knownTrackIds ?? [],
    );
    return {
        session: records.at(-1)!,
        track: records.find((record) => record.id === trackId)!,
        take: records.find((record) => record.fields.get("record_role") === "recording-take")!,
        trackId,
    };
}

function audioProcessEvent(
    channel0: Float32Array | { length: number } = new Float32Array([0.5, -0.5]),
    channel1?: Float32Array | { length: number },
): unknown {
    return {
        inputBuffer: {
            length: channel0.length,
            getChannelData: (channel: number) =>
                channel === 0 ? channel0 : (channel1 ?? channel0),
        },
    };
}

function drive(processor: FakeProcessor | undefined, event: unknown): void {
    (processor!.onaudioprocess as ((value: unknown) => void) | null)!(event);
}

beforeEach(() => {
    FakeAudioContext.instances.length = 0;
});

afterEach(() => {
    restoreBrowser();
    vi.restoreAllMocks();
});

describe("microphone capture start records", () => {
    it("persists identity defaults and links known tracks", () => {
        const knownTrackId = crypto.randomUUID();
        const session = makeSession({
            recording_track_id: knownTrackId,
            recording_track_ids: `${knownTrackId},  ${knownTrackId.toUpperCase()}  ,not-a-uuid`,
            audio_import_track_id: knownTrackId,
            recording_audio_chunks: "7",
            recording_samples: "8",
            recording_timeline_samples: "9",
            recording_bytes: "10",
        });
        const trackId = crypto.randomUUID();

        const records = makeMicrophoneCaptureStartRecords(
            session,
            {
                trackId,
                takeId: crypto.randomUUID(),
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                sampleRateHz: SAMPLE_RATE,
            },
            [],
        );

        const track = records.find((record) => record.id === trackId)!;
        expect(track.fields.get("capture_source_backend")).toBe("web-audio");
        expect(track.fields.get("consent_confirmed_by")).toBe("");
        const updated = records.at(-1)!;
        expect(updated.fields.get("recording_track_id")).toBe(knownTrackId);
        expect(updated.fields.get("recording_track_ids")).toBe(`${knownTrackId},${trackId}`);
        expect(updated.fields.get("recording_audio_chunks")).toBe("7");
        expect(updated.fields.get("recording_samples")).toBe("8");
        expect(updated.fields.get("recording_timeline_samples")).toBe("9");
        expect(updated.fields.get("recording_bytes")).toBe("10");
    });

    it("applies explicit backend, consent, and known track identifiers", () => {
        const knownTrackId = crypto.randomUUID();
        const records = makeMicrophoneCaptureStartRecords(
            makeSession(),
            {
                trackId: crypto.randomUUID(),
                takeId: crypto.randomUUID(),
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                sampleRateHz: SAMPLE_RATE,
                captureSourceBackend: "native",
                consentConfirmedBy: "Tutor",
            },
            [knownTrackId],
        );
        const updated = records.at(-1)!;
        expect(updated.fields.get("recording_source_backend")).toBe("native");
        expect(updated.fields.get("recording_consent_confirmed_by")).toBe("Tutor");
        expect(updated.fields.get("recording_track_ids")).toContain(knownTrackId);
    });

    it("rejects an inactive session", () => {
        expect(() =>
            makeMicrophoneCaptureStartRecords(
                { ...makeSession(), type: RecordType.student },
                {
                    trackId: crypto.randomUUID(),
                    takeId: crypto.randomUUID(),
                    startedAtUs: TIMESTAMP,
                    consentAtUs: TIMESTAMP,
                    sampleRateHz: SAMPLE_RATE,
                },
                [],
            ),
        ).toThrow(/active tutoring session/u);
    });

    it.each([4_000, 400_000, 16_000.5])("rejects unsupported sample rate %s", (rate) => {
        expect(() =>
            makeMicrophoneCaptureStartRecords(
                makeSession(),
                {
                    trackId: crypto.randomUUID(),
                    takeId: crypto.randomUUID(),
                    startedAtUs: TIMESTAMP,
                    consentAtUs: TIMESTAMP,
                    sampleRateHz: rate,
                },
                [],
            ),
        ).toThrow(/unsupported sample rate/u);
    });

    it("rejects malformed identifiers", () => {
        expect(() =>
            makeMicrophoneCaptureStartRecords(
                makeSession(),
                {
                    trackId: "bad",
                    takeId: crypto.randomUUID(),
                    startedAtUs: TIMESTAMP,
                    consentAtUs: TIMESTAMP,
                    sampleRateHz: SAMPLE_RATE,
                },
                [],
            ),
        ).toThrow(/microphone track ID is invalid/u);
        expect(() =>
            makeMicrophoneCaptureStartRecords(
                makeSession(),
                {
                    trackId: crypto.randomUUID(),
                    takeId: "bad",
                    startedAtUs: TIMESTAMP,
                    consentAtUs: TIMESTAMP,
                    sampleRateHz: SAMPLE_RATE,
                },
                [],
            ),
        ).toThrow(/microphone take ID is invalid/u);
    });

    it("rejects a session that is already recording", () => {
        expect(() => startFixture({ session: makeSession({ recording_state: "paused" }) })).toThrow(
            /active recording before starting another take/u,
        );
    });

    it("accepts a session with no recording state and ignores invalid known IDs", () => {
        const session: ArchiveRecord = {
            type: RecordType.session,
            id: crypto.randomUUID(),
            revision: 0n,
            previousOffset: 0n,
            fields: new Map(),
            blob: new Uint8Array(),
        };
        const records = makeMicrophoneCaptureStartRecords(
            session,
            {
                trackId: crypto.randomUUID(),
                takeId: crypto.randomUUID(),
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                sampleRateHz: SAMPLE_RATE,
            },
            ["not-a-uuid"],
        );
        expect(records.at(-1)!.fields.get("recording_track_ids")).not.toContain("not-a-uuid");
    });
});

describe("microphone capture chunk records", () => {
    function chunkFixture(): ReturnType<typeof startFixture> {
        return startFixture();
    }

    it("appends a checksummed chunk for every supported format", () => {
        const formats = [
            { format: "pcm_u8" as const, bytes: 4, channels: 2 },
            { format: "pcm_s16le" as const, bytes: 8, channels: 2 },
            { format: "pcm_s24le" as const, bytes: 12, channels: 2 },
            { format: "pcm_s32le" as const, bytes: 8, channels: 1 },
            { format: "pcm_f32le" as const, bytes: 4, channels: 1 },
        ];
        for (const { format, bytes, channels } of formats) {
            const fixture = chunkFixture();
            const records = makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([
                        ...fixture.track.fields,
                        ["sample_format", format],
                        ["channel_count", String(channels)],
                    ]),
                },
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(bytes),
                    sampleFormat: format,
                    channelCount: channels,
                },
                sampleRateHz: SAMPLE_RATE,
            });
            expect(records[0]!.fields.get("sample_format")).toBe(format);
        }
    });

    it("defaults source, format, channel count, gap, and discontinuity", () => {
        const fixture = chunkFixture();
        const records = makeMicrophoneCaptureChunkRecords({
            session: fixture.session,
            track: fixture.track,
            chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
            sampleRateHz: SAMPLE_RATE,
        });
        const chunk = records[0]!;
        expect(chunk.fields.get("source")).toBe("microphone");
        expect(chunk.fields.get("sample_format")).toBe("pcm_s16le");
        expect(chunk.fields.get("channel_count")).toBe("1");
        expect(chunk.fields.get("gap_before_samples")).toBe("0");
        expect(chunk.fields.get("contains_device_discontinuity")).toBe("false");
        expect(chunk.fields.get("channel_mask")).toBe("0");
    });

    it("rejects a track that no longer matches the capture", () => {
        const fixture = chunkFixture();
        const cases = [
            { ...fixture.track, type: RecordType.student },
            {
                ...fixture.track,
                fields: new Map([...fixture.track.fields, ["record_role", "other"]]),
            },
            {
                ...fixture.track,
                fields: new Map([...fixture.track.fields, ["session_id", crypto.randomUUID()]]),
            },
            {
                ...fixture.track,
                fields: new Map([...fixture.track.fields, ["source", "system-audio"]]),
            },
            {
                ...fixture.track,
                fields: new Map([...fixture.track.fields, ["sample_rate_hz", "8000"]]),
            },
            {
                ...fixture.track,
                fields: new Map([...fixture.track.fields, ["state", "paused"]]),
            },
        ];
        for (const track of cases) {
            expect(() =>
                makeMicrophoneCaptureChunkRecords({
                    session: fixture.session,
                    track,
                    chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
                    sampleRateHz: SAMPLE_RATE,
                }),
            ).toThrow(/no longer active/u);
        }
    });

    it("rejects a format change mid-recording", () => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: fixture.track,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(4),
                    sampleFormat: "pcm_s24le",
                },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/changed format/u);
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: fixture.track,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(4),
                    channelCount: 2,
                },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/changed format/u);
    });

    it.each([
        ["negative sequence", { sequence: -1 }],
        ["fractional sequence", { sequence: 0.5 }],
        ["empty samples", { samples: new Uint8Array(0) }],
        ["oversized samples", { samples: new Uint8Array(MAX_MICROPHONE_ARCHIVE_CHUNK_BYTES + 2) }],
        ["unaligned samples", { samples: new Uint8Array(3) }],
    ])("rejects %s", (_label, override) => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: fixture.track,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(4),
                    ...override,
                },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/aligned PCM below 1 MiB/u);
    });

    it("rejects unsupported channel counts", () => {
        const fixture = chunkFixture();
        for (const channelCount of [0, 9, 1.5]) {
            expect(() =>
                makeMicrophoneCaptureChunkRecords({
                    session: fixture.session,
                    track: {
                        ...fixture.track,
                        fields: new Map([
                            ...fixture.track.fields,
                            ["channel_count", String(channelCount)],
                        ]),
                    },
                    chunk: {
                        sequence: 0,
                        firstSampleIndex: "0",
                        samples: new Uint8Array(4),
                        channelCount,
                    },
                    sampleRateHz: SAMPLE_RATE,
                }),
            ).toThrow(/aligned PCM below 1 MiB/u);
        }
    });

    it.each([
        ["out-of-sequence", { sequence: 1 }],
        ["negative first index", { firstSampleIndex: "-1" }],
        ["negative gap", { gapBeforeSamples: "-1" }],
        ["index ahead of timeline", { firstSampleIndex: "9", gapBeforeSamples: "0" }],
    ])("rejects %s metadata", (_label, override) => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: fixture.track,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "4",
                    samples: new Uint8Array(4),
                    ...override,
                },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/committed once in sequence/u);
    });

    it("rejects an index behind the recorded timeline", () => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([...fixture.track.fields, ["timeline_sample_count", "8"]]),
                },
                chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/committed once in sequence/u);
    });

    it("falls back to defaults when optional track fields are missing", () => {
        const fixture = chunkFixture();
        const fields = new Map(fixture.track.fields);
        for (const key of [
            "sample_format",
            "channel_count",
            "started_at_us",
            "channel_mask",
            "duration_us",
        ]) {
            fields.delete(key);
        }
        const track = { ...fixture.track, fields };
        const records = makeMicrophoneCaptureChunkRecords({
            session: fixture.session,
            track,
            chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
            sampleRateHz: SAMPLE_RATE,
        });
        expect(records[0]!.fields.get("sample_format")).toBe("pcm_s16le");
        expect(records[0]!.fields.get("channel_count")).toBe("1");
        expect(records[0]!.fields.get("channel_mask")).toBe("0");
        expect(records.at(-1)!.fields.get("recording_started_at_us")).toBe("");

        const finished = makeMicrophoneCaptureFinishRecords({
            session: fixture.session,
            track,
            take: fixture.take,
            pauseCount: 0,
            pausedDurationUs: "0",
        });
        expect(finished[1]!.fields.get("duration_us")).toBe("0");
    });

    it("rejects a recovery track whose counters exceed 64 bits", () => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([
                        ...fixture.track.fields,
                        ["chunk_count", "18446744073709551616"],
                    ]),
                },
                chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/committed once in sequence/u);
    });

    it("rejects a recovery track with corrupt counters", () => {
        const fixture = chunkFixture();
        expect(() =>
            makeMicrophoneCaptureChunkRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([...fixture.track.fields, ["chunk_count", "invalid"]]),
                },
                chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
                sampleRateHz: SAMPLE_RATE,
            }),
        ).toThrow(/committed once in sequence/u);
    });

    it("falls back to zero session counters", () => {
        const fixture = startFixture();
        const session = {
            ...fixture.session,
            fields: new Map([
                ...fixture.session.fields,
                ["recording_audio_chunks", "nope"],
                ["recording_samples", "nope"],
                ["recording_timeline_samples", "nope"],
                ["recording_duration_us", "nope"],
                ["recording_bytes", "nope"],
                ["recording_sample_rate_hz", "nope"],
            ]),
        };
        const records = makeMicrophoneCaptureChunkRecords({
            session,
            track: fixture.track,
            chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
            sampleRateHz: SAMPLE_RATE,
        });
        const updated = records.at(-1)!;
        expect(updated.fields.get("recording_audio_chunks")).toBe("1");
        expect(updated.fields.get("recording_samples")).toBe("2");
        expect(updated.fields.get("recording_bytes")).toBe("4");
        expect(updated.fields.get("recording_timeline_samples")).toBe("2");
        expect(updated.fields.get("recording_duration_us")).toBe("125");
    });

    it("keeps larger prior session counters", () => {
        const fixture = startFixture();
        const session = {
            ...fixture.session,
            fields: new Map([
                ...fixture.session.fields,
                ["recording_timeline_samples", "100"],
                ["recording_duration_us", "999999"],
            ]),
        };
        const records = makeMicrophoneCaptureChunkRecords({
            session,
            track: fixture.track,
            chunk: { sequence: 0, firstSampleIndex: "0", samples: new Uint8Array(4) },
            sampleRateHz: SAMPLE_RATE,
        });
        const updated = records.at(-1)!;
        expect(updated.fields.get("recording_timeline_samples")).toBe("100");
        expect(updated.fields.get("recording_duration_us")).toBe("999999");
    });
});

describe("microphone capture finish records", () => {
    it("marks a completed take and accumulates pause counters", () => {
        const fixture = startFixture({
            identity: { consentConfirmedBy: "Tutor" },
        });
        const records = makeMicrophoneCaptureFinishRecords({
            session: fixture.session,
            track: fixture.track,
            take: fixture.take,
            pauseCount: 2,
            pausedDurationUs: "1500",
        });
        expect(records[0]!.fields.get("state")).toBe("completed");
        expect(records[0]!.fields.get("capture_pause_count")).toBe("2");
        expect(records[0]!.fields.get("capture_paused_duration_us")).toBe("1500");
        expect(records[1]!.fields.get("state")).toBe("completed");
        expect(records[2]!.fields.get("recording_state")).toBe("completed");
        expect(records[2]!.fields.get("recording_error")).toBe("");
    });

    it("marks an interrupted take with the supplied reason", () => {
        const fixture = startFixture();
        const records = makeMicrophoneCaptureFinishRecords({
            session: fixture.session,
            track: fixture.track,
            take: fixture.take,
            pauseCount: 0,
            pausedDurationUs: "0",
            interruptedReason: "Device removed",
        });
        expect(records[0]!.fields.get("state")).toBe("interrupted");
        expect(records[0]!.fields.get("recovery_error")).toBe("Device removed");
        expect(records[1]!.fields.get("state")).toBe("partial");
        expect(records[2]!.fields.get("recording_state")).toBe("interrupted");
    });

    it("adds to existing pause counters and defaults empty ones", () => {
        const fixture = startFixture();
        const track = {
            ...fixture.track,
            fields: new Map([
                ...fixture.track.fields,
                ["capture_pause_count", "3"],
                ["capture_paused_duration_us", ""],
            ]),
        };
        const records = makeMicrophoneCaptureFinishRecords({
            session: fixture.session,
            track,
            take: fixture.take,
            pauseCount: 1,
            pausedDurationUs: "10",
        });
        expect(records[0]!.fields.get("capture_pause_count")).toBe("4");
        expect(records[0]!.fields.get("capture_paused_duration_us")).toBe("10");
    });

    it("rejects corrupt or overflowing pause counters", () => {
        const fixture = startFixture();
        expect(() =>
            makeMicrophoneCaptureFinishRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([...fixture.track.fields, ["capture_pause_count", "bad"]]),
                },
                take: fixture.take,
                pauseCount: 1,
                pausedDurationUs: "0",
            }),
        ).toThrow(/exceed the supported archive range/u);
        expect(() =>
            makeMicrophoneCaptureFinishRecords({
                session: fixture.session,
                track: fixture.track,
                take: fixture.take,
                pauseCount: 1,
                pausedDurationUs: "bad",
            }),
        ).toThrow(/exceed the supported archive range/u);
        expect(() =>
            makeMicrophoneCaptureFinishRecords({
                session: fixture.session,
                track: {
                    ...fixture.track,
                    fields: new Map([
                        ...fixture.track.fields,
                        ["capture_pause_count", U64_MAX.toString()],
                    ]),
                },
                take: fixture.take,
                pauseCount: 1,
                pausedDurationUs: "0",
            }),
        ).toThrow(/exceed the supported archive range/u);
        expect(() =>
            makeMicrophoneCaptureFinishRecords({
                session: fixture.session,
                track: fixture.track,
                take: fixture.take,
                pauseCount: Number.NaN,
                pausedDurationUs: "0",
            }),
        ).toThrow(/exceed the supported archive range/u);
    });
});

describe("microphone capture state records", () => {
    it("updates the session, track, and take state", () => {
        const fixture = startFixture();
        const records = makeMicrophoneCaptureStateRecords(
            fixture.session,
            fixture.track,
            fixture.take,
            "paused",
        );
        expect(records[0]!.fields.get("state")).toBe("paused");
        expect(records[1]!.fields.get("state")).toBe("paused");
        expect(records[2]!.fields.get("recording_state")).toBe("paused");
        expect(records[2]!.fields.get("updated_at_us")).toBe(
            records[0]!.fields.get("updated_at_us"),
        );
    });
});

describe("microphone recording import", () => {
    function waveData(samples: readonly number[]): Uint8Array {
        const bytes = new Uint8Array(samples.length * 2);
        const view = new DataView(bytes.buffer);
        samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
        return bytes;
    }

    function waveFile(data: Uint8Array, name = "lesson.wav"): File {
        const fmt = new Uint8Array(16);
        const view = new DataView(fmt.buffer);
        view.setUint16(0, 1, true);
        view.setUint16(2, 1, true);
        view.setUint32(4, 8_000, true);
        view.setUint32(8, 16_000, true);
        view.setUint16(12, 2, true);
        view.setUint16(14, 16, true);
        const chunks = [chunk("fmt ", fmt), chunk("data", data)];
        const body = join([ascii("WAVE"), ...chunks]);
        const header = new Uint8Array(8);
        header.set(ascii("RIFF"), 0);
        new DataView(header.buffer).setUint32(4, body.byteLength, true);
        return new File([header, body as Uint8Array<ArrayBuffer>], name, { type: "audio/wav" });
    }

    function chunk(name: string, payload: Uint8Array): Uint8Array {
        const header = new Uint8Array(8);
        header.set(ascii(name), 0);
        new DataView(header.buffer).setUint32(4, payload.byteLength, true);
        return join(
            payload.byteLength % 2 ? [header, payload, new Uint8Array(1)] : [header, payload],
        );
    }

    function ascii(value: string): Uint8Array {
        return Uint8Array.from(value, (character) => character.charCodeAt(0));
    }

    function join(values: readonly Uint8Array[]): Uint8Array {
        const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
        let offset = 0;
        for (const value of values) {
            output.set(value, offset);
            offset += value.byteLength;
        }
        return output;
    }

    it("applies capture metadata to a single imported track", async () => {
        const session = makeSession({
            audio_import_track_id: "preserved",
            audio_chunks_imported: "5",
            audio_samples_imported: "6",
        });
        const result = await makeMicrophoneRecordingRecords({
            session,
            file: waveFile(waveData([1, -1])),
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 3,
            pausedDurationUs: "1200",
            consentConfirmedBy: "Tutor",
        });

        const chunkRecord = result.records.find((record) => record.type === RecordType.audioChunk)!;
        expect(chunkRecord.fields.has("source_filename")).toBe(false);
        const metadata = result.records.filter(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") !== "recording-take",
        );
        expect(metadata[0]!.fields.get("source")).toBe("microphone");
        expect(metadata[0]!.fields.get("capture_source_backend")).toBe("web-audio");
        expect(metadata[0]!.fields.get("capture_pause_count")).toBe("3");
        expect(metadata[0]!.fields.get("capture_paused_duration_us")).toBe("1200");
        const take = result.records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;
        expect(take.fields.get("started_at_us")).toBe(TIMESTAMP);
        expect(take.fields.has("ended_at_us")).toBe(true);
        const updated = result.records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("audio_import_track_id")).toBe("preserved");
        expect(updated.fields.get("audio_chunks_imported")).toBe("5");
        expect(updated.fields.get("audio_samples_imported")).toBe("6");
        expect(updated.fields.get("recording_ended_at_us")).toBeTruthy();
        expect(updated.fields.get("recording_consent_confirmed_by")).toBe("Tutor");
    });

    it("drops import keys that did not previously exist and rewrites source fields", async () => {
        const session = makeSession();
        const result = await makeMicrophoneRecordingRecords({
            session,
            file: waveFile(waveData([1, 2]), "  folder/lesson.wav  "),
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 0,
            pausedDurationUs: "0",
            source: "system-audio",
            captureSourceBackend: "native",
        });

        const updated = result.records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.has("audio_import_track_id")).toBe(false);
        expect(updated.fields.has("audio_chunks_imported")).toBe(false);
        expect(updated.fields.has("audio_samples_imported")).toBe(false);
        expect(updated.fields.get("recording_track_id")).toBe(result.trackId);
        expect(updated.fields.get("recording_source")).toBe("system-audio");
        expect(updated.fields.get("recording_source_backend")).toBe("native");
        expect(updated.fields.get("recording_started_at_us")).toBe(TIMESTAMP);
        expect(updated.fields.get("recording_consent_confirmed_by")).toBe("");
    });

    it("keeps a pre-existing recording track selection", async () => {
        const existing = crypto.randomUUID();
        const session = makeSession({ recording_track_id: existing });
        const result = await makeMicrophoneRecordingRecords({
            session,
            file: waveFile(waveData([1])),
            knownTrackIds: [existing],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 0,
            pausedDurationUs: "0",
        });
        const updated = result.records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("recording_track_id")).toBe(existing);
    });

    it("propagates WAV import failures", async () => {
        await expect(
            makeMicrophoneRecordingRecords({
                session: makeSession(),
                file: waveFile(waveData([1]), "broken.wav"),
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                pauseCount: 0,
                pausedDurationUs: "0",
            }),
        ).resolves.toBeDefined();
        const invalid = new File([new Uint8Array(12)], "bad.wav");
        await expect(
            makeMicrophoneRecordingRecords({
                session: makeSession(),
                file: invalid,
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                pauseCount: 0,
                pausedDurationUs: "0",
            }),
        ).rejects.toThrow(/RIFF\/WAVE/u);
    });
});

describe("MicrophoneRecording", () => {
    function microphoneStream(audio = 1, video = 0): FakeStream {
        return new FakeStream(
            Array.from({ length: audio }, () => new FakeTrack("audio")),
            Array.from({ length: video }, () => new FakeTrack("video")),
        );
    }

    function setup(
        overrides: {
            getUserMedia?: (constraints: unknown) => Promise<FakeStream>;
            deviceId?: string;
            onLimit?: () => void;
            onDeviceEnded?: () => void;
        } = {},
    ): {
        stream: FakeStream;
        receivedConstraints: unknown[];
        onDeviceEnded: () => void;
        onLimit: () => void;
        start: () => Promise<MicrophoneRecording>;
    } {
        const stream = microphoneStream();
        const receivedConstraints: unknown[] = [];
        const onLimit = overrides.onLimit ?? vi.fn();
        const onDeviceEnded = overrides.onDeviceEnded ?? vi.fn();
        installBrowser({
            getUserMedia: async (constraints) => {
                receivedConstraints.push(constraints);
                return overrides.getUserMedia
                    ? overrides.getUserMedia(constraints)
                    : Promise.resolve(stream);
            },
        });
        return {
            stream,
            receivedConstraints,
            onDeviceEnded,
            onLimit,
            start: () => MicrophoneRecording.start(onLimit, onDeviceEnded, overrides.deviceId),
        };
    }

    it("throws when the window cannot capture audio", async () => {
        installBrowser({});
        await expect(MicrophoneRecording.start(vi.fn(), vi.fn())).rejects.toThrow(
            /unavailable in this window/u,
        );

        Object.defineProperty(globalThis, "AudioContext", {
            value: undefined,
            configurable: true,
            writable: true,
        });
        await expect(MicrophoneRecording.start(vi.fn(), vi.fn())).rejects.toThrow(
            /unavailable in this window/u,
        );
    });

    it("requests the exact device when one is provided", async () => {
        const fixture = setup({ deviceId: "mic-42" });
        const recording = await fixture.start();
        expect(fixture.receivedConstraints[0]).toEqual({
            audio: { deviceId: { exact: "mic-42" } },
        });
        await recording.discard();
    });

    it("requests default audio when the device id is empty", async () => {
        const fixture = setup({ deviceId: "" });
        const recording = await fixture.start();
        expect(fixture.receivedConstraints[0]).toEqual({ audio: true });
        await recording.discard();
    });

    it("wires the graph and stops the stream on discard", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const context = FakeAudioContext.instances[0]!;

        expect(context.sources).toHaveLength(1);
        expect(context.processors).toHaveLength(1);
        expect(context.gains).toHaveLength(1);
        expect(context.processors[0]!.connections[0]!.target).toBe(context.gains[0]);
        expect(context.gains[0]!.gain.value).toBe(0);
        expect(context.gains[0]!.connections[0]!.target).toBe(context.destination);

        await recording.discard();
        expect(fixture.stream.getTracks()[0]!.stopCount).toBe(1);
        expect(context.processors[0]!.onaudioprocess).toBeNull();
        expect(context.sources[0]!.disconnected).toBe(true);
        expect(context.processors[0]!.disconnected).toBe(true);
        expect(context.gains[0]!.disconnected).toBe(true);
    });

    it("registers ended listeners for every audio track", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        fixture.stream.getAudioTracks()[0]!.ended();
        expect(fixture.onDeviceEnded).toHaveBeenCalledTimes(1);
        await recording.discard();
    });

    it("stops tracks and closes the context when setup fails", async () => {
        const fixture = setup();
        const context = FakeAudioContext;
        const original = context.prototype.createMediaStreamSource;
        context.prototype.createMediaStreamSource = () => {
            throw new Error("graph failed");
        };
        try {
            await expect(fixture.start()).rejects.toThrow(/graph failed/u);
        } finally {
            context.prototype.createMediaStreamSource = original;
        }
        expect(fixture.stream.getTracks()[0]!.stopCount).toBe(1);
    });

    it("swallows a close failure while cleaning up a failed start", async () => {
        const fixture = setup();
        const original = FakeAudioContext.prototype.resume;
        FakeAudioContext.prototype.resume = async () => {
            throw new Error("resume failed");
        };
        const originalClose = FakeAudioContext.prototype.close;
        FakeAudioContext.prototype.close = async () => {
            throw new Error("close failed");
        };
        try {
            await expect(fixture.start()).rejects.toThrow(/resume failed/u);
        } finally {
            FakeAudioContext.prototype.resume = original;
            FakeAudioContext.prototype.close = originalClose;
        }
        expect(fixture.stream.getTracks()[0]!.stopCount).toBe(1);
    });

    it("propagates a getUserMedia denial without creating a context", async () => {
        installBrowser({
            getUserMedia: async () => {
                throw new Error("Permission denied");
            },
            getDisplayMedia: async () => microphoneStream(),
        });
        await expect(MicrophoneRecording.start(vi.fn(), vi.fn())).rejects.toThrow(
            /Permission denied/u,
        );
        expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it("captures PCM and writes a WAV on stop", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const processor = FakeAudioContext.instances[0]!.processors[0]!;

        drive(
            processor,
            audioProcessEvent(new Float32Array([-2, -1, 0, 1, 2]), new Float32Array([0.5])),
        );
        drive(processor, audioProcessEvent(new Float32Array([0.25, -0.25])));
        const result = await recording.stop();

        expect(result.pauseCount).toBe(0);
        expect(result.pausedDurationUs).toBe("0");
        expect(result.file.name).toMatch(/^Microphone .*\.wav$/u);
        expect(result.file.type).toBe("audio/wav");
        expect(result.file.size).toBe(44 + 14);
        const header = new Uint8Array(await result.file.slice(0, 44).arrayBuffer());
        expect(String.fromCharCode(...header.subarray(0, 4))).toBe("RIFF");
        expect(new DataView(header.buffer).getUint32(40, true)).toBe(14);
        expect(new DataView(header.buffer).getUint32(24, true)).toBe(48_000);
        expect(processor.onaudioprocess).toBeNull();
        await expect(recording.stop()).rejects.toThrow(/already stopped/u);
    });

    it("treats missing samples as silence and skips capture while paused or finished", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const processor = FakeAudioContext.instances[0]!.processors[0]!;
        const handler = processor.onaudioprocess!;

        drive(processor, audioProcessEvent({ length: 2 }));
        await recording.pause();
        handler(audioProcessEvent(new Float32Array([1, 1])));
        await recording.resume();
        drive(processor, audioProcessEvent(new Float32Array([1, 1])));
        const result = await recording.stop();
        expect(result.file.size).toBe(44 + 8);

        handler(audioProcessEvent(new Float32Array([1, 1])));
        await recording.discard();
        expect(processor.onaudioprocess).toBeNull();
        handler(audioProcessEvent(new Float32Array([1, 1])));
    });

    it("discard is a no-op after stop", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        drive(FakeAudioContext.instances[0]!.processors[0], audioProcessEvent());
        await recording.stop();
        const track = fixture.stream.getTracks()[0]!;
        const stops = track.stopCount;
        await recording.discard();
        expect(track.stopCount).toBe(stops);
    });

    it("ignores a close failure while discarding", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        FakeAudioContext.instances[0]!.closeImpl = async () => {
            throw new Error("close failed");
        };
        await expect(recording.discard()).resolves.toBeUndefined();
        expect(fixture.stream.getTracks()[0]!.stopCount).toBe(1);
    });

    it("rejects stopping before any audio arrived", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        await expect(recording.stop()).rejects.toThrow(/did not provide any audio/u);
    });

    it("accounts for paused time when stopping directly", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        drive(FakeAudioContext.instances[0]!.processors[0], audioProcessEvent());
        vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_500);
        await recording.pause();
        const result = await recording.stop();
        expect(result.pauseCount).toBe(1);
        expect(result.pausedDurationUs).toBe("1500000");
    });

    it("throws when pausing twice or after stopping", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        await recording.pause();
        await expect(recording.pause()).rejects.toThrow(/cannot be paused now/u);
        await expect(recording.resume()).resolves.toBeUndefined();
        await expect(recording.resume()).rejects.toThrow(/cannot be resumed now/u);
        drive(FakeAudioContext.instances[0]!.processors[0], audioProcessEvent());
        await recording.stop();
        await expect(recording.pause()).rejects.toThrow(/cannot be paused now/u);
        await expect(recording.resume()).rejects.toThrow(/cannot be resumed now/u);
    });

    it("rolls back a failed suspend while still recording", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const context = FakeAudioContext.instances[0]!;
        drive(context.processors[0], audioProcessEvent());
        context.suspendImpl = async () => {
            throw new Error("suspend failed");
        };
        const track = fixture.stream.getAudioTracks()[0]!;
        await expect(recording.pause()).rejects.toThrow(/suspend failed/u);
        expect(track.enabled).toBe(true);

        context.suspendImpl = async () => undefined;
        await recording.pause();
        expect(track.enabled).toBe(false);
        await recording.resume();
        expect(track.enabled).toBe(true);
        expect((await recording.stop()).pauseCount).toBe(1);
    });

    it("does not roll back a suspend failure after the recording finished", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const context = FakeAudioContext.instances[0]!;
        let rejectSuspend: (error: Error) => void = () => undefined;
        context.suspendImpl = () =>
            new Promise<void>((_resolve, reject) => {
                rejectSuspend = reject;
            });
        const paused = recording.pause();
        await recording.discard();
        rejectSuspend(new Error("suspend failed"));
        await expect(paused).rejects.toThrow(/suspend failed/u);
    });

    it("returns before clearing pause state when finishing during resume", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const context = FakeAudioContext.instances[0]!;
        await recording.pause();
        let resolveResume: () => void = () => undefined;
        context.resumeImpl = () =>
            new Promise<void>((resolve) => {
                resolveResume = resolve;
            });
        const resumed = recording.resume();
        await recording.discard();
        resolveResume();
        await expect(resumed).resolves.toBeUndefined();
    });

    it("propagates resume failures and leaves the recording paused", async () => {
        const fixture = setup();
        const recording = await fixture.start();
        const context = FakeAudioContext.instances[0]!;
        await recording.pause();
        context.resumeImpl = async () => {
            throw new Error("resume failed");
        };
        await expect(recording.resume()).rejects.toThrow(/resume failed/u);
        expect(fixture.stream.getAudioTracks()[0]!.enabled).toBe(false);
    });

    it("signals the byte limit once the buffer is full", async () => {
        const onLimit = vi.fn();
        const fixture = setup({ onLimit });
        const recording = await fixture.start();
        const processor = FakeAudioContext.instances[0]!.processors[0]!;

        drive(processor, audioProcessEvent({ length: 67_108_864 }));
        expect(onLimit).toHaveBeenCalledTimes(1);

        drive(processor, audioProcessEvent(new Float32Array([1, 1])));
        expect(onLimit).toHaveBeenCalledTimes(2);

        await expect(recording.stop()).resolves.toBeDefined();
    }, 30_000);

    it("clamps a buffer larger than the remaining space", async () => {
        const onLimit = vi.fn();
        const fixture = setup({ onLimit });
        const recording = await fixture.start();
        const processor = FakeAudioContext.instances[0]!.processors[0]!;

        drive(processor, audioProcessEvent({ length: 67_108_860 }));
        expect(onLimit).not.toHaveBeenCalled();
        drive(processor, audioProcessEvent({ length: 1024 }));
        expect(onLimit).toHaveBeenCalledTimes(1);
        await recording.stop();
    }, 30_000);
});
