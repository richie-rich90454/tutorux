import { describe, expect, it } from "vitest";
import {
    ArchiveFormatError,
    MAX_RECORD_PAYLOAD,
    compressRecordPayload,
    crc32,
    decodeArchiveHeader,
    decodeLz4Block,
    decodeRecordFrame,
    decodeRecordFrameHeader,
    decodeRecordPayload,
    decodeStoredPayload,
    encodeArchiveHeader,
    encodeRecordFrame,
    encodeRecordFrameHeader,
    encodeRecordPayload,
    uuidFromBytes,
    validateRecordPayloadSize,
} from "../../../frontend/archive/format";

const ID = "d670e61f-8c37-4e0a-a27d-5cfd987ab132";

function headerBytes(mutate: (bytes: Uint8Array) => void): Uint8Array {
    const bytes = encodeArchiveHeader({
        id: ID,
        majorVersion: 1,
        minorVersion: 0,
        createdAtUs: 1n,
        capabilities: 0n,
    });
    mutate(bytes);
    new DataView(bytes.buffer).setUint32(60, crc32(bytes.subarray(0, 60)), true);
    return bytes;
}

function rawPayload(
    fields: readonly (readonly [number[], number[]])[],
    blob: number[] = [],
    count = fields.length,
): Uint8Array {
    let size = 16;
    for (const [key, value] of fields) size += 6 + key.length + value.length;
    size += blob.length;
    const payload = new Uint8Array(size);
    const view = new DataView(payload.buffer);
    payload.set([0x54, 0x58, 0x4d, 0x44], 0);
    view.setUint16(4, 1, true);
    view.setUint16(6, count, true);
    view.setBigUint64(8, BigInt(blob.length), true);
    let cursor = 16;
    for (const [key, value] of fields) {
        view.setUint16(cursor, key.length, true);
        view.setUint32(cursor + 2, value.length, true);
        cursor += 6;
        payload.set(key, cursor);
        cursor += key.length;
        payload.set(value, cursor);
        cursor += value.length;
    }
    payload.set(blob, cursor);
    return payload;
}

function lz4Block(decodedLength: bigint, block: readonly number[]): Uint8Array {
    const stored = new Uint8Array(8 + block.length);
    new DataView(stored.buffer).setBigUint64(0, decodedLength, true);
    stored.set(block, 8);
    return stored;
}

function prngBytes(length: number, seed = 123): Uint8Array {
    let state = seed >>> 0;
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        const byte = state & 0xff;
        bytes[index] = byte === 0x41 ? 0x42 : byte;
    }
    return bytes;
}

function withPatterns(offsets: readonly number[], pattern: Uint8Array): Uint8Array {
    const payload = prngBytes(256);
    for (const offset of offsets) payload.set(pattern, offset);
    return payload;
}

describe("archive header validation branches", () => {
    it("rejects an unsupported header length field", () => {
        const bytes = headerBytes((value) => {
            new DataView(value.buffer).setUint32(12, 63, true);
        });
        expect(() => decodeArchiveHeader(bytes)).toThrowError(
            expect.objectContaining({ code: "archive_header_invalid" }),
        );
    });

    it("rejects non-zero reserved header bytes", () => {
        const bytes = headerBytes((value) => {
            value[48] = 1;
        });
        expect(() => decodeArchiveHeader(bytes)).toThrowError(
            expect.objectContaining({ code: "archive_header_reserved" }),
        );
    });

    it("rejects unsupported versions and capabilities", () => {
        const version = headerBytes((value) => {
            new DataView(value.buffer).setUint16(8, 2, true);
        });
        expect(() => decodeArchiveHeader(version)).toThrowError(
            expect.objectContaining({ code: "archive_version_unsupported" }),
        );
        const capabilities = headerBytes((value) => {
            new DataView(value.buffer).setBigUint64(40, 2n, true);
        });
        expect(() => decodeArchiveHeader(capabilities)).toThrowError(
            expect.objectContaining({ code: "archive_capability_unsupported" }),
        );
    });

    it("rejects UUID byte arrays that are not 128-bit", () => {
        expect(() => uuidFromBytes(new Uint8Array(15))).toThrowError(
            expect.objectContaining({ code: "id_invalid" }),
        );
    });
});

