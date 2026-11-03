import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    loadSessionAudioTrashChanges,
    planSessionRestore,
    planSessionTrash,
} from "../../../frontend/domain/session-trash";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const ANNOTATION_ID = "44444444-4444-4444-8444-444444444444";
const NODE_ID = "55555555-5555-4555-8555-555555555555";
const EDGE_ID = "66666666-6666-4666-8666-666666666666";
const NOTES_ID = "77777777-7777-4777-8777-777777777777";
const TRANSCRIPT_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_SESSION_ID = "12121212-1212-4212-8212-121212121212";
const GUIDE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WAVEFORM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TRACK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CHUNK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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

interface SnapshotOptions {
    tracks?: Map<string, string[]>;
    chunks?: ArchiveRecord[];
    missingChunkIds?: Set<string>;
}

function snapshot(records: ArchiveRecord[], options: SnapshotOptions = {}): ArchiveSnapshot {
    const tracks = options.tracks ?? new Map();
    const chunks = options.chunks ?? [];
    return {
        listRecords: async (type: number, includeDeleted = false) =>
            records.filter(
                (item) =>
                    item.type === type &&
                    (includeDeleted || item.fields.get("_deleted") !== "true"),
            ),
        audioTrackIdsBySession: () => tracks,
        listAudioChunkMetadata: async (
            sessionId: string,
            trackId: string,
            includeDeleted = false,
        ) =>
            chunks.filter(
                (item) =>
                    item.fields.get("session_id")?.toLowerCase() === sessionId.toLowerCase() &&
                    item.fields.get("track_id")?.toLowerCase() === trackId.toLowerCase() &&
                    (includeDeleted || item.fields.get("_deleted") !== "true"),
            ),
        getRecord: async (type: number, id: string) => {
            if (type !== RecordType.audioChunk) return null;
            if (options.missingChunkIds?.has(id)) return null;
            return chunks.find((item) => item.id === id) ?? null;
        },
    } as unknown as ArchiveSnapshot;
}

function makeGuide(
    id: string,
    sessionId: string,
    blocks: readonly { kind: string; text: string; sourceIds?: string }[],
): ArchiveRecord {
    const fields: Record<string, string> = {
        session_id: sessionId,
        section_count: "1",
        "section.0.block_count": String(blocks.length),
    };
    blocks.forEach((block, index) => {
        fields[`section.0.block.${index}.kind`] = block.kind;
        fields[`section.0.block.${index}.text`] = block.text;
        fields[`section.0.block.${index}.source_ids`] = block.sourceIds ?? "";
    });
    return record(RecordType.guide, id, fields);
}

function baseRecords(): ArchiveRecord[] {
    return [
        record(RecordType.session, SESSION_ID, { entry_id: ENTRY_ID }),
        record(RecordType.transcriptSegment, TRANSCRIPT_ID, { session_id: SESSION_ID }),
        record(RecordType.annotation, ANNOTATION_ID, { session_id: SESSION_ID }),
        record(RecordType.evidenceNode, NODE_ID, { session_id: SESSION_ID }),
        record(RecordType.settings, NOTES_ID, {
            record_role: "journal-notes",
            session_id: SESSION_ID,
        }),
        record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
            session_ids: SESSION_ID,
        }),
    ];
}

