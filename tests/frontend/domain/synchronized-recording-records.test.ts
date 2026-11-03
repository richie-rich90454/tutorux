import { describe, expect, it } from "vitest";
import { newUuid, RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    makeSynchronizedCaptureChunkRecords,
    makeSynchronizedCaptureFinishRecords,
    makeSynchronizedCaptureStartRecords,
    makeSynchronizedCaptureStateRecords,
    makeSynchronizedRecordingRecords,
    type SynchronizedCaptureTrackIdentity,
} from "../../../frontend/domain/synchronized-recording";

const SAMPLE_RATE = 16_000;
const TIMESTAMP = "1700000000000000";
const U64_MAX = "18446744073709551615";
const U64_OVERFLOW = "18446744073709551616";

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

function identity(
    overrides: Partial<SynchronizedCaptureTrackIdentity> = {},
): SynchronizedCaptureTrackIdentity {
    return {
        source: "microphone",
        trackId: newUuid(),
        sampleRateHz: SAMPLE_RATE,
        ...overrides,
    };
}

function startRecords(
    options: {
        session?: ArchiveRecord;
        tracks?: SynchronizedCaptureTrackIdentity[];
        takeId?: string;
        startedAtUs?: string;
        consentAtUs?: string;
        knownTrackIds?: readonly string[];
        durability?: "default" | "maximum" | "reduced-write";
    } = {},
): {
    session: ArchiveRecord;
    tracks: ArchiveRecord[];
    take: ArchiveRecord;
} {
    const records = makeSynchronizedCaptureStartRecords({
        session: options.session ?? makeSession(),
        takeId: options.takeId ?? newUuid(),
        tracks: options.tracks ?? [identity()],
        knownTrackIds: options.knownTrackIds ?? [],
        startedAtUs: options.startedAtUs ?? TIMESTAMP,
        consentAtUs: options.consentAtUs ?? TIMESTAMP,
        ...(options.durability === undefined ? {} : { durability: options.durability }),
        captureSourceBackend: "web-audio",
        consentConfirmedBy: "Tutor",
    });
    return {
        session: records.find((record) => record.type === RecordType.session)!,
        tracks: records.filter(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "audio-track",
        ),
        take: records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!,
    };
}

