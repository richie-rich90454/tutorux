import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    makeWaveImportRecords,
    makeWaveImportRecordsIncremental,
    type WaveFile,
} from "../../../frontend/domain/wav";

const SAMPLE_RATE = 8_000;

type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

describe("WAV import edge cases", () => {
    it("rejects inactive, deleted, and wrong-type sessions", async () => {
        const file = waveFile([pcm16([1, 2])]);

        await expect(
            makeWaveImportRecords({ ...makeSession(), type: RecordType.guide }, file),
        ).rejects.toThrow(/active tutoring session/u);
        await expect(
            makeWaveImportRecords(makeSession(new Map([["_deleted", "true"]])), file),
        ).rejects.toThrow(/active tutoring session/u);
        await expect(
            makeWaveImportRecords(makeSession(new Map([["recording_state", "recording"]])), file),
        ).rejects.toThrow(/Stop the active recording/u);
    });

    it("treats a missing recording state as idle", async () => {
        const session = makeSession();
        session.fields.delete("recording_state");
        const imported = await makeWaveImportRecords(session, waveFile([pcm16([1, 2])]));
        expect(imported.sampleCount).toBe(2n);
    });

    it("rejects invalid file sizes", async () => {
        const session = makeSession();
        const bytes = waveFile([pcm16([1, 2])]);

        await expect(
            makeWaveImportRecords(session, { ...bytes, size: Number.NaN }),
        ).rejects.toThrow(/file size is invalid/u);
        await expect(makeWaveImportRecords(session, { ...bytes, size: 11 })).rejects.toThrow(
            /file size is invalid/u,
        );
    });

    it("imports unsigned 8-bit PCM", async () => {
        const session = makeSession();
        const imported = await makeWaveImportRecords(
            session,
            waveFile([new Uint8Array([0, 128, 255])], 8),
        );
        expect(imported.sampleFormat).toBe("pcm_u8");
        expect(imported.sampleCount).toBe(3n);
    });

    it("imports 24-bit and 32-bit PCM", async () => {
        const session = makeSession();
        const pcm24 = await makeWaveImportRecords(session, waveFile([new Uint8Array(6)], 24));
        const pcm32 = await makeWaveImportRecords(session, waveFile([new Uint8Array(8)], 32));
        expect(pcm24.sampleFormat).toBe("pcm_s24le");
        expect(pcm32.sampleFormat).toBe("pcm_s32le");
    });

    it("rejects a non-RIFF container", async () => {
        await expect(
            makeWaveImportRecords(makeSession(), waveFile([pcm16([1, 2])], 16, "junk.wav", true)),
        ).rejects.toThrow(/little-endian RIFF\/WAVE/u);
    });

    it("rejects an incomplete trailing chunk header", async () => {
        const bytes = new Uint8Array(16);
        bytes.set(ascii("RIFF"), 0);
        bytes.set(ascii("WAVE"), 8);
        new DataView(bytes.buffer).setUint32(4, 8, true);
        await expect(
            makeWaveImportRecords(makeSession(), fromBytes(bytes, "short.wav")),
        ).rejects.toThrow(/incomplete chunk header/u);
    });

    it("rejects invalid and duplicate format chunks", async () => {
        const tooShort = fromBytes(
            riffBytes([chunk("fmt ", new Uint8Array(8)), chunk("data", new Uint8Array(4))]),
        );
        await expect(makeWaveImportRecords(makeSession(), tooShort)).rejects.toThrow(
            /format chunk is duplicated or invalid/u,
        );

        const duplicate = fromBytes(
            riffBytes([formatChunk(16), formatChunk(16), chunk("data", new Uint8Array(4))]),
        );
        await expect(makeWaveImportRecords(makeSession(), duplicate)).rejects.toThrow(
            /format chunk is duplicated or invalid/u,
        );
    });

    it("rejects an extensible format with a mismatched GUID", async () => {
        const fmt = formatChunk(16, { extensible: true });
        new DataView(fmt.buffer).setUint8(36, 0xff);
        const file = fromBytes(riffBytes([fmt, chunk("data", pcm16([1, 2]))]));
        await expect(makeWaveImportRecords(makeSession(), file)).rejects.toThrow(
            /extensible formats are supported/u,
        );
    });

    it("rejects unsupported channel counts, sample rates, and alignment", async () => {
        for (const options of [
            { channels: 0 },
            { channels: 9 },
            { rate: 7_999 },
            { rate: 384_001 },
            { blockAlign: 4 },
            { byteRate: 1 },
        ]) {
            const file = fromBytes(
                riffBytes([formatChunk(16, options), chunk("data", pcm16([1, 2]))]),
            );
            await expect(makeWaveImportRecords(makeSession(), file)).rejects.toThrow(
                /outside supported limits|inconsistent/u,
            );
        }
    });

    it("rejects a RIFF length below the minimum header", async () => {
        const bytes = riffBytes([formatChunk(16), chunk("data", pcm16([1, 2]))]);
        new DataView(bytes.buffer).setUint32(4, 0, true);
        await expect(makeWaveImportRecords(makeSession(), fromBytes(bytes))).rejects.toThrow(
            /RIFF length exceeds/u,
        );
    });

    it("requires a format chunk and nonempty data", async () => {
        await expect(
            makeWaveImportRecords(
                makeSession(),
                fromBytes(riffBytes([chunk("data", pcm16([1, 2]))])),
            ),
        ).rejects.toThrow(/one format chunk and nonempty audio data/u);
        await expect(
            makeWaveImportRecords(makeSession(), fromBytes(riffBytes([formatChunk(16)]))),
        ).rejects.toThrow(/one format chunk and nonempty audio data/u);
    });

    it("rejects data that does not contain whole sample frames", async () => {
        const file = fromBytes(
            riffBytes([formatChunk(16), chunk("data", new Uint8Array([1, 2, 3]))]),
        );
        await expect(makeWaveImportRecords(makeSession(), file)).rejects.toThrow(
            /incomplete audio frame/u,
        );
    });

    it("rejects a data chunk that runs past the declared RIFF length", async () => {
        const bytes = riffBytes([formatChunk(16), chunk("data", pcm16([1, 2]))]);
        new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 10, true);
        await expect(makeWaveImportRecords(makeSession(), fromBytes(bytes))).rejects.toThrow(
            /extends beyond/u,
        );
    });

    it("cleans control characters and directory components from the filename", async () => {
        const imported = await makeWaveImportRecords(
            makeSession(),
            waveFile([pcm16([1, 2])], 16, "C:\\recordings\\lesson\u0001one.wav"),
        );
        const track = imported.records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "audio-track",
        );
        expect(track?.fields.get("label")).toBe("lesson one.wav");
    });

    it("rejects an empty filename", async () => {
        await expect(
            makeWaveImportRecords(makeSession(), waveFile([pcm16([1, 2])], 16, "/")),
        ).rejects.toThrow(/filename must contain/u);
    });

    it("uses a caller-supplied codec and filename", async () => {
        const imported = await makeWaveImportRecords(
            makeSession(),
            waveFile([pcm16([1, 2])]),
            false,
            [],
            { sourceFilename: "custom.wav", sourceCodec: "custom-codec" },
        );
        const chunk = imported.records.find((record) => record.type === RecordType.audioChunk);
        expect(chunk?.fields.get("source_codec")).toBe("custom-codec");
        expect(chunk?.fields.get("source_filename")).toBe("custom.wav");
    });

    it("reports interrupted imports before the first chunk as failed", async () => {
        const session = makeSession();
        const file = waveFile([pcm16([1, 2])]);
        const dataPayload = 44;
        const commits: { generation: bigint; records: readonly ArchiveRecord[] }[] = [];

        await expect(
            makeWaveImportRecordsIncremental({
                session,
                file: failingRange(file, dataPayload, new Error("simulated failure")),
                expectedGeneration: 0n,
                commit: async (records, generation) => {
                    commits.push({ generation, records });
                    return [...records];
                },
            }),
        ).rejects.toThrow(/simulated failure/u);

        const interrupted = commits.at(-1)!.records;
        expect(
            interrupted
                .find((record) => record.type === RecordType.session)
                ?.fields.get("audio_import_state"),
        ).toBe("interrupted");
        const take = interrupted.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        );
        expect(take?.fields.get("state")).toBe("failed");
        const track = interrupted.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "audio-track",
        );
        expect(track?.fields.get("state")).toBe("failed");
    });

    it("wraps non-Error failures and reports a non-Error persist failure", async () => {
        const file = waveFile([pcm16([1, 2])]);
        let calls = 0;

        await expect(
            makeWaveImportRecordsIncremental({
                session: makeSession(),
                file: failingRange(file, 44, "boom"),
                expectedGeneration: 0n,
                commit: async (records) => {
                    calls += 1;
                    if (calls > 1) throw "disk full";
                    return [...records];
                },
            }),
        ).rejects.toThrow(/boom Unable to persist interrupted state: disk full/u);
    });

    it("reports an Error persist failure with its message", async () => {
        const file = waveFile([pcm16([1, 2])]);
        let calls = 0;

        await expect(
            makeWaveImportRecordsIncremental({
                session: makeSession(),
                file: failingRange(file, 44, new Error("read failed")),
                expectedGeneration: 0n,
                commit: async (records) => {
                    calls += 1;
                    if (calls > 1) throw new Error("disk full");
                    return [...records];
                },
            }),
        ).rejects.toThrow(/read failed Unable to persist interrupted state: disk full/u);
    });

    it("rejects a source that changes size between reads", async () => {
        const file = waveFile([pcm16([1, 2])]);
        await expect(
            makeWaveImportRecords(makeSession(), {
                name: file.name,
                size: file.size,
                slice: () => new Blob([new Uint8Array(1)]),
            }),
        ).rejects.toThrow(/changed during import/u);
    });

    it("rejects a range reader that returns a different length", async () => {
        const file = waveFile([pcm16([1, 2])]);
        await expect(
            makeWaveImportRecords(makeSession(), {
                name: file.name,
                size: file.size,
                slice: (start, end) => file.slice(start, end),
                readRange: async (offset, length) => {
                    if (offset >= 44) return new Uint8Array(length - 1);
                    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
                },
            }),
        ).rejects.toThrow(/changed during import/u);
    });

    it("treats invalid prior counter fields as zero", async () => {
        const existingTrackId = crypto.randomUUID();
        const session = makeSession(
            new Map([
                ["recording_track_id", existingTrackId],
                ["recording_track_ids", existingTrackId],
                ["recording_audio_chunks", "not-a-number"],
                ["recording_bytes", "also-bad"],
                ["recording_duration_us", "-5"],
            ]),
        );
        const imported = await makeWaveImportRecords(session, waveFile([pcm16([1, 2])]), true, [
            existingTrackId,
        ]);
        const updated = imported.records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("recording_audio_chunks")).toBe("1");
        expect(updated.fields.get("recording_bytes")).toBe("4");
        expect(updated.fields.get("recording_duration_us")).toBe("250");
    });

    it("treats an unsafe prior chunk count as zero", async () => {
        const existingTrackId = crypto.randomUUID();
        const session = makeSession(
            new Map([
                ["recording_track_id", existingTrackId],
                ["recording_track_ids", existingTrackId],
                ["recording_audio_chunks", "9007199254740992"],
            ]),
        );
        const imported = await makeWaveImportRecords(session, waveFile([pcm16([1, 2])]), true, [
            existingTrackId,
        ]);
        const updated = imported.records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("recording_audio_chunks")).toBe("1");
    });

    it("keeps the original session when a commit omits it", async () => {
        const result = await makeWaveImportRecordsIncremental({
            session: makeSession(),
            file: waveFile([pcm16([1, 2])]),
            expectedGeneration: 0n,
            commit: async () => [],
        });
        expect(result.chunkCount).toBe(1);
    });

    it("ignores known track identifiers that are not UUIDs", async () => {
        const imported = await makeWaveImportRecords(
            makeSession(),
            waveFile([pcm16([1, 2])]),
            true,
            ["not-a-uuid"],
        );
        expect(imported.sampleCount).toBe(2n);
    });

    it("skips unknown RIFF chunks before the audio data", async () => {
        const bytes = riffBytes([
            formatChunk(16),
            chunk("JUNK", new Uint8Array([1, 2])),
            chunk("data", pcm16([1, 2])),
        ]);
        const imported = await makeWaveImportRecords(makeSession(), fromBytes(bytes));
        expect(imported.sampleCount).toBe(2n);
    });

    it("fails when the source shrinks after the format was inspected", async () => {
        const base = waveFile([pcm16([1, 2])]);
        let sizeReads = 0;
        const shrinking: WaveFile = {
            name: base.name,
            get size(): number {
                sizeReads += 1;
                return sizeReads < 6 ? base.size : 0;
            },
            slice: (start, end) => base.slice(start, end),
        };
        await expect(makeWaveImportRecords(makeSession(), shrinking)).rejects.toThrow(
            /ended before the requested data could be read/u,
        );
    });
});

