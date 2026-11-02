import { describe, expect, it } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    makeSynchronizedCaptureChunkRecords,
    makeSynchronizedCaptureStartRecords,
} from "../../../frontend/domain/synchronized-recording";

const SAMPLE_RATE = 16_000;
const TIMESTAMP = "1700000000000000";

function makeSession(fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.session,
        id: newUuid(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["recording_state", "completed"], ...Object.entries(fields)]),
        blob: new Uint8Array(),
    };
}

function startCapture(options: { trackId?: string; sampleRateHz?: number } = {}): {
    sessionId: string;
    trackId: string;
    session: ArchiveRecord;
    track: ArchiveRecord;
} {
    const session = makeSession();
    const trackId = options.trackId ?? newUuid();
    const records = makeSynchronizedCaptureStartRecords({
        session,
        takeId: newUuid(),
        tracks: [
            {
                source: "microphone",
                trackId,
                sampleRateHz: options.sampleRateHz ?? SAMPLE_RATE,
            },
        ],
        knownTrackIds: [],
        startedAtUs: TIMESTAMP,
        consentAtUs: TIMESTAMP,
        captureSourceBackend: "web-audio",
        consentConfirmedBy: "Tutor",
    });
    return {
        sessionId: session.id,
        trackId,
        session: records.find((record) => record.type === RecordType.session)!,
        track: records.find(
            (record) => record.type === RecordType.assetMetadata && record.id === trackId,
        )!,
    };
}

function chunkRecord(
    fixture: ReturnType<typeof startCapture>,
    sequence: number,
    firstSampleIndex: string,
    gapBeforeSamples = "0",
    frameCount = 4,
): {
    chunk: ArchiveRecord;
    track: ArchiveRecord;
    session: ArchiveRecord;
} {
    const records = makeSynchronizedCaptureChunkRecords({
        session: fixture.session,
        track: fixture.track,
        chunk: {
            sequence,
            firstSampleIndex,
            samples: new Uint8Array(frameCount * 2),
            sampleFormat: "pcm_s16le",
            channelCount: 1,
            gapBeforeSamples,
        },
        source: "microphone",
    });
    return {
        chunk: records.find((record) => record.type === RecordType.audioChunk)!,
        track: records.find(
            (record) => record.type === RecordType.assetMetadata && record.id === fixture.trackId,
        )!,
        session: records.find((record) => record.type === RecordType.session)!,
    };
}

describe("synchronized capture durability", () => {
    it("persists the saved recording.durability policy on the session and take", () => {
        const session: ArchiveRecord = {
            type: RecordType.session,
            id: newUuid(),
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([["recording_state", "completed"]]),
            blob: new Uint8Array(),
        };
        const trackId = newUuid();
        const records = makeSynchronizedCaptureStartRecords({
            session,
            takeId: newUuid(),
            tracks: [{ source: "microphone", trackId, sampleRateHz: 16_000 }],
            knownTrackIds: [],
            startedAtUs: "1700000000000000",
            consentAtUs: "1700000000000000",
            durability: "reduced-write",
            captureSourceBackend: "native-audio-helper",
            consentConfirmedBy: "Tutor",
        });
        const updatedSession = records.find((record) => record.type === RecordType.session)!;
        const track = records.find(
            (record) => record.type === RecordType.assetMetadata && record.id === trackId,
        )!;
        const take = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;

        expect(updatedSession.fields.get("recording_durability")).toBe("reduced-write");
        expect(track.fields.get("durability")).toBe("reduced-write");
        expect(take.fields.get("durability")).toBe("reduced-write");
    });
});

