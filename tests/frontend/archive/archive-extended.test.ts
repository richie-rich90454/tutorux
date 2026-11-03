import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveBytes,
    verifyArchiveSnapshot,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import {
    decodeRecordFrame,
    decodeRecordFrameHeader,
    encodeRecordFrame,
    newUuid,
    RecordType,
    RECORD_HEADER_SIZE,
    type ArchiveRecord,
    type RecordTypeValue,
} from "../../../frontend/archive/format";
import { MemoryArchiveSource } from "../../../frontend/archive/source";

function record(
    type: RecordTypeValue,
    id: string,
    fields: Record<string, string> = {},
    blob = new Uint8Array(),
): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob,
    };
}

async function plain(records: ArchiveRecord[] = []): Promise<ArchiveSnapshot> {
    const empty = await openArchiveBytes(await createArchiveBytes("extended snapshot"));
    return records.length ? appendRecords(empty, records) : empty;
}

async function readFrame(snapshot: ArchiveSnapshot, offset: bigint) {
    const header = decodeRecordFrameHeader(await snapshot.source.read(offset, RECORD_HEADER_SIZE));
    const padding = (8 - (header.payloadLength % 8)) % 8;
    return decodeRecordFrame(
        await snapshot.source.read(offset, RECORD_HEADER_SIZE + header.payloadLength + padding),
    );
}

function reencodeFrameAt(
    bytes: Uint8Array,
    offset: number,
    mutate: (payload: Uint8Array) => void,
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const payload = frame.storedPayload.slice();
    mutate(payload);
    const replacement = encodeRecordFrame(
        {
            type: frame.type,
            id: frame.id,
            revision: frame.revision,
            previousOffset: frame.previousOffset,
        },
        payload,
        frame.codec,
        frame.flags,
    );
    bytes.set(replacement, offset);
}

