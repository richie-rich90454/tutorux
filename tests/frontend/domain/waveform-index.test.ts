import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    buildWaveformIndex,
    buildWaveformIndexFromChunks,
    readWaveformIndex,
    waveformIndexIsCurrent,
} from "../../../frontend/domain/waveform-index";

const audioMock = vi.hoisted(() => ({
    stream: undefined as ReadableStream<Uint8Array> | undefined,
    error: undefined as Error | undefined,
}));

vi.mock("../../../frontend/domain/audio", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/domain/audio")>();
    return {
        ...actual,
        buildAudioTrackWavStream: async () => {
            if (audioMock.error) throw audioMock.error;
            return audioMock.stream!;
        },
    };
});

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "22222222-2222-4222-8222-222222222222";
const RATE = "8000";

type Format = "pcm_u8" | "pcm_s16le" | "pcm_s24le" | "pcm_s32le" | "pcm_f32le";
type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

function metadata(
    overrides: Partial<{
        sequence: number;
        first: string;
        count: string;
        gap: string;
        format: string;
        rate: string;
        channels: string;
        revision: bigint;
        id: string;
        type: number;
    }> = {},
): FixtureRecord {
    return {
        type: overrides.type ?? RecordType.audioChunk,
        id: overrides.id ?? "33333333-3333-4333-8333-333333333333",
        revision: overrides.revision ?? 0n,
        previousOffset: 0n,
        fields: new Map([
            ["session_id", SESSION_ID],
            ["track_id", TRACK_ID],
            ["sequence_number", String(overrides.sequence ?? 0)],
            ["first_sample_index", overrides.first ?? "0"],
            ["sample_count", overrides.count ?? "5"],
            ["gap_before_samples", overrides.gap ?? "0"],
            ["sample_rate_hz", overrides.rate ?? RATE],
            ["channel_count", overrides.channels ?? "1"],
            ["sample_format", overrides.format ?? "pcm_s16le"],
        ]),
        blob: new Uint8Array(),
    };
}

function chunk(
    blob: Uint8Array,
    overrides: Partial<Parameters<typeof metadata>[0]> = {},
): FixtureRecord {
    const record = metadata({ channels: "2", count: "1", ...overrides });
    return { ...record, blob };
}

function streamOf(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index >= parts.length) {
                controller.close();
                return;
            }
            controller.enqueue(parts[index++]!);
        },
    });
}

/** Re-pull a source that returns without enqueueing, which the platform stream never does. */
class RepullingStream {
    private readonly queue: Uint8Array[] = [];
    private closed = false;
    private failure: Error | undefined;

    constructor(source: { pull?: (controller: unknown) => void }) {
        this.source = source;
    }

    private source: { pull?: (controller: unknown) => void };

    private pullOnce(): void {
        const controller = {
            enqueue: (value: Uint8Array) => this.queue.push(value),
            close: () => {
                this.closed = true;
            },
            error: (error: Error) => {
                this.failure = error;
            },
            desiredSize: 1,
        };
        this.source.pull?.(controller);
    }

    getReader() {
        return {
            read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
                while (!this.queue.length && !this.closed && !this.failure) this.pullOnce();
                if (this.failure) throw this.failure;
                const value = this.queue.shift();
                return value ? { done: false, value } : { done: true };
            },
            cancel: async () => undefined,
            releaseLock: () => undefined,
        };
    }
}

async function withRepullingStreams<T>(run: () => Promise<T>): Promise<T> {
    const original = globalThis.ReadableStream;
    (globalThis as { ReadableStream: unknown }).ReadableStream = RepullingStream;
    try {
        return await run();
    } finally {
        (globalThis as { ReadableStream: unknown }).ReadableStream = original;
    }
}

