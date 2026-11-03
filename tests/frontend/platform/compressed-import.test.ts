import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockState {
    tauri: boolean;
    calls: { command: string; args: Record<string, unknown> }[];
    handler: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const state = vi.hoisted((): MockState => ({
    tauri: true,
    calls: [],
    handler: async () => undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
    isTauri: () => state.tauri,
    invoke: (command: string, args?: Record<string, unknown>) => {
        state.calls.push({ command, args: args ?? {} });
        return state.handler(command, args);
    },
}));

import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    compressedAudioCodec,
    DESKTOP_AUDIO_IMPORT_ACCEPT,
    DESKTOP_AUDIO_IMPORT_EXTENSIONS,
    importCompressedAudio,
    importCompressedAudioRecords,
} from "../../../frontend/audio/compressed-import";

const BASE64_PCM = btoa(String.fromCharCode(0, 0, 1, 0));
const SECOND_PCM = btoa(String.fromCharCode(2, 0, 3, 0));

function decoded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        sourceFilename: "lesson.flac",
        sourceCodec: "flac",
        sampleRateHz: 8_000,
        channelCount: 1,
        channelMask: 0,
        sampleFormat: "pcm_s16le",
        sampleCount: "4",
        byteCount: 8,
        chunkCount: 2,
        durationUs: "500",
        chunks: [
            { sequence: 0, firstSampleIndex: "0", frameCount: "2", pcmBase64: BASE64_PCM },
            { sequence: 1, firstSampleIndex: "2", frameCount: "2", pcmBase64: SECOND_PCM },
        ],
        ...overrides,
    };
}

function makeSession(fields: ReadonlyMap<string, string> = new Map()): ArchiveRecord {
    return {
        type: RecordType.session,
        id: crypto.randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["student_id", "anonymous"],
            ["title", "Compressed audio"],
            ["session_state", "completed"],
            ["recording_state", "not-started"],
            ...fields,
        ]),
        blob: new Uint8Array(),
    };
}

beforeEach(() => {
    state.tauri = true;
    state.calls = [];
    state.handler = async () => decoded();
});