describe("makeSynchronizedCaptureStartRecords", () => {
    it("rejects a non-session record", () => {
        expect(() =>
            startRecords({ session: { ...makeSession(), type: RecordType.student } }),
        ).toThrow(/active tutoring session/u);
    });

    it("rejects an empty track list", () => {
        expect(() => startRecords({ tracks: [] })).toThrow(/No native audio source/u);
    });

    it("accepts the largest supported timestamp", () => {
        const fixture = startRecords({ startedAtUs: U64_MAX, consentAtUs: U64_MAX });
        expect(fixture.take.fields.get("started_at_us")).toBe(U64_MAX);
    });

    it.each([
        ["start", { startedAtUs: U64_OVERFLOW }],
        ["consent", { consentAtUs: U64_OVERFLOW }],
    ] as const)("rejects an overflowing %s timestamp", (_label, override) => {
        expect(() => startRecords(override)).toThrow(/timestamp is invalid/u);
    });

    it("rejects an invalid take identifier", () => {
        expect(() => startRecords({ takeId: "not-a-uuid" })).toThrow(/take ID is invalid/u);
    });

    it("rejects an invalid track identifier", () => {
        expect(() => startRecords({ tracks: [identity({ trackId: "bad" })] })).toThrow(
            /track ID is invalid/u,
        );
    });

    it.each([16_000.5, 4_000, 400_000])("rejects sample rate %s", (sampleRateHz) => {
        expect(() => startRecords({ tracks: [identity({ sampleRateHz })] })).toThrow(
            /unsupported sample rate/u,
        );
    });

    it.each(["initializing", "recording", "paused", "finalizing"] as const)(
        "rejects a session that is already %s",
        (state) => {
            expect(() =>
                startRecords({ session: makeSession({ recording_state: state }) }),
            ).toThrow(/Stop or recover the active recording/u);
        },
    );

    it("accepts a session without a recording state", () => {
        const session = makeSession();
        const fields = new Map(session.fields);
        fields.delete("recording_state");
        expect(startRecords({ session: { ...session, fields } }).tracks).toHaveLength(1);
    });

    it("writes defaults for a single microphone track", () => {
        const fixture = startRecords();
        const track = fixture.tracks[0]!;
        expect(track.fields.get("label")).toBe("Microphone recording");
        expect(track.fields.get("capture_source_backend")).toBe("web-audio");
        expect(track.fields.get("sample_format")).toBe("pcm_s16le");
        expect(track.fields.get("channel_count")).toBe("1");
        expect(track.fields.get("durability")).toBe("default");
        expect(fixture.take.fields.get("source")).toBe("microphone");
        expect(fixture.take.fields.get("label")).toBe("Audio recording");
        expect(fixture.take.fields.get("track_ids")).toBe(track.id);
        expect(fixture.session.fields.get("recording_track_mode")).toBe("single-source");
        expect(fixture.session.fields.get("recording_track_id")).toBe(track.id);
        expect(fixture.session.fields.get("recording_track_count")).toBe("1");
        expect(fixture.session.fields.get("recording_sample_format")).toBe("pcm_s16le");
        expect(fixture.session.fields.get("recording_audio_chunks")).toBe("0");
        expect(fixture.session.fields.get("recording_samples")).toBe("0");
        expect(fixture.session.fields.get("recording_timeline_samples")).toBe("0");
        expect(fixture.session.fields.get("recording_bytes")).toBe("0");
        expect(fixture.session.fields.get("recording_duration_us")).toBe("0");
    });

    it("defaults the system and application track labels", () => {
        const system = startRecords({
            tracks: [identity({ source: "system-audio" })],
        }).tracks[0]!;
        expect(system.fields.get("label")).toBe("Shared system audio");
        const application = startRecords({
            tracks: [identity({ source: "application-audio" })],
        }).tracks[0]!;
        expect(application.fields.get("label")).toBe("Application audio");
    });

    it("persists identity overrides and links evaluated track identifiers", () => {
        const known = newUuid();
        const first = identity({ source: "microphone", trackId: newUuid() });
        const second = identity({
            source: "system-audio",
            trackId: newUuid(),
            label: "Lecture capture",
            sampleFormat: "pcm_f32le",
            channelCount: 2,
            sourceDeviceId: "device-2",
            sourceBackend: "native",
            applicationName: "Player",
            applicationProcessId: 0,
            applicationBundleId: "com.example.player",
        });
        const third = identity({
            source: "application-audio",
            trackId: newUuid(),
            channelCount: 4,
        });
        const session = makeSession({
            recording_track_ids: `${known}, not-a-uuid, ${known.toUpperCase()}`,
            recording_track_id: known,
            audio_import_track_id: known,
            recording_audio_chunks: "7",
            recording_samples: "8",
            recording_timeline_samples: "9",
            recording_bytes: "10",
        });

        const fixture = startRecords({
            session,
            tracks: [first, second, third],
            knownTrackIds: [known, "ignored"],
            durability: "maximum",
        });

        expect(fixture.session.fields.get("recording_track_ids")).toBe(
            [
                known,
                first.trackId.toLowerCase(),
                second.trackId.toLowerCase(),
                third.trackId.toLowerCase(),
            ].join(","),
        );
        expect(fixture.session.fields.get("recording_track_count")).toBe("4");
        expect(fixture.session.fields.get("recording_source")).toBe(
            "microphone+system-audio+application-audio",
        );
        expect(fixture.session.fields.get("recording_track_id")).toBe(known);
        expect(fixture.session.fields.get("recording_durability")).toBe("maximum");
        expect(fixture.session.fields.get("recording_track_mode")).toBe("single-source");
        expect(fixture.session.fields.get("recording_audio_chunks")).toBe("7");
        expect(fixture.session.fields.get("recording_samples")).toBe("8");
        expect(fixture.session.fields.get("recording_timeline_samples")).toBe("9");
        expect(fixture.session.fields.get("recording_bytes")).toBe("10");

        const track = fixture.tracks[1]!;
        expect(track.fields.get("label")).toBe("Lecture capture");
        expect(track.fields.get("sample_format")).toBe("pcm_f32le");
        expect(track.fields.get("channel_count")).toBe("2");
        expect(track.fields.get("source_device_id")).toBe("device-2");
        expect(track.fields.get("capture_source_backend")).toBe("native");
        expect(track.fields.get("application_name")).toBe("Player");
        expect(track.fields.get("application_process_id")).toBe("0");
        expect(track.fields.get("application_bundle_id")).toBe("com.example.player");
        expect(track.fields.get("durability")).toBe("maximum");
    });

    it("labels two synchronized tracks and keeps their IDs unique", () => {
        const first = identity({ trackId: newUuid().toUpperCase() });
        const second = identity({ source: "system-audio", trackId: newUuid() });
        const fixture = startRecords({ tracks: [first, second] });

        expect(fixture.take.fields.get("label")).toBe("Synchronized recording");
        expect(fixture.take.fields.get("source")).toBe("microphone+system-audio");
        expect(fixture.session.fields.get("recording_track_mode")).toBe("synchronized-separate");
        expect(fixture.session.fields.get("recording_track_id")).toBe(first.trackId.toLowerCase());
    });

    it("persists explicit sample format and channel metadata on the session", () => {
        const fixture = startRecords({
            tracks: [
                identity({
                    sampleFormat: "pcm_s24le",
                    channelCount: 2,
                }),
            ],
        });
        expect(fixture.session.fields.get("recording_sample_format")).toBe("pcm_s24le");
        expect(fixture.session.fields.get("recording_channel_count")).toBe("2");
    });
});

