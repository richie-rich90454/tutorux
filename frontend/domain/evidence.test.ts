import { describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../archive/archive";
import { RecordType, type ArchiveRecord } from "../archive/format";
import {
    makeEvidenceRecord,
    restoreEvidenceEdge,
    restoreEvidenceRecordGroup,
    trashEvidenceEdge,
    trashEvidenceRecord,
    updateEvidenceRecord,
} from "./evidence";

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

function evidenceEdge(fromId: string, toId: string, id: string): ArchiveRecord {
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
        const storedEdges = [linked, unrelated];
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