describe("record payload size limits", () => {
    it("rejects invalid blob lengths and negative maxima", () => {
        expect(() => validateRecordPayloadSize([], -1)).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
        expect(() => validateRecordPayloadSize([], 0, -1n)).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
    });

    it("rejects too many fields, empty names, and oversized totals", () => {
        function* manyFields(): Generator<readonly [string, string]> {
            for (let index = 0; index < 0x10000; index += 1) yield ["k", ""];
        }
        expect(() => validateRecordPayloadSize(manyFields())).toThrowError(
            expect.objectContaining({ code: "record_field_limit" }),
        );
        expect(() => validateRecordPayloadSize([["", "x"]])).toThrowError(
            expect.objectContaining({ code: "record_field_limit" }),
        );
        expect(() => validateRecordPayloadSize([["a", "b"]], 0, 16n)).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
    });

    it("counts every UTF-8 width including unpaired surrogates", () => {
        const total = validateRecordPayloadSize([
            ["ascii", "a"],
            ["two", "é"],
            ["three", "€"],
            ["four", "😀"],
            ["high", "\ud800"],
            ["low", "\udc00"],
        ]);
        expect(total).toBeGreaterThan(16);
    });

    it("rejects text that cannot round-trip as Unicode", () => {
        expect(() =>
            encodeRecordPayload({
                fields: new Map([["value", "\ud800"]]),
                blob: new Uint8Array(),
            }),
        ).toThrowError(expect.objectContaining({ code: "record_text_invalid" }));
    });
});

describe("record payload decoding branches", () => {
    it("rejects truncated field headers", () => {
        const payload = rawPayload([], [], 1);
        expect(() => decodeRecordPayload(5, ID, 1n, 0n, payload)).toThrowError(
            expect.objectContaining({ code: "archive_truncated" }),
        );
    });

    it("rejects unsupported schemas", () => {
        const payload = rawPayload([]);
        new DataView(payload.buffer).setUint16(4, 2, true);
        expect(() => decodeRecordPayload(5, ID, 1n, 0n, payload)).toThrowError(
            expect.objectContaining({ code: "record_schema_unsupported" }),
        );
    });

    it("rejects an empty key and a field beyond its payload", () => {
        expect(() => decodeRecordPayload(5, ID, 1n, 0n, rawPayload([[[], []]]))).toThrowError(
            expect.objectContaining({ code: "record_field_invalid" }),
        );

        const truncated = rawPayload([[new Array(3).fill(0x61), []]]);
        new DataView(truncated.buffer).setUint16(16, 5, true);
        expect(() => decodeRecordPayload(5, ID, 1n, 0n, truncated)).toThrowError(
            expect.objectContaining({ code: "record_field_invalid" }),
        );
    });

    it("rejects invalid UTF-8 and duplicate field names", () => {
        expect(() =>
            decodeRecordPayload(5, ID, 1n, 0n, rawPayload([[[0x61], [0xff]]])),
        ).toThrowError(expect.objectContaining({ code: "record_text_invalid" }));

        expect(() =>
            decodeRecordPayload(
                5,
                ID,
                1n,
                0n,
                rawPayload([
                    [[0x61], [0x31]],
                    [[0x61], [0x32]],
                ]),
            ),
        ).toThrowError(expect.objectContaining({ code: "record_field_duplicate" }));
    });
});

describe("record frame header validation branches", () => {
    const record = { type: 5, id: ID, revision: 1n, previousOffset: 0n };

    it("rejects out-of-range record types", () => {
        expect(() => encodeRecordFrameHeader({ ...record, type: -1 }, 0, 0, 0, 0)).toThrowError(
            expect.objectContaining({ code: "record_type_invalid" }),
        );
        expect(() =>
            encodeRecordFrameHeader({ ...record, type: 0x10000 }, 0, 0, 0, 0),
        ).toThrowError(expect.objectContaining({ code: "record_type_invalid" }));
    });

    it("rejects invalid payload lengths", () => {
        expect(() => encodeRecordFrameHeader(record, -1, 0, 0, 0)).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
        expect(() =>
            encodeRecordFrameHeader(record, Number(MAX_RECORD_PAYLOAD) + 1, 0, 0, 0),
        ).toThrowError(expect.objectContaining({ code: "record_payload_limit" }));
    });

    it("rejects invalid codecs, flags, and checksums", () => {
        expect(() => encodeRecordFrameHeader(record, 0, 2 as 0 | 1, 0, 0)).toThrowError(
            expect.objectContaining({ code: "record_codec_invalid" }),
        );
        expect(() => encodeRecordFrameHeader(record, 0, 0, 2, 0)).toThrowError(
            expect.objectContaining({ code: "record_flags_invalid" }),
        );
        expect(() => encodeRecordFrameHeader(record, 0, 0, 0, -1)).toThrowError(
            expect.objectContaining({ code: "record_payload_checksum" }),
        );
    });

    it("rejects invalid header checksums, reserved bytes, flags, and codecs", () => {
        const valid = encodeRecordFrameHeader(record, 0, 0, 0, 0);
        expect(decodeRecordFrameHeader(valid).type).toBe(5);

        const mutate = (index: number, value: number): Uint8Array => {
            const bytes = valid.slice();
            bytes[index] = value;
            new DataView(bytes.buffer).setUint32(60, crc32(bytes.subarray(0, 60)), true);
            return bytes;
        };

        const badChecksum = valid.slice();
        new DataView(badChecksum.buffer).setUint32(60, 1, true);
        expect(() => decodeRecordFrameHeader(badChecksum)).toThrowError(
            expect.objectContaining({ code: "record_header_checksum" }),
        );

        for (const bytes of [mutate(54, 1), mutate(53, 2), mutate(52, 2)]) {
            expect(() => decodeRecordFrameHeader(bytes)).toThrowError(
                expect.objectContaining({ code: "record_header_checksum" }),
            );
        }
    });

    it("rejects unaligned or negative absolute offsets", () => {
        expect(() => decodeRecordFrameHeader(new Uint8Array(64), 1)).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );
        expect(() => decodeRecordFrameHeader(new Uint8Array(64), -8)).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );
    });
});

