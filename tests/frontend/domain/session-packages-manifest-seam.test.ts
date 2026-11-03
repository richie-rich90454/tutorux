import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, newUuid, type ArchiveRecord } from "../../../frontend/archive/format";
import { createSessionPackage } from "../../../frontend/domain/session-packages";

const mocks = vi.hoisted(() => ({ openArchiveBytes: vi.fn() }));

vi.mock("../../../frontend/archive/archive", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../frontend/archive/archive")>();
    return { ...actual, openArchiveBytes: mocks.openArchiveBytes };
});

function sessionRecord(id: string): ArchiveRecord {
    return {
        type: RecordType.session,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["student_id", "anonymous"],
            ["session_state", "completed"],
        ]),
        blob: new Uint8Array(),
    };
}

function sourceSnapshot(session: ArchiveRecord): ArchiveSnapshot {
    return {
        getRecord: async (type: number, id: string) =>
            type === RecordType.session && id === session.id ? session : null,
        listRecords: async (type: number) => (type === RecordType.session ? [session] : []),
        getRecordHistory: async () => [session],
    } as unknown as ArchiveSnapshot;
}

beforeEach(() => {
    mocks.openArchiveBytes.mockReset();
});

describe("session package manifest seam", () => {
    it("rejects a freshly created package that lost its manifest", async () => {
        const session = sessionRecord(newUuid());
        mocks.openArchiveBytes.mockResolvedValue({
            header: { id: newUuid() },
            getRecord: async () => null,
        } as unknown as ArchiveSnapshot);

        await expect(createSessionPackage(sourceSnapshot(session), session.id)).rejects.toThrow(
            /new package archive is missing its manifest/u,
        );
    });
});
