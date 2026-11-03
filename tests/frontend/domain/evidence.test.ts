import { describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    classifyTranscriptEvidence,
    evidenceSourcesAreCurrent,
    extractSessionEvidence,
    makeEvidenceEdge,
    makeEvidenceRecord,
    restoreEvidenceEdge,
    restoreEvidenceRecordGroup,
    reviewEvidenceRecord,
    trashEvidenceEdge,
    trashEvidenceRecord,
    updateEvidenceRecord,
} from "../../../frontend/domain/evidence";

type FixtureRecord = ArchiveRecord & { fields: Map<string, string> };

function evidenceRecord(overrides: Record<string, string> = {}): ArchiveRecord {
    return {
        type: RecordType.evidenceNode,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: 3n,
        previousOffset: 42n,
        blob: new Uint8Array(),
        fields: new Map<string, string>([
            ["session_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
            ["title", "Possible explanation"],
            ["type", "explanation-candidate"],
            ["content", "The student described the reason."],
            ["priority", "normal"],
            ["verification_state", "human-verified"],
            ["reviewed_at_us", "1700000000000000"],
            ["source_segment_ids", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
            ...Object.entries(overrides),
        ]),
    };
}

function evidenceEdge(fromId: string, toId: string, id: string): FixtureRecord {
    return {
        type: RecordType.evidenceEdge,
        id,
        revision: 1n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
            ["from_id", fromId],
            ["to_id", toId],
            ["relationship", "supports"],
        ]),
    };
}

