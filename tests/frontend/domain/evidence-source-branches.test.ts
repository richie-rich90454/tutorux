import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import { evidenceSourcesAreCurrent } from "../../../frontend/domain/evidence";

const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANNOTATION_ID = "11111111-1111-4111-8111-111111111111";
const SEGMENT_ID = "22222222-2222-4222-8222-222222222222";

function record(
    type: number,
    id: string,
    revision: bigint,
    fields: Record<string, string>,
): ArchiveRecord {
    return {
        type,
        id,
        revision,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map(Object.entries(fields)),
    };
}

function evidence(fields: Record<string, string>): ArchiveRecord {
    return record(RecordType.evidenceNode, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 3n, {
        session_id: SESSION_ID,
        ...fields,
    });
}

function snapshotOf(byId: readonly ArchiveRecord[]): ArchiveSnapshot {
    return {
        getRecord: async (type: number, id: string) =>
            byId.find((item) => item.type === type && item.id === id) ?? null,
        listRecords: async () => [],
        getRecordByIndexKey: async () => null,
    } as unknown as ArchiveSnapshot;
}

describe("evidence source currency edges", () => {
    it("accepts an annotation whose stored revision matches the recorded revision", async () => {
        const annotation = record(RecordType.annotation, ANNOTATION_ID, 4n, {
            session_id: SESSION_ID,
        });
        await expect(
            evidenceSourcesAreCurrent(
                snapshotOf([annotation]),
                evidence({
                    source_annotation_id: ANNOTATION_ID,
                    source_annotation_revision: "4",
                }),
            ),
        ).resolves.toBe(true);
    });

    it("accepts a single segment that has no recorded revision at all", async () => {
        const segment = record(RecordType.transcriptSegment, SEGMENT_ID, 6n, {
            session_id: SESSION_ID,
        });
        await expect(
            evidenceSourcesAreCurrent(
                snapshotOf([segment]),
                evidence({ source_segment_ids: SEGMENT_ID }),
            ),
        ).resolves.toBe(true);
    });

    it("rejects a zero revision recorded on an annotation", async () => {
        const annotation = record(RecordType.annotation, ANNOTATION_ID, 0n, {
            session_id: SESSION_ID,
        });
        await expect(
            evidenceSourcesAreCurrent(
                snapshotOf([annotation]),
                evidence({
                    source_annotation_id: ANNOTATION_ID,
                    source_annotation_revision: "0",
                }),
            ),
        ).resolves.toBe(false);
    });
});
