import { describe, expect, it } from "vitest";
import {
    appendRecords,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    inspectArchiveRecovery,
    openArchiveBytes,
    rebuildDamagedPrimaryIndex,
    recoverChecksumDamagedArchiveHeader,
    recoverMagicDamagedArchiveHeader,
    verifyArchiveSnapshot,
    type ArchiveSnapshot,
} from "../../../frontend/archive/archive";
import {
    decodeArchiveHeader,
    decodeRecordFrame,
    encodeArchiveHeader,
    encodeRecordFrame,
    newUuid,
    RecordType,
    RECORD_HEADER_SIZE,
    type ArchiveRecord,
} from "../../../frontend/archive/format";
import { MemoryArchiveSource } from "../../../frontend/archive/source";

function record(
    type: number,
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

function reencodeFrameAt(
    bytes: Uint8Array,
    offset: number,
    mutate: (
        frame: ReturnType<typeof decodeRecordFrame>,
        payload: Uint8Array,
    ) => {
        payload?: Uint8Array;
        revision?: bigint;
        previousOffset?: bigint;
        codec?: 0 | 1;
        flags?: number;
    } = () => ({}),
): void {
    const frame = decodeRecordFrame(bytes.subarray(offset));
    const changes = mutate(frame, frame.storedPayload);
    const replacement = encodeRecordFrame(
        {
            type: frame.type,
            id: frame.id,
            revision: changes.revision ?? frame.revision,
            previousOffset: changes.previousOffset ?? frame.previousOffset,
        },
        changes.payload ?? frame.storedPayload,
        changes.codec ?? frame.codec,
        changes.flags ?? frame.flags,
    );
    bytes.set(replacement, offset);
}

async function plainSnapshot(): Promise<ArchiveSnapshot> {
    return appendRecords(await openArchiveBytes(await createArchiveBytes("repair source")), [
        record(RecordType.student, newUuid(), { display_name: "Mina" }),
        record(RecordType.session, newUuid(), { title: "Algebra" }),
    ]);
}

describe("damaged primary index reconstruction", () => {
    it("rebuilds a readable copy from a damaged index", async () => {
        const base = await openArchiveBytes(await createArchiveBytes("repair source"));
        const original = await appendRecords(base, [
            record(RecordType.student, newUuid(), { display_name: "Mina" }),
            record(RecordType.session, newUuid(), { title: "Algebra" }),
        ]);
        const bytes = await original.source.read(0n, Number(original.source.size));
        for (const rootOffset of [
            Number(base.commit.rootOffset),
            Number(original.commit.rootOffset),
        ]) {
            bytes[rootOffset + RECORD_HEADER_SIZE] = bytes[rootOffset + RECORD_HEADER_SIZE]! ^ 0xff;
        }
        await expect(openArchiveBytes(bytes)).rejects.toBeDefined();

        const rebuilt = await rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes));
        expect(rebuilt.sourceGeneration).toBe(original.commit.generation);
        expect(rebuilt.recoveredRecords).toBeGreaterThan(1);
        expect(rebuilt.recoveredRevisions).toBeGreaterThanOrEqual(rebuilt.recoveredRecords);
        await expect(rebuilt.snapshot.getManifest()).resolves.toMatchObject({
            displayName: "repair source",
        });
        await expect(verifyArchiveSnapshot(rebuilt.snapshot)).resolves.toMatchObject({
            generation: "1",
        });
    });

    it("rebuilds indexes for guide source aliases", async () => {
        const sessionId = newUuid();
        const guideId = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("repair guide"));
        const original = await appendRecords(base, [
            record(RecordType.session, sessionId, { title: "Session" }),
            record(RecordType.guide, guideId, {
                title: "Guide",
                session_id: sessionId,
                source_index_history: sessionId,
                section_count: "0",
            }),
        ]);
        const bytes = await original.source.read(0n, Number(original.source.size));
        for (const rootOffset of [
            Number(base.commit.rootOffset),
            Number(original.commit.rootOffset),
        ]) {
            const damagedOffset = rootOffset + RECORD_HEADER_SIZE;
            bytes[damagedOffset] = (bytes[damagedOffset] ?? 0) ^ 0xff;
        }
        const rebuilt = await rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes));
        expect(rebuilt.snapshot.allIndexEntries().has(`GUIDESOURCE:${sessionId}:${guideId}`)).toBe(
            true,
        );
    });

    it("rejects encrypted, truncated, and unknown archives", async () => {
        const encrypted = await createEncryptedArchiveBytes(
            "encrypted repair",
            "",
            "repair passphrase",
        );
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(encrypted)),
        ).rejects.toMatchObject({ code: "archive_index_repair_encrypted" });
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(new Uint8Array(10))),
        ).rejects.toMatchObject({ code: "archive_index_repair_unavailable" });

        const unknown = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("unknown repair")),
            [record(99, newUuid(), { extension: "future" })],
        );
        const bytes = await unknown.source.read(0n, Number(unknown.source.size));
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_index_repair_unknown" });
    });

    it("rejects unsupported index framing and truncated tails", async () => {
        const original = await plainSnapshot();
        const bytes = await original.source.read(0n, Number(original.source.size));
        reencodeFrameAt(bytes, Number(original.commit.rootOffset), () => ({ codec: 1 }));
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_index_repair_structure" });

        const truncated = await original.source.read(0n, Number(original.source.size));
        const withTail = new Uint8Array(truncated.length + 8);
        withTail.set(truncated);
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(withTail)),
        ).rejects.toMatchObject({ code: "archive_index_repair_unpublished" });
    });

    it("rejects headers that do not match their manifest", async () => {
        const original = await plainSnapshot();
        const bytes = await original.source.read(0n, Number(original.source.size));
        const header = decodeArchiveHeader(bytes);
        const replacement = encodeArchiveHeader({ ...header, id: newUuid() });
        bytes.set(replacement, 0);
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_index_repair_manifest" });
    });

    it("rejects incomplete or forward record lineage", async () => {
        const original = await plainSnapshot();
        const entries = [...original.allIndexEntries()].filter(([key]) =>
            key.startsWith("STUDENT:"),
        );
        const offset = Number(entries[0]![1]);

        const incomplete = await original.source.read(0n, Number(original.source.size));
        reencodeFrameAt(incomplete, offset, (frame) => ({ revision: frame.revision + 1n }));
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(incomplete)),
        ).rejects.toMatchObject({ code: "archive_index_repair_lineage" });

        const forward = await original.source.read(0n, Number(original.source.size));
        reencodeFrameAt(forward, offset, () => ({ previousOffset: 64n }));
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(forward)),
        ).rejects.toMatchObject({ code: "archive_index_repair_lineage" });
    });

    it("rejects conflicting reconstructed secondary indexes", async () => {
        const contentHash = "b".repeat(64);
        const original = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("conflict repair")),
            [
                record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
                record(RecordType.assetBlob, newUuid(), { content_hash: contentHash }),
            ],
        );
        const bytes = await original.source.read(0n, Number(original.source.size));
        await expect(
            rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_index_repair_conflict" });
    });

    it("rebuilds when a record predecessor can be relocated", async () => {
        const studentId = newUuid();
        const base = await openArchiveBytes(await createArchiveBytes("revision repair"));
        const first = await appendRecords(base, [
            record(RecordType.student, studentId, { display_name: "First" }),
        ]);
        const second = await appendRecords(first, [
            record(RecordType.student, studentId, { display_name: "Second" }),
        ]);
        const bytes = await second.source.read(0n, Number(second.source.size));
        const damagedOffset = Number(second.commit.rootOffset) + RECORD_HEADER_SIZE;
        bytes[damagedOffset] = (bytes[damagedOffset] ?? 0) ^ 0xff;
        const rebuilt = await rebuildDamagedPrimaryIndex(new MemoryArchiveSource(bytes));
        expect(rebuilt.recoveredRevisions).toBeGreaterThan(rebuilt.recoveredRecords);
        await expect(
            rebuilt.snapshot.getRecordHistory(RecordType.student, studentId),
        ).resolves.toHaveLength(2);
    });
});

