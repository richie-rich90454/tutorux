import { describe, expect, it } from "vitest";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import {
    canChangeAssetSession,
    moveAssetToSession,
} from "../../../frontend/domain/asset-placement";

const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION_ID = "33333333-3333-4333-8333-333333333333";

function record(type: number, id: string, fields: Record<string, string> = {}): ArchiveRecord {
    return {
        type,
        id,
        revision: 2n,
        previousOffset: 8n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function asset(fields: Record<string, string> = {}): ArchiveRecord {
    return record(RecordType.assetMetadata, ASSET_ID, {
        record_role: "worksheet",
        session_id: OTHER_SESSION_ID,
        ...fields,
    });
}

function snapshot(records: ArchiveRecord[]): ArchiveSnapshot {
    const byKey = new Map(records.map((item) => [`${item.type}:${item.id.toLowerCase()}`, item]));
    return {
        getRecord: async (type: number, id: string) =>
            byKey.get(`${type}:${id.toLowerCase()}`) ?? null,
        listRecords: async (type: number) => records.filter((item) => item.type === type),
    } as unknown as ArchiveSnapshot;
}

describe("asset session eligibility", () => {
    it.each([
        "audio-track",
        "recording-take",
        "waveform-pyramid",
        "sparse-timestamp-seek-index",
        "asset-blob-manifest",
        "asset-blob-chunk",
    ])("rejects internal role %s", (role) => {
        expect(canChangeAssetSession(asset({ record_role: role }))).toBe(false);
    });

    it("rejects non-material records and allows ordinary materials", () => {
        expect(canChangeAssetSession(record(RecordType.session, SESSION_ID))).toBe(false);
        expect(canChangeAssetSession(asset({ record_role: "" }))).toBe(true);
        expect(canChangeAssetSession(asset({ record_role: "handout" }))).toBe(true);
        const noRole = {
            ...asset(),
            fields: new Map([["session_id", SESSION_ID]]),
        };
        expect(canChangeAssetSession(noRole)).toBe(true);
    });
});

describe("moving materials between sessions", () => {
    it("moves a material into a session and stamps the revision", async () => {
        const moved = await moveAssetToSession(
            snapshot([asset(), record(RecordType.session, SESSION_ID)]),
            asset(),
            ` ${SESSION_ID.toUpperCase()} `,
            "12345",
        );
        expect(moved.id).toBe(ASSET_ID);
        expect(moved.fields.get("session_id")).toBe(SESSION_ID);
        expect(moved.fields.get("updated_at_us")).toBe("12345");
        expect(moved.revision).toBe(2n);
    });

    it("falls back to the current time when no timestamp is supplied", async () => {
        const moved = await moveAssetToSession(snapshot([asset()]), asset(), "");
        expect(moved.fields.get("updated_at_us")).toMatch(/^\d+$/);
    });

    it("moves a material back to the general library", async () => {
        const moved = await moveAssetToSession(snapshot([asset()]), asset(), "", "999");
        expect(moved.fields.has("session_id")).toBe(false);
        expect(moved.fields.get("updated_at_us")).toBe("999");
    });

    it("rejects internally managed source records", async () => {
        const internal = asset({ record_role: "audio-track" });
        await expect(
            moveAssetToSession(snapshot([internal]), internal, SESSION_ID),
        ).rejects.toMatchObject({ code: "asset_session_move_not_supported" });
    });

    it("rejects missing and deleted material revisions", async () => {
        await expect(moveAssetToSession(snapshot([]), asset(), SESSION_ID)).rejects.toMatchObject({
            code: "asset_session_move_unavailable",
        });
        const deleted = asset({ _deleted: "true" });
        await expect(
            moveAssetToSession(snapshot([deleted]), asset(), SESSION_ID),
        ).rejects.toMatchObject({ code: "asset_session_move_unavailable" });
    });

    it("rejects a material that became internally managed", async () => {
        const latest = asset({ record_role: "asset-blob-chunk" });
        await expect(
            moveAssetToSession(snapshot([latest]), asset(), SESSION_ID),
        ).rejects.toMatchObject({ code: "asset_session_move_not_supported" });
    });

    it("rejects invalid and unavailable sessions", async () => {
        await expect(
            moveAssetToSession(snapshot([asset()]), asset(), "not-a-uuid"),
        ).rejects.toMatchObject({ code: "asset_session_invalid" });
        await expect(
            moveAssetToSession(snapshot([asset()]), asset(), SESSION_ID),
        ).rejects.toMatchObject({ code: "asset_session_unavailable" });
        const deletedSession = record(RecordType.session, SESSION_ID, { _deleted: "true" });
        await expect(
            moveAssetToSession(snapshot([asset(), deletedSession]), asset(), SESSION_ID),
        ).rejects.toMatchObject({ code: "asset_session_unavailable" });
    });

    it("allows unchanged references from the target session and deleted records", async () => {
        const moved = await moveAssetToSession(
            snapshot([
                asset(),
                record(RecordType.session, SESSION_ID),
                record(RecordType.annotation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
                    session_id: SESSION_ID,
                    linked_asset_ids: ASSET_ID,
                }),
                record(RecordType.annotation, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
                    session_id: SESSION_ID,
                    _deleted: "true",
                    linked_asset_ids: ASSET_ID,
                }),
                record(RecordType.annotation, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
                    session_id: SESSION_ID,
                    text: `asset:${ASSET_ID}`,
                    linked_asset_ids: "some-other-asset",
                }),
                record(RecordType.annotation, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
                    session_id: SESSION_ID,
                    source_ids: "other",
                }),
            ]),
            asset(),
            SESSION_ID,
        );
        expect(moved.fields.get("session_id")).toBe(SESSION_ID);
    });

    it("rejects materials referenced from another session", async () => {
        await expect(
            moveAssetToSession(
                snapshot([
                    asset(),
                    record(RecordType.session, SESSION_ID),
                    record(RecordType.annotation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
                        session_id: OTHER_SESSION_ID,
                        linked_asset_ids: ASSET_ID,
                    }),
                ]),
                asset(),
                SESSION_ID,
            ),
        ).rejects.toMatchObject({ code: "asset_session_move_breaks_link" });
    });

    it("allows references from records without a session", async () => {
        const moved = await moveAssetToSession(
            snapshot([
                asset(),
                record(RecordType.session, SESSION_ID),
                record(RecordType.annotation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
                    linked_asset_ids: ASSET_ID,
                }),
            ]),
            asset(),
            SESSION_ID,
        );
        expect(moved.fields.get("session_id")).toBe(SESSION_ID);
    });

    it.each([
        ["source_asset_ids", { source_asset_ids: ASSET_ID }],
        ["attachment_ids", { attachment_ids: ASSET_ID }],
        ["source_ids", { source_ids: ASSET_ID }],
        ["nested source_ids", { "section.0.block.0.source_ids": `x ${ASSET_ID}` }],
        ["content", { content: `See asset:${ASSET_ID} for details` }],
        ["text field", { notes_text: `ASSET:${ASSET_ID}` }],
        ["source text JSON", { assets_manifest: `[{"id":"${ASSET_ID}"}]` }],
        ["nested manifest JSON", { assets_manifest: `{"nested":{"id":"${ASSET_ID}"}}` }],
        ["manifest root string", { assets_manifest: `"${ASSET_ID}"` }],
    ])("detects references from %s", async (_label, fields) => {
        await expect(
            moveAssetToSession(
                snapshot([
                    asset(),
                    record(RecordType.session, SESSION_ID),
                    record(RecordType.guide, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
                        session_id: OTHER_SESSION_ID,
                        ...fields,
                    }),
                ]),
                asset(),
                SESSION_ID,
            ),
        ).rejects.toMatchObject({ code: "asset_session_move_breaks_link" });
    });

    it("ignores unrelated text, manifests, and malformed JSON", async () => {
        const moved = await moveAssetToSession(
            snapshot([
                asset(),
                record(RecordType.session, SESSION_ID),
                record(RecordType.guide, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
                    session_id: OTHER_SESSION_ID,
                    text: "unrelated",
                    assets_manifest: "not json",
                    source_ids: "other",
                }),
                record(RecordType.guide, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
                    session_id: OTHER_SESSION_ID,
                    assets_manifest: '{"count":3,"missing":null}',
                }),
                record(RecordType.guide, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
                    session_id: OTHER_SESSION_ID,
                    assets_manifest: `"other-asset"`,
                }),
                record(RecordType.guide, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
                    session_id: OTHER_SESSION_ID,
                    assets_manifest: "[1,2,3]",
                }),
            ]),
            asset(),
            SESSION_ID,
        );
        expect(moved.fields.get("session_id")).toBe(SESSION_ID);
    });
});
