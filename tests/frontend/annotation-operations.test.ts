import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
    mergeObservations,
    setObservationLink,
    splitObservation,
} from "../../frontend/annotation-operations";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function observation(
    id: string,
    fields: Record<string, string> = {},
    type: number = RecordType.annotation,
): ArchiveRecord {
    return {
        type,
        id,
        revision: 2n,
        previousOffset: 4n,
        fields: new Map([
            ["session_id", SESSION_ID],
            ["type", "observation"],
            ["priority", "normal"],
            ["content", "abcdef"],
            ["start_time_us", "1000000"],
            ["end_time_us", "5000000"],
            ...Object.entries(fields),
        ]),
        blob: new Uint8Array(),
    };
}

describe("splitting observations", () => {
    it("splits content at a character and timestamp", () => {
        const record = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        const [first, second] = splitObservation(record, 3, "2");
        expect(first!.id).toBe(record.id);
        expect(first!.fields.get("content")).toBe("abc");
        expect(first!.fields.get("end_time_us")).toBe("2000000");
        expect(first!.fields.get("updated_at_us")).toMatch(/^\d+$/u);
        expect(second!.id).not.toBe(record.id);
        expect(second!.revision).toBe(0n);
        expect(second!.previousOffset).toBe(0n);
        expect(second!.fields.get("content")).toBe("def");
        expect(second!.fields.get("start_time_us")).toBe("2000000");
        expect(second!.fields.get("created_at_us")).toBe(first!.fields.get("updated_at_us"));
    });

    it("defaults timestamps to zero and allows the initial instant", () => {
        const record = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            start_time_us: "",
            end_time_us: "",
        });
        const [first, second] = splitObservation(record, 2, "");
        expect(first!.fields.get("end_time_us")).toBe("0");
        expect(second!.fields.get("start_time_us")).toBe("0");
    });

    it.each([0, -1, 6, 1.5, Number.NaN])("rejects the split offset %s", (offset) => {
        expect(() =>
            splitObservation(observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), offset, "2"),
        ).toThrow("Choose a split position inside the observation.");
    });

    it("rejects splitting between surrogate halves", () => {
        const record = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { content: "a😀b" });
        expect(() => splitObservation(record, 2, "2")).toThrow(
            "Choose a position between characters.",
        );
    });

    it.each([
        ["before the start", "0"],
        ["at the start", "1"],
        ["at the end", "5"],
        ["after the end", "9"],
    ])("rejects a split time %s", (_label, time) => {
        expect(() =>
            splitObservation(
                observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                offsetFor(time),
                time,
            ),
        ).toThrow("Choose a split time strictly inside the observation range.");
    });
});

function offsetFor(time: string): number {
    return time === "0" ? 1 : 3;
}