describe("damaged archive header recovery", () => {
    async function archiveBytes(): Promise<Uint8Array> {
        return createArchiveBytes("header repair", "description", 1_782_930_000_000_000n);
    }

    it("repairs a checksum-only header", async () => {
        const bytes = await archiveBytes();
        bytes[60] = bytes[60]! ^ 1;
        await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
            code: "archive_header_checksum",
        });
        const repaired = await recoverChecksumDamagedArchiveHeader(new MemoryArchiveSource(bytes));
        await expect(repaired.getManifest()).resolves.toMatchObject({
            displayName: "header repair",
        });
        await expect(verifyArchiveSnapshot(repaired)).resolves.toBeDefined();
    });

    it("rejects checksum repair when it is not applicable", async () => {
        const bytes = await archiveBytes();
        await expect(
            recoverChecksumDamagedArchiveHeader(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unavailable" });
        await expect(
            recoverChecksumDamagedArchiveHeader(new MemoryArchiveSource(new Uint8Array(10))),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unavailable" });
    });

    it("repairs a damaged magic value", async () => {
        const bytes = await archiveBytes();
        bytes[0] = 0;
        await expect(openArchiveBytes(bytes)).rejects.toMatchObject({
            code: "archive_magic_invalid",
        });
        const repaired = await recoverMagicDamagedArchiveHeader(new MemoryArchiveSource(bytes));
        await expect(repaired.getManifest()).resolves.toMatchObject({
            displayName: "header repair",
        });
    });

    it("rejects magic repair when it is not applicable or unconfirmed", async () => {
        const intact = await archiveBytes();
        await expect(
            recoverMagicDamagedArchiveHeader(new MemoryArchiveSource(intact)),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unavailable" });
        await expect(
            recoverMagicDamagedArchiveHeader(new MemoryArchiveSource(new Uint8Array(10))),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unavailable" });

        const damaged = await archiveBytes();
        damaged[0] = 0;
        damaged[20] = damaged[20]! ^ 1;
        await expect(
            recoverMagicDamagedArchiveHeader(new MemoryArchiveSource(damaged)),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unavailable" });
    });

    it("requires a passphrase for an encrypted header and rejects identity mismatches", async () => {
        const passphrase = "header repair passphrase";
        const encrypted = await createEncryptedArchiveBytes("encrypted header", "", passphrase);
        encrypted[60] = encrypted[60]! ^ 1;
        await expect(
            recoverChecksumDamagedArchiveHeader(new MemoryArchiveSource(encrypted)),
        ).rejects.toMatchObject({ code: "archive_locked" });
        const repaired = await recoverChecksumDamagedArchiveHeader(
            new MemoryArchiveSource(encrypted),
            passphrase,
        );
        expect(repaired.locked).toBe(false);
        await expect(verifyArchiveSnapshot(repaired)).resolves.toBeDefined();

        const bytes = await archiveBytes();
        const header = decodeArchiveHeader(bytes);
        const mismatched = encodeArchiveHeader({ ...header, createdAtUs: header.createdAtUs + 1n });
        bytes.set(mismatched, 0);
        bytes[60] = bytes[60]! ^ 1;
        await expect(
            recoverChecksumDamagedArchiveHeader(new MemoryArchiveSource(bytes)),
        ).rejects.toMatchObject({ code: "archive_header_recovery_unverified" });
    });
});

describe("archive recovery inspection", () => {
    it("reports a repairable checksum-damaged header", async () => {
        const bytes = await createArchiveBytes("inspect checksum");
        bytes[60] = bytes[60]! ^ 1;
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection).toMatchObject({
            archiveHeaderValid: false,
            headerRepairCandidate: true,
            headerRepairAvailable: true,
            recoveryAssessmentComplete: true,
            requiresPassphrase: false,
        });
        expect(inspection.issues.join(" ")).toContain("header is damaged");
        expect(inspection.headerRepairGeneration).toBe(1n);
    });

    it("reports a repairable magic-damaged header", async () => {
        const bytes = await createArchiveBytes("inspect magic");
        bytes[0] = 0;
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection).toMatchObject({
            archiveHeaderValid: false,
            headerRepairAvailable: true,
        });
    });

    it("reports an encrypted header that needs a passphrase", async () => {
        const passphrase = "inspect passphrase";
        const encrypted = await createEncryptedArchiveBytes("inspect encrypted", "", passphrase);
        encrypted[60] = encrypted[60]! ^ 1;
        const without = await inspectArchiveRecovery(new MemoryArchiveSource(encrypted));
        expect(without).toMatchObject({
            archiveHeaderValid: false,
            headerRepairCandidate: true,
            headerRepairAvailable: false,
            requiresPassphrase: true,
            recoveryAssessmentComplete: false,
        });
        const withPassphrase = await inspectArchiveRecovery(
            new MemoryArchiveSource(encrypted),
            passphrase,
        );
        expect(withPassphrase).toMatchObject({
            headerRepairAvailable: true,
            requiresPassphrase: false,
            recoveryAssessmentComplete: true,
        });
    });

    it("reports an unrecoverable header identity mismatch", async () => {
        const bytes = await createArchiveBytes("inspect mismatch");
        const header = decodeArchiveHeader(bytes);
        bytes.set(encodeArchiveHeader({ ...header, createdAtUs: header.createdAtUs + 1n }), 0);
        bytes[60] = bytes[60]! ^ 1;
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection).toMatchObject({
            archiveHeaderValid: false,
            headerRepairCandidate: true,
            headerRepairAvailable: false,
        });
        expect(inspection.issues.join(" ")).toContain("could not be reconstructed safely");
    });

    it("reports partial header verification failures", async () => {
        const sessionId = newUuid();
        const snapshot = await appendRecords(
            await openArchiveBytes(await createArchiveBytes("inspect partial")),
            [record(RecordType.session, sessionId, { student_id: newUuid() })],
        );
        const bytes = await snapshot.source.read(0n, Number(snapshot.source.size));
        bytes[60] = bytes[60]! ^ 1;
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(bytes));
        expect(inspection).toMatchObject({
            archiveHeaderValid: false,
            headerRepairCandidate: true,
            headerRepairAvailable: false,
            recoveryAssessmentComplete: false,
        });
        expect(inspection.issues.join(" ")).toContain("partial verification");
    });

    it("reports trailing bytes without a complete commit", async () => {
        const bytes = await createArchiveBytes("inspect trailing");
        const withTail = new Uint8Array(bytes.length + 8);
        withTail.set(bytes);
        withTail.set([1, 2, 3, 4, 5, 6, 7, 8], bytes.length);
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(withTail));
        expect(inspection).toMatchObject({
            archiveHeaderValid: true,
            hasUnpublishedCommit: false,
            trailingBytes: 8n,
            recoverable: false,
        });
        expect(inspection.issues.join(" ")).toContain("Trailing archive bytes");
    });

    it("reports non-header failures without repair", async () => {
        const inspection = await inspectArchiveRecovery(
            new MemoryArchiveSource(new Uint8Array(10)),
        );
        expect(inspection.archiveHeaderValid).toBe(true);
        expect(inspection.headerRepairCandidate).toBe(false);
        expect(inspection.issues).toHaveLength(1);
    });

    it("requires a passphrase to verify unpublished encrypted data", async () => {
        const passphrase = "inspect unpublished passphrase";
        const encrypted = await createEncryptedArchiveBytes("inspect locked", "", passphrase);
        const locked = await openArchiveBytes(encrypted);
        const student = record(RecordType.student, newUuid(), { display_name: "A" });
        const unlocked = await locked.unlock(passphrase);
        const edited = await appendRecords(unlocked, [student]);
        const bytes = await edited.source.read(0n, Number(edited.source.size));
        const withoutLocator = bytes.subarray(0, bytes.length - 32);
        const inspection = await inspectArchiveRecovery(new MemoryArchiveSource(withoutLocator));
        expect(inspection).toMatchObject({
            committedGeneration: 1n,
            requiresPassphrase: true,
            recoverable: false,
        });
        unlocked.lock();
        edited.lock();
        void encrypted;
        void passphrase;
    });
});