describe("archive snapshot lifecycle", () => {
    it("rejects passphrase operations on plaintext and locked snapshots", async () => {
        const plaintext = await plain();
        await expect(plaintext.unlock("any passphrase here")).rejects.toMatchObject({
            code: "archive_not_encrypted",
        });
        await expect(
            plaintext.changePassphrase("any passphrase here", "another passphrase here"),
        ).rejects.toMatchObject({ code: "archive_not_encrypted" });

        const passphrase = "extended encrypted passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("extended", "", passphrase),
        );
        await expect(
            locked.changePassphrase(passphrase, "a different passphrase"),
        ).rejects.toMatchObject({ code: "archive_locked" });
        await expect(
            locked.authenticateEncryptedPayload("label", new Uint8Array()),
        ).rejects.toMatchObject({ code: "archive_locked" });
        await expect(
            locked.encodeRecordFrameForAppend(record(RecordType.student, newUuid())),
        ).rejects.toMatchObject({ code: "archive_locked" });

        const unlocked = await locked.unlock(passphrase);
        expect(await unlocked.unlock(passphrase)).toBe(unlocked);
        const authentication = await unlocked.authenticateEncryptedPayload(
            "TUTORUX-MANIFEST-V1",
            new Uint8Array([1, 2, 3]),
        );
        expect(authentication).toHaveLength(32);
        await expect(
            unlocked.authenticateEncryptedPayload("label", new Uint8Array()),
        ).resolves.toHaveLength(32);
        await expect(
            plaintext.authenticateEncryptedPayload("label", new Uint8Array()),
        ).rejects.toMatchObject({ code: "archive_locked" });
        unlocked.lock();
    });

    it("enables encryption and re-keys an archive", async () => {
        const firstPassphrase = "first extended passphrase";
        const secondPassphrase = "second extended passphrase";
        const snapshot = await plain([
            record(RecordType.student, newUuid(), { display_name: "A" }),
        ]);
        const encrypted = await snapshot.enableEncryption(firstPassphrase);
        expect(encrypted.encrypted).toBe(true);
        expect(encrypted.locked).toBe(false);
        await expect(verifyArchiveSnapshot(encrypted)).resolves.toMatchObject({
            currentRecords: 3,
        });
        await expect(encrypted.enableEncryption(secondPassphrase)).rejects.toMatchObject({
            code: "archive_already_encrypted",
        });
        await expect(
            encrypted.changePassphrase(firstPassphrase, firstPassphrase),
        ).rejects.toMatchObject({ code: "archive_passphrase_unchanged" });
        await expect(
            encrypted.changePassphrase("wrong current passphrase", secondPassphrase),
        ).rejects.toMatchObject({ code: "archive_passphrase_invalid" });

        const rekeyed = await encrypted.changePassphrase(firstPassphrase, secondPassphrase);
        await expect(verifyArchiveSnapshot(rekeyed)).resolves.toMatchObject({ currentRecords: 3 });
        const bytes = await rekeyed.source.read(0n, Number(rekeyed.source.size));
        const reopened = await openArchiveBytes(bytes);
        await expect(reopened.unlock(firstPassphrase)).rejects.toMatchObject({
            code: "archive_passphrase_invalid",
        });
        const unlocked = await reopened.unlock(secondPassphrase);
        await expect(verifyArchiveSnapshot(unlocked)).resolves.toMatchObject({ currentRecords: 3 });

        await expect(snapshot.enableEncryption("short")).rejects.toMatchObject({
            code: "archive_passphrase_too_short",
        });
        await expect(snapshot.enableEncryption("\uD800".repeat(20))).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });
        await expect(snapshot.enableEncryption("x".repeat(4097))).rejects.toMatchObject({
            code: "crypto_input_invalid",
        });

        rekeyed.lock();
        unlocked.lock();
        encrypted.lock();
    });

    it("refuses encryption when the archive already has encryption metadata", async () => {
        const snapshot = await plain();
        const withEnvelope = await appendRecords(snapshot, [
            record(RecordType.encryption, snapshot.header.id, { encryption_version: "1" }),
        ]);
        await expect(withEnvelope.enableEncryption("some valid passphrase")).rejects.toMatchObject({
            code: "archive_encryption_metadata_invalid",
        });
    });

    it("relocates protected frames only for unlocked encrypted archives", async () => {
        const passphrase = "relocation passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("relocate", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const studentId = newUuid();
        const edited = await appendRecords(unlocked, [
            record(RecordType.student, studentId, { display_name: "Mina" }),
        ]);
        const offset = edited.allIndexEntries().get(`STUDENT:${studentId}`)!;
        const frame = await readFrame(edited, offset);
        expect(frame.flags & 1).toBe(1);
        const relocated = await edited.relocateProtectedFrame(frame, 0n);
        const relocatedFrame = decodeRecordFrame(relocated);
        expect(relocatedFrame.previousOffset).toBe(0n);
        expect(relocatedFrame.id).toBe(studentId);

        const plaintext = await plain();
        await expect(plaintext.relocateProtectedFrame(frame, 0n)).rejects.toMatchObject({
            code: "archive_locked",
        });
        const manifestFrame = await readFrame(
            edited,
            edited.allIndexEntries().get(`SETTINGS:${edited.header.id}`)!,
        );
        await expect(edited.relocateProtectedFrame(manifestFrame, 0n)).rejects.toMatchObject({
            code: "archive_locked",
        });
        locked.lock();
        unlocked.lock();
        edited.lock();
    });

    it("opens cloned generations for encrypted snapshots", async () => {
        const passphrase = "generation passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("generation", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const next = await unlocked.openGeneration(
            unlocked.source,
            unlocked.commit,
            new Map(unlocked.allIndexEntries()),
            unlocked.publishedEndOffset,
        );
        expect(next.locked).toBe(false);
        await expect(next.getManifest()).resolves.toMatchObject({ displayName: "generation" });
        next.lock();

        const reopened = await unlocked.openNextGeneration(unlocked.source);
        expect(reopened.commit.generation).toBe(unlocked.commit.generation);
        reopened.lock();

        const bytes = await unlocked.source.read(0n, Number(unlocked.source.size));
        const commitFrame = await readFrame(unlocked, unlocked.commit.offset);
        reencodeFrameAt(bytes, Number(unlocked.commit.offset), (payload) => {
            payload[payload.length - 1] = payload[payload.length - 1]! ^ 1;
        });
        void commitFrame;
        await expect(
            unlocked.openNextGeneration(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_commit_authentication_failed" });
        locked.lock();
        unlocked.lock();
    });

    it("reads records by index key and validates history limits", async () => {
        const studentId = newUuid();
        const snapshot = await plain([
            record(RecordType.student, studentId, { display_name: "A" }),
        ]);
        await expect(snapshot.getRecordByIndexKey(`STUDENT:${studentId}`)).resolves.toMatchObject({
            id: studentId,
        });
        await expect(snapshot.getRecordByIndexKey("STUDENT:missing")).resolves.toBeNull();
        await expect(
            snapshot.getRecordHistory(RecordType.student, studentId, 0),
        ).rejects.toMatchObject({ code: "history_limit_invalid" });
        await expect(
            snapshot.getRecordHistory(RecordType.student, studentId, 1.5),
        ).rejects.toMatchObject({ code: "history_limit_invalid" });
        await expect(
            snapshot.getRecordHistory(RecordType.student, studentId, 10_001),
        ).rejects.toMatchObject({ code: "history_limit_invalid" });
        await expect(
            snapshot.getRecordHistory(RecordType.student, studentId),
        ).resolves.toHaveLength(1);
        await expect(snapshot.listRecords(RecordType.student, true)).resolves.toHaveLength(1);
    });

    it("verifies revision frames for unknown and known record types", async () => {
        const extensionId = newUuid();
        const studentId = newUuid();
        const snapshot = await plain([
            record(99, extensionId, { extension: "payload" }),
            record(RecordType.student, studentId, { display_name: "A" }),
        ]);
        const extensionFrame = await readFrame(
            snapshot,
            snapshot.allIndexEntries().get(`UNKNOWN:${extensionId}`)!,
        );
        await expect(snapshot.verifyRevisionFrame(extensionFrame)).resolves.toBeUndefined();
        const studentFrame = await readFrame(
            snapshot,
            snapshot.allIndexEntries().get(`STUDENT:${studentId}`)!,
        );
        await expect(snapshot.verifyRevisionFrame(studentFrame)).resolves.toBeUndefined();
    });

    it("rejects inconsistent encryption flags on decoded frames", async () => {
        const studentId = newUuid();
        const plaintext = await plain([
            record(RecordType.student, studentId, { display_name: "A" }),
        ]);
        const frame = await readFrame(
            plaintext,
            plaintext.allIndexEntries().get(`STUDENT:${studentId}`)!,
        );
        await expect(plaintext.decodeFramePayload({ ...frame, flags: 1 })).rejects.toMatchObject({
            code: "archive_record_encryption_invalid",
        });

        const passphrase = "frame flags passphrase";
        const unlocked = await (
            await openArchiveBytes(await createEncryptedArchiveBytes("flags", "", passphrase))
        ).unlock(passphrase);
        const manifestFrame = await readFrame(
            unlocked,
            unlocked.allIndexEntries().get(`SETTINGS:${unlocked.header.id}`)!,
        );
        await expect(
            unlocked.decodeFramePayload({ ...manifestFrame, flags: 1 }),
        ).rejects.toMatchObject({ code: "archive_record_encryption_invalid" });
        await expect(
            unlocked.decodeFramePayload({ ...manifestFrame, flags: 0 }),
        ).resolves.toBeInstanceOf(Uint8Array);
        await expect(
            unlocked.decodeFramePayload({
                ...manifestFrame,
                type: RecordType.student,
                flags: 0,
            }),
        ).rejects.toMatchObject({ code: "archive_record_unencrypted" });
        unlocked.lock();
    });

    it("requires an unlocked key to decode protected frames", async () => {
        const passphrase = "protected frame passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("protected", "", passphrase),
        );
        const unlocked = await locked.unlock(passphrase);
        const studentId = newUuid();
        const edited = await appendRecords(unlocked, [
            record(RecordType.student, studentId, { display_name: "A" }),
        ]);
        const frame = await readFrame(
            edited,
            edited.allIndexEntries().get(`STUDENT:${studentId}`)!,
        );
        await expect(locked.decodeFramePayload(frame)).rejects.toMatchObject({
            code: "archive_locked",
        });
        await expect(edited.decodeFramePayload(frame)).resolves.toBeInstanceOf(Uint8Array);
        locked.lock();
        unlocked.lock();
        edited.lock();
    });

    it("verifies encrypted index trees and rejects a mismatched root", async () => {
        const passphrase = "index tree passphrase";
        const unlocked = await (
            await openArchiveBytes(await createEncryptedArchiveBytes("tree", "", passphrase))
        ).unlock(passphrase);
        const tree = await unlocked.readVerifiedIndexTree(unlocked.commit);
        expect(tree.entries.size).toBeGreaterThan(0);
        expect(tree.pageOffsets.length).toBeGreaterThan(0);
        await expect(
            unlocked.readVerifiedIndexTree({ ...unlocked.commit, rootHash: new Uint8Array(32) }),
        ).rejects.toMatchObject({ code: "archive_commit_root_invalid" });
        const plaintext = await plain();
        const plainTree = await plaintext.readVerifiedIndexTree(plaintext.commit);
        expect(plainTree.entries.size).toBeGreaterThan(0);
        unlocked.lock();
    });

    it("lists audio chunk metadata and session track identifiers", async () => {
        const sessionId = newUuid();
        const trackId = newUuid();
        const otherTrack = newUuid();
        const otherSession = newUuid();
        const chunkZero = newUuid();
        const chunkOne = newUuid();
        const chunkOther = newUuid();
        const chunkDeleted = newUuid();
        const snapshot = await plain([
            record(RecordType.session, sessionId, {}),
            record(RecordType.audioChunk, chunkZero, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "0",
            }),
            record(RecordType.audioChunk, chunkOne, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "10",
            }),
            record(RecordType.audioChunk, chunkOther, {
                session_id: otherSession,
                track_id: otherTrack,
                sequence_number: "0",
            }),
            record(RecordType.audioChunk, chunkDeleted, {
                session_id: sessionId,
                track_id: trackId,
                sequence_number: "20",
                _deleted: "true",
            }),
        ]);
        const metadata = await snapshot.listAudioChunkMetadata(sessionId, trackId);
        expect(metadata.map((item) => item.id)).toEqual([chunkZero, chunkOne]);
        const withDeleted = await snapshot.listAudioChunkMetadata(sessionId, trackId, true);
        expect(withDeleted).toHaveLength(3);
        await expect(snapshot.listAudioChunkMetadata("not-a-uuid", trackId)).rejects.toMatchObject({
            code: "audio_chunk_identity_invalid",
        });
        await expect(
            snapshot.listAudioChunkMetadata(sessionId, "not-a-uuid"),
        ).rejects.toMatchObject({ code: "audio_chunk_identity_invalid" });

        const tracks = snapshot.audioTrackIdsBySession();
        expect(tracks.get(sessionId)).toEqual([trackId]);
        expect(tracks.get(otherSession)).toEqual([otherTrack]);
    });

    it("lists metadata for encrypted archives without blobs", async () => {
        const passphrase = "metadata listing passphrase";
        const unlocked = await (
            await openArchiveBytes(await createEncryptedArchiveBytes("metadata", "", passphrase))
        ).unlock(passphrase);
        const studentId = newUuid();
        const edited = await appendRecords(unlocked, [
            record(RecordType.student, studentId, { display_name: "A" }, new Uint8Array([1, 2, 3])),
        ]);
        const [metadata] = await edited.listRecordMetadata(RecordType.student);
        expect(metadata?.blob).toHaveLength(0);
        const [full] = await edited.listRecords(RecordType.student);
        expect(full?.blob).toHaveLength(3);
        edited.lock();
        unlocked.lock();
        void passphrase;
    });

    it("verifies encryption authentication errors", async () => {
        const passphrase = "authentication passphrase";
        const locked = await openArchiveBytes(
            await createEncryptedArchiveBytes("auth", "", passphrase),
        );
        await expect(locked.verifyEncryptionAuthentication()).rejects.toMatchObject({
            code: "archive_locked",
        });
        const unlocked = await locked.unlock(passphrase);
        await expect(unlocked.verifyEncryptionAuthentication()).resolves.toBeUndefined();

        const bytes = await unlocked.source.read(0n, Number(unlocked.source.size));
        const commitFrame = await readFrame(unlocked, unlocked.commit.offset);
        void commitFrame;
        reencodeFrameAt(bytes, Number(unlocked.commit.offset), (payload) => {
            payload[payload.length - 1] = payload[payload.length - 1]! ^ 1;
        });
        const reopened = await openArchiveBytes(bytes);
        const wrong = await reopened.unlock(passphrase).catch((error: unknown) => error);
        expect(wrong).toMatchObject({ code: "archive_commit_authentication_failed" });
        expect(reopened.locked).toBe(true);
        unlocked.lock();
        locked.lock();
    });
});

describe("archive snapshot manifest fallbacks", () => {
    it("falls back to defaults for missing manifest fields", async () => {
        const snapshot = await plain();
        const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
        if (!manifest) throw new Error("manifest missing");
        const fields = new Map(manifest.fields);
        fields.delete("display_name");
        const rewrittenManifest = { ...manifest, fields };
        const withManifest = await appendRecords(snapshot, [rewrittenManifest]);
        await expect(withManifest.getManifest()).resolves.toMatchObject({
            displayName: "Tutorux archive",
            description: "",
        });
    });
});