describe("record frame bounds", () => {
    const record = { type: 5, id: ID, revision: 1n, previousOffset: 0n };

    it("rejects invalid frame offsets and short headers", () => {
        const frame = encodeRecordFrame(record, new Uint8Array(3));
        expect(() => decodeRecordFrame(frame, -8)).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );
        expect(() => decodeRecordFrame(frame, 1)).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );
        expect(() => decodeRecordFrame(frame, frame.length)).toThrowError(
            expect.objectContaining({ code: "record_header_invalid" }),
        );
        expect(() => decodeRecordFrame(new Uint8Array(10))).toThrowError(
            expect.objectContaining({ code: "record_header_invalid" }),
        );
    });

    it("rejects payloads and padding beyond the archive", () => {
        const header = encodeRecordFrameHeader(record, 16, 0, 0, crc32(new Uint8Array()));
        expect(() => decodeRecordFrame(header)).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );

        const padded = encodeRecordFrame(record, new Uint8Array([1, 2, 3, 4]));
        expect(() => decodeRecordFrame(padded.slice(0, padded.length - 1))).toThrowError(
            expect.objectContaining({ code: "record_offset_invalid" }),
        );
    });

    it("rejects stored payloads flagged as encrypted", () => {
        expect(() =>
            decodeStoredPayload({ codec: 0, flags: 1, storedPayload: new Uint8Array() }),
        ).toThrowError(expect.objectContaining({ code: "archive_locked" }));
    });
});

describe("compression limits and failures", () => {
    it("rejects payloads above the uncompressed limit", () => {
        const oversized = {
            byteLength: Number(MAX_RECORD_PAYLOAD) + 1,
        } as unknown as Uint8Array;
        expect(() => compressRecordPayload(oversized)).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
    });

    it("rejects malformed LZ4 headers and lengths", () => {
        expect(() => decodeLz4Block(new Uint8Array(4))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
        expect(() => decodeLz4Block(lz4Block(MAX_RECORD_PAYLOAD + 1n, []))).toThrowError(
            expect.objectContaining({ code: "record_payload_limit" }),
        );
        expect(() => decodeLz4Block(lz4Block(20n, [0xf0]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
    });

    it("rejects literal runs that exceed their block or decoded length", () => {
        expect(() => decodeLz4Block(lz4Block(10n, [0x30, 0x41, 0x41]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
        expect(() => decodeLz4Block(lz4Block(2n, [0x30, 0x41, 0x41, 0x41]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
    });

    it("rejects invalid offsets and over-long matches", () => {
        expect(() => decodeLz4Block(lz4Block(4n, [0x10, 0x41, 0x00, 0x00]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
        expect(() => decodeLz4Block(lz4Block(4n, [0x10, 0x41, 0x01, 0x00]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
    });

    it("rejects blocks whose decoded length does not match", () => {
        expect(() => decodeLz4Block(lz4Block(4n, [0x10, 0x41]))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
    });

    it("grows the output buffer for long literal runs", () => {
        const block: number[] = [0xf0];
        let remaining = 70_000 - 15;
        while (remaining >= 255) {
            block.push(255);
            remaining -= 255;
        }
        block.push(remaining);
        for (let index = 0; index < 70_000; index += 1) block.push(0x41);
        expect(() => decodeLz4Block(lz4Block(200_000n, block))).toThrowError(
            expect.objectContaining({ code: "record_compression_invalid" }),
        );
    });

    it("returns uncompressed output when compression cannot fit its budget", () => {
        const four = Uint8Array.from([0x41, 0x41, 0x41, 0x41]);
        const pattern = prngBytes(20, 777);
        const cases = [
            withPatterns([0, 230], four),
            withPatterns([0, 229], four),
            withPatterns([0, 228, 232], four),
            withPatterns([0, 228], pattern.slice(0, 17)),
            withPatterns([0, 228], pattern.slice(0, 20)),
        ];
        for (const payload of cases) {
            expect(compressRecordPayload(payload)).toEqual({ codec: 0, bytes: payload });
        }
    });
});

describe("error identity", () => {
    it("exposes a stable error name and code", () => {
        const error = new ArchiveFormatError("some_code", "message");
        expect(error.name).toBe("ArchiveFormatError");
        expect(error.code).toBe("some_code");
    });
});
