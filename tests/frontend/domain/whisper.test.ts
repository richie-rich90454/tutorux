import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import type { AudioPreview } from "../../../frontend/domain/audio";
import { makeWhisperRecords, whisperAudio } from "../../../frontend/domain/whisper";

const preview: AudioPreview = {
    wav: new Uint8Array(44 + 32_000),
    sampleRateHz: 16_000,
    channelCount: 1,
    frameCount: 16_000,
    startFrame: 0n,
    durationUs: 1_000_000n,
};

function whisperJson(language?: string): string {
    return JSON.stringify({
        ...(language === undefined ? {} : { result: { language } }),
        transcription: [{ text: "Hello", offsets: { from: 0, to: 500 } }],
    });
}

function pcmWav(values: readonly number[], channels = 1, rate = 16_000): AudioPreview {
    const bytes = new Uint8Array(44 + values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setInt16(44 + index * 2, value, true));
    return {
        wav: bytes,
        sampleRateHz: rate,
        channelCount: channels,
        frameCount: Math.floor(values.length / channels),
        startFrame: 0n,
        durationUs: 1_000_000n,
    };
}

function segment(
    id: string,
    fields: Record<string, string>,
    type: number = RecordType.transcriptSegment,
): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(Object.entries(fields)),
    };
}

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const trackId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeInput(overrides: Record<string, unknown> = {}) {
    return {
        json: whisperJson(),
        sessionId,
        trackId,
        modelName: "ggml-small.bin",
        language: "en",
        preview,
        existing: [] as readonly ArchiveRecord[],
        ...overrides,
    };
}

describe("Whisper transcript records", () => {
    it("stores the language detected by whisper.cpp instead of the requested auto", () => {
        const result = makeWhisperRecords(makeInput({ json: whisperJson("fr"), language: "auto" }));

        expect(result.records).toHaveLength(1);
        expect(result.records[0]!.fields.get("language")).toBe("fr");
    });

    it("keeps the requested language when detection is not reported", () => {
        const result = makeWhisperRecords(makeInput());

        expect(result.records[0]!.fields.get("language")).toBe("en");
    });

    it("ignores malformed detected language metadata", () => {
        expect(
            makeWhisperRecords(
                makeInput({ json: whisperJson("not a language code!") }),
            ).records[0]!.fields.get("language"),
        ).toBe("en");
        expect(
            makeWhisperRecords(
                makeInput({ json: JSON.stringify({ result: null, transcription: [] }) }),
            ).records,
        ).toEqual([]);
        expect(
            makeWhisperRecords(
                makeInput({ json: JSON.stringify({ result: "en", transcription: [] }) }),
            ).records,
        ).toEqual([]);
        expect(
            makeWhisperRecords(
                makeInput({ json: JSON.stringify({ result: {}, transcription: [] }) }),
            ).records,
        ).toEqual([]);
    });

    it("rejects malformed whisper output", () => {
        expect(() => makeWhisperRecords(makeInput({ json: "null" }))).toThrow("invalid transcript");
        expect(() => makeWhisperRecords(makeInput({ json: "{}" }))).toThrow("invalid transcript");
        expect(() =>
            makeWhisperRecords(makeInput({ json: JSON.stringify({ transcription: "x" }) })),
        ).toThrow("invalid transcript");
        expect(() =>
            makeWhisperRecords(makeInput({ json: JSON.stringify({ transcription: [null] }) })),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(makeInput({ json: JSON.stringify({ transcription: ["x"] }) })),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({ json: JSON.stringify({ transcription: [{ text: "x" }] }) }),
            ),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    json: JSON.stringify({
                        transcription: [{ text: 1, offsets: { from: 0, to: 10 } }],
                    }),
                }),
            ),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    json: JSON.stringify({
                        transcription: [{ text: "x", offsets: { from: 0.5, to: 10 } }],
                    }),
                }),
            ),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    json: JSON.stringify({
                        transcription: [{ text: "x", offsets: { from: -1, to: 10 } }],
                    }),
                }),
            ),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    json: JSON.stringify({
                        transcription: [{ text: "x", offsets: { from: 5, to: 5 } }],
                    }),
                }),
            ),
        ).toThrow("invalid segment");
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    json: JSON.stringify({
                        transcription: [
                            { text: "x".repeat(1_000_001), offsets: { from: 0, to: 10 } },
                        ],
                    }),
                }),
            ),
        ).toThrow("invalid segment");
    });

    it("refuses to overwrite unreviewed provisional cues unless replacing them", () => {
        const provisional = segment("c1", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "500000",
            origin: "local-whisper",
            verification_state: "provisional",
        });
        expect(() => makeWhisperRecords(makeInput({ existing: [provisional] }))).toThrow(
            "already has provisional Whisper cues",
        );

        const result = makeWhisperRecords(
            makeInput({
                existing: [
                    provisional,
                    segment("c2", {
                        session_id: sessionId,
                        source_audio_track_id: trackId,
                        start_time_us: "0",
                        end_time_us: "1000",
                        origin: "human",
                        verification_state: "provisional",
                    }),
                    segment("c3", {
                        session_id: sessionId,
                        source_audio_track_id: trackId,
                        start_time_us: "0",
                        end_time_us: "1000",
                    }),
                ],
                replaceProvisional: true,
                runId: "run-1",
            }),
        );
        expect(result.records[0]!.fields.get("_deleted")).toBe("true");
        expect(result.records[0]!.fields.get("superseded_by_run")).toBe("run-1");
        expect(result.records[1]!.fields.get("source_run_id")).toBe("run-1");
    });

    it("filters existing cues by session, track, type, and deleted state", () => {
        const otherSession = segment("c1", {
            session_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1",
        });
        const otherTrack = segment("c2", {
            session_id: sessionId,
            source_audio_track_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            start_time_us: "0",
            end_time_us: "1",
        });
        const deleted = segment("c3", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1",
            _deleted: "true",
        });
        const wrongType = segment(
            "c4",
            {
                session_id: sessionId,
                source_audio_track_id: trackId,
                start_time_us: "0",
                end_time_us: "1",
            },
            RecordType.guide,
        );
        const unparsable = segment("c5", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "abc",
            end_time_us: "1",
        });
        const editedProvisional = segment("c6", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1",
            origin: "local-whisper",
            verification_state: "provisional",
            human_edited_at_us: "1",
        });
        const noTimes = segment("c7", {
            session_id: sessionId,
            source_audio_track_id: trackId,
        });
        const plain = segment("c8", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1000",
        });
        const otherOriginProvisional = segment("c9", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1000",
            origin: "human",
            verification_state: "provisional",
        });

        const result = makeWhisperRecords(
            makeInput({
                existing: [
                    otherSession,
                    otherTrack,
                    deleted,
                    wrongType,
                    unparsable,
                    editedProvisional,
                    noTimes,
                    plain,
                    otherOriginProvisional,
                ],
                json: JSON.stringify({
                    transcription: [{ text: "Hello", offsets: { from: 600, to: 700 } }],
                }),
            }),
        );
        expect(result.records).toHaveLength(1);
    });

    it("skips segments outside the preview window and over protected ranges", () => {
        const humanEdited = segment("c1", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1000",
            human_edited_at_us: "1",
        });
        const verified = segment("c2", {
            session_id: sessionId,
            source_audio_track_id: trackId,
            start_time_us: "0",
            end_time_us: "1000",
            verification_state: "human-verified",
        });
        const result = makeWhisperRecords(
            makeInput({
                existing: [humanEdited, verified],
                json: JSON.stringify({
                    transcription: [
                        { text: "   ", offsets: { from: 0, to: 500 } },
                        { text: "late", offsets: { from: 2_000, to: 2_100 } },
                        { text: "past", offsets: { from: 900, to: 1_100 } },
                        { text: "overlap", offsets: { from: 0, to: 10 } },
                    ],
                }),
            }),
        );
        expect(result.records).toHaveLength(0);
        expect(result.skipped).toBe(3);
    });

    it("adds experimental speaker-turn metadata when diarization is requested", () => {
        expect(() =>
            makeWhisperRecords(
                makeInput({
                    diarizeSpeakerTurns: true,
                    json: JSON.stringify({
                        transcription: [{ text: "Hi", offsets: { from: 0, to: 10 } }],
                    }),
                }),
            ),
        ).toThrow("speaker-turn boundaries");

        const result = makeWhisperRecords(
            makeInput({
                diarizeSpeakerTurns: true,
                json: JSON.stringify({
                    transcription: [
                        { text: "Hi", offsets: { from: 0, to: 10 }, speaker_turn_next: true },
                    ],
                }),
            }),
        );
        expect(result.records[0]!.fields.get("speaker_turn_next")).toBe("true");
        expect(result.records[0]!.fields.get("diarization_enabled")).toBe("true");
    });
});