describe("synchronized capture chunks", () => {
    const cases = [
        { name: "contiguous", gaps: [0, 0, 0], firstSampleIndexes: ["0", "4", "8"] },
        { name: "gapped", gaps: [0, 5, 0], firstSampleIndexes: ["0", "9", "13"] },
    ] as const;

    for (const testCase of cases) {
        it(`writes ${testCase.name} chunk sequences and timelines`, () => {
            const fixture = startCapture();

            testCase.firstSampleIndexes.forEach((firstSampleIndex, sequence) => {
                const updated = chunkRecord(
                    fixture,
                    sequence,
                    firstSampleIndex,
                    String(testCase.gaps[sequence]),
                );
                fixture.session = updated.session;
                fixture.track = updated.track;

                expect(updated.chunk.fields.get("sequence_number")).toBe(String(sequence));
                expect(updated.chunk.fields.get("first_sample_index")).toBe(firstSampleIndex);
                expect(updated.chunk.fields.get("sample_count")).toBe("4");
                expect(updated.chunk.fields.get("gap_before_samples")).toBe(
                    String(testCase.gaps[sequence]),
                );
            });

            const lastFirst = Number(testCase.firstSampleIndexes.at(-1));
            expect(fixture.track.fields.get("chunk_count")).toBe("3");
            expect(fixture.track.fields.get("timeline_sample_count")).toBe(String(lastFirst + 4));
            expect(fixture.track.fields.get("sample_count")).toBe("12");
        });
    }

    it("rejects a chunk for an inactive session", () => {
        const fixture = startCapture();
        const deletedSession = {
            ...fixture.session,
            fields: new Map([...fixture.session.fields, ["_deleted", "true"]]),
        };

        expect(() =>
            makeSynchronizedCaptureChunkRecords({
                session: deletedSession,
                track: fixture.track,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(8),
                },
                source: "microphone",
            }),
        ).toThrow(/active tutoring session/u);
    });

    it("rejects a track whose sample rate is not numeric", () => {
        const fixture = startCapture();
        const brokenTrack = {
            ...fixture.track,
            fields: new Map([...fixture.track.fields, ["sample_rate_hz", "not-a-rate"]]),
        };

        expect(() =>
            makeSynchronizedCaptureChunkRecords({
                session: fixture.session,
                track: brokenTrack,
                chunk: {
                    sequence: 0,
                    firstSampleIndex: "0",
                    samples: new Uint8Array(8),
                },
                source: "microphone",
            }),
        ).toThrow(/unsupported sample rate/u);
    });
});

describe("synchronized capture start validation", () => {
    it("rejects duplicate native track IDs", () => {
        const trackId = newUuid();
        const session = makeSession();

        expect(() =>
            makeSynchronizedCaptureStartRecords({
                session,
                takeId: newUuid(),
                tracks: [
                    { source: "microphone", trackId, sampleRateHz: SAMPLE_RATE },
                    { source: "system-audio", trackId, sampleRateHz: SAMPLE_RATE },
                ],
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                captureSourceBackend: "web-audio",
                consentConfirmedBy: "Tutor",
            }),
        ).toThrow(/track IDs must be unique/u);
    });

    it("rejects unsupported sample rates", () => {
        const session = makeSession();
        expect(() =>
            makeSynchronizedCaptureStartRecords({
                session,
                takeId: newUuid(),
                tracks: [{ source: "microphone", trackId: newUuid(), sampleRateHz: 4_000 }],
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                captureSourceBackend: "web-audio",
                consentConfirmedBy: "Tutor",
            }),
        ).toThrow(/unsupported sample rate/u);
    });

    it.each([
        ["startedAtUs", { startedAtUs: "not-a-timestamp" }],
        ["consentAtUs", { consentAtUs: "not-a-timestamp" }],
    ] as const)("rejects a non-numeric %s", (_label, override) => {
        const session = makeSession();
        expect(() =>
            makeSynchronizedCaptureStartRecords({
                session,
                takeId: newUuid(),
                tracks: [{ source: "microphone", trackId: newUuid(), sampleRateHz: SAMPLE_RATE }],
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                captureSourceBackend: "web-audio",
                consentConfirmedBy: "Tutor",
                ...override,
            }),
        ).toThrow(/timestamp is invalid/u);
    });

    it("rejects a deleted session", () => {
        const session = makeSession({ _deleted: "true" });
        expect(() =>
            makeSynchronizedCaptureStartRecords({
                session,
                takeId: newUuid(),
                tracks: [{ source: "microphone", trackId: newUuid(), sampleRateHz: SAMPLE_RATE }],
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                captureSourceBackend: "web-audio",
                consentConfirmedBy: "Tutor",
            }),
        ).toThrow(/active tutoring session/u);
    });
});
