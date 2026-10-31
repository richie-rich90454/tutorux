import { describe, expect, it } from "vitest";
import {
    ArchiveFormatError,
    compressRecordPayload,
    crc32,
    crc32Finalize,
    crc32Update,
    decodeArchiveHeader,
    decodeLz4Block,
    decodeRecordFrame,
    decodeRecordPayload,
    decodeStoredPayload,
    encodeArchiveHeader,
    encodeRecordFrame,
    encodeRecordPayload,
    type ArchiveRecord,
} from "../../../frontend/archive/format";

describe("Tutorux archive v1 encoding", () => {
    it("uses the CRC-32/IEEE check value", () => {
        const bytes = new TextEncoder().encode("123456789");
        expect(crc32(bytes)).toBe(0xcbf43926);
        const state = crc32Update(crc32Update(0xffffffff, bytes.subarray(0, 4)), bytes.subarray(4));
        expect(crc32Finalize(state)).toBe(crc32(bytes));
    });

    it("round-trips a v1 header and preserves its 64-bit timestamps", () => {
        const createdAtUs = 1_782_930_000_123_456n;
        const bytes = encodeArchiveHeader({
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            majorVersion: 1,
            minorVersion: 0,
            createdAtUs,
            capabilities: 0n,
        });

        expect(bytes).toHaveLength(64);
        expect(decodeArchiveHeader(bytes)).toEqual({
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            majorVersion: 1,
            minorVersion: 0,
            createdAtUs,
            capabilities: 0n,
        });
    });

    it("rejects a header with a changed byte", () => {
        const bytes = encodeArchiveHeader({
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            majorVersion: 1,
            minorVersion: 0,
            createdAtUs: 1n,
            capabilities: 0n,
        });
        bytes[20] = bytes[20]! ^ 0x40;
        expect(() => decodeArchiveHeader(bytes)).toThrowError(
            expect.objectContaining({ code: "archive_header_checksum" }),
        );
    });

    it("serializes metadata keys in UTF-8 byte order and preserves blobs", () => {
        const record: ArchiveRecord = {
            type: 5,
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            revision: 9n,
            previousOffset: 128n,
            fields: new Map([
                ["content", "Line one\nline two"],
                ["title", "Café"],
            ]),
            blob: new Uint8Array([0, 1, 127, 128, 255]),
        };
        const payload = encodeRecordPayload(record);
        expect(
            decodeRecordPayload(
                record.type,
                record.id,
                record.revision,
                record.previousOffset,
                payload,
            ),
        ).toEqual(record);
    });

    it("rejects malformed schema and inconsistent blob lengths", () => {
        const record: ArchiveRecord = {
            type: 5,
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            revision: 1n,
            previousOffset: 0n,
            fields: new Map(),
            blob: new Uint8Array([1]),
        };
        const payload = encodeRecordPayload(record);
        const badLength = payload.slice();
        new DataView(badLength.buffer).setBigUint64(8, 2n, true);
        expect(() => decodeRecordPayload(5, record.id, 1n, 0n, badLength)).toThrowError(
            expect.objectContaining({ code: "record_blob_invalid" }),
        );
    });

    it("round-trips record framing and verifies payload checksum and zero padding", () => {
        const record: ArchiveRecord = {
            type: 5,
            id: "d670e61f-8c37-4e0a-a27d-5cfd987ab132",
            revision: 2n,
            previousOffset: 64n,
            fields: new Map(),
            blob: new Uint8Array(),
        };
        const payload = new Uint8Array([1, 2, 3]);
        const frame = encodeRecordFrame(record, payload);
        const decoded = decodeRecordFrame(frame);

        expect(decoded).toMatchObject({
            type: record.type,
            id: record.id,
            revision: 2n,
            previousOffset: 64n,
            codec: 0,
            flags: 0,
            endOffset: 72,
        });
        expect(decodeStoredPayload(decoded)).toEqual(payload);

        const invalidPadding = frame.slice();
        invalidPadding[67] = 1;
        expect(() => decodeRecordFrame(invalidPadding)).toThrowError(
            expect.objectContaining({ code: "record_padding_invalid" }),
        );
    });

    it("decodes overlapping LZ4 matches without changing their byte semantics", () => {
        const compressedBlock = new Uint8Array([0x14, 0x61, 0x01, 0x00]);
        const storedPayload = new Uint8Array(8 + compressedBlock.length);
        new DataView(storedPayload.buffer).setBigUint64(0, 9n, true);
        storedPayload.set(compressedBlock, 8);
        expect(new TextDecoder().decode(decodeLz4Block(storedPayload))).toBe("aaaaaaaaa");
    });

    it("writes the C++-compatible LZ4 block for compressible record payloads", () => {
        const payload = new Uint8Array(256).fill(0x61);
        const compressed = compressRecordPayload(payload);

        expect(compressed.codec).toBe(1);
        expect(Array.from(compressed.bytes.subarray(8))).toEqual([
            0x1f, 0x61, 0x01, 0x00, 0xe7, 0x50, 0x61, 0x61, 0x61, 0x61, 0x61,
        ]);
        expect(decodeLz4Block(compressed.bytes)).toEqual(payload);
    });

    it("keeps small and low-savings payloads uncompressed", () => {
        const smallPayload = new Uint8Array(255);
        expect(compressRecordPayload(smallPayload)).toEqual({ codec: 0, bytes: smallPayload });

        let seed = 0x12345678;
        const noisyPayload = new Uint8Array(4096);
        for (let index = 0; index < noisyPayload.length; index += 1) {
            seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
            noisyPayload[index] = seed >>> 24;
        }
        expect(compressRecordPayload(noisyPayload)).toEqual({ codec: 0, bytes: noisyPayload });
    });

    it("returns stable typed errors for malformed UUIDs", () => {
        expect(() =>
            encodeArchiveHeader({
                id: "not-a-uuid",
                majorVersion: 1,
                minorVersion: 0,
                createdAtUs: 0n,
                capabilities: 0n,
            }),
        ).toThrowError(ArchiveFormatError);
    });
});
