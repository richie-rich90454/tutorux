import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { planSessionRestore } from "../../../frontend/domain/session-trash";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_A = "22222222-2222-4222-8222-222222222222";
const ENTRY_B = "33333333-3333-4333-8333-333333333333";
const ANNOTATION_ID = "44444444-4444-4444-8444-444444444444";
const NODE_ID = "55555555-5555-4555-8555-555555555555";
const EDGE_ID = "66666666-6666-4666-8666-666666666666";
const NOTES_ID = "77777777-7777-4777-8777-777777777777";

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