function pcmBytes(format: Format): Uint8Array {
    switch (format) {
        case "pcm_u8":
            return new Uint8Array([0, 128, 255, 64, 192]);
        case "pcm_s16le": {
            const bytes = new Uint8Array(10);
            const view = new DataView(bytes.buffer);
            [-32768, 0, 32767, -16384, 16384].forEach((value, index) =>
                view.setInt16(index * 2, value, true),
            );
            return bytes;
        }
        case "pcm_s24le": {
            const bytes = new Uint8Array(15);
            [-8388608, 0, 8388607, -4194304, 4194304].forEach((value, index) => {
                const offset = index * 3;
                let sample = value;
                if (sample < 0) sample += 0x1000000;
                bytes[offset] = sample & 0xff;
                bytes[offset + 1] = (sample >> 8) & 0xff;
                bytes[offset + 2] = (sample >> 16) & 0xff;
            });
            return bytes;
        }
        case "pcm_s32le": {
            const bytes = new Uint8Array(20);
            const view = new DataView(bytes.buffer);
            [-2147483648, 0, 2147483647, -1073741824, 1073741824].forEach((value, index) =>
                view.setInt32(index * 4, value, true),
            );
            return bytes;
        }
        case "pcm_f32le": {
            const bytes = new Uint8Array(20);
            const view = new DataView(bytes.buffer);
            [-2, 0, 2, 0.5, Number.NaN].forEach((value, index) =>
                view.setFloat32(index * 4, value, true),
            );
            return bytes;
        }
    }
}

function snapshot(
    chunks: readonly ArchiveRecord[],
    previous: readonly ArchiveRecord[] = [],
): {
    listAudioChunkMetadata: () => Promise<ArchiveRecord[]>;
    listRecords: () => Promise<ArchiveRecord[]>;
} {
    return {
        listAudioChunkMetadata: async () => [...chunks],
        listRecords: async () => [...previous],
    };
}

function abortSignalAt(limit: number): AbortSignal {
    let reads = 0;
    const signal = {
        get aborted() {
            reads += 1;
            return reads >= limit;
        },
    };
    return signal as unknown as AbortSignal;
}

async function sha256Lines(lines: string): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines)),
    );
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(() => {
    audioMock.stream = undefined;
    audioMock.error = undefined;
});