describe("makeSynchronizedCaptureChunkRecords", () => {
    it("derives the sample rate from the track metadata", () => {
        const fixture = startRecords();
        const track = fixture.tracks[0]!;
        const records = makeSynchronizedCaptureChunkRecords({
            session: fixture.session,
            track,
            chunk: {
                sequence: 0,
                firstSampleIndex: "4",
                samples: new Uint8Array(8),
                gapBeforeSamples: "4",
            },
            source: "microphone",
        });
        const chunk = records.find((record) => record.type === RecordType.audioChunk)!;
        expect(chunk.fields.get("sample_rate_hz")).toBe(String(SAMPLE_RATE));
        expect(chunk.fields.get("sample_count")).toBe("4");
    });
});

describe("makeSynchronizedCaptureStateRecords", () => {
    it("marks every record paused without pause totals", () => {
        const fixture = startRecords();
        const records = makeSynchronizedCaptureStateRecords(
            fixture.session,
            fixture.tracks,
            fixture.take,
            "paused",
        );

        expect(records.at(-1)!.fields.get("recording_state")).toBe("paused");
        expect(records[0]!.fields.get("state")).toBe("paused");
        expect(records[1]!.fields.get("state")).toBe("paused");
        expect(records[0]!.fields.get("capture_pause_count")).toBe("0");
    });

    it("persists pause counters", () => {
        const fixture = startRecords();
        const records = makeSynchronizedCaptureStateRecords(
            fixture.session,
            fixture.tracks,
            fixture.take,
            "recording",
            { pauseCount: 3, pausedDurationUs: "2500" },
        );

        expect(records[0]!.fields.get("capture_pause_count")).toBe("3");
        expect(records[0]!.fields.get("capture_paused_duration_us")).toBe("2500");
        expect(records[1]!.fields.get("capture_pause_count")).toBe("3");
        expect(records.at(-1)!.fields.get("recording_state")).toBe("recording");
    });
});