describe("compressed audio import", () => {
    it("recognizes only the supported compressed extensions", () => {
        expect(compressedAudioCodec("a.FLAC")).toBe("flac");
        expect(compressedAudioCodec("a.mp3")).toBe("mp3");
        expect(compressedAudioCodec("take.final.m4a")).toBe("m4a");
        expect(compressedAudioCodec("take.wav")).toBeUndefined();
        expect(compressedAudioCodec("no-extension")).toBeUndefined();
        expect(DESKTOP_AUDIO_IMPORT_EXTENSIONS).toContain(".m4a");
        expect(DESKTOP_AUDIO_IMPORT_ACCEPT).toContain("audio/flac");
    });

    it("requires the desktop app", async () => {
        state.tauri = false;
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(/desktop app/u);
    });

    it("passes an optional FFmpeg path and builds a virtual WAV header", async () => {
        const prepared = await importCompressedAudio("song.flac", "ffmpeg");
        expect(state.calls).toEqual([
            {
                command: "import_compressed_audio",
                args: { path: "song.flac", ffmpegPath: "ffmpeg" },
            },
        ]);
        expect(prepared.sourceCodec).toBe("flac");
        expect(prepared.sourceFilename).toBe("lesson.flac");
        expect(prepared.waveFile.size).toBe(44 + 8);
        expect(() => prepared.waveFile.slice()).toThrow(/bounded range reader/u);
        await expect(prepared.cleanup()).resolves.toBeUndefined();

        const header = await prepared.waveFile.readRange!(0, 4);
        expect(new TextDecoder().decode(header)).toBe("RIFF");
        const entireHeader = await prepared.waveFile.readRange!(0, 10_000);
        expect(entireHeader.byteLength).toBe(44);
        const view = new DataView(entireHeader.buffer, entireHeader.byteOffset);
        expect(view.getUint16(20, true)).toBe(1);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(24, true)).toBe(8_000);
        expect(view.getUint32(40, true)).toBe(8);

        const data = await prepared.waveFile.readRange!(44, 8);
        expect([...data]).toEqual([0, 0, 1, 0, 2, 0, 3, 0]);
    });

    it("writes an extensible header when a channel mask is present", async () => {
        state.handler = async () =>
            decoded({ channelMask: 3, sourceFilename: "stereo.m4a", sourceCodec: "m4a" });
        const prepared = await importCompressedAudio("stereo.m4a");
        expect(prepared.sourceCodec).toBe("m4a");
        const header = await prepared.waveFile.readRange!(0, 68);
        const view = new DataView(header.buffer, header.byteOffset);
        expect(view.getUint16(20, true)).toBe(0xfffe);
        expect(view.getUint16(36, true)).toBe(22);
        expect(view.getUint32(40, true)).toBe(3);
        expect(header[48]).toBe(0x00);
        expect(header[49]).toBe(0x00);
        expect(header[50]).toBe(0x10);
        expect(header[51]).toBe(0x00);
        expect(header[52]).toBe(0x80);
        expect(header[53]).toBe(0x00);
        expect((await prepared.waveFile.readRange!(4, 2)).byteLength).toBe(2);
    });

    it("omits the source codec for an unknown extension", async () => {
        state.handler = async () => decoded({ sourceFilename: "capture.bin" });
        const prepared = await importCompressedAudio("capture.bin");
        expect(prepared.sourceCodec).toBeUndefined();
    });

    it("rejects decoded audio whose byte count does not match the samples", async () => {
        state.handler = async () => decoded({ byteCount: 9 });
        await expect(importCompressedAudio("bad.flac")).rejects.toThrow(
            /does not match its sample count/u,
        );
    });

    it("rejects a chunk whose decoded length disagrees with its frame count", async () => {
        state.handler = async () =>
            decoded({
                chunks: [
                    { sequence: 0, firstSampleIndex: "0", frameCount: "3", pcmBase64: BASE64_PCM },
                ],
                chunkCount: 1,
            });
        const prepared = await importCompressedAudio("bad.flac");
        await expect(prepared.waveFile.readRange!(44, 4)).rejects.toThrow(/invalid length/u);
    });

    it("rejects a sparse decoded chunk list", async () => {
        state.handler = async () => {
            const value = decoded({ chunks: new Array(1), chunkCount: 1 });
            return value;
        };
        const prepared = await importCompressedAudio("sparse.flac");
        await expect(prepared.waveFile.readRange!(44, 2)).rejects.toThrow(
            /ended before the requested data/u,
        );
    });

    it("rejects gaps between decoded chunk boundaries", async () => {
        state.handler = async () =>
            decoded({
                chunks: [
                    { sequence: 0, firstSampleIndex: "0", frameCount: "2", pcmBase64: BASE64_PCM },
                    {
                        sequence: 1,
                        firstSampleIndex: "10",
                        frameCount: "2",
                        pcmBase64: SECOND_PCM,
                    },
                ],
            });
        const prepared = await importCompressedAudio("gap.flac");
        await expect(prepared.waveFile.readRange!(44, 6)).rejects.toThrow(
            /boundaries are inconsistent/u,
        );
    });

    it("maps FFmpeg failures to an actionable message", async () => {
        state.handler = async () => {
            throw new Error("spawn ffmpeg ENOENT");
        };
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(
            /requires FFmpeg with the FLAC, MP3, and M4A decoders/u,
        );
    });

    it("maps a non-Error FFmpeg failure to an actionable message", async () => {
        state.handler = async () => {
            throw "ffmpeg is missing";
        };
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(/requires FFmpeg/u);
    });

    it("rethrows ordinary errors and wraps non-Error failures", async () => {
        const failure = new Error("decoder crashed");
        state.handler = async () => {
            throw failure;
        };
        await expect(importCompressedAudio("song.mp3")).rejects.toBe(failure);

        state.handler = async () => {
            throw "decoder crashed";
        };
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow("decoder crashed");
    });

    it("rejects unsupported importer results", async () => {
        state.handler = async () => null;
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(/unsupported result/u);
        state.handler = async () => ({ chunks: "nope" });
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(/unsupported result/u);
    });

    it("validates the decoded metadata", async () => {
        const invalid: Record<string, unknown>[] = [
            decoded({ sourceFilename: "" }),
            decoded({ sourceFilename: 7 }),
            decoded({ sourceCodec: "" }),
            decoded({ sampleRateHz: 0 }),
            decoded({ sampleRateHz: "8000" }),
            decoded({ channelCount: 0 }),
            decoded({ sampleFormat: "pcm_f32le" }),
            decoded({ sampleCount: "" }),
            decoded({ byteCount: 1 }),
            decoded({ chunkCount: 0 }),
        ];
        for (const value of invalid) {
            state.handler = async () => value;
            await expect(importCompressedAudio("song.mp3")).rejects.toThrow(
                /invalid decoded audio metadata/u,
            );
        }
    });

    it("defaults a missing duration to zero", async () => {
        state.handler = async () => decoded({ durationUs: 5 });
        const prepared = await importCompressedAudio("song.flac");
        expect(prepared.waveFile.name).toBe("lesson.flac");
    });

    it("validates each decoded audio chunk", async () => {
        const invalidChunks: unknown[] = [
            null,
            { sequence: 1, firstSampleIndex: "0", frameCount: "2", pcmBase64: BASE64_PCM },
            { sequence: 0, firstSampleIndex: "", frameCount: "2", pcmBase64: BASE64_PCM },
            { sequence: 0, firstSampleIndex: "0", frameCount: "", pcmBase64: BASE64_PCM },
            { sequence: 0, firstSampleIndex: "0", frameCount: "2", pcmBase64: "" },
            {
                sequence: 0,
                firstSampleIndex: "0",
                frameCount: "2",
                pcmBase64: "A".repeat(2 * 1024 * 1024 + 1),
            },
        ];
        for (const chunk of invalidChunks) {
            state.handler = async () => decoded({ chunks: [chunk], chunkCount: 1 });
            await expect(importCompressedAudio("song.mp3")).rejects.toThrow(/invalid audio chunk/u);
        }
    });

    it("rejects an incomplete chunk list", async () => {
        state.handler = async () => decoded({ chunkCount: 3 });
        await expect(importCompressedAudio("song.mp3")).rejects.toThrow(
            /incomplete audio chunk list/u,
        );
    });

    it("builds archive records and runs cleanup", async () => {
        const session = makeSession();
        const result = await importCompressedAudioRecords(session, "song.mp3", {
            allowAdditionalTrack: true,
            knownTrackIds: [],
            ffmpegPath: "ffmpeg",
        });
        expect(result.sampleCount).toBe(4n);
        expect(result.sampleRateHz).toBe(8_000);
        expect(result.records.some((record) => record.fields.get("source_codec") === "flac")).toBe(
            true,
        );
        expect(state.calls[0]!.args["ffmpegPath"]).toBe("ffmpeg");
    });

    it("imports with default options and no source codec", async () => {
        state.handler = async () => decoded({ sourceFilename: "capture.bin" });
        const result = await importCompressedAudioRecords(makeSession(), "capture.bin");
        expect(result.sampleCount).toBe(4n);
        expect(result.records.some((record) => record.fields.get("source_codec") === "bin")).toBe(
            false,
        );
    });

    it("still cleans up when archive record creation fails", async () => {
        const session = {
            ...makeSession(),
            type: RecordType.assetMetadata,
        } as ArchiveRecord;
        await expect(importCompressedAudioRecords(session, "song.flac")).rejects.toThrow();
    });
});
