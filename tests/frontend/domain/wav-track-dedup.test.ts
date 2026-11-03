import { describe, expect, it, vi } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { makeWaveImportRecords, type WaveFile } from "../../../frontend/domain/wav";

const mocks = vi.hoisted(() => ({ uuid: "11111111-1111-4111-8111-111111111111" }));

vi.mock("../../../frontend/archive/format", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/archive/format")>();
    return { ...actual, newUuid: () => mocks.uuid };
});

function chunk(name: string, payload: Uint8Array): Uint8Array {
    const header = new Uint8Array(8);
    header.set(
        Uint8Array.from(name, (character) => character.charCodeAt(0)),
        0,
    );
    new DataView(header.buffer).setUint32(4, payload.byteLength, true);
    const bytes = new Uint8Array(header.byteLength + payload.byteLength);
    bytes.set(header, 0);
    bytes.set(payload, header.byteLength);
    return bytes;
}

function waveFile(): WaveFile {
    const format = new Uint8Array(16);
    const view = new DataView(format.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, 1, true);
    view.setUint32(4, 8_000, true);
    view.setUint32(8, 16_000, true);
    view.setUint16(12, 2, true);
    view.setUint16(14, 16, true);
    const chunks = [chunk("fmt ", format), chunk("data", new Uint8Array(4))];
    const body = new Uint8Array(4 + chunks.reduce((total, part) => total + part.byteLength, 0));
    body.set(
        Uint8Array.from("WAVE", (character) => character.charCodeAt(0)),
        0,
    );
    let offset = 4;
    for (const part of chunks) {
        body.set(part, offset);
        offset += part.byteLength;
    }
    const bytes = new Uint8Array(8 + body.byteLength);
    bytes.set(
        Uint8Array.from("RIFF", (character) => character.charCodeAt(0)),
        0,
    );
    new DataView(bytes.buffer).setUint32(4, body.byteLength, true);
    bytes.set(body, 8);
    return {
        name: "dedup.wav",
        size: bytes.byteLength,
        slice: (start, end) => new Blob([bytes.slice(start, end)]),
    };
}

function session(fields: ReadonlyMap<string, string>): ArchiveRecord {
    return {
        type: RecordType.session,
        id: "22222222-2222-4222-8222-222222222222",
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([["recording_state", "not-started"], ...fields]),
        blob: new Uint8Array(),
    };
}

describe("WAV track identifier deduplication", () => {
    it("does not append a generated track id that is already linked", async () => {
        const imported = await makeWaveImportRecords(
            session(new Map([["recording_track_id", mocks.uuid]])),
            waveFile(),
            true,
            [mocks.uuid],
        );
        expect(imported.trackId).toBe(mocks.uuid);
        expect(imported.sampleCount).toBe(2n);
    });
});