describe("makeSynchronizedCaptureFinishRecords", () => {
    it("completes every track and takes the longest duration", () => {
        const fixture = startRecords({
            tracks: [identity(), identity({ source: "system-audio" })],
        });
        const first = {
            ...fixture.tracks[0]!,
            fields: new Map([...fixture.tracks[0]!.fields, ["duration_us", "1000"]]),
        };
        const second = {
            ...fixture.tracks[1]!,
            fields: new Map([...fixture.tracks[1]!.fields, ["duration_us", "2000"]]),
        };

        const records = makeSynchronizedCaptureFinishRecords({
            session: {
                ...fixture.session,
                fields: new Map([...fixture.session.fields, ["recording_duration_us", "3000"]]),
            },
            tracks: [first, second],
            take: fixture.take,
            pauseCount: 2,
            pausedDurationUs: "500",
            failures: {},
        });

        expect(records[0]!.fields.get("state")).toBe("completed");
        expect(records[1]!.fields.get("state")).toBe("completed");
        expect(records[2]!.fields.get("duration_us")).toBe("2000");
        expect(records[2]!.fields.get("state")).toBe("completed");
        expect(records[3]!.fields.get("recording_duration_us")).toBe("3000");
        expect(records[3]!.fields.get("recording_state")).toBe("completed");
        expect(records[0]!.fields.get("capture_pause_count")).toBe("2");
    });

    it("retains per-source failures and marks the take partial", () => {
        const fixture = startRecords({
            tracks: [identity(), identity({ source: "system-audio" })],
        });
        const records = makeSynchronizedCaptureFinishRecords({
            session: makeSession({ recording_duration_us: "1" }),
            tracks: [
                {
                    ...fixture.tracks[0]!,
                    fields: new Map([...fixture.tracks[0]!.fields, ["duration_us", "invalid"]]),
                },
                fixture.tracks[1]!,
            ],
            take: fixture.take,
            pauseCount: 0,
            pausedDurationUs: "0",
            failures: { "system-audio": "Cable removed", microphone: "" },
        });

        expect(records[0]!.fields.get("state")).toBe("completed");
        expect(records[1]!.fields.get("state")).toBe("interrupted");
        expect(records[1]!.fields.get("recovery_error")).toBe("Cable removed");
        expect(records[2]!.fields.get("state")).toBe("partial");
        expect(records[2]!.fields.get("recovery_error")).toBe("system-audio: Cable removed");
        expect(records[3]!.fields.get("recording_state")).toBe("partial");
    });

    it("keeps a longer previous session duration", () => {
        const fixture = startRecords();
        const records = makeSynchronizedCaptureFinishRecords({
            session: makeSession({ recording_duration_us: U64_MAX }),
            tracks: [
                {
                    ...fixture.tracks[0]!,
                    fields: new Map([...fixture.tracks[0]!.fields, ["duration_us", "5"]]),
                },
            ],
            take: fixture.take,
            pauseCount: 0,
            pausedDurationUs: "0",
            failures: {},
        });
        expect(records.at(-1)!.fields.get("recording_duration_us")).toBe(U64_MAX);
    });

    it("uses the track duration when the session has no recorded duration", () => {
        const fixture = startRecords({
            tracks: [identity(), identity({ source: "system-audio" })],
        });
        const records = makeSynchronizedCaptureFinishRecords({
            session: makeSession(),
            tracks: [
                {
                    ...fixture.tracks[0]!,
                    fields: new Map([...fixture.tracks[0]!.fields, ["duration_us", U64_OVERFLOW]]),
                },
                {
                    ...fixture.tracks[1]!,
                    fields: new Map([...fixture.tracks[1]!.fields, ["duration_us", "5000"]]),
                },
            ],
            take: fixture.take,
            pauseCount: 0,
            pausedDurationUs: "0",
            failures: {},
        });
        expect(records.at(-1)!.fields.get("recording_duration_us")).toBe("5000");
    });
});