describe("merging observations", () => {
    const first = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        content: "first",
        title: "Alpha",
        start_time_us: "1000000",
        end_time_us: "2000000",
        linked_asset_ids: "asset-a, asset-b",
        linked_evidence_ids: "evidence-a",
        source_segment_ids: "segment-a",
    });
    const second = observation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        content: "second",
        title: "Beta",
        start_time_us: "3000000",
        end_time_us: "6000000",
        linked_asset_ids: "asset-b, asset-c",
        linked_evidence_ids: "",
        source_segment_ids: "segment-b",
    });

    it("merges linked lists, titles, and content", () => {
        const [merged, deleted] = mergeObservations([first, second]);
        expect(merged!.id).toBe(first.id);
        expect(merged!.fields.get("content")).toBe("first\nsecond");
        expect(merged!.fields.get("end_time_us")).toBe("6000000");
        expect(merged!.fields.get("merged_titles")).toBe("Alpha\nBeta");
        expect(merged!.fields.get("source_annotation_ids")).toBe(`${first.id},${second.id}`);
        expect(merged!.fields.get("linked_asset_ids")).toBe("asset-a,asset-b,asset-c");
        expect(merged!.fields.get("linked_evidence_ids")).toBe("evidence-a");
        expect(merged!.fields.get("source_segment_ids")).toBe("segment-a,segment-b");
        expect(deleted!.fields.get("_deleted")).toBe("true");
        expect(deleted!.fields.get("updated_at_us")).toBe(merged!.fields.get("updated_at_us"));
        expect(deleted!.id).toBe(second.id);
    });

    it("defaults missing timestamps while merging", () => {
        const stripTimes = (id: string) => {
            const base = observation(id);
            const fields = new Map(base.fields);
            fields.delete("start_time_us");
            fields.delete("end_time_us");
            return { ...base, fields };
        };
        const a = stripTimes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        const b = stripTimes("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        const [merged] = mergeObservations([a, b]);
        expect(merged!.fields.get("end_time_us")).toBe("0");
    });

    it("omits titles that are absent", () => {
        const a = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            title: "",
            start_time_us: "0",
            end_time_us: "1",
        });
        const b = observation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            title: "",
            start_time_us: "0",
            end_time_us: "1",
        });
        expect(mergeObservations([a, b])[0]!.fields.get("merged_titles")).toBe("");
    });

    it("rejects fewer than two observations", () => {
        expect(() => mergeObservations([first])).toThrow(
            "Select at least two observations to merge.",
        );
    });

    it.each([
        [
            "wrong record type",
            () => observation("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {}, RecordType.session),
        ],
        [
            "deleted record",
            () => observation("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { _deleted: "true" }),
        ],
    ])("rejects a set with a %s", (_label, build) => {
        expect(() => mergeObservations([first, build()])).toThrow(
            "Select distinct active observations.",
        );
    });

    it("rejects duplicate observation ids", () => {
        expect(() => mergeObservations([first, { ...second, id: first.id.toUpperCase() }])).toThrow(
            "Select distinct active observations.",
        );
    });

    it.each([
        ["session", { session_id: OTHER_SESSION_ID }],
        ["type", { type: "question" }],
        ["priority", { priority: "high" }],
    ])("rejects a different %s", (_label, overrides) => {
        const other = observation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            start_time_us: "3000000",
            ...overrides,
        });
        expect(() => mergeObservations([first, other])).toThrow(
            "Observations must belong to the same session and have the same type and priority.",
        );
    });

    it("rejects out of order observations", () => {
        const earlier = observation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
            start_time_us: "500000",
        });
        expect(() => mergeObservations([first, earlier])).toThrow(
            "Observations must be in chronological order.",
        );
    });
});

describe("observation links", () => {
    const record = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        linked_asset_ids: "asset-b, asset-a",
        linked_evidence_ids: "evidence-a",
    });
    const asset = observation(
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        { session_id: SESSION_ID },
        RecordType.assetMetadata,
    );
    const evidence = observation(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        { session_id: "" },
        RecordType.evidenceNode,
    );

    it("adds and removes asset links", () => {
        const linked = setObservationLink(record, asset, true);
        expect(linked.fields.get("linked_asset_ids")).toBe("asset-b,asset-a," + asset.id);
        expect(linked.fields.get("updated_at_us")).toMatch(/^\d+$/u);
        const unlinked = setObservationLink(record, asset, false);
        expect(unlinked.fields.get("linked_asset_ids")).toBe("asset-b,asset-a");
    });

    it("deduplicates existing links case-insensitively", () => {
        const duplicate = observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
            linked_asset_ids: `${asset.id},${asset.id.toUpperCase()},other`,
        });
        expect(setObservationLink(duplicate, asset, true).fields.get("linked_asset_ids")).toBe(
            `other,${asset.id}`,
        );
    });

    it("updates evidence links independently", () => {
        const linked = setObservationLink(record, evidence, true);
        expect(linked.fields.get("linked_evidence_ids")).toBe(`evidence-a,${evidence.id}`);
        expect(linked.fields.get("linked_asset_ids")).toBe("asset-b, asset-a");
        expect(setObservationLink(record, evidence, false).fields.get("linked_evidence_ids")).toBe(
            "evidence-a",
        );
    });

    it("rejects invalid record and target types", () => {
        expect(() =>
            setObservationLink(
                observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {}, RecordType.session),
                asset,
                true,
            ),
        ).toThrow("Choose an asset or evidence record.");
        expect(() =>
            setObservationLink(
                record,
                observation("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {}, RecordType.guide),
                true,
            ),
        ).toThrow("Choose an asset or evidence record.");
    });

    it("rejects links from another session", () => {
        const other = observation(
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            { session_id: OTHER_SESSION_ID },
            RecordType.assetMetadata,
        );
        expect(() => setObservationLink(record, other, true)).toThrow(
            "The linked record belongs to another session.",
        );
    });
});