describe("session trash edge cases", () => {
    it("rejects wrong session states for trash and restore", async () => {
        await expect(
            planSessionTrash(snapshot([]), record(RecordType.guide, SESSION_ID)),
        ).rejects.toThrow(/active session/u);
        await expect(
            planSessionTrash(
                snapshot([]),
                record(RecordType.session, SESSION_ID, { _deleted: "true" }),
            ),
        ).rejects.toThrow(/active session/u);
        await expect(
            planSessionRestore(snapshot([]), record(RecordType.session, SESSION_ID)),
        ).rejects.toThrow(/not in Trash/u);
        await expect(
            planSessionRestore(
                snapshot([]),
                record(RecordType.guide, SESSION_ID, { _deleted: "true" }),
            ),
        ).rejects.toThrow(/not in Trash/u);
    });

    it("plans a full cascade with guides, assets, waveform indices, and partial edges", async () => {
        const records = [
            ...baseRecords().filter((item) => item.id !== ENTRY_ID),
            record(RecordType.waveformIndex, WAVEFORM_ID, { session_id: SESSION_ID }),
            makeGuide(GUIDE_ID, SESSION_ID, []),
            record(RecordType.assetMetadata, ASSET_ID, {
                session_id: SESSION_ID,
                record_role: "material",
                blob_id: OTHER_ID,
            }),
            record(RecordType.evidenceEdge, EDGE_ID, {
                from_id: ANNOTATION_ID,
                to_id: NODE_ID,
            }),
            record(RecordType.evidenceEdge, OTHER_ID, {
                from_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                to_id: NODE_ID,
            }),
            record(RecordType.settings, ENTRY_ID, {
                record_role: "journal-entry",
                session_ids: `${SESSION_ID},${OTHER_SESSION_ID}`,
                study_guide_ids: GUIDE_ID,
                attachment_ids: `${ASSET_ID},ffffffff-ffff-4fff-8fff-ffffffffffff`,
            }),
            record(RecordType.settings, OTHER_ENTRY_ID, {
                record_role: "journal-entry",
                session_ids: "",
            }),
            record(RecordType.annotation, OTHER_ID, {
                session_id: OTHER_SESSION_ID,
                linked_asset_ids: "",
                linked_evidence_ids: "",
                source_segment_ids: "",
            }),
            record(RecordType.evidenceNode, "ffffffff-ffff-4fff-8fff-ffffffffffff", {
                session_id: OTHER_SESSION_ID,
            }),
            makeGuide("12121212-1212-4212-8212-121212121212", OTHER_SESSION_ID, []),
        ];
        const session = records[0]!;
        const chunk = record(RecordType.audioChunk, CHUNK_ID, {
            session_id: SESSION_ID,
            track_id: TRACK_ID,
        });
        const plan = await planSessionTrash(
            snapshot(records, {
                tracks: new Map([[SESSION_ID, [TRACK_ID]]]),
                chunks: [chunk],
            }),
            session,
        );
        const byId = new Map(plan.scopeRecords.map((item) => [item.id.toLowerCase(), item]));
        const entry = byId.get(ENTRY_ID)!;

        expect(plan.counts).toMatchObject({
            audioChunks: 1,
            waveformIndices: 1,
            guides: 1,
            assets: 1,
            entriesUpdated: 1,
            evidenceEdges: 2,
            totalRecords: plan.scopeRecords.length,
        });
        expect(entry.fields.get("session_ids")).toBe(OTHER_SESSION_ID);
        expect(entry.fields.get("study_guide_ids")).toBe("");
        expect(entry.fields.get("attachment_ids")).toBe("ffffffff-ffff-4fff-8fff-ffffffffffff");
        expect(entry.fields.get("_trash_restore_session_refs")).toBe(SESSION_ID);
        expect(entry.fields.get("_trash_restore_guide_refs")).toBe(GUIDE_ID);
        expect(entry.fields.get("_trash_restore_asset_refs")).toBe(ASSET_ID);
        expect(byId.get(OTHER_ENTRY_ID)?.fields.get("_trash_group_id")).toBeUndefined();
        expect(byId.get(OTHER_ID)?.fields.get("_deleted")).toBe("true");
        expect(plan.audioChunkRecords).toHaveLength(1);
        expect(plan.changes.some((item) => item.type === RecordType.audioChunk)).toBe(false);
    });

    it("blocks guides that reference records being removed", async () => {
        const cases: {
            block: { kind: string; text: string; sourceIds?: string };
            error: RegExp;
        }[] = [
            {
                block: { kind: "paragraph", text: "plain", sourceIds: ANNOTATION_ID },
                error: /Another study guide references this session/u,
            },
            {
                block: { kind: "paragraph", text: `see [[source:${ANNOTATION_ID}]]` },
                error: /Another study guide references this session/u,
            },
            {
                block: { kind: "paragraph", text: "see [[source:not-a-uuid]]" },
                error: /invalid inline source/u,
            },
            {
                block: { kind: "paragraph", text: "see [[source:broken" },
                error: /incomplete inline source/u,
            },
            {
                block: { kind: "image", text: `![chart](asset:${ASSET_ID})` },
                error: /Another study guide references this session/u,
            },
            {
                block: { kind: "figure", text: "plain text" },
                error: /invalid image source/u,
            },
            {
                block: { kind: "paragraph", text: "![chart](asset:not-a-uuid)" },
                error: /invalid image source/u,
            },
            {
                block: { kind: "paragraph", text: "![chart](asset:not-a-uuid)" },
                error: /invalid image source/u,
            },
        ];

        for (const { block, error } of cases) {
            const records = [
                ...baseRecords(),
                record(RecordType.assetMetadata, ASSET_ID, {
                    session_id: SESSION_ID,
                    record_role: "material",
                }),
                makeGuide(OTHER_ID, "99999999-9999-4999-8999-999999999999", [block]),
            ];
            await expect(planSessionTrash(snapshot(records), records[0]!)).rejects.toThrow(error);
        }
    });

    it("allows guides with valid inline and image sources", async () => {
        const records = [
            ...baseRecords(),
            makeGuide(OTHER_ID, "99999999-9999-4999-8999-999999999999", [
                { kind: "paragraph", text: "see [[source:ffffffff-ffff-4fff-8fff-ffffffffffff]]" },
                { kind: "image", text: "![chart](asset:ffffffff-ffff-4fff-8fff-ffffffffffff)" },
            ]),
        ];
        await expect(planSessionTrash(snapshot(records), records[0]!)).resolves.toBeDefined();
    });

    it("blocks annotations that reference removed records through any key", async () => {
        for (const key of ["linked_asset_ids", "linked_evidence_ids", "source_segment_ids"]) {
            const value =
                key === "source_segment_ids"
                    ? TRANSCRIPT_ID
                    : key === "linked_evidence_ids"
                      ? NODE_ID
                      : ASSET_ID;
            const records = [
                ...baseRecords(),
                record(RecordType.assetMetadata, ASSET_ID, {
                    session_id: SESSION_ID,
                    record_role: "material",
                }),
                record(RecordType.annotation, OTHER_ID, {
                    session_id: "99999999-9999-4999-8999-999999999999",
                    [key]: value,
                }),
            ];
            await expect(planSessionTrash(snapshot(records), records[0]!)).rejects.toThrow(
                /Another session annotation references this session/u,
            );
        }
    });

    it("blocks evidence nodes that reference removed records through any key", async () => {
        const records = [
            ...baseRecords(),
            record(RecordType.assetMetadata, ASSET_ID, {
                session_id: SESSION_ID,
                record_role: "material",
            }),
            record(RecordType.evidenceNode, OTHER_ID, {
                session_id: "99999999-9999-4999-8999-999999999999",
                source_annotation_id: ANNOTATION_ID,
            }),
            record(RecordType.evidenceNode, "ffffffff-ffff-4fff-8fff-ffffffffffff", {
                session_id: "99999999-9999-4999-8999-999999999999",
                source_asset_ids: ASSET_ID,
            }),
            record(RecordType.evidenceNode, "12121212-1212-4212-8212-121212121212", {
                session_id: "99999999-9999-4999-8999-999999999999",
            }),
        ];
        await expect(planSessionTrash(snapshot(records), records[0]!)).rejects.toThrow(
            /Another session evidence node references this session/u,
        );
    });

    it("marks audio chunk metadata only when the deletion scope is confirmed", async () => {
        const chunk = record(RecordType.audioChunk, CHUNK_ID, {
            session_id: SESSION_ID,
            track_id: TRACK_ID,
            revision: "1",
        });
        chunk.revision = 3n;
        const changes = await loadSessionAudioTrashChanges(
            snapshot([], { chunks: [chunk] }),
            SESSION_ID.toUpperCase(),
            [{ id: CHUNK_ID, revision: 3n } as ArchiveRecord],
        );
        expect(changes).toHaveLength(1);
        expect(changes[0]?.fields.get("_deleted")).toBe("true");
        expect(changes[0]?.fields.get("_trash_group_id")).toBe(SESSION_ID);

        await expect(
            loadSessionAudioTrashChanges(snapshot([], { chunks: [chunk] }), SESSION_ID, [
                { id: CHUNK_ID, revision: 4n } as ArchiveRecord,
            ]),
        ).rejects.toThrow(/changed after the deletion scope was reviewed/u);

        await expect(
            loadSessionAudioTrashChanges(
                snapshot([], { chunks: [chunk], missingChunkIds: new Set([CHUNK_ID]) }),
                SESSION_ID,
                [{ id: CHUNK_ID, revision: 3n } as ArchiveRecord],
            ),
        ).rejects.toThrow(/changed after the deletion scope was reviewed/u);

        const deleted = {
            ...chunk,
            fields: new Map(chunk.fields).set("_deleted", "true"),
        };
        await expect(
            loadSessionAudioTrashChanges(snapshot([], { chunks: [deleted] }), SESSION_ID, [
                { id: CHUNK_ID, revision: 3n } as ArchiveRecord,
            ]),
        ).rejects.toThrow(/already in Trash/u);
    });

    it("restores audio chunks and edges reached through restored records", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            recording_track_ids: TRACK_ID,
        });
        const annotation = record(RecordType.annotation, ANNOTATION_ID, {
            _deleted: "true",
            session_id: SESSION_ID,
        });
        const chunk = record(RecordType.audioChunk, CHUNK_ID, {
            session_id: SESSION_ID,
            track_id: TRACK_ID,
            _deleted: "true",
            _trash_group_id: SESSION_ID,
        });
        const alreadyLive = record(RecordType.audioChunk, OTHER_ID, {
            session_id: SESSION_ID,
            track_id: TRACK_ID,
        });
        const otherChunk = record(RecordType.audioChunk, "ffffffff-ffff-4fff-8fff-ffffffffffff", {
            session_id: "99999999-9999-4999-8999-999999999999",
            track_id: TRACK_ID,
            _deleted: "true",
            _trash_group_id: "99999999-9999-4999-8999-999999999999",
        });
        const edge = record(RecordType.evidenceEdge, EDGE_ID, {
            _deleted: "true",
            from_id: ANNOTATION_ID,
            to_id: "12121212-1212-4212-8212-121212121212",
        });
        const secondEdge = record(RecordType.evidenceEdge, "13131313-1313-4313-8313-131313131313", {
            _deleted: "true",
            from_id: ANNOTATION_ID,
            to_id: "14141414-1414-4414-8414-141414141414",
        });
        const sessionGroupChunk = record(
            RecordType.audioChunk,
            "15151515-1515-4515-8515-151515151515",
            {
                session_id: SESSION_ID,
                track_id: TRACK_ID,
                _deleted: "true",
                _trash_group_id: OTHER_SESSION_ID,
            },
        );

        const changes = await planSessionRestore(
            snapshot([session, annotation, edge, secondEdge], {
                tracks: new Map([[SESSION_ID, [TRACK_ID]]]),
                chunks: [chunk, alreadyLive, otherChunk, sessionGroupChunk],
            }),
            session,
        );
        const byId = new Map(changes.map((item) => [item.id.toLowerCase(), item]));
        expect(byId.get(CHUNK_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(sessionGroupChunk.id)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(EDGE_ID)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(secondEdge.id)?.fields.has("_deleted")).toBe(false);
        expect(byId.get(OTHER_ID)?.fields.has("restored_at_us")).toBeUndefined();
        expect(changes.some((item) => item.id === "ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe(
            false,
        );
    });

    it("reports a recording chunk that disappears during restore", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            recording_track_ids: TRACK_ID,
        });
        const chunk = record(RecordType.audioChunk, CHUNK_ID, {
            session_id: SESSION_ID,
            track_id: TRACK_ID,
            _deleted: "true",
            _trash_group_id: SESSION_ID,
        });
        await expect(
            planSessionRestore(
                snapshot([session], {
                    tracks: new Map([[SESSION_ID, [TRACK_ID]]]),
                    chunks: [chunk],
                    missingChunkIds: new Set([CHUNK_ID]),
                }),
                session,
            ),
        ).rejects.toThrow(/disappeared from the archive/u);
    });

    it("merges the session link into an entry that has no session list field", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_ID,
        });
        const entry = record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
            session_ids: OTHER_SESSION_ID,
        });
        const deletedEntry = record(RecordType.settings, OTHER_ENTRY_ID, {
            record_role: "journal-entry",
            _deleted: "true",
            _trash_session_group_id: SESSION_ID,
        });
        const changes = await planSessionRestore(snapshot([session, entry, deletedEntry]), session);
        const restored = changes.find((item) => item.id === ENTRY_ID);
        expect(restored?.fields.get("session_ids")).toBe(`${OTHER_SESSION_ID},${SESSION_ID}`);
    });

    it("merges the session link when the entry has no session list field", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_ID,
        });
        const entry = record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
        });
        const changes = await planSessionRestore(snapshot([session, entry]), session);
        expect(changes.find((item) => item.id === ENTRY_ID)?.fields.get("session_ids")).toBe(
            SESSION_ID,
        );
    });

    it("restores journal entries and notes marked for the session group", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_ID,
            notes_document_id: NOTES_ID,
        });
        const entry = record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
            session_ids: OTHER_SESSION_ID,
            _trash_session_group_id: SESSION_ID,
            _trash_restore_session_refs: SESSION_ID,
            _trash_restore_guide_refs: GUIDE_ID,
        });
        const notes = record(RecordType.settings, NOTES_ID, {
            record_role: "journal-notes",
            _deleted: "true",
            _trash_group_id: SESSION_ID,
            session_id: SESSION_ID,
        });
        const changes = await planSessionRestore(snapshot([session, entry, notes]), session);
        const byId = new Map(changes.map((item) => [item.id.toLowerCase(), item]));
        expect(byId.get(ENTRY_ID)?.fields.get("study_guide_ids")).toBe(GUIDE_ID);
        expect(byId.get(ENTRY_ID)?.fields.get("session_ids")).toBe(
            `${OTHER_SESSION_ID},${SESSION_ID}`,
        );
        expect(byId.get(ENTRY_ID)?.fields.has("_trash_restore_guide_refs")).toBe(false);
        expect(byId.get(NOTES_ID)?.fields.has("_deleted")).toBe(false);
    });
});