describe("makeSynchronizedRecordingRecords", () => {
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
        return join([header, payload]);
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

    it("requires at least one file", async () => {
        await expect(
            makeSynchronizedRecordingRecords({
                session: makeSession(),
                files: [null, null],
                knownTrackIds: [],
                startedAtUs: TIMESTAMP,
                consentAtUs: TIMESTAMP,
                pauseCount: 0,
                pausedDurationUs: "0",
            }),
        ).rejects.toThrow(/Neither audio source/u);
    });

    it("imports a single system track with defaults and deletes stale mode", async () => {
        const session = makeSession({
            recording_track_mode: "synchronized-separate",
            recording_sample_rate_hz: "0",
            recording_samples: "invalid",
            recording_duration_us: U64_OVERFLOW,
            recording_timeline_samples: "invalid",
        });
        const records = await makeSynchronizedRecordingRecords({
            session,
            files: [null, waveFile(waveData([1, 2]))],
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 2,
            pausedDurationUs: "700",
        });

        const updated = records.find((record) => record.type === RecordType.session)!;
        const track = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "audio-track",
        )!;
        const take = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;
        expect(track.fields.get("source")).toBe("system-audio");
        expect(track.fields.get("label")).toBe("Shared system audio");
        expect(take.fields.get("source")).toBe("system-audio");
        expect(take.fields.get("label")).toBe("Audio recording");
        expect(updated.fields.has("recording_track_mode")).toBe(false);
        expect(updated.fields.get("recording_source")).toBe("system-audio");
        expect(updated.fields.get("recording_source_backend")).toBe("web-audio");
        expect(updated.fields.get("recording_samples")).toBe("2");
        expect(updated.fields.get("recording_duration_us")).toBe("250");
        expect(updated.fields.get("recording_consent_confirmed_by")).toBe("");
    });

    it("imports two synchronized tracks and links previous counters", async () => {
        const known = newUuid();
        const session = makeSession({
            recording_track_ids: `${known},not-valid`,
            audio_import_track_id: known,
            recording_track_id: known,
            recording_sample_rate_hz: "8000",
            recording_samples: "10",
            recording_duration_us: "1",
            recording_timeline_samples: "1",
        });
        const records = await makeSynchronizedRecordingRecords({
            session,
            files: [waveFile(waveData([1, 2])), waveFile(waveData([3, 4, 5]))],
            knownTrackIds: [known],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 1,
            pausedDurationUs: "100",
            captureSourceBackend: "native",
            consentConfirmedBy: "Tutor",
            warnings: ["system-audio: stopped", "microphone: noisy"],
        });

        const updated = records.find((record) => record.type === RecordType.session)!;
        const tracks = records.filter(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "audio-track",
        );
        const take = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;
        expect(tracks).toHaveLength(2);
        expect(tracks[0]!.fields.get("source")).toBe("microphone");
        expect(tracks[1]!.fields.get("source")).toBe("system-audio");
        expect(tracks[1]!.fields.get("label")).toBe("Shared system audio");
        expect(take.fields.get("label")).toBe("Synchronized recording");
        expect(take.fields.get("source")).toBe("microphone+system-audio");
        expect(take.fields.get("state")).toBe("partial");
        expect(take.fields.get("track_ids")).toBe(tracks.map((track) => track.id).join(","));
        expect(updated.fields.get("recording_track_ids")).toContain(known);
        expect(updated.fields.get("recording_track_count")).toBe(
            String(updated.fields.get("recording_track_ids")!.split(",").length),
        );
        expect(updated.fields.get("recording_track_id")).toBe(known);
        expect(updated.fields.get("recording_source")).toBe("microphone+system-audio");
        expect(updated.fields.get("recording_source_backend")).toBe("native");
        expect(updated.fields.get("recording_state")).toBe("partial");
        expect(updated.fields.get("recording_error")).toBe(
            "system-audio: stopped\nmicrophone: noisy",
        );
        expect(updated.fields.get("recording_consent_confirmed_by")).toBe("Tutor");
        expect(updated.fields.get("recording_track_mode")).toBe("synchronized-separate");
        expect(updated.fields.get("recording_samples")).toBe("15");
        expect(updated.fields.get("recording_duration_us")).toBe("375");
        expect(updated.fields.get("recording_timeline_samples")).toBe("3");
    });

    it("keeps an existing timeline when it is already longer", async () => {
        const session = makeSession({
            recording_sample_rate_hz: "8000",
            recording_duration_us: "10000",
            recording_timeline_samples: U64_MAX,
        });
        const records = await makeSynchronizedRecordingRecords({
            session,
            files: [waveFile(waveData([1])), null],
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 0,
            pausedDurationUs: "0",
        });
        const updated = records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("recording_timeline_samples")).toBe(U64_MAX);
        expect(updated.fields.get("recording_duration_us")).toBe("10000");
        expect(updated.fields.get("recording_state")).toBe("completed");
    });

    it("keeps the longest imported duration when the second source is shorter", async () => {
        const records = await makeSynchronizedRecordingRecords({
            session: makeSession({ recording_sample_rate_hz: "8000" }),
            files: [waveFile(waveData([1, 2, 3])), waveFile(waveData([4]))],
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 0,
            pausedDurationUs: "0",
        });
        const updated = records.find((record) => record.type === RecordType.session)!;
        const take = records.find(
            (record) =>
                record.type === RecordType.assetMetadata &&
                record.fields.get("record_role") === "recording-take",
        )!;
        expect(take.fields.get("duration_us")).toBe("375");
        expect(updated.fields.get("recording_duration_us")).toBe("375");
    });

    it("uses the first sample rate when the session has no timeline rate", async () => {
        const session = makeSession();
        const fields = new Map(session.fields);
        fields.delete("recording_sample_rate_hz");
        const records = await makeSynchronizedRecordingRecords({
            session: { ...session, fields },
            files: [waveFile(waveData([1, 2, 3])), null],
            knownTrackIds: [],
            startedAtUs: TIMESTAMP,
            consentAtUs: TIMESTAMP,
            pauseCount: 0,
            pausedDurationUs: "0",
        });
        const updated = records.find((record) => record.type === RecordType.session)!;
        expect(updated.fields.get("recording_timeline_samples")).toBe("3");
    });
});
