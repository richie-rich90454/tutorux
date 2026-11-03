import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { crc32, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    buildAudioPreview,
    buildAudioTrackPcmRangeStream,
    buildAudioTrackWavExport,
    buildAudioTrackWavStream,
    listSessionAudioTracks,
} from "../../../frontend/domain/audio";

const U64_MAX = 18_446_744_073_709_551_615n;
const SESSION = "11111111-1111-4111-8111-111111111111";
const TRACK = "22222222-2222-4222-8222-222222222222";

interface ChunkOptions {
    id?: string;
    sequence?: number;
    firstFrame?: number | string | bigint;
    frameCount?: number;
    gap?: number | string | bigint;
    sampleFormat?: string;
    sampleRate?: number;
    channels?: number;
    blob?: Uint8Array;
    fields?: Record<string, string>;
    revision?: bigint;
    sessionId?: string;
    trackId?: string;
}

function trackId(): string {
    return crypto.randomUUID();
}

function pcmBytes(frames: number, channels: number, bytesPerSample: number): Uint8Array {
    return new Uint8Array(frames * channels * bytesPerSample);
}

function makeChunk(options: ChunkOptions = {}): ArchiveRecord & { fields: Map<string, string> } {
    const sampleFormat = options.sampleFormat ?? "pcm_s16le";
    const channels = options.channels ?? 1;
    const bytesPerSample =
        sampleFormat === "pcm_u8"
            ? 1
            : sampleFormat === "pcm_s24le"
              ? 3
              : sampleFormat === "pcm_s16le"
                ? 2
                : 4;
    const frameCount = options.frameCount ?? 1;
    const blob = options.blob ?? pcmBytes(frameCount, channels, bytesPerSample);
    const fields = new Map<string, string>([
        ["session_id", options.sessionId ?? SESSION],
        ["track_id", options.trackId ?? TRACK],
        ["sequence_number", String(options.sequence ?? 0)],
        ["first_sample_index", String(options.firstFrame ?? 0)],
        ["sample_count", String(frameCount)],
        ["sample_rate_hz", String(options.sampleRate ?? 8_000)],
        ["channel_count", String(channels)],
        ["sample_format", sampleFormat],
        ["codec", "none"],
        ["payload_checksum", String(crc32(blob))],
    ]);
    if (options.gap !== undefined) fields.set("gap_before_samples", String(options.gap));
    for (const [key, value] of Object.entries(options.fields ?? {})) fields.set(key, value);
    return {
        type: RecordType.audioChunk,
        id: options.id ?? crypto.randomUUID(),
        revision: options.revision ?? 0n,
        previousOffset: 0n,
        fields,
        blob,
    };
}