describe("evidence editing and recoverable relationships", () => {
    it("creates tutor-authored evidence with current transcript and material provenance", async () => {
        const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const segmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const assetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const session: ArchiveRecord = {
            ...evidenceRecord(),
            type: RecordType.session,
            id: sessionId,
            fields: new Map([["student_id", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]]),
        };
        const segment: ArchiveRecord = {
            ...evidenceRecord(),
            type: RecordType.transcriptSegment,
            id: segmentId,
            revision: 7n,
            fields: new Map([
                ["session_id", sessionId],
                ["linked_asset_ids", assetId],
                ["speaker_label", "Tutor"],
                ["start_time_us", "1200000"],
                ["end_time_us", "3400000"],
            ]),
        };
        const snapshot = {
            getRecord: vi.fn(async (type: number) =>
                type === RecordType.session ? session : segment,
            ),
        } as unknown as ArchiveSnapshot;

        const created = await makeEvidenceRecord(snapshot, sessionId, segmentId, {
            title: "Tutor explanation",
            type: "Tutor Explanation",
            content: "The learner used a common denominator.",
            priority: "high",
        });

        expect(created.type).toBe(RecordType.evidenceNode);
        expect(created.revision).toBe(0n);
        expect(created.fields.get("student_id")).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
        expect(created.fields.get("origin")).toBe("tutor-authored");
        expect(created.fields.get("type")).toBe("tutor-explanation");
        expect(created.fields.get("verification_state")).toBe("needs-review");
        expect(created.fields.get("source_segment_ids")).toBe(segmentId);
        expect(created.fields.get("source_segment_revision")).toBe("7");
        expect(created.fields.get("source_segment_revisions")).toBe(`${segmentId}=7`);
        expect(created.fields.get("source_asset_ids")).toBe(assetId);
        expect(created.fields.get("source_speaker_label")).toBe("Tutor");
        expect(created.fields.get("start_time_us")).toBe("1200000");
        expect(created.fields.get("end_time_us")).toBe("3400000");
    });

    it("rejects transcript sources from another session and empty content", async () => {
        const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const segmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const session = { ...evidenceRecord(), type: RecordType.session, id: sessionId };
        const segment = {
            ...evidenceRecord({ session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
            type: RecordType.transcriptSegment,
            id: segmentId,
        };
        const snapshot = {
            getRecord: vi.fn(async (type: number) =>
                type === RecordType.session ? session : segment,
            ),
        } as unknown as ArchiveSnapshot;

        await expect(
            makeEvidenceRecord(snapshot, sessionId, segmentId, {
                title: "Title",
                type: "claim",
                content: "Text",
                priority: "normal",
            }),
        ).rejects.toThrow("selected session");
        await expect(
            makeEvidenceRecord(
                {
                    ...snapshot,
                    getRecord: vi.fn(async (type: number) =>
                        type === RecordType.session
                            ? session
                            : { ...segment, fields: new Map([["session_id", sessionId]]) },
                    ),
                } as unknown as ArchiveSnapshot,
                sessionId,
                segmentId,
                { title: "Title", type: "claim", content: " ", priority: "normal" },
            ),
        ).rejects.toThrow("Evidence content cannot be empty");
    });

    it("treats a singular legacy source_segment_revision as stale after the segment changes", async () => {
        const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const segmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        const record = evidenceRecord({
            session_id: sessionId,
            source_segment_ids: segmentId,
            source_segment_revision: "7",
        });
        const segment = {
            ...evidenceRecord(),
            type: RecordType.transcriptSegment,
            id: segmentId,
            revision: 7n,
            fields: new Map([["session_id", sessionId]]),
        };
        const snapshot = {
            getRecord: vi.fn(async (type: number, id: string) =>
                type === RecordType.transcriptSegment && id === segmentId ? segment : null,
            ),
        } as unknown as ArchiveSnapshot;

        await expect(evidenceSourcesAreCurrent(snapshot, record)).resolves.toBe(true);
        await expect(
            evidenceSourcesAreCurrent(
                {
                    ...snapshot,
                    getRecord: vi.fn(async (type: number, id: string) =>
                        type === RecordType.transcriptSegment && id === segmentId
                            ? { ...segment, revision: 8n }
                            : null,
                    ),
                } as unknown as ArchiveSnapshot,
                record,
            ),
        ).resolves.toBe(false);
    });

    it("updates editable fields and returns the item to source review", () => {
        const original = evidenceRecord();
        const updated = updateEvidenceRecord(original, {
            title: "Tutor explanation",
            type: "Tutor Explanation",
            content: "A corrected summary.",
            priority: "high",
        });

        expect(updated.revision).toBe(original.revision);
        expect(updated.previousOffset).toBe(original.previousOffset);
        expect(updated.fields.get("title")).toBe("Tutor explanation");
        expect(updated.fields.get("type")).toBe("tutor-explanation");
        expect(updated.fields.get("content")).toBe("A corrected summary.");
        expect(updated.fields.get("priority")).toBe("high");
        expect(updated.fields.get("verification_state")).toBe("needs-review");
        expect(updated.fields.get("reviewed_at_us")).toBe("");
        expect(updated.fields.get("source_segment_ids")).toBe(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        );
        expect(original.fields.get("title")).toBe("Possible explanation");
    });

    it("rejects empty fields and edits to non-evidence or deleted records", () => {
        const current = evidenceRecord();
        expect(() =>
            updateEvidenceRecord(current, {
                title: " ",
                type: "claim",
                content: "x",
                priority: "normal",
            }),
        ).toThrow("Evidence title cannot be empty");
        expect(() =>
            updateEvidenceRecord(
                { ...current, type: RecordType.annotation },
                { title: "Title", type: "claim", content: "Text", priority: "normal" },
            ),
        ).toThrow("active evidence item");
        expect(() =>
            updateEvidenceRecord(
                { ...current, fields: new Map([...current.fields, ["_deleted", "true"]]) },
                { title: "Title", type: "claim", content: "Text", priority: "normal" },
            ),
        ).toThrow("active evidence item");
    });

    it("moves linked edges to Trash and restores the full relationship group", async () => {
        const node = evidenceRecord();
        const otherId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const linked = evidenceEdge(node.id, otherId, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
        const unrelated = evidenceEdge(
            otherId,
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            "11111111-1111-4111-8111-111111111111",
        );
        const storedEdges: ArchiveRecord[] = [linked, unrelated];
        const snapshot = {
            listRecords: vi
                .fn()
                .mockImplementation(async (type: number) =>
                    type === RecordType.evidenceEdge ? storedEdges : [],
                ),
        } as unknown as ArchiveSnapshot;

        const trashed = await trashEvidenceRecord(snapshot, node);
        expect(trashed).toHaveLength(2);
        expect(trashed[0]?.fields.get("_trash_group_id")).toBe(node.id);
        expect(trashed[1]?.fields.get("_trash_group_id")).toBe(node.id);
        expect(trashed.every((record) => record.fields.get("_deleted") === "true")).toBe(true);
        expect(unrelated.fields.get("_deleted")).toBeUndefined();
        storedEdges.splice(0, storedEdges.length, ...trashed.slice(1), unrelated);

        const restored = await restoreEvidenceRecordGroup(snapshot, trashed[0]!);
        expect(restored).toHaveLength(2);
        expect(restored.every((record) => record.fields.get("_deleted") !== "true")).toBe(true);
        expect(restored.every((record) => !record.fields.has("_trash_group_id"))).toBe(true);
        expect(restored[0]?.fields.get("source_segment_ids")).toBe(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        );
    });

    it("moves one relationship into its own recoverable Trash group", () => {
        const edge = evidenceEdge(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        );
        const trashed = trashEvidenceEdge(edge);
        expect(trashed.fields.get("_deleted")).toBe("true");
        expect(trashed.fields.get("_trash_group_id")).toBe(edge.id);
        expect(edge.fields.get("_deleted")).toBeUndefined();
        expect(() => trashEvidenceEdge(trashed)).toThrow("active evidence relationship");
    });

    it("restores a removed relationship only when both endpoints are active", async () => {
        const fromId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const toId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const edge = trashEvidenceEdge(
            evidenceEdge(fromId, toId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        );
        const from = { ...evidenceRecord(), id: fromId };
        const to = { ...evidenceRecord(), id: toId };
        const snapshot = {
            getRecord: vi.fn(async (_type: number, id: string) =>
                id === fromId ? from : id === toId ? to : null,
            ),
        } as unknown as ArchiveSnapshot;

        const restored = await restoreEvidenceEdge(snapshot, edge);
        expect(restored.fields.get("_deleted")).toBeUndefined();
        expect(restored.fields.get("from_id")).toBe(fromId);
        expect(restored.fields.get("to_id")).toBe(toId);

        await expect(
            restoreEvidenceEdge(
                {
                    ...snapshot,
                    getRecord: vi.fn(async (_type: number, id: string) =>
                        id === fromId
                            ? from
                            : { ...to, fields: new Map([...to.fields, ["_deleted", "true"]]) },
                    ),
                } as unknown as ArchiveSnapshot,
                edge,
            ),
        ).rejects.toThrow("Restore both linked evidence items");
    });
});

function annotationRecord(
    id: string,
    fields: Record<string, string>,
    revision = 2n,
): ArchiveRecord {
    return {
        ...evidenceRecord(),
        type: RecordType.annotation,
        id,
        revision,
        fields: new Map(Object.entries(fields)),
    };
}

function transcriptRecord(
    id: string,
    fields: Record<string, string>,
    revision = 4n,
): ArchiveRecord {
    return {
        ...evidenceRecord(),
        type: RecordType.transcriptSegment,
        id,
        revision,
        fields: new Map(Object.entries(fields)),
    };
}

function listSnapshot(
    records: Partial<Record<number, ArchiveRecord[]>>,
    byId: ArchiveRecord[] = [],
) {
    return {
        listRecords: vi.fn(async (type: number) => records[type] ?? []),
        getRecord: vi.fn(
            async (type: number, id: string) =>
                byId.find((item) => item.type === type && item.id === id) ?? null,
        ),
        getRecordByIndexKey: vi.fn(async () => null),
    } as unknown as ArchiveSnapshot;
}

describe("transcript evidence classification", () => {
    it("detects cues from every heuristic group questions", () => {
        expect(classifyTranscriptEvidence("")).toEqual([]);
        expect(classifyTranscriptEvidence("plain statement")).toEqual([]);
        const text =
            "Remember to check. It means balance. Because it works. Not quite, instead. I thought so. For example, suppose. Now I understand. Next session?";
        const types = classifyTranscriptEvidence(text).map((item) => item.type);
        expect(types).toContain("explicit-instruction-candidate");
        expect(types).toContain("important-concept-candidate");
        expect(types).toContain("explanation-candidate");
        expect(types).toContain("tutor-correction-candidate");
        expect(types).toContain("student-mistake-candidate");
        expect(types).toContain("worked-example-candidate");
        expect(types).toContain("learning-outcome-candidate");
        expect(types).toContain("follow-up-priority-candidate");
        expect(types).toContain("student-question-candidate");
    });
});

describe("session evidence extraction", () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    it("rejects inactive or non-session records", async () => {
        await expect(
            extractSessionEvidence(listSnapshot({}), {
                ...evidenceRecord(),
                type: RecordType.guide,
            }),
        ).rejects.toThrow("active session");
        await expect(
            extractSessionEvidence(listSnapshot({}), {
                ...evidenceRecord(),
                fields: new Map([["_deleted", "true"]]),
            }),
        ).rejects.toThrow("active session");
    });

    it("derives records from annotations and transcript cues while skipping sources", async () => {
        const session = {
            ...evidenceRecord(),
            type: RecordType.session,
            id: sessionId,
            fields: new Map(),
        };
        const annotationId = "11111111-1111-4111-8111-111111111111";
        const segmentId = "22222222-2222-4222-8222-222222222222";
        const snapshot = listSnapshot({
            [RecordType.annotation]: [
                annotationRecord(annotationId, {
                    session_id: sessionId,
                    type: "important-concept",
                    title: "Concept",
                    content: "Concept text",
                    priority: "high",
                    start_time_us: "1",
                    end_time_us: "2",
                }),
                annotationRecord("33333333-3333-4333-8333-333333333333", {
                    session_id: "other",
                }),
                annotationRecord("44444444-4444-4444-8444-444444444444", {}),
                annotationRecord("99999999-9999-4999-8999-999999999999", {
                    session_id: sessionId,
                }),
            ],
            [RecordType.transcriptSegment]: [
                transcriptRecord(segmentId, {
                    session_id: sessionId,
                    text: "Now I understand?",
                    linked_asset_ids: "asset-1",
                    speaker_label: "Tutor",
                    start_time_us: "10",
                    end_time_us: "20",
                }),
                transcriptRecord("55555555-5555-4555-8555-555555555555", {
                    session_id: "other",
                    text: "ignored",
                }),
                transcriptRecord("66666666-6666-4666-8666-666666666666", {
                    session_id: sessionId,
                    text: "because this works",
                }),
            ],
            [RecordType.evidenceNode]: [],
        });

        const records = await extractSessionEvidence(snapshot, session);
        expect(records.length).toBeGreaterThanOrEqual(3);
        const annotation = records.find(
            (item) => item.fields.get("source_annotation_id") === annotationId,
        )!;
        expect(annotation.fields.get("type")).toBe("important-concept");
        expect(annotation.fields.get("priority")).toBe("high");
        const fallback = records.find((item) => item.fields.get("session_id") === "other");
        expect(fallback).toBeUndefined();
    });

    it("skips previously extracted current and legacy sources", async () => {
        const annotationId = "11111111-1111-4111-8111-111111111111";
        const segmentId = "22222222-2222-4222-8222-222222222222";
        const session = {
            ...evidenceRecord(),
            type: RecordType.session,
            id: sessionId,
        };
        const existing = [
            {
                ...evidenceRecord(),
                fields: new Map([
                    ["source_annotation_id", annotationId],
                    ["source_annotation_revision", "2"],
                ]),
            },
            {
                ...evidenceRecord(),
                fields: new Map([
                    ["source_annotation_id", "33333333-3333-4333-8333-333333333333"],
                    ["content", "legacy annotation"],
                ]),
            },
            {
                ...evidenceRecord(),
                fields: new Map([
                    ["source_segment_ids", segmentId],
                    ["type", "learning-outcome-candidate"],
                    ["source_segment_revision", "4"],
                ]),
            },
            {
                ...evidenceRecord(),
                fields: new Map([
                    ["source_segment_ids", "44444444-4444-4444-8444-444444444444"],
                    ["type", "explanation-candidate"],
                    ["content", "legacy segment"],
                ]),
            },
            {
                ...evidenceRecord(),
                fields: new Map([["source_annotation_id", "66666666-6666-4666-8666-666666666666"]]),
            },
            {
                ...evidenceRecord(),
                fields: new Map([["source_segment_ids", "77777777-7777-4777-8777-777777777777"]]),
            },
        ];
        const snapshot = listSnapshot({
            [RecordType.annotation]: [
                annotationRecord(annotationId, {
                    session_id: sessionId,
                }),
                annotationRecord("33333333-3333-4333-8333-333333333333", {
                    session_id: sessionId,
                    content: "legacy annotation",
                }),
            ],
            [RecordType.transcriptSegment]: [
                transcriptRecord(segmentId, { session_id: sessionId, text: "I learned now" }),
                transcriptRecord("44444444-4444-4444-8444-444444444444", {
                    session_id: sessionId,
                    text: "legacy segment because",
                }),
                transcriptRecord("88888888-8888-4888-8888-888888888888", {
                    session_id: sessionId,
                }),
            ],
            [RecordType.evidenceNode]: existing,
        });

        const records = await extractSessionEvidence(snapshot, session);
        expect(records).toHaveLength(0);
    });
});

describe("evidence creation and review", () => {
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const segmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    it("validates identifiers, sessions, and segments", async () => {
        const snapshot = listSnapshot({});
        await expect(
            makeEvidenceRecord(snapshot, "bad", segmentId, {
                title: "t",
                type: "x",
                content: "c",
                priority: "p",
            }),
        ).rejects.toThrow("valid session");
        await expect(
            makeEvidenceRecord(snapshot, sessionId, segmentId, {
                title: "t",
                type: "x",
                content: "c",
                priority: "p",
            }),
        ).rejects.toThrow("active session");

        const session = { ...evidenceRecord(), type: RecordType.session, id: sessionId };
        await expect(
            makeEvidenceRecord(listSnapshot({}), sessionId, segmentId, {
                title: "t",
                type: "x",
                content: "c",
                priority: "p",
            }),
        ).rejects.toThrow("active session");

        const wrongSegment = {
            ...evidenceRecord(),
            type: RecordType.guide,
            id: segmentId,
        };
        await expect(
            makeEvidenceRecord(listSnapshot({}, [session, wrongSegment]), sessionId, segmentId, {
                title: "t",
                type: "x",
                content: "c",
                priority: "p",
            }),
        ).rejects.toThrow("active transcript segment");
    });

    it("uses fallbacks for sparse session and segment metadata", async () => {
        const session = {
            ...evidenceRecord(),
            type: RecordType.session,
            id: sessionId,
            fields: new Map(),
        };
        const segment = {
            ...evidenceRecord(),
            type: RecordType.transcriptSegment,
            id: segmentId,
            fields: new Map([["session_id", sessionId]]),
        };
        const created = await makeEvidenceRecord(
            listSnapshot({}, [session, segment]),
            sessionId,
            segmentId,
            { title: "Title", type: "My Type", content: "Content", priority: "normal" },
        );
        expect(created.fields.get("student_id")).toBe("");
        expect(created.fields.get("source_asset_ids")).toBe("");
        expect(created.fields.get("source_speaker_label")).toBe("");
        expect(created.fields.get("start_time_us")).toBe("0");
        expect(created.fields.get("end_time_us")).toBe("0");
        expect(created.fields.get("type")).toBe("my-type");
    });

    it("reviews evidence only when its sources are current", async () => {
        const record = evidenceRecord({
            source_annotation_id: "",
            source_segment_ids: "",
            source_asset_ids: "",
        });
        await expect(
            reviewEvidenceRecord(
                listSnapshot({}),
                { ...record, type: RecordType.guide },
                "rejected",
            ),
        ).rejects.toThrow("active evidence item");
        await expect(
            reviewEvidenceRecord(
                listSnapshot({}),
                { ...record, fields: new Map([...record.fields, ["_deleted", "true"]]) },
                "rejected",
            ),
        ).rejects.toThrow("active evidence item");

        const rejected = await reviewEvidenceRecord(listSnapshot({}), record, "rejected");
        expect(rejected.fields.get("verification_state")).toBe("rejected");

        await expect(
            reviewEvidenceRecord(
                listSnapshot({}, [transcriptRecord(segmentId, { session_id: sessionId })]),
                evidenceRecord({
                    session_id: sessionId,
                    source_segment_ids: segmentId,
                    source_segment_revision: "4",
                }),
                "human-verified",
            ),
        ).resolves.toBeTruthy();

        await expect(
            reviewEvidenceRecord(
                listSnapshot({}),
                evidenceRecord({
                    session_id: sessionId,
                    source_segment_ids: segmentId,
                    source_segment_revision: "4",
                }),
                "human-verified",
            ),
        ).rejects.toThrow("cannot be approved");
    });
});

describe("evidence validation limits", () => {
    it("rejects oversized or empty evidence fields", () => {
        expect(() =>
            updateEvidenceRecord(evidenceRecord(), {
                title: "a".repeat(513),
                type: "claim",
                content: "c",
                priority: "p",
            }),
        ).toThrow("512-byte limit");
        expect(() =>
            updateEvidenceRecord(evidenceRecord(), {
                title: "t",
                type: "a".repeat(129),
                content: "c",
                priority: "p",
            }),
        ).toThrow("128-byte limit");
        expect(() =>
            updateEvidenceRecord(evidenceRecord(), {
                title: "t",
                type: "claim",
                content: "c",
                priority: "a".repeat(33),
            }),
        ).toThrow("32-byte limit");
    });

    it("rejects invalid trash and restore operations", async () => {
        await expect(
            trashEvidenceRecord(listSnapshot({}), {
                ...evidenceRecord(),
                fields: new Map([["_deleted", "true"]]),
            }),
        ).rejects.toThrow("move to Trash");
        await expect(
            restoreEvidenceRecordGroup(listSnapshot({}), {
                ...evidenceRecord(),
                fields: new Map([["session_id", ""]]),
            }),
        ).rejects.toThrow("from Trash");
        expect(() =>
            trashEvidenceEdge({ ...evidenceEdge("a", "b", "c"), type: RecordType.guide }),
        ).toThrow("active evidence relationship");
        await expect(
            restoreEvidenceEdge(listSnapshot({}), {
                ...evidenceEdge("a", "b", "c"),
                type: RecordType.guide,
            }),
        ).rejects.toThrow("from Trash");
        await expect(
            restoreEvidenceEdge(
                listSnapshot({}),
                trashEvidenceEdge(evidenceEdge("not-a-uuid", "b", "c")),
            ),
        ).rejects.toThrow("Restore both linked evidence items");

        const trashedEdge = trashEvidenceEdge(
            evidenceEdge(
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            ),
        );
        const missingFrom = { ...trashedEdge, fields: new Map(trashedEdge.fields) };
        missingFrom.fields.delete("from_id");
        await expect(
            restoreEvidenceEdge(
                listSnapshot({}, [
                    {
                        ...evidenceRecord(),
                        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        type: RecordType.evidenceNode,
                    },
                ]),
                missingFrom,
            ),
        ).rejects.toThrow("Restore both linked evidence items");
    });

    it("ignores unrelated or already-trashed edges when grouping", async () => {
        const node = evidenceRecord();
        const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const already = {
            ...evidenceEdge(node.id, other, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
            fields: new Map([
                ["from_id", node.id],
                ["to_id", other],
                ["_deleted", "true"],
            ]),
        };
        const toMatch = evidenceEdge(
            "ffffffff-ffff-4fff-8fff-ffffffffffff",
            node.id,
            "11111111-1111-4111-8111-111111111111",
        );
        const snapshot = listSnapshot({ [RecordType.evidenceEdge]: [already, toMatch] });
        const trashed = await trashEvidenceRecord(snapshot, node);
        expect(trashed).toHaveLength(2);

        const notDeleted = { ...node, fields: new Map([["session_id", "x"]]) };
        const wrongGroup = {
            ...evidenceEdge(node.id, other, "22222222-2222-4222-8222-222222222222"),
            fields: new Map([
                ["from_id", node.id],
                ["to_id", other],
                ["_deleted", "true"],
                ["_trash_group_id", "other"],
            ]),
        };
        const matching = {
            ...evidenceEdge(node.id, other, "33333333-3333-4333-8333-333333333333"),
            fields: new Map([
                ["from_id", node.id],
                ["to_id", other],
                ["_deleted", "true"],
                ["_trash_group_id", node.id],
            ]),
        };
        const restoreSnapshot = listSnapshot({ [RecordType.evidenceEdge]: [wrongGroup, matching] });
        const restored = await restoreEvidenceRecordGroup(restoreSnapshot, {
            ...notDeleted,
            fields: new Map([
                ["_deleted", "true"],
                ["session_id", "x"],
            ]),
        });
        expect(restored).toHaveLength(2);
    });
});

describe("evidence edges", () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    it("validates endpoints, relationships, sessions, and duplicates", async () => {
        const snapshot = listSnapshot({});
        await expect(makeEvidenceEdge(snapshot, "bad", b, "supports")).rejects.toThrow(
            "two different",
        );
        await expect(makeEvidenceEdge(snapshot, a, a, "supports")).rejects.toThrow("two different");
        await expect(makeEvidenceEdge(snapshot, a, b, "nope")).rejects.toThrow(
            "supported evidence relationship",
        );
        await expect(makeEvidenceEdge(snapshot, a, b, "SUPPORTS")).rejects.toThrow(
            "Both evidence items",
        );

        const from = { ...evidenceRecord(), id: a, fields: new Map([["session_id", "s"]]) };
        const to = { ...evidenceRecord(), id: b, fields: new Map([["session_id", "s"]]) };
        await expect(
            makeEvidenceEdge(listSnapshot({}, [from, to]), a, b, "supports"),
        ).resolves.toBeTruthy();

        const otherSession = { ...to, fields: new Map([["session_id", "other"]]) };
        await expect(
            makeEvidenceEdge(listSnapshot({}, [from, otherSession]), a, b, "supports"),
        ).rejects.toThrow("within one session");

        const noSession = { ...from, fields: new Map() };
        await expect(
            makeEvidenceEdge(listSnapshot({}, [noSession, to]), a, b, "supports"),
        ).rejects.toThrow("within one session");

        const deleted = {
            ...from,
            fields: new Map([
                ["_deleted", "true"],
                ["session_id", "s"],
            ]),
        };
        await expect(
            makeEvidenceEdge(listSnapshot({}, [deleted, to]), a, b, "supports"),
        ).rejects.toThrow("Both evidence items");
    });

    it("detects duplicate relationships", async () => {
        const from = { ...evidenceRecord(), id: a, fields: new Map([["session_id", "s"]]) };
        const to = { ...evidenceRecord(), id: b, fields: new Map([["session_id", "s"]]) };
        const existing = {
            ...evidenceEdge(a, b, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
            fields: new Map([
                ["from_id", a],
                ["to_id", b],
                ["relationship", "supports"],
            ]),
        };
        await expect(
            makeEvidenceEdge(
                listSnapshot({ [RecordType.evidenceEdge]: [existing] }, [from, to]),
                a,
                b,
                " supports ",
            ),
        ).rejects.toThrow("already exists");
    });
});

describe("evidence source currency", () => {
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    it("returns false when there are no sources", async () => {
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...evidenceRecord(),
                fields: new Map([["session_id", sessionId]]),
            }),
        ).resolves.toBe(false);
    });

    it("validates annotation sources and revisions", async () => {
        const annotationId = "11111111-1111-4111-8111-111111111111";
        const base = { ...evidenceRecord(), fields: new Map([["session_id", sessionId]]) };
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_annotation_id", "bad"],
                    ["source_annotation_revision", "1"],
                ]),
            }),
        ).resolves.toBe(false);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_annotation_id", annotationId],
                    ["source_annotation_revision", "bad"],
                ]),
            }),
        ).resolves.toBe(false);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([...base.fields, ["source_annotation_id", annotationId]]),
            }),
        ).resolves.toBe(false);

        const annotation = annotationRecord(
            annotationId,
            {
                session_id: sessionId,
            },
            3n,
        );
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [annotation]), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_annotation_id", annotationId],
                    ["source_annotation_revision", "9"],
                ]),
            }),
        ).resolves.toBe(false);

        const deleted = {
            ...annotation,
            fields: new Map([...annotation.fields, ["_deleted", "true"]]),
        };
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [deleted]), {
                ...base,
                fields: new Map([...base.fields, ["source_annotation_id", annotationId]]),
            }),
        ).resolves.toBe(false);

        const otherSession = annotationRecord(annotationId, { session_id: "other" });
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [otherSession]), {
                ...base,
                fields: new Map([...base.fields, ["source_annotation_id", annotationId]]),
            }),
        ).resolves.toBe(false);
    });

    it("validates segment revision entries and assets", async () => {
        const segmentId = "22222222-2222-4222-8222-222222222222";
        const base = { ...evidenceRecord(), fields: new Map([["session_id", sessionId]]) };
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revisions", "no-separator"],
                ]),
            }),
        ).resolves.toBe(false);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revisions", `${segmentId}=bad`],
                ]),
            }),
        ).resolves.toBe(false);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revision", "bad"],
                ]),
            }),
        ).resolves.toBe(false);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...base,
                fields: new Map([...base.fields, ["source_asset_ids", "bad"]]),
            }),
        ).resolves.toBe(false);

        const segment = transcriptRecord(segmentId, { session_id: "" }, 4n);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [segment]), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revision", "4"],
                ]),
            }),
        ).resolves.toBe(true);

        const bare = transcriptRecord(segmentId, {}, 4n);
        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [bare]), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revision", "4"],
                ]),
            }),
        ).resolves.toBe(true);

        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}, [bare]), {
                ...base,
                fields: new Map([
                    ...base.fields,
                    ["source_segment_ids", segmentId],
                    ["source_segment_revisions", `${segmentId}=4`],
                ]),
            }),
        ).resolves.toBe(true);

        await expect(
            evidenceSourcesAreCurrent(listSnapshot({}), {
                ...evidenceRecord(),
                fields: new Map(),
            }),
        ).resolves.toBe(false);
    });
});