describe("buildWaveformIndex", () => {
    it("builds a pyramid from a streamed track and reuses the previous index identity", async () => {
        const data = pcmBytes("pcm_s16le");
        const previous: ArchiveRecord = {
            type: RecordType.waveformIndex,
            id: "44444444-4444-4444-8444-444444444444",
            revision: 4n,
            previousOffset: 8n,
            fields: new Map([
                ["record_role", "waveform-pyramid"],
                ["session_id", SESSION_ID.toUpperCase()],
                ["track_id", TRACK_ID.toUpperCase()],
            ]),
            blob: new Uint8Array(),
        };
        audioMock.stream = streamOf([new Uint8Array([1, 2, 3]), data]);
        const progress: number[] = [];

        const record = await buildWaveformIndex(
            snapshot(
                [metadata()],
                [
                    {
                        ...previous,
                        id: "77777777-7777-4777-8777-777777777777",
                        fields: new Map([["record_role", "waveform-pyramid"]]),
                    },
                    {
                        ...previous,
                        id: "88888888-8888-4888-8888-888888888888",
                        fields: new Map([
                            ["record_role", "waveform-pyramid"],
                            ["session_id", SESSION_ID],
                        ]),
                    },
                    previous,
                ],
            ) as never,
            SESSION_ID,
            TRACK_ID,
            { onProgress: (value) => progress.push(value) },
        );

        expect(record.id).toBe(previous.id);
        expect(record.revision).toBe(4n);
        expect(record.previousOffset).toBe(8n);
        expect(record.fields.get("timeline_frame_count")).toBe("5");
        expect(record.fields.get("source_sample_format")).toBe("pcm_s16le");
        expect(record.fields.get("stored_frame_count")).toBe("5");
        expect(progress).toEqual([1]);
        const levels = readWaveformIndex(record);
        expect(levels[0]).toHaveLength(5);
        expect(levels.at(-1)).toHaveLength(1);
    });

    it("throws when the track has no chunks", async () => {
        await expect(
            buildWaveformIndex(snapshot([]) as never, SESSION_ID, TRACK_ID),
        ).rejects.toThrow(/no audio chunks/u);
    });

    it("throws when the sample format is missing", async () => {
        const record = metadata();
        record.fields.delete("sample_format");
        await expect(
            buildWaveformIndex(snapshot([record]) as never, SESSION_ID, TRACK_ID),
        ).rejects.toThrow(/cannot be indexed/u);
    });

    it("throws when a numeric metadata field is invalid", async () => {
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(new Uint8Array(4), { count: "1", rate: "not-a-rate" })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/Invalid waveform source metadata/u);
    });

    it("defaults an absent optional gap to zero", async () => {
        const record = chunk(new Uint8Array(4), { count: "1" });
        record.fields.delete("gap_before_samples");
        const built = await buildWaveformIndexFromChunks([record], SESSION_ID, TRACK_ID);
        expect(built.fields.get("timeline_frame_count")).toBe("1");
    });

    it("rejects a missing required counter", async () => {
        const record = chunk(new Uint8Array(4), { count: "1" });
        record.fields.delete("sequence_number");
        await expect(buildWaveformIndexFromChunks([record], SESSION_ID, TRACK_ID)).rejects.toThrow(
            /Invalid waveform source metadata/u,
        );
    });

    it("checks for cancellation before listing chunks", async () => {
        await expect(
            buildWaveformIndex(snapshot([metadata()]) as never, SESSION_ID, TRACK_ID, {
                signal: abortSignalAt(1),
            }),
        ).rejects.toThrow(/canceled/u);
    });

    it("propagates stream construction failures", async () => {
        audioMock.error = new Error("stream failed");
        await expect(
            buildWaveformIndex(snapshot([metadata()]) as never, SESSION_ID, TRACK_ID),
        ).rejects.toThrow("stream failed");
    });

    it.each(["pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"] as const)(
        "indexes %s samples with playback scaling",
        async (format) => {
            const data = pcmBytes(format);
            audioMock.stream = streamOf([new Uint8Array(0), data]);
            const record = await buildWaveformIndex(
                snapshot([metadata({ format })]) as never,
                SESSION_ID,
                TRACK_ID,
            );

            expect(record.fields.get("source_sample_format")).toBe(format);
            const levels = readWaveformIndex(record);
            expect(levels[0]).toHaveLength(5);
            expect(levels[0]![0]!.minimum).toBe(-32768);
            expect(levels.at(-1)).toHaveLength(1);
        },
    );
});

