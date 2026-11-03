import { describe, expect, it } from "vitest";
import { RecordType, type ArchiveRecord } from "../../../frontend/archive/format";
import type { ArchiveSnapshot } from "../../../frontend/archive/archive";
import { estimateAiTokenCount, packAiContext } from "../../../frontend/ai/context";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

let nextId = 0;
function record(
    type: ArchiveRecord["type"],
    fields: Record<string, string>,
    id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`,
): ArchiveRecord {
    return {
        type,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map(Object.entries(fields)),
        blob: new Uint8Array(),
    };
}

function sessionRecord(fields: Record<string, string> = {}): ArchiveRecord {
    return record(
        RecordType.session,
        { entry_id: "", student_id: "anonymous", ...fields },
        SESSION_ID,
    );
}

function fakeSnapshot(records: readonly ArchiveRecord[]): ArchiveSnapshot {
    return {
        async getRecord(type: number, id: string) {
            return (
                records.find(
                    (item) => item.type === type && item.id.toLowerCase() === id.toLowerCase(),
                ) ?? null
            );
        },
        async listRecords(type: number) {
            return records.filter((item) => item.type === type);
        },
    } as unknown as ArchiveSnapshot;
}

async function pack(
    records: readonly ArchiveRecord[],
    options?: Parameters<typeof packAiContext>[2],
    sessionId = SESSION_ID,
) {
    return packAiContext(fakeSnapshot(records), sessionId, options);
}

const lengthTokenizer = (value: string) => value.length;

describe("estimateAiTokenCount", () => {
    it("rounds UTF-8 byte length up to whole tokens", () => {
        expect(estimateAiTokenCount("")).toBe(0);
        expect(estimateAiTokenCount("abc")).toBe(1);
        expect(estimateAiTokenCount("abcd")).toBe(2);
        expect(estimateAiTokenCount("é")).toBe(1);
        expect(estimateAiTokenCount("€")).toBe(1);
        expect(estimateAiTokenCount("😀")).toBe(2);
    });
});

describe("packAiContext", () => {
    it("rejects a missing or deleted session", async () => {
        await expect(pack([])).rejects.toThrow(
            "Choose an active session before packing AI context.",
        );

        const deleted = sessionRecord({ _deleted: "true" });
        await expect(pack([deleted])).rejects.toThrow(
            "Choose an active session before packing AI context.",
        );
    });

    it("validates the token budget and per-item limit", async () => {
        const records = [sessionRecord()];
        for (const tokenBudget of [0, 1.5, Number.NaN, 10_000_001]) {
            await expect(pack(records, { tokenBudget })).rejects.toThrow(
                "AI context token budget must be between 1 and 10,000,000.",
            );
        }
        for (const maximumItemTokens of [0, 2, Number.NaN]) {
            await expect(pack(records, { tokenBudget: 1, maximumItemTokens })).rejects.toThrow(
                "Maximum AI context item tokens must be between 1 and its context budget.",
            );
        }
    });

    it("returns an empty pack when no sources belong to the session", async () => {
        const result = await pack([
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: "other-session", text: "ignored" }),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                _deleted: "true",
                text: "gone",
            }),
        ]);

        expect(result).toEqual({
            session_id: SESSION_ID,
            token_budget: 8192,
            used_tokens: 0,
            complete: true,
            included: [],
            omitted: [],
        });
    });

    it("packs prioritized transcript, annotation, evidence, and asset sources", async () => {
        const annotation = record(RecordType.annotation, {
            session_id: SESSION_ID,
            title: "Tutor note",
            content: "Remember this",
            priority: "critical",
            type: "explicit-instruction",
        });
        const evidence = record(RecordType.evidenceNode, {
            session_id: SESSION_ID,
            content: "Verified fact",
            priority: "high",
            verification_state: "human-verified",
            origin: "tutor-authored",
            source_annotation_id: annotation.id,
        });
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                text: "Verified words",
                verification_state: "human-verified",
                updated_at_us: "200",
            }),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                text: "Plain words",
                updated_at_us: "100",
            }),
            annotation,
            record(RecordType.annotation, {
                session_id: SESSION_ID,
                content: "Untitled note",
                priority: "normal",
            }),
            evidence,
            record(RecordType.assetMetadata, {
                session_id: SESSION_ID,
                file_name: "diagram.png",
                extracted_text: "Diagram text",
            }),
            record(RecordType.assetMetadata, { session_id: SESSION_ID, filename: "empty.png" }),
            record(RecordType.assetMetadata, {
                session_id: SESSION_ID,
                file_name: "internal",
                record_role: "waveform-pyramid",
            }),
        ];

        const result = await pack(records, { tokenBudget: 1_000, maximumItemTokens: 1_000 });

        expect(result.complete).toBe(true);
        expect(result.omitted).toEqual([]);
        expect(result.included.map((item) => [item.source_kind, item.content])).toEqual([
            ["tutor-annotation", "Tutor note\nRemember this"],
            ["evidence", "Verified fact"],
            ["transcript", "Verified words"],
            ["tutor-annotation", "Untitled note"],
            ["transcript", "Plain words"],
            ["asset", "Imported asset: empty.png"],
            ["asset", "Imported asset: diagram.png\nDiagram text"],
        ]);
        expect(result.included[0]).toMatchObject({ tutor_authored: true });
        expect(result.included[1]).toMatchObject({ tutor_authored: true });
        expect(result.included[2]).toMatchObject({ estimated_tokens: 5 });
    });

    it("drops stale evidence and transcript-derived candidates", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "Missing annotation",
                origin: "tutor-authored",
                source_annotation_id: "99999999-9999-9999-9999-999999999999",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "Stale candidate",
                origin: "transcript-derived-candidate",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "Authored without sources",
                origin: "tutor-authored",
            }),
            record(RecordType.annotation, { session_id: SESSION_ID, title: "Only a title" }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                origin: "tutor-authored",
            }),
            record(RecordType.assetMetadata, { session_id: SESSION_ID }),
        ];

        const result = await pack(records);
        expect(result.included.map((item) => item.content)).toEqual(
            expect.arrayContaining(["Authored without sources", "", "", "Imported asset: "]),
        );
        expect(result.included).toHaveLength(4);
    });

    it("maps evidence priority and confidence from verification state", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "critical",
                origin: "tutor-authored",
                priority: "critical",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "low",
                origin: "tutor-authored",
                priority: "low",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "normal",
                origin: "tutor-authored",
                priority: "normal",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "default",
                origin: "tutor-authored",
            }),
            record(RecordType.evidenceNode, {
                session_id: SESSION_ID,
                content: "verified",
                origin: "tutor-authored",
                priority: "low",
                verification_state: "human-verified",
            }),
        ];

        const result = await pack(records, { tokenBudget: 1_000 });
        expect(result.included.map((item) => item.content)).toEqual([
            "verified",
            "critical",
            "default",
            "normal",
            "low",
        ]);
    });

    it("omits items that exceed the per-item token limit", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID, text: "😀" }),
        ];

        const result = await pack(records, { tokenBudget: 1, maximumItemTokens: 1 });
        expect(result).toMatchObject({ used_tokens: 0, complete: false });
        expect(result.omitted).toEqual([
            {
                source_id: records[1]!.id,
                reason: "exceeds-item-token-limit",
                estimated_tokens: 2,
                fragment_index: 0,
            },
        ]);
    });

    it("omits items that exceed the remaining context budget", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                text: "abc",
                updated_at_us: "200",
            }),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                text: "def",
                updated_at_us: "100",
            }),
        ];

        const result = await pack(records, {
            tokenBudget: 4,
            maximumItemTokens: 4,
            countTokens: lengthTokenizer,
        });
        expect(result.used_tokens).toBe(3);
        expect(result.complete).toBe(false);
        expect(result.omitted).toEqual([
            {
                source_id: records[2]!.id,
                reason: "exceeds-remaining-context-budget",
                estimated_tokens: 3,
                fragment_index: 0,
            },
        ]);
    });

    it("splits long sources at paragraph and line boundaries", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.annotation, {
                session_id: SESSION_ID,
                content: "aa\n\nbbbb",
                updated_at_us: "200",
            }),
            record(RecordType.annotation, {
                session_id: SESSION_ID,
                content: "aa\nbbbbbb",
                updated_at_us: "100",
            }),
        ];

        const result = await pack(records, {
            tokenBudget: 1_000,
            maximumItemTokens: 5,
            countTokens: lengthTokenizer,
        });

        const contents = result.included.map((item) => item.content);
        expect(contents).toEqual(["aa\n\n", "bbbb", "aa\n", "bbbbb", "b"]);
        expect(result.included[0]).toMatchObject({
            fragment_index: 0,
            source_byte_start: 0,
            source_byte_end: 4,
        });
        expect(result.included[1]).toMatchObject({
            fragment_index: 1,
            source_byte_start: 4,
            source_byte_end: 8,
        });
        expect(result.included[2]).toMatchObject({
            fragment_index: 0,
            source_byte_start: 0,
            source_byte_end: 3,
        });
    });

    it("counts UTF-8 byte ranges for multibyte characters", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID, text: "aé€😀" }),
        ];
        const result = await pack(records);
        expect(result.included[0]).toMatchObject({
            content: "aé€😀",
            source_byte_start: 0,
            source_byte_end: 10,
        });
    });

    it("includes empty source content as a single empty fragment", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID }),
        ];
        const result = await pack(records);
        expect(result.included[0]).toMatchObject({
            content: "",
            estimated_tokens: 0,
            source_byte_start: 0,
            source_byte_end: 0,
        });
    });

    it("rejects invalid tokenizer results", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID, text: "abc" }),
        ];
        for (const countTokens of [() => -1, () => 1.5, () => Number.NaN]) {
            await expect(pack(records, { countTokens })).rejects.toThrow(
                "The AI tokenizer must return a nonnegative safe integer.",
            );
        }
    });

    it("sorts equal candidates deterministically by update time, id, and order", async () => {
        const duplicateId = "22222222-2222-2222-2222-222222222222";
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID }, duplicateId),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID }, duplicateId),
            record(
                RecordType.transcriptSegment,
                { session_id: SESSION_ID, updated_at_us: "5" },
                "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            ),
            record(
                RecordType.transcriptSegment,
                { session_id: SESSION_ID, updated_at_us: "bad" },
                "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            ),
        ];

        const result = await pack(records);
        expect(result.included.map((item) => item.source_id)).toEqual([
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "22222222-2222-2222-2222-222222222222",
            "22222222-2222-2222-2222-222222222222",
        ]);
    });

    it("rejects a source larger than the 64 MiB per-record limit", async () => {
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, {
                session_id: SESSION_ID,
                text: "x".repeat(64 * 1024 * 1024 + 1),
            }),
        ];
        await expect(pack(records)).rejects.toThrow(
            "An AI context source exceeds the 64 MiB per-record limit.",
        );
    });

    it("rejects sources that together exceed the 64 MiB total limit", async () => {
        const chunk = "x".repeat(33 * 1024 * 1024);
        const records = [
            sessionRecord(),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID, text: chunk }),
            record(RecordType.transcriptSegment, { session_id: SESSION_ID, text: chunk }),
        ];
        await expect(pack(records)).rejects.toThrow(
            "The selected AI context sources exceed the 64 MiB total limit.",
        );
    });

    it("rejects an excessive number of source candidates", async () => {
        const fields = new Map([["session_id", SESSION_ID]]);
        const records: ArchiveRecord[] = [
            sessionRecord(),
            ...Array.from({ length: 100_001 }, () => ({
                type: RecordType.transcriptSegment,
                id: "33333333-3333-3333-3333-333333333333",
                revision: 0n,
                previousOffset: 0n,
                fields,
                blob: new Uint8Array(),
            })),
        ];
        await expect(pack(records)).rejects.toThrow(
            "AI context contains too many source records to pack safely.",
        );
    });
});