function makeSession(fields: ReadonlyMap<string, string> = new Map()): FixtureRecord {
    return {
        type: RecordType.session,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["student_id", "anonymous"],
            ["title", "WAV edge session"],
            ["recording_state", "not-started"],
            ...fields,
        ]),
        blob: new Uint8Array(),
    };
}

function waveFile(
    dataChunks: readonly Uint8Array[],
    bitsPerSample = 16,
    name = "edge.wav",
    junkMagic = false,
): WaveFile {
    const chunks = [formatChunk(bitsPerSample), ...dataChunks.map((data) => chunk("data", data))];
    const bytes = riffBytes(chunks);
    if (junkMagic) bytes.set(ascii("RIFX"), 0);
    return fromBytes(bytes, name);
}

function fromBytes(bytes: Uint8Array, name = "edge.wav"): WaveFile {
    const blob = new Blob([bytes as BlobPart]);
    return { name, size: bytes.byteLength, slice: (start, end) => blob.slice(start, end) };
}

function failingRange(file: WaveFile, threshold: number, failure: unknown): WaveFile {
    return {
        name: file.name,
        size: file.size,
        slice: (start, end) => file.slice(start, end),
        readRange: async (offset, length) => {
            if (offset >= threshold) throw failure;
            return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
        },
    };
}