describe("buildWaveformIndexFromChunks", () => {
    it("rejects an empty chunk list", async () => {
        await expect(buildWaveformIndexFromChunks([], SESSION_ID, TRACK_ID)).rejects.toThrow(
            /no audio chunks/u,
        );
    });

    it("rejects an unsupported mixed-audio format", async () => {
        const blob = new Uint8Array(4).fill(1);
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(blob, { count: "1", format: "pcm_s24le" })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/unsupported format/u);
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(blob, { count: "1", channels: "1" })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/unsupported format/u);
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(blob, { count: "1", type: RecordType.assetMetadata })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/unsupported format/u);
    });

    it("rejects a gap that cannot be indexed", async () => {
        const blob = new Uint8Array(4).fill(1);
        await expect(
            buildWaveformIndexFromChunks(
                [
                    chunk(blob, {
                        count: "1",
                        gap: "3000000000000000",
                        first: "3000000000000000",
                    }),
                ],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/gap is too large/u);
    });

    it("inserts whole silence blocks for a 64 KiB gap", async () => {
        const firstChunk = chunk(new Uint8Array(4).fill(2), {
            count: "1",
            gap: "16384",
            first: "16384",
        });
        const record = await withRepullingStreams(() =>
            buildWaveformIndexFromChunks([firstChunk], SESSION_ID, TRACK_ID),
        );
        const levels = readWaveformIndex(record);
        expect(record.fields.get("timeline_frame_count")).toBe("16385");
        expect(levels[0]!.some((bucket) => bucket.containsGap)).toBe(true);
    });

    it("inserts sliced silence blocks and pending chunk data across pulls", async () => {
        const first = chunk(new Uint8Array(4).fill(3), {
            count: "1",
            gap: "20000",
            first: "20000",
            revision: 3n,
        });
        const second = chunk(new Uint8Array(4).fill(4), {
            sequence: 1,
            count: "1",
            first: "20001",
        });
        const third = chunk(new Uint8Array(4).fill(5), {
            sequence: 2,
            count: "1",
            first: "20002",
        });
        const record = await withRepullingStreams(() =>
            buildWaveformIndexFromChunks([first, second, third], SESSION_ID, TRACK_ID),
        );
        expect(record.fields.get("timeline_frame_count")).toBe("20003");
        const levels = readWaveformIndex(record);
        expect(levels[0]).toHaveLength(8192);
        expect(levels.at(-1)).toHaveLength(1);
    });

    it.each(["sequence", "start", "count"] as const)(
        "rejects inconsistent %s metadata",
        async (label) => {
            const first = chunk(new Uint8Array(4), { count: "1" });
            const second = chunk(new Uint8Array(4), {
                count: label === "count" ? "0" : "1",
                sequence: label === "sequence" ? 2 : 1,
                first: label === "start" ? "2" : "1",
            });
            await expect(
                buildWaveformIndexFromChunks([first, second], SESSION_ID, TRACK_ID),
            ).rejects.toThrow(/inconsistent timeline metadata/u);
        },
    );

    it.each([
        ["rate", { rate: "16000" }],
        ["channels", { channels: "1" }],
        ["format", { format: "pcm_u8" }],
    ] as const)("rejects inconsistent %s metadata", async (_label, overrides) => {
        const first = chunk(new Uint8Array(4), { count: "1" });
        const second = chunk(new Uint8Array(4), {
            sequence: 1,
            count: "1",
            first: "1",
            ...overrides,
        });
        await expect(
            buildWaveformIndexFromChunks([first, second], SESSION_ID, TRACK_ID),
        ).rejects.toThrow(/inconsistent timeline metadata/u);
    });

    it("rejects a timeline larger than a safe integer", async () => {
        await expect(
            buildWaveformIndexFromChunks(
                [
                    chunk(new Uint8Array(4), {
                        count: "9007199254740992",
                    }),
                ],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/timeline is too large/u);
    });

    it("rejects an incomplete trailing frame", async () => {
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(new Uint8Array(3), { count: "1" })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/incomplete frame/u);
    });

    it("rejects a stream that ends before the timeline", async () => {
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(new Uint8Array(4), { count: "2" })],
                SESSION_ID,
                TRACK_ID,
            ),
        ).rejects.toThrow(/ended before the complete waveform/u);
    });

    it.each([1, 2, 3, 4, 5])("cancels at abort check %i", async (limit) => {
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(new Uint8Array(4), { count: "1" })],
                SESSION_ID,
                TRACK_ID,
                { signal: abortSignalAt(limit) },
            ),
        ).rejects.toThrow(/canceled/u);
    });

    it("aborts during progress reporting", async () => {
        const controller = new AbortController();
        await expect(
            buildWaveformIndexFromChunks(
                [chunk(new Uint8Array(4), { count: "1" })],
                SESSION_ID,
                TRACK_ID,
                {
                    signal: controller.signal,
                    onProgress: () => controller.abort(),
                },
            ),
        ).rejects.toThrow(/canceled/u);
    });
});