describe("session trash scope branches", () => {
    it("leaves evidence edges outside the deletion scope untouched", async () => {
        const unrelatedEdge = record(RecordType.evidenceEdge, OTHER_ID, {
            session_id: OTHER_SESSION_ID,
            from_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            to_id: "12121212-1212-4212-8212-121212121212",
        });
        const records = [...baseRecords(), unrelatedEdge];
        const plan = await planSessionTrash(snapshot(records), records[0]!);
        expect(plan.scopeRecords.some((item) => item.id === OTHER_ID)).toBe(false);
        expect(plan.counts.evidenceEdges).toBe(0);
    });

    it("records guide restoration refs when the entry does not reference the session", async () => {
        const records = [
            ...baseRecords().filter((item) => item.id !== ENTRY_ID && item.id !== NOTES_ID),
            makeGuide(GUIDE_ID, SESSION_ID, []),
            record(RecordType.settings, ENTRY_ID, {
                record_role: "journal-entry",
                session_ids: OTHER_SESSION_ID,
                study_guide_ids: GUIDE_ID,
            }),
        ];
        const session = records.find((item) => item.id === SESSION_ID)!;
        const plan = await planSessionTrash(snapshot(records), session);
        const entry = plan.scopeRecords.find((item) => item.id === ENTRY_ID)!;
        expect(entry.fields.get("_trash_restore_guide_refs")).toBe(GUIDE_ID);
        expect(entry.fields.has("_trash_restore_session_refs")).toBe(false);
    });

    it("does not rewrite an entry whose session list already contains the session", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_ID,
        });
        const entry = record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
            session_ids: SESSION_ID,
        });
        const changes = await planSessionRestore(snapshot([session, entry]), session);
        expect(changes.some((item) => item.id === ENTRY_ID)).toBe(false);
    });

    it("does not duplicate references that the restore marker already lists", async () => {
        const session = record(RecordType.session, SESSION_ID, {
            _deleted: "true",
            entry_id: ENTRY_ID,
        });
        const entry = record(RecordType.settings, ENTRY_ID, {
            record_role: "journal-entry",
            session_ids: `${SESSION_ID},${OTHER_SESSION_ID}`,
            _trash_session_group_id: SESSION_ID,
            _trash_restore_session_refs: SESSION_ID,
        });
        const changes = await planSessionRestore(snapshot([session, entry]), session);
        const restored = changes.find((item) => item.id === ENTRY_ID)!;
        expect(restored.fields.get("session_ids")).toBe(`${SESSION_ID},${OTHER_SESSION_ID}`);
    });

    it("restores a duplicated edge listing only once", async () => {
        const session = record(RecordType.session, SESSION_ID, { _deleted: "true" });
        const edge = record(RecordType.evidenceEdge, EDGE_ID, {
            _deleted: "true",
            session_id: SESSION_ID,
        });
        const changes = await planSessionRestore(snapshot([session, edge, edge]), session);
        expect(changes.filter((item) => item.id === EDGE_ID)).toHaveLength(1);
    });
});