function riffBytes(chunks: readonly Uint8Array[]): Uint8Array {
    const body = joinBytes([ascii("WAVE"), ...chunks]);
    const header = new Uint8Array(8);
    header.set(ascii("RIFF"), 0);
    new DataView(header.buffer).setUint32(4, body.byteLength, true);
    return joinBytes([header, body]);
}

function formatChunk(
    bitsPerSample: number,
    options: {
        channels?: number;
        rate?: number;
        blockAlign?: number;
        byteRate?: number;
        extensible?: boolean;
    } = {},
): Uint8Array {
    const channels = options.channels ?? 1;
    const rate = options.rate ?? SAMPLE_RATE;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = options.blockAlign ?? channels * bytesPerSample;
    const fmt = new Uint8Array(options.extensible ? 40 : 16);
    const view = new DataView(fmt.buffer);
    view.setUint16(0, options.extensible ? 0xfffe : 1, true);
    view.setUint16(2, channels, true);
    view.setUint32(4, rate, true);
    view.setUint32(8, options.byteRate ?? rate * blockAlign, true);
    view.setUint16(12, blockAlign, true);
    view.setUint16(14, bitsPerSample, true);
    if (options.extensible) {
        view.setUint16(16, 22, true);
        view.setUint16(18, bitsPerSample, true);
        view.setUint32(20, 0, true);
        view.setUint32(24, 1, true);
        fmt.set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 28);
    }
    return chunk("fmt ", fmt);
}

function chunk(name: string, payload: Uint8Array): Uint8Array {
    const header = new Uint8Array(8);
    header.set(ascii(name), 0);
    new DataView(header.buffer).setUint32(4, payload.byteLength, true);
    return joinBytes(
        payload.byteLength % 2 ? [header, payload, new Uint8Array(1)] : [header, payload],
    );
}

function pcm16(samples: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    return bytes;
}

function ascii(value: string): Uint8Array {
    return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function joinBytes(values: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
    let offset = 0;
    for (const value of values) {
        result.set(value, offset);
        offset += value.byteLength;
    }
    return result;
}