function pyramidRecord(
    levels: { start: bigint; end: bigint; min: number; max: number; gap: number }[][],
    total: bigint,
    overrides: Partial<{ type: number; role: string; version: string }> = {},
): ArchiveRecord {
    const size = 12 + levels.reduce((sum, level) => sum + 4 + level.length * 21, 0);
    const blob = new Uint8Array(size);
    blob.set(new TextEncoder().encode("TUXWFP2\0"));
    const view = new DataView(blob.buffer);
    view.setUint32(8, levels.length, true);
    let offset = 12;
    for (const level of levels) {
        view.setUint32(offset, level.length, true);
        offset += 4;
        for (const bucket of level) {
            view.setBigUint64(offset, bucket.start, true);
            view.setBigUint64(offset + 8, bucket.end, true);
            view.setInt16(offset + 16, bucket.min, true);
            view.setInt16(offset + 18, bucket.max, true);
            view.setUint8(offset + 20, bucket.gap);
            offset += 21;
        }
    }
    return {
        type: overrides.type ?? RecordType.waveformIndex,
        id: "55555555-5555-4555-8555-555555555555",
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["record_role", overrides.role ?? "waveform-pyramid"],
            ["format_version", overrides.version ?? "2"],
            ["timeline_frame_count", total.toString()],
        ]),
        blob,
    };
}

const validLevels = [
    [
        { start: 0n, end: 2n, min: -10, max: 10, gap: 0 },
        { start: 2n, end: 4n, min: -5, max: 5, gap: 1 },
    ],
    [{ start: 0n, end: 4n, min: -10, max: 10, gap: 1 }],
];