describe("whisperAudio", () => {
    it("writes 16 kHz mono PCM with linear interpolation", () => {
        const input = pcmWav([1_000, 2_000, 3_000], 1, 8_000);
        const output = whisperAudio(input);
        const view = new DataView(output.buffer);
        expect(String.fromCharCode(...output.slice(0, 4))).toBe("RIFF");
        expect(view.getUint32(24, true)).toBe(16_000);
        expect(view.getUint16(22, true)).toBe(1);
        expect(view.getUint32(40, true)).toBe(12);
        expect(view.getInt16(44, true)).toBe(1_000);
        expect(view.getInt16(46, true)).toBe(1_500);
    });

    it("averages multiple channels", () => {
        const input = pcmWav([1_000, 3_000, -1_000, 1_000], 2, 16_000);
        const output = whisperAudio(input);
        const view = new DataView(output.buffer);
        expect(view.getInt16(44, true)).toBe(2_000);
        expect(view.getInt16(46, true)).toBe(0);
    });

    it("rejects invalid previews", () => {
        const base = pcmWav([0, 0], 1, 16_000);
        expect(() => whisperAudio({ ...base, sampleRateHz: 0 })).toThrow("invalid");
        expect(() => whisperAudio({ ...base, channelCount: 0 })).toThrow("invalid");
        expect(() => whisperAudio({ ...base, frameCount: 0 })).toThrow("invalid");
        expect(() => whisperAudio({ ...base, wav: new Uint8Array(10) })).toThrow("invalid");
    });

    it("limits previews to 30 seconds", () => {
        expect(() => whisperAudio({ ...pcmWav([0], 1, 384_000), sampleRateHz: 384_000 })).toThrow(
            "30 seconds",
        );
        const frames = 240_001;
        expect(() =>
            whisperAudio({
                ...pcmWav(new Array(frames).fill(0), 1, 8_000),
                sampleRateHz: 8_000,
                frameCount: frames,
            }),
        ).toThrow("30 seconds");
    });
});
