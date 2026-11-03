import { afterEach, describe, expect, it, vi } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import {
    ArchiveDataKey,
    encryptionEnvelopeFromRecord,
    encryptionEnvelopeToRecord,
    unwrapArchiveDataKeyBytes,
    wrapArchiveDataKeyBytesInWorker,
    type ArchiveEncryptionEnvelope,
} from "../../../frontend/archive/crypto";
import {
    ArchiveFormatError,
    newUuid,
    RecordType,
    type ArchiveRecord,
} from "../../../frontend/archive/format";

const PASSPHRASE = "a sufficiently long passphrase";

async function makeEnvelope(archiveId: string): Promise<ArchiveEncryptionEnvelope> {
    const key = await ArchiveDataKey.createRandom();
    const envelope = await key.wrap(PASSPHRASE, archiveId);
    key.dispose();
    return envelope;
}

function envelopeRecord(envelope: ArchiveEncryptionEnvelope, archiveId: string): ArchiveRecord {
    return encryptionEnvelopeToRecord(envelope, archiveId);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("archive crypto validation", () => {
    it("rejects malformed envelope buffers and KDF limits", async () => {
        const archiveId = newUuid();
        const key = await ArchiveDataKey.createRandom();
        const envelope = await key.wrap(PASSPHRASE, archiveId);
        key.dispose();

        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, salt: new Uint8Array(15) }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_metadata_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, nonce: new Uint8Array(23) }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_metadata_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, wrappedKey: new Uint8Array(47) }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_metadata_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, opsLimit: 1 }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_parameters_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, opsLimit: 4 }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_parameters_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord({ ...envelope, memoryLimit: 1 }, archiveId),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_parameters_invalid" }));
        expect(() =>
            encryptionEnvelopeToRecord(
                { ...envelope, opsLimit: 1.5, memoryLimit: 64 * 1024 * 1024 },
                archiveId,
            ),
        ).toThrowError(expect.objectContaining({ code: "archive_encryption_parameters_invalid" }));

        await expect(
            unwrapArchiveDataKeyBytes(
                PASSPHRASE,
                { ...envelope, salt: new Uint8Array(1) },
                archiveId,
            ),
        ).rejects.toMatchObject({ code: "archive_encryption_metadata_invalid" });
        await expect(
            unwrapArchiveDataKeyBytes(
                PASSPHRASE,
                { ...envelope, nonce: new Uint8Array(1) },
                archiveId,
            ),
        ).rejects.toMatchObject({ code: "archive_encryption_metadata_invalid" });
        await expect(
            unwrapArchiveDataKeyBytes(
                PASSPHRASE,
                { ...envelope, wrappedKey: new Uint8Array(1) },
                archiveId,
            ),
        ).rejects.toMatchObject({ code: "archive_encryption_metadata_invalid" });
        await expect(
            unwrapArchiveDataKeyBytes(PASSPHRASE, { ...envelope, opsLimit: 0 }, archiveId),
        ).rejects.toMatchObject({ code: "archive_encryption_parameters_invalid" });
    });

    it("rejects invalid passphrase text and lengths", async () => {
        const archiveId = newUuid();
        const key = await ArchiveDataKey.createRandom();
        await expect(key.wrap("\uD800", archiveId)).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });
        await expect(key.wrap("", archiveId)).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });
        await expect(key.wrap("x".repeat(4097), archiveId)).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });
        await expect(
            unwrapArchiveDataKeyBytes("\uD800", await makeEnvelope(archiveId), archiveId),
        ).rejects.toMatchObject({ code: "crypto_input_invalid" });
        await expect(
            unwrapArchiveDataKeyBytes("", await makeEnvelope(archiveId), archiveId),
        ).rejects.toMatchObject({ code: "crypto_input_invalid" });
        key.dispose();
    });

    it("rejects out-of-range record associated data", async () => {
        const archiveId = newUuid();
        const key = await ArchiveDataKey.createRandom();
        const plaintext = new Uint8Array([1, 2, 3]);
        const base = {
            archiveId,
            type: RecordType.student,
            recordId: newUuid(),
            revision: 1n,
            previousOffset: 0n,
        };
        await expect(
            key.encryptRecordPayload(plaintext, { ...base, previousOffset: -1n }),
        ).rejects.toMatchObject({ code: "record_integer_invalid" });
        await expect(
            key.encryptRecordPayload(plaintext, { ...base, revision: -1n }),
        ).rejects.toMatchObject({ code: "record_integer_invalid" });
        await expect(
            key.encryptRecordPayload(plaintext, { ...base, type: -1 }),
        ).rejects.toMatchObject({ code: "record_type_invalid" });
        await expect(
            key.encryptRecordPayload(plaintext, { ...base, type: 0x10000 }),
        ).rejects.toMatchObject({ code: "record_type_invalid" });
        await expect(
            key.encryptRecordPayload(plaintext, { ...base, codec: 2 as unknown as 0 }),
        ).rejects.toMatchObject({ code: "record_codec_invalid" });
        key.dispose();
    });

    it("reports KDF and key-wrap failures without leaking native errors", async () => {
        const archiveId = newUuid();
        const envelope = await makeEnvelope(archiveId);
        const key = await ArchiveDataKey.createRandom();

        const pwhash = vi.spyOn(sodium, "crypto_pwhash").mockImplementation(() => {
            throw new Error("out of memory");
        });
        await expect(
            unwrapArchiveDataKeyBytes(PASSPHRASE, envelope, archiveId),
        ).rejects.toMatchObject({ code: "crypto_memory_unavailable" });
        await expect(key.wrap(PASSPHRASE, archiveId)).rejects.toMatchObject({
            code: "crypto_memory_unavailable",
        });
        pwhash.mockRestore();

        const encrypt = vi
            .spyOn(sodium, "crypto_aead_xchacha20poly1305_ietf_encrypt")
            .mockReturnValue(new Uint8Array(10) as unknown as string);
        await expect(key.wrap(PASSPHRASE, archiveId)).rejects.toMatchObject({
            code: "crypto_key_wrap_failed",
        });
        encrypt.mockRestore();

        const random = vi.spyOn(sodium, "randombytes_buf").mockImplementation(() => {
            throw new Error("no entropy");
        });
        await expect(key.wrap(PASSPHRASE, archiveId)).rejects.toMatchObject({
            code: "crypto_key_wrap_failed",
        });
        random.mockRestore();
        key.dispose();
    });

    it("rejects envelope metadata that is malformed or unsupported", async () => {
        const archiveId = newUuid();
        const envelope = await makeEnvelope(archiveId);
        const valid = envelopeRecord(envelope, archiveId);

        const badSalt = { ...valid, fields: new Map(valid.fields) };
        badSalt.fields.set("salt", "zz");
        expect(() => encryptionEnvelopeFromRecord(badSalt, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const badNonce = { ...valid, fields: new Map(valid.fields) };
        badNonce.fields.set("nonce", "00");
        expect(() => encryptionEnvelopeFromRecord(badNonce, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const badKey = { ...valid, fields: new Map(valid.fields) };
        badKey.fields.set("wrapped_key", "00");
        expect(() => encryptionEnvelopeFromRecord(badKey, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const badOps = { ...valid, fields: new Map(valid.fields) };
        badOps.fields.set("opslimit", "abc");
        expect(() => encryptionEnvelopeFromRecord(badOps, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const hugeMem = { ...valid, fields: new Map(valid.fields) };
        hugeMem.fields.set("memlimit", "99999999999999999999");
        expect(() => encryptionEnvelopeFromRecord(hugeMem, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_parameters_invalid" }),
        );

        const unsupportedVersion = { ...valid, fields: new Map(valid.fields) };
        unsupportedVersion.fields.set("encryption_version", "2");
        expect(() => encryptionEnvelopeFromRecord(unsupportedVersion, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const wrongId = { ...valid, fields: new Map(valid.fields) };
        expect(() => encryptionEnvelopeFromRecord(wrongId, newUuid())).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        const wrongType = { ...valid, type: RecordType.settings, fields: new Map(valid.fields) };
        expect(() => encryptionEnvelopeFromRecord(wrongType, archiveId)).toThrowError(
            expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
        );

        for (const missing of ["salt", "nonce", "wrapped_key", "opslimit", "memlimit"]) {
            const fields = new Map(valid.fields);
            fields.delete(missing);
            expect(() =>
                encryptionEnvelopeFromRecord({ ...valid, fields }, archiveId),
            ).toThrowError(
                expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
            );
        }
        expect(encryptionEnvelopeFromRecord(valid, archiveId).salt).toHaveLength(16);
    });

    it("rejects payloads outside the v1 encryption limits", async () => {
        const archiveId = newUuid();
        const key = await ArchiveDataKey.createRandom();
        const context = {
            archiveId,
            type: RecordType.student,
            recordId: newUuid(),
            revision: 1n,
            previousOffset: 0n,
        };
        const oversized = new Uint8Array(1);
        Object.defineProperty(oversized, "byteLength", { value: 256 * 1024 * 1024 + 1 });
        await expect(key.encryptRecordPayload(oversized, context)).rejects.toMatchObject({
            code: "record_payload_limit",
        });

        const oversizedCiphertext = new Uint8Array(1);
        Object.defineProperty(oversizedCiphertext, "byteLength", {
            value: 256 * 1024 * 1024 + 1,
        });
        await expect(key.decryptRecordPayload(oversizedCiphertext, context)).rejects.toMatchObject({
            code: "record_payload_limit",
        });

        await expect(key.decryptRecordPayload(new Uint8Array(10), context)).rejects.toMatchObject({
            code: "archive_record_encrypted",
        });
        key.dispose();
    });

    it("rejects disposed keys for every operation", async () => {
        const key = await ArchiveDataKey.createRandom();
        key.dispose();
        expect(() => key.clone()).toThrowError(
            expect.objectContaining({ code: "archive_key_disposed" }),
        );
        await expect(key.wrap(PASSPHRASE, newUuid())).rejects.toMatchObject({
            code: "archive_key_disposed",
        });
        await expect(
            key.encryptRecordPayload(new Uint8Array(1), {
                archiveId: newUuid(),
                type: RecordType.student,
                recordId: newUuid(),
                revision: 1n,
                previousOffset: 0n,
            }),
        ).rejects.toMatchObject({ code: "archive_key_disposed" });
        await expect(
            key.decryptRecordPayload(new Uint8Array(64), {
                archiveId: newUuid(),
                type: RecordType.student,
                recordId: newUuid(),
                revision: 1n,
                previousOffset: 0n,
            }),
        ).rejects.toMatchObject({ code: "archive_key_disposed" });
        await expect(
            key.authenticationMatches("label", new Uint8Array(), new Uint8Array(32)),
        ).rejects.toMatchObject({ code: "archive_key_disposed" });
    });
});

class FakeWorker {
    static instances: FakeWorker[] = [];
    static respond: ((worker: FakeWorker, message: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { preventDefault: () => void }) => void) | null = null;
    terminated = 0;
    posted: { message: unknown; transfer?: Transferable[] }[] = [];

    constructor(
        readonly url: URL,
        readonly options: unknown,
    ) {
        FakeWorker.instances.push(this);
    }

    terminate(): void {
        this.terminated += 1;
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
        this.posted.push(transfer === undefined ? { message } : { message, transfer });
        FakeWorker.respond?.(this, message);
    }

    static install(): void {
        vi.stubGlobal("window", {});
        vi.stubGlobal("Worker", FakeWorker);
    }
}

function latest(): FakeWorker {
    return FakeWorker.instances[FakeWorker.instances.length - 1]!;
}

function reply(response: unknown): void {
    FakeWorker.respond = (worker) => {
        worker.onmessage?.({ data: response });
    };
}

const envelopeForWorker: ArchiveEncryptionEnvelope = {
    salt: new Uint8Array(16),
    nonce: new Uint8Array(24),
    wrappedKey: new Uint8Array(48),
    opsLimit: 2,
    memoryLimit: 64 * 1024 * 1024,
};

afterEach(() => {
    FakeWorker.instances = [];
    FakeWorker.respond = null;
});

describe("ArchiveDataKey worker protocol", () => {
    it("requires Web Worker support when running in a browser", async () => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("Worker", undefined);
        await expect(
            ArchiveDataKey.unwrap(PASSPHRASE, envelopeForWorker, newUuid()),
        ).rejects.toMatchObject({ code: "crypto_worker_unavailable" });

        const key = await ArchiveDataKey.createRandom();
        await expect(key.wrap(PASSPHRASE, newUuid())).rejects.toMatchObject({
            code: "crypto_worker_unavailable",
        });
        key.dispose();
    });

    it("derives and transfers an unwrap key through a worker", async () => {
        FakeWorker.install();
        const keyBytes = new Uint8Array(32).fill(5).buffer;
        reply({ success: true, operation: "unwrap", key: keyBytes });
        const archiveId = newUuid();
        const key = await ArchiveDataKey.unwrap(PASSPHRASE, envelopeForWorker, archiveId);
        expect(latest().terminated).toBe(1);
        expect(latest().posted[0]!.message).toMatchObject({
            operation: "unwrap",
            passphrase: PASSPHRASE,
            archiveId,
        });
        const roundTrip = await key.encryptRecordPayload(new Uint8Array([1]), {
            archiveId,
            type: RecordType.student,
            recordId: newUuid(),
            revision: 1n,
            previousOffset: 0n,
        });
        expect(roundTrip.byteLength).toBeGreaterThan(40);
        key.dispose();
    });

    it("rejects invalid unwrap worker responses", async () => {
        FakeWorker.install();
        const cases: { response: unknown; code: string }[] = [
            { response: null, code: "crypto_worker_failed" },
            { response: 7, code: "crypto_worker_failed" },
            {
                response: { success: true, operation: "unwrap", key: "nope" },
                code: "crypto_worker_failed",
            },
            {
                response: { success: true, operation: "unwrap", key: new ArrayBuffer(16) },
                code: "crypto_worker_failed",
            },
            {
                response: { success: true, operation: "wrap", envelope: envelopeForWorker },
                code: "crypto_worker_failed",
            },
            {
                response: { success: false, code: "archive_passphrase_invalid", message: "bad" },
                code: "archive_passphrase_invalid",
            },
        ];
        for (const testCase of cases) {
            reply(testCase.response);
            await expect(
                ArchiveDataKey.unwrap(PASSPHRASE, envelopeForWorker, newUuid()),
            ).rejects.toMatchObject({ code: testCase.code });
            expect(latest().terminated).toBe(1);
        }
    });

    it("rejects unwrap worker errors and postMessage failures", async () => {
        FakeWorker.install();
        FakeWorker.respond = (worker) => {
            worker.onerror?.({ preventDefault: () => undefined });
        };
        await expect(
            ArchiveDataKey.unwrap(PASSPHRASE, envelopeForWorker, newUuid()),
        ).rejects.toMatchObject({ code: "crypto_worker_failed" });
        expect(latest().terminated).toBe(1);

        FakeWorker.respond = () => {
            throw new Error("cannot post");
        };
        await expect(
            ArchiveDataKey.unwrap(PASSPHRASE, envelopeForWorker, newUuid()),
        ).rejects.toMatchObject({ code: "crypto_worker_failed" });
        expect(latest().terminated).toBe(1);
    });

    it("wraps a key through a worker", async () => {
        FakeWorker.install();
        reply({ success: true, operation: "wrap", envelope: envelopeForWorker });
        const key = await ArchiveDataKey.createRandom();
        const envelope = await key.wrap(PASSPHRASE, newUuid());
        expect(envelope).toBe(envelopeForWorker);
        expect(latest().terminated).toBe(1);
        expect(latest().posted[0]!.transfer).toHaveLength(1);
        key.dispose();
    });

    it("rejects invalid wrap worker responses and errors", async () => {
        FakeWorker.install();
        const cases: { response: unknown; code: string }[] = [
            { response: null, code: "crypto_worker_failed" },
            {
                response: { success: true, operation: "unwrap", key: new ArrayBuffer(32) },
                code: "crypto_worker_failed",
            },
            {
                response: { success: false, code: "crypto_key_wrap_failed", message: "bad" },
                code: "crypto_key_wrap_failed",
            },
        ];
        for (const testCase of cases) {
            reply(testCase.response);
            const key = await ArchiveDataKey.createRandom();
            await expect(key.wrap(PASSPHRASE, newUuid())).rejects.toMatchObject({
                code: testCase.code,
            });
            expect(latest().terminated).toBe(1);
            key.dispose();
        }

        FakeWorker.respond = (worker) => {
            worker.onerror?.({ preventDefault: () => undefined });
        };
        let key = await ArchiveDataKey.createRandom();
        await expect(key.wrap(PASSPHRASE, newUuid())).rejects.toMatchObject({
            code: "crypto_worker_failed",
        });
        key.dispose();

        FakeWorker.respond = () => {
            throw new Error("cannot post");
        };
        key = await ArchiveDataKey.createRandom();
        await expect(key.wrap(PASSPHRASE, newUuid())).rejects.toMatchObject({
            code: "crypto_worker_failed",
        });
        key.dispose();
    });

    it("exposes the worker wrap entry point directly", async () => {
        const archiveId = newUuid();
        const key = new Uint8Array(32).fill(1);
        const envelope = await wrapArchiveDataKeyBytesInWorker(PASSPHRASE, key, archiveId);
        expect(envelope.wrappedKey).toHaveLength(48);
        const unwrapped = await unwrapArchiveDataKeyBytes(PASSPHRASE, envelope, archiveId);
        expect(unwrapped).toEqual(key);
    });
});

describe("archive crypto error helpers", () => {
    it("treats non-format errors as typed failures", async () => {
        const key = await ArchiveDataKey.createRandom();
        const wrongLength = new Uint8Array(31);
        await expect(
            key.authenticationMatches("label", new Uint8Array(), wrongLength),
        ).resolves.toBe(false);
        key.dispose();
        expect(new ArchiveFormatError("x", "y").name).toBe("ArchiveFormatError");
    });
});