describe("readWaveformIndex", () => {
    it("reads a valid pyramid", () => {
        const levels = readWaveformIndex(pyramidRecord(validLevels, 4n));
        expect(levels).toHaveLength(2);
        expect(levels[0]![1]!.containsGap).toBe(true);
    });

    it.each([
        ["type", { type: RecordType.assetMetadata }],
        ["role", { role: "other" }],
        ["version", { version: "1" }],
    ] as const)("rejects an unsupported %s", (_label, overrides) => {
        expect(() => readWaveformIndex(pyramidRecord(validLevels, 4n, overrides))).toThrow(
            /Unsupported waveform index/u,
        );
    });

    it("rejects a short or corrupt header", () => {
        const record = pyramidRecord(validLevels, 4n);
        expect(() => readWaveformIndex({ ...record, blob: new Uint8Array(4) })).toThrow(
            /Invalid waveform index header/u,
        );
        const corrupt = new Uint8Array(record.blob);
        corrupt[0] = 0;
        expect(() => readWaveformIndex({ ...record, blob: corrupt })).toThrow(
            /Invalid waveform index header/u,
        );
    });

    it("rejects an invalid level count", () => {
        const record = pyramidRecord(validLevels, 4n);
        const zero = new Uint8Array(record.blob);
        new DataView(zero.buffer).setUint32(8, 0, true);
        expect(() => readWaveformIndex({ ...record, blob: zero })).toThrow(
            /Invalid waveform level count/u,
        );
        const many = new Uint8Array(record.blob);
        new DataView(many.buffer).setUint32(8, 15, true);
        expect(() => readWaveformIndex({ ...record, blob: many })).toThrow(
            /Invalid waveform level count/u,
        );
    });

    it("rejects a truncated level header", () => {
        const record = pyramidRecord(validLevels, 4n);
        expect(() => readWaveformIndex({ ...record, blob: record.blob.slice(0, 13) })).toThrow(
            /Truncated waveform index/u,
        );
    });

    it.each([
        [
            "zero bucket count",
            (blob: Uint8Array) => {
                new DataView(blob.buffer).setUint32(12, 0, true);
            },
            /Invalid waveform bucket count/u,
        ],
        [
            "too many buckets",
            (blob: Uint8Array) => {
                new DataView(blob.buffer).setUint32(12, 8193, true);
            },
            /Invalid waveform bucket count/u,
        ],
        [
            "missing bucket bytes",
            (blob: Uint8Array) => {
                new DataView(blob.buffer).setUint32(8, 1, true);
                new DataView(blob.buffer).setUint32(12, 1, true);
            },
            /Invalid waveform bucket count/u,
        ],
    ] as const)("rejects %s", (_label, mutate, message) => {
        const record = pyramidRecord(validLevels, 4n);
        const blob = new Uint8Array(record.blob.slice(0, 20));
        blob.set(record.blob.slice(0, 20));
        mutate(blob);
        expect(() => readWaveformIndex({ ...record, blob })).toThrow(message);
    });

    it("rejects a higher level that does not shrink", () => {
        expect(() =>
            readWaveformIndex(
                pyramidRecord(
                    [
                        [
                            { start: 0n, end: 2n, min: 0, max: 1, gap: 0 },
                            { start: 2n, end: 4n, min: 0, max: 1, gap: 0 },
                        ],
                        [
                            { start: 0n, end: 2n, min: 0, max: 1, gap: 0 },
                            { start: 2n, end: 4n, min: 0, max: 1, gap: 0 },
                        ],
                    ],
                    4n,
                ),
            ),
        ).toThrow(/Invalid waveform bucket count/u);
    });

    it.each([
        ["end before start", { start: 0n, end: 0n, min: 0, max: 1, gap: 0 }],
        ["minimum above maximum", { start: 0n, end: 2n, min: 2, max: 1, gap: 0 }],
        ["invalid gap flag", { start: 0n, end: 2n, min: 0, max: 1, gap: 2 }],
        ["discontinuous start", { start: 1n, end: 2n, min: 0, max: 1, gap: 0 }],
    ] as const)("rejects a bucket with %s", (_label, bucket) => {
        expect(() => readWaveformIndex(pyramidRecord([[bucket]], 2n))).toThrow(
            /Invalid waveform bucket/u,
        );
    });

    it("rejects a waveform that does not cover the recording", () => {
        expect(() => readWaveformIndex(pyramidRecord(validLevels, 5n))).toThrow(
            /does not cover the complete recording/u,
        );
    });

    it("rejects trailing data", () => {
        const record = pyramidRecord(validLevels, 4n);
        const blob = new Uint8Array(record.blob.length + 1);
        blob.set(record.blob);
        expect(() => readWaveformIndex({ ...record, blob })).toThrow(/Unexpected waveform data/u);
    });
});

function currentRecord(
    overrides: Partial<{
        type: number;
        deleted: string;
        role: string;
        version: string;
        chunkCount: string;
        format: string;
        rate: string;
        channels: string;
        timeline: string;
        stored: string;
        fingerprint: string;
    }> = {},
): FixtureRecord {
    return {
        type: overrides.type ?? RecordType.waveformIndex,
        id: "66666666-6666-4666-8666-666666666666",
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(
            Object.entries({
                record_role: overrides.role ?? "waveform-pyramid",
                format_version: overrides.version ?? "2",
                ...(overrides.deleted === undefined ? {} : { _deleted: overrides.deleted }),
                session_id: SESSION_ID,
                track_id: TRACK_ID,
                chunk_count: overrides.chunkCount ?? "1",
                source_sample_format: overrides.format ?? "pcm_s16le",
                sample_rate_hz: overrides.rate ?? RATE,
                channel_count: overrides.channels ?? "1",
                timeline_frame_count: overrides.timeline ?? "1",
                stored_frame_count: overrides.stored ?? "1",
                ...(overrides.fingerprint === undefined
                    ? {}
                    : { source_fingerprint: overrides.fingerprint }),
            }),
        ),
        blob: new Uint8Array(),
    };
}