function fakeSnapshot(
    chunks: readonly ArchiveRecord[],
    options: {
        locked?: boolean;
        getRecord?: (type: number, id: string) => Promise<ArchiveRecord | null>;
    } = {},
): ArchiveSnapshot {
    return {
        locked: options.locked ?? false,
        listAudioChunkMetadata: async () =>
            chunks.map((chunk) => ({ ...chunk, blob: new Uint8Array() })),
        getRecord:
            options.getRecord ??
            (async (type: number, id: string) =>
                type === RecordType.audioChunk
                    ? (chunks.find((chunk) => chunk.id === id) ?? null)
                    : null),
    } as unknown as ArchiveSnapshot;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function assetMetadata(id: string, fields: Record<string, string>): ArchiveRecord {
    return {
        type: RecordType.assetMetadata,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function sessionRecord(fields: Record<string, string>): ArchiveRecord {
    return {
        type: RecordType.session,
        id: SESSION,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

describe("audio track listing", () => {
    it("resolves track metadata from session fields, indexes, and asset records", () => {
        const t1 = trackId();
        const t2 = trackId();
        const t3 = trackId();
        const t4 = trackId();
        const t5 = trackId();
        const t6 = trackId();
        const t8 = trackId();
        const t10 = trackId();
        const t12 = trackId();
        const unrelated = trackId();

        const session = sessionRecord({
            recording_track_ids: ` ${t1.toUpperCase()} , ${t2} , ${t6},`,
            recording_track_id: t3,
            audio_import_track_id: "",
            recording_source: "wav-import",
            recording_state: "imported",
            recording_sample_format: "pcm_u8",
            recording_sample_rate_hz: "16000",
            recording_channel_count: "2",
        });
        const metadata = [
            assetMetadata(t1, {
                record_role: "audio-track",
                session_id: SESSION.toUpperCase(),
                track_id: t1,
                source: "microphone",
                label: "Mic",
                state: "stored",
                sample_format: "pcm_s16le",
                sample_rate_hz: "8000",
                channel_count: "1",
            }),
            assetMetadata(t2, {
                record_role: "audio-track",
                session_id: SESSION,
                source: "system-audio-loopback",
            }),
            assetMetadata(t4, {
                record_role: "audio-track",
                session_id: SESSION,
                source: "application-audio",
            }),
            assetMetadata(t5, {
                record_role: "audio-track",
                session_id: SESSION,
                source: "custom-source",
            }),
            assetMetadata(t6, {
                record_role: "audio-track",
                session_id: "99999999-9999-4999-8999-999999999999",
                source: "microphone",
            }),
            assetMetadata(t8, {
                record_role: "audio-track",
                session_id: SESSION,
            }),
            assetMetadata(t10, {
                record_role: "audio-track",
                session_id: SESSION,
                _deleted: "true",
            }),
            assetMetadata(t12, {
                record_role: "audio-track",
                session_id: SESSION,
                label: "Numeric",
                source: "wav-import",
                sample_rate_hz: "abc",
                channel_count: "9007199254740992",
            }),
            assetMetadata(unrelated, {
                record_role: "material",
                session_id: SESSION,
            }),
            assetMetadata(trackId(), {
                record_role: "audio-track",
                track_id: trackId(),
            }),
        ];
        const tracks = listSessionAudioTracks(session, metadata, [t4, "not-a-uuid"]);
        const byId = new Map(tracks.map((track) => [track.id, track]));

        expect([...byId.keys()].sort()).toEqual([t1, t2, t3, t4, t5, t6, t8, t12].sort());
        expect(byId.get(t1)).toMatchObject({
            sessionId: SESSION,
            label: "Mic",
            source: "microphone",
            state: "stored",
            sampleFormat: "pcm_s16le",
            sampleRateHz: 8_000,
            channelCount: 1,
        });
        expect(byId.get(t2)).toMatchObject({
            label: "System audio",
            source: "system-audio-loopback",
            state: "imported",
            sampleFormat: "pcm_u8",
            sampleRateHz: 16_000,
            channelCount: 2,
        });
        expect(byId.get(t3)).toMatchObject({
            label: "Imported recording",
            source: "wav-import",
        });
        expect(byId.get(t4)?.label).toBe("Application audio");
        expect(byId.get(t5)?.label).toBe("custom source");
        expect(byId.get(t6)?.label).toBe("Microphone");
        expect(byId.get(t8)?.label).toBe("Imported recording");
        expect(byId.get(t12)).toMatchObject({ sampleRateHz: 0, channelCount: 0 });
    });

    it("falls back to numbered labels and defaults when no metadata exists", () => {
        const id = trackId();
        const tracks = listSessionAudioTracks(sessionRecord({}), [], [id]);
        expect(tracks).toEqual([
            {
                sessionId: SESSION,
                id,
                label: "Track 1",
                source: "",
                state: "stored",
                sampleFormat: "",
                sampleRateHz: 0,
                channelCount: 0,
            },
        ]);
    });
});

describe("audio previews", () => {
    it("rejects locked archives and empty tracks", async () => {
        await expect(
            buildAudioPreview(fakeSnapshot([], { locked: true }), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "archive_locked" });
        await expect(buildAudioPreview(fakeSnapshot([]), SESSION, TRACK, 0n)).rejects.toMatchObject(
            { code: "audio_track_empty" },
        );
    });

    it("rejects inconsistent chunk timelines", async () => {
        const chunks = [makeChunk({ sequence: 1, firstFrame: 0 })];
        await expect(
            buildAudioPreview(fakeSnapshot(chunks), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_timeline_invalid" });
    });

    it("validates the requested playback range", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        const snapshot = fakeSnapshot([chunk]);
        await expect(buildAudioPreview(snapshot, SESSION, TRACK, "10", "5")).rejects.toMatchObject({
            code: "audio_range_invalid",
        });
        await expect(buildAudioPreview(snapshot, SESSION, TRACK, "-1")).rejects.toMatchObject({
            code: "audio_range_invalid",
        });
        await expect(
            buildAudioPreview(snapshot, SESSION, TRACK, (U64_MAX + 1n).toString()),
        ).rejects.toMatchObject({ code: "audio_range_invalid" });
        await expect(buildAudioPreview(snapshot, SESSION, TRACK, 1_000n)).rejects.toMatchObject({
            code: "audio_range_outside_track",
        });
    });

    it("enforces the preview byte limit", async () => {
        const chunk = makeChunk({ frameCount: 17_000_000, blob: new Uint8Array(2) });
        await expect(
            buildAudioPreview(fakeSnapshot([chunk]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_preview_limit" });
    });

    it("rejects chunks that change after indexing", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        await expect(
            buildAudioPreview(
                fakeSnapshot([chunk], { getRecord: async () => null }),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_changed" });

        const changed = { ...chunk, revision: 9n };
        await expect(
            buildAudioPreview(
                fakeSnapshot([chunk], { getRecord: async () => changed }),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_changed" });
    });

    it("rejects unsupported and invalid chunk metadata", async () => {
        await expect(
            buildAudioPreview(
                fakeSnapshot([makeChunk({ sampleFormat: "mp3" })]),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_format_unsupported" });
        const missingFormat = makeChunk({});
        missingFormat.fields.delete("sample_format");
        await expect(
            buildAudioPreview(fakeSnapshot([missingFormat]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_format_unsupported" });
        await expect(
            buildAudioPreview(fakeSnapshot([makeChunk({ sampleRate: 4_000 })]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
        await expect(
            buildAudioPreview(
                fakeSnapshot([makeChunk({ fields: { sequence_number: "x" } })]),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
        await expect(
            buildAudioPreview(
                fakeSnapshot([
                    makeChunk({ fields: { sequence_number: (U64_MAX + 1n).toString() } }),
                ]),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_metadata_invalid" });
    });

    it("converts every supported PCM format to 16-bit output", async () => {
        const cases: {
            format: string;
            blob: Uint8Array;
            bytesPerSample: number;
            expected: number[];
        }[] = [
            {
                format: "pcm_u8",
                blob: new Uint8Array([0, 128, 255]),
                bytesPerSample: 1,
                expected: [-32_768, 0, 32_512],
            },
            {
                format: "pcm_s32le",
                blob: new Uint8Array(12),
                bytesPerSample: 4,
                expected: [0, -32_768, 32_767],
            },
        ];
        const s32 = cases[1]!.blob;
        const s32View = new DataView(s32.buffer);
        s32View.setInt32(4, -2_147_483_648, true);
        s32View.setInt32(8, 2_147_483_647, true);

        for (const testCase of cases) {
            const chunk = makeChunk({
                sampleFormat: testCase.format,
                blob: testCase.blob,
                frameCount: testCase.blob.byteLength / testCase.bytesPerSample,
            });
            const preview = await buildAudioPreview(fakeSnapshot([chunk]), SESSION, TRACK, 0n);
            const view = new DataView(
                preview.wav.buffer,
                preview.wav.byteOffset,
                preview.wav.byteLength,
            );
            expect(
                Array.from({ length: testCase.expected.length }, (_, index) =>
                    view.getInt16(44 + index * 2, true),
                ),
            ).toEqual(testCase.expected);
        }
    });

    it("clamps and sanitizes IEEE float samples", async () => {
        const blob = new Uint8Array(16);
        const view = new DataView(blob.buffer);
        view.setFloat32(0, Number.NaN, true);
        view.setFloat32(4, 2, true);
        view.setFloat32(8, -2, true);
        view.setFloat32(12, 0.5, true);
        const chunk = makeChunk({ sampleFormat: "pcm_f32le", blob, frameCount: 4 });
        const preview = await buildAudioPreview(fakeSnapshot([chunk]), SESSION, TRACK, 0n);
        const output = new DataView(
            preview.wav.buffer,
            preview.wav.byteOffset,
            preview.wav.byteLength,
        );
        expect(
            Array.from({ length: 4 }, (_, index) => output.getInt16(44 + index * 2, true)),
        ).toEqual([0, 32_767, -32_768, 16_384]);
    });

    it("skips chunks outside the requested range", async () => {
        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 2 });
        const second = makeChunk({ sequence: 1, firstFrame: 4, frameCount: 2, gap: 2 });
        const preview = await buildAudioPreview(
            fakeSnapshot([first, second]),
            SESSION,
            TRACK,
            0n,
            250n,
        );
        expect(preview.frameCount).toBe(2);
    });

    it("accepts chunks without an optional gap or checksum", async () => {
        const blob = pcmBytes(2, 1, 2);
        const chunk = makeChunk({ blob, frameCount: 2 });
        chunk.fields.delete("payload_checksum");
        chunk.fields.delete("gap_before_samples");
        const preview = await buildAudioPreview(fakeSnapshot([chunk]), SESSION, TRACK, 0n);
        expect(preview.frameCount).toBe(2);
    });

    it("rejects chunks whose declared length or size is invalid", async () => {
        const wrongLength = makeChunk({ frameCount: 2, blob: new Uint8Array(2) });
        await expect(
            buildAudioPreview(fakeSnapshot([wrongLength]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_chunk_length_invalid" });

        const oversized = makeChunk({ frameCount: 524_289, blob: new Uint8Array(1_048_578) });
        await expect(
            buildAudioPreview(
                fakeSnapshot([oversized], { getRecord: async () => oversized }),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_size_limit" });
    });

    it("rejects chunks whose stored fields no longer match the index", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        const mismatched = {
            ...chunk,
            fields: new Map(chunk.fields).set("codec", "flac"),
        };
        await expect(
            buildAudioPreview(
                fakeSnapshot([chunk], { getRecord: async () => mismatched }),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_invalid" });

        const wrongType = { ...chunk, type: RecordType.assetMetadata };
        await expect(
            buildAudioPreview(
                fakeSnapshot([chunk], { getRecord: async () => wrongType }),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_invalid" });
    });

    it("rejects timeline values that overflow the unsigned 64-bit range", async () => {
        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 1 });
        const overflowGap = makeChunk({
            sequence: 1,
            firstFrame: 0,
            frameCount: 1,
            gap: U64_MAX,
        });
        await expect(
            buildAudioPreview(fakeSnapshot([first, overflowGap]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_timeline_invalid" });

        const overflowFrame = makeChunk({
            sequence: 0,
            firstFrame: 1,
            frameCount: Number.MAX_SAFE_INTEGER,
            gap: 1,
            blob: new Uint8Array(2),
            fields: { sample_count: U64_MAX.toString() },
        });
        await expect(
            buildAudioPreview(fakeSnapshot([overflowFrame]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_timeline_invalid" });
    });
});

describe("audio track WAV export", () => {
    it("rejects locked archives and empty tracks", async () => {
        await expect(
            buildAudioTrackWavExport(fakeSnapshot([], { locked: true }), SESSION, TRACK),
        ).rejects.toMatchObject({ code: "archive_locked" });
        await expect(
            buildAudioTrackWavStream(fakeSnapshot([]), SESSION, TRACK),
        ).rejects.toMatchObject({ code: "audio_track_empty" });
    });

    it("rejects inconsistent timelines and gaps without confirmation", async () => {
        await expect(
            buildAudioTrackWavExport(fakeSnapshot([makeChunk({ sequence: 3 })]), SESSION, TRACK),
        ).rejects.toMatchObject({ code: "audio_timeline_invalid" });

        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 1 });
        const gap = makeChunk({ sequence: 1, firstFrame: 2, frameCount: 1, gap: 1 });
        await expect(
            buildAudioTrackWavExport(fakeSnapshot([first, gap]), SESSION, TRACK, {
                fillGapsWithSilence: false,
            }),
        ).rejects.toMatchObject({ code: "audio_export_gaps_require_confirmation" });
    });

    it("exports stored frames only when silence filling is disabled", async () => {
        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 1 });
        const second = makeChunk({ sequence: 1, firstFrame: 1, frameCount: 2 });
        const exported = await buildAudioTrackWavExport(
            fakeSnapshot([first, second]),
            SESSION,
            TRACK,
            { fillGapsWithSilence: false },
        );
        const wav = await collect(exported.stream);
        expect(exported.dataBytes).toBe(6n);
        expect(exported.sampleCount).toBe(3n);
        expect(new DataView(wav.buffer).getUint32(40, true)).toBe(6);
    });

    it("splits large silence gaps into bounded chunks", async () => {
        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 1 });
        const second = makeChunk({ sequence: 1, firstFrame: 600_001, frameCount: 1, gap: 600_000 });
        const exported = await buildAudioTrackWavExport(
            fakeSnapshot([first, second]),
            SESSION,
            TRACK,
        );
        const wav = await collect(exported.stream);
        expect(wav.byteLength).toBe(44 + 600_002 * 2);
    });

    it("rejects exports that exceed the RF64 size limit", async () => {
        const chunk = makeChunk({
            frameCount: 10_000_000_000_000_000_000,
            blob: new Uint8Array(2),
        });
        await expect(
            buildAudioTrackWavExport(fakeSnapshot([chunk]), SESSION, TRACK),
        ).rejects.toMatchObject({ code: "audio_wav_size_limit" });
    });

    it("writes float and RF64 float headers", async () => {
        const floatChunk = makeChunk({
            sampleFormat: "pcm_f32le",
            frameCount: 1,
            blob: new Uint8Array(4),
        });
        const wav = await collect(
            await buildAudioTrackWavStream(fakeSnapshot([floatChunk]), SESSION, TRACK),
        );
        expect(new DataView(wav.buffer).getUint16(20, true)).toBe(3);

        const hugeFloat = makeChunk({
            sampleFormat: "pcm_f32le",
            frameCount: 1_100_000_000,
            blob: new Uint8Array(4),
        });
        const exported = await buildAudioTrackWavExport(fakeSnapshot([hugeFloat]), SESSION, TRACK);
        const reader = exported.stream.getReader();
        const header = await reader.read();
        const bytes = header.value!;
        expect(exported.rf64).toBe(true);
        expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RF64");
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(56, true)).toBe(3);
        await reader.cancel().catch(() => undefined);
    });

    it("propagates chunk changes and supports cancellation", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        const exported = await buildAudioTrackWavExport(
            fakeSnapshot([chunk], { getRecord: async () => null }),
            SESSION,
            TRACK,
        );
        await expect(collect(exported.stream)).rejects.toMatchObject({
            code: "audio_chunk_changed",
        });

        const cancellable = await buildAudioTrackWavExport(fakeSnapshot([chunk]), SESSION, TRACK);
        await expect(cancellable.stream.cancel()).resolves.toBeUndefined();
    });
});

describe("audio PCM range streaming", () => {
    it("rejects locked archives, invalid ranges, and empty tracks", async () => {
        await expect(
            buildAudioTrackPcmRangeStream(fakeSnapshot([], { locked: true }), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "archive_locked" });
        const chunk = makeChunk({ frameCount: 2 });
        await expect(
            buildAudioTrackPcmRangeStream(fakeSnapshot([chunk]), SESSION, TRACK, -1n),
        ).rejects.toMatchObject({ code: "audio_range_invalid" });
        await expect(
            buildAudioTrackPcmRangeStream(fakeSnapshot([chunk]), SESSION, TRACK, 0n, 0n),
        ).rejects.toMatchObject({ code: "audio_playback_duration_invalid" });
        await expect(
            buildAudioTrackPcmRangeStream(fakeSnapshot([]), SESSION, TRACK, 0n),
        ).rejects.toMatchObject({ code: "audio_track_not_found" });
    });

    it("rejects unsupported formats and invalid timelines", async () => {
        await expect(
            buildAudioTrackPcmRangeStream(
                fakeSnapshot([makeChunk({ sampleFormat: "pcm_f32le", blob: new Uint8Array(4) })]),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_timeline_format_unsupported" });

        await expect(
            buildAudioTrackPcmRangeStream(
                fakeSnapshot([makeChunk({ sequence: 2 })]),
                SESSION,
                TRACK,
                0n,
            ),
        ).rejects.toMatchObject({ code: "audio_timeline_sequence_invalid" });
    });

    it("validates the seek position", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        await expect(
            buildAudioTrackPcmRangeStream(fakeSnapshot([chunk]), SESSION, TRACK, 3n),
        ).rejects.toMatchObject({ code: "audio_timeline_seek_invalid" });

        const atEnd = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([chunk]),
            SESSION,
            TRACK,
            2n,
        );
        expect(atEnd.playedFrames).toBe(0n);
        expect((await collect(atEnd.stream)).byteLength).toBe(0);
    });

    it("streams the complete timeline with gap silence", async () => {
        const first = makeChunk({
            sequence: 0,
            firstFrame: 0,
            frameCount: 2,
            blob: new Uint8Array([1, 0, 2, 0]),
        });
        const second = makeChunk({
            sequence: 1,
            firstFrame: 4,
            frameCount: 1,
            gap: 2,
            blob: new Uint8Array([3, 0]),
        });
        const result = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([first, second]),
            SESSION,
            TRACK,
            0n,
        );
        const bytes = await collect(result.stream);
        expect(result).toMatchObject({
            trackId: TRACK,
            sampleRateHz: 8_000,
            channelCount: 1,
            timelineFrameCount: 5n,
            startFrame: 0n,
            playedFrames: 5n,
            gapFramesPlayed: 2n,
        });
        expect(Array.from(bytes)).toEqual([1, 0, 2, 0, 0, 0, 0, 0, 3, 0]);
    });

    it("caps playback to the requested duration", async () => {
        const first = makeChunk({
            sequence: 0,
            firstFrame: 0,
            frameCount: 2,
            blob: new Uint8Array([1, 0, 2, 0]),
        });
        const second = makeChunk({ sequence: 1, firstFrame: 2, frameCount: 2 });
        const result = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([first, second]),
            SESSION,
            TRACK,
            1n,
            2n,
        );
        expect(result.playedFrames).toBe(2n);
        const bytes = await collect(result.stream);
        expect(Array.from(bytes)).toEqual([2, 0, 0, 0]);
    });

    it("splits large gaps and skips chunks outside the range", async () => {
        const first = makeChunk({ sequence: 0, firstFrame: 0, frameCount: 1 });
        const second = makeChunk({
            sequence: 1,
            firstFrame: 600_001,
            frameCount: 1,
            gap: 600_000,
        });
        const beyond = makeChunk({ sequence: 2, firstFrame: 600_002, frameCount: 1 });
        const result = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([first, second, beyond]),
            SESSION,
            TRACK,
            0n,
            600_002n,
        );
        expect(result.playedFrames).toBe(600_002n);
        expect(result.gapFramesPlayed).toBe(600_000n);
        const bytes = await collect(result.stream);
        expect(bytes.byteLength).toBe(600_002 * 2);
    });

    it("rejects chunks that change or do not belong to the track", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        await expect(
            collect(
                (
                    await buildAudioTrackPcmRangeStream(
                        fakeSnapshot([chunk], { getRecord: async () => null }),
                        SESSION,
                        TRACK,
                        0n,
                    )
                ).stream,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_changed" });

        const changed = { ...chunk, revision: 5n };
        await expect(
            collect(
                (
                    await buildAudioTrackPcmRangeStream(
                        fakeSnapshot([chunk], { getRecord: async () => changed }),
                        SESSION,
                        TRACK,
                        0n,
                    )
                ).stream,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_changed" });

        const wrongSession = makeChunk({
            frameCount: 2,
            sessionId: "99999999-9999-4999-8999-999999999999",
        });
        await expect(
            collect(
                (
                    await buildAudioTrackPcmRangeStream(
                        fakeSnapshot([wrongSession]),
                        SESSION,
                        TRACK,
                        0n,
                    )
                ).stream,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_invalid" });

        const wrongTrack = makeChunk({
            frameCount: 2,
            trackId: "99999999-9999-4999-8999-999999999999",
        });
        await expect(
            collect(
                (
                    await buildAudioTrackPcmRangeStream(
                        fakeSnapshot([wrongTrack]),
                        SESSION,
                        TRACK,
                        0n,
                    )
                ).stream,
            ),
        ).rejects.toMatchObject({ code: "audio_chunk_invalid" });
    });

    it("propagates stream failures and supports cancellation", async () => {
        const chunk = makeChunk({ frameCount: 2 });
        const failing = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([chunk], { getRecord: async () => null }),
            SESSION,
            TRACK,
            0n,
        );
        await expect(collect(failing.stream)).rejects.toMatchObject({
            code: "audio_chunk_changed",
        });

        const cancellable = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([chunk]),
            SESSION,
            TRACK,
            0n,
        );
        await expect(cancellable.stream.cancel()).resolves.toBeUndefined();
    });

    it("clamps durations that exceed the unsigned 64-bit range", async () => {
        const chunk = makeChunk({
            frameCount: 200_000_000_000_000_000,
            blob: new Uint8Array(2),
        });
        const result = await buildAudioTrackPcmRangeStream(
            fakeSnapshot([chunk]),
            SESSION,
            TRACK,
            0n,
        );
        expect(result.durationUs).toBe(U64_MAX);
        await expect(result.stream.cancel()).resolves.toBeUndefined();
    });
});
