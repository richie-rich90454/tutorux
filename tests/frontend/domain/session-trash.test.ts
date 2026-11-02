import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { planSessionRestore, planSessionTrash } from "../../../frontend/domain/session-trash";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_A = "22222222-2222-4222-8222-222222222222";
const ENTRY_B = "33333333-3333-4333-8333-333333333333";
const ANNOTATION_ID = "44444444-4444-4444-8444-444444444444";
const NODE_ID = "55555555-5555-4555-8555-555555555555";
const EDGE_ID = "66666666-6666-4666-8666-666666666666";
const NOTES_ID = "77777777-7777-4777-8777-777777777777";
const TRANSCRIPT_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_SESSION_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_NODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function record(type: number, id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type,
        id,
        revision: 1n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(Object.entries(fields)),
    };
}

function snapshot(records: ArchiveRecord[]): ArchiveSnapshot {
    return {
        listRecords: async (type: number, includeDeleted = false) =>
            records.filter(
                (item) =>
                    item.type === type &&
                    (includeDeleted || item.fields.get("_deleted") !== "true"),
            ),
        audioTrackIdsBySession: () => new Map(),
        listAudioChunkMetadata: async () => [],
    } as unknown as ArchiveSnapshot;
}

describe("session group restore", () => {
    it("restores legacy children, edges into the group, and the journal entry link", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_B,
        });
        const annotation = record(RecordType.annotation, ANNOTATION_ID, {
            _deleted: "true",
            session_id: SESSION_ID,
        });
        const node = record(RecordType.evidenceNode, NODE_ID, {
            _deleted: "true",
            session_id: SESSION_ID,
            _trash_group_id: SESSION_ID,
        });
        const edge = record(RecordType.evidenceEdge, EDGE_ID, {
            _deleted: "true",
            from_id: ANNOTATION_ID,
            to_id: NODE_ID,
        });
        const sessionNotes = record(RecordType.settings, NOTES_ID, {
            _deleted: "true",
            record_role: "journal-notes",
            session_id: SESSION_ID,
        });
        const markedEntry = record(RecordType.settings, ENTRY_A, {
            record_role: "journal-entry",
            session_ids: "",
            _trash_session_group_id: SESSION_ID,
            _trash_restore_session_refs: SESSION_ID,
        });
        const entryWithoutMarker = record(RecordType.settings, ENTRY_B, {
            record_role: "journal-entry",
            session_ids: "",
        });

        const changes = await planSessionRestore(
            snapshot([
                session,
                annotation,
                node,
                edge,
                sessionNotes,
                markedEntry,
                entryWithoutMarker,
            ]),
            session,
        );
        const byId = new Map(changes.map((item) => [item.id.toLowerCase(), item]));

        expect(byId.get(ANNOTATION_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(NODE_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(EDGE_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(NOTES_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(SESSION_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(ENTRY_A)?.fields.get("session_ids")).toBe(SESSION_ID);
        expect(byId.get(ENTRY_A)?.fields.has("_trash_session_group_id")).toBe(false);
        expect(byId.get(ENTRY_B)?.fields.get("session_ids")).toBe(SESSION_ID);
    });

    it("does not restore a removed edge whose endpoints stay in Trash", async () => {
        const session = record(RecordType.session, SESSION_ID, { _deleted: "true" });
        const outsider = record(RecordType.evidenceEdge, EDGE_ID, {
            _deleted: "true",
            from_id: ANNOTATION_ID,
            to_id: NODE_ID,
        });

        const changes = await planSessionRestore(snapshot([session, outsider]), session);
        expect(changes.some((item) => item.id === EDGE_ID)).toBe(false);
        expect(changes.some((item) => item.id === SESSION_ID)).toBe(true);
    });
});

describe("session trash cascade", () => {
    function sessionRecords(): ArchiveRecord[] {
        return [
            record(RecordType.session, SESSION_ID, { entry_id: ENTRY_B }),
            record(RecordType.settings, NOTES_ID, {
                record_role: "journal-notes",
                session_id: SESSION_ID,
            }),
            record(RecordType.transcriptSegment, TRANSCRIPT_ID, {
                session_id: SESSION_ID,
                text: "A cue that belongs to the session.",
            }),
            record(RecordType.annotation, ANNOTATION_ID, {
                session_id: SESSION_ID,
                content: "An observation in the session.",
            }),
            record(RecordType.evidenceNode, NODE_ID, {
                session_id: SESSION_ID,
                source_segment_ids: TRANSCRIPT_ID,
            }),
            record(RecordType.evidenceEdge, EDGE_ID, {
                from_id: ANNOTATION_ID,
                to_id: NODE_ID,
                relationship: "supports",
            }),
            record(RecordType.settings, ENTRY_B, {
                record_role: "journal-entry",
                session_ids: SESSION_ID,
                study_guide_ids: "",
                attachment_ids: "",
            }),
        ];
    }

    it("includes notes, transcript segments, and evidence edges in the session group", async () => {
        const records = sessionRecords();
        const session = records[0]!;
        const plan = await planSessionTrash(snapshot(records), session);
        const byId = new Map(plan.scopeRecords.map((item) => [item.id.toLowerCase(), item]));

        expect(plan.counts.sessionNotes).toBe(1);
        expect(plan.counts.transcriptSegments).toBe(1);
        expect(plan.counts.annotations).toBe(1);
        expect(plan.counts.evidenceNodes).toBe(1);
        expect(plan.counts.evidenceEdges).toBe(1);
        expect(plan.counts.entriesUpdated).toBe(1);

        for (const id of [SESSION_ID, NOTES_ID, TRANSCRIPT_ID, ANNOTATION_ID, NODE_ID, EDGE_ID]) {
            expect(byId.get(id)?.fields.get("_deleted"), id).toBe("true");
            expect(byId.get(id)?.fields.get("_trash_group_id"), id).toBe(SESSION_ID);
        }
        expect(byId.get(ENTRY_B)?.fields.get("session_ids")).toBe("");
        expect(byId.get(ENTRY_B)?.fields.get("_trash_restore_session_refs")).toBe(SESSION_ID);
    });

    it("blocks trashing when an active evidence node references a session record", async () => {
        const records = [
            ...sessionRecords(),
            record(RecordType.evidenceNode, OTHER_NODE_ID, {
                session_id: OTHER_SESSION_ID,
                source_segment_ids: TRANSCRIPT_ID,
            }),
        ];

        await expect(planSessionTrash(snapshot(records), records[0]!)).rejects.toThrow(
            /Another session evidence node references this session/u,
        );
    });

    it("blocks trashing when an active annotation references a session record", async () => {
        const records = [
            ...sessionRecords(),
            record(RecordType.annotation, OTHER_NODE_ID, {
                session_id: OTHER_SESSION_ID,
                linked_evidence_ids: NODE_ID,
            }),
        ];

        await expect(planSessionTrash(snapshot(records), records[0]!)).rejects.toThrow(
            /Another session annotation references this session/u,
        );
    });
});