function signatureFor(chunks: readonly ArchiveRecord[]): string {
    let signature = "";
    chunks.forEach((record, index) => {
        signature += `${record.id.toLowerCase()}:${record.revision}:${index}:${record.fields.get("first_sample_index")}:${record.fields.get("sample_count")}:${record.fields.get("gap_before_samples")}\n`;
    });
    return signature;
}

describe("waveformIndexIsCurrent", () => {
    it.each([
        ["wrong type", currentRecord({ type: RecordType.assetMetadata })],
        ["deleted", currentRecord({ deleted: "true" })],
        ["wrong role", currentRecord({ role: "other" })],
        ["wrong version", currentRecord({ version: "1" })],
    ] as const)("returns false for a %s record", async (_label, record) => {
        await expect(waveformIndexIsCurrent(snapshot([metadata()]) as never, record)).resolves.toBe(
            false,
        );
    });

    it("returns false without chunks or with a different chunk count", async () => {
        await expect(waveformIndexIsCurrent(snapshot([]) as never, currentRecord())).resolves.toBe(
            false,
        );
        await expect(
            waveformIndexIsCurrent(
                snapshot([metadata()]) as never,
                currentRecord({ chunkCount: "2" }),
            ),
        ).resolves.toBe(false);
    });

    it("returns false for an unsupported stored format", async () => {
        await expect(
            waveformIndexIsCurrent(
                snapshot([metadata()]) as never,
                currentRecord({ format: "mp3" }),
            ),
        ).resolves.toBe(false);
    });

    it.each([
        ["format", { format: "pcm_u8" }, undefined],
        ["sequence", { sequence: 1 }, undefined],
        ["count", { count: "0" }, undefined],
        ["start", { first: "1" }, undefined],
        ["rate", {}, { rate: "16000" }],
        ["channels", {}, { channels: "2" }],
    ] as const)(
        "returns false for different %s metadata",
        async (_label, chunkOverride, recordOverride) => {
            await expect(
                waveformIndexIsCurrent(
                    snapshot([metadata({ count: "1", ...chunkOverride })]) as never,
                    currentRecord({ ...recordOverride }),
                ),
            ).resolves.toBe(false);
        },
    );

    it("returns false for mismatched frame totals", async () => {
        await expect(
            waveformIndexIsCurrent(
                snapshot([metadata({ count: "1" })]) as never,
                currentRecord({ timeline: "2" }),
            ),
        ).resolves.toBe(false);
        await expect(
            waveformIndexIsCurrent(
                snapshot([metadata({ count: "1" })]) as never,
                currentRecord({ timeline: "1", stored: "2" }),
            ),
        ).resolves.toBe(false);
    });

    it("returns true only for a matching fingerprint", async () => {
        const chunks = [metadata({ count: "1" })];
        const fingerprint = await sha256Lines(signatureFor(chunks));

        await expect(
            waveformIndexIsCurrent(snapshot(chunks) as never, currentRecord({ fingerprint })),
        ).resolves.toBe(true);
        await expect(
            waveformIndexIsCurrent(snapshot(chunks) as never, currentRecord({ fingerprint: "00" })),
        ).resolves.toBe(false);
        await expect(
            waveformIndexIsCurrent(snapshot(chunks) as never, currentRecord()),
        ).resolves.toBe(false);
    });

    it("uses a fallback format when the record has none", async () => {
        const record = currentRecord();
        record.fields.delete("source_sample_format");
        await expect(
            waveformIndexIsCurrent(snapshot([metadata({ count: "1" })]) as never, record),
        ).resolves.toBe(false);
    });

    it("uses empty identifiers when the record has none", async () => {
        const record = currentRecord();
        record.fields.delete("session_id");
        record.fields.delete("track_id");
        await expect(
            waveformIndexIsCurrent(snapshot([metadata({ count: "1" })]) as never, record),
        ).resolves.toBe(false);
    });
});
