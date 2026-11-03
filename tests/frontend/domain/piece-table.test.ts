import { describe, expect, it } from "vitest";
import {
    PieceTable,
    type DocumentEditTransaction,
    type TextOperation,
} from "../../../frontend/domain/piece-table";

function transaction(
    table: PieceTable,
    offset: number,
    insertedText: string,
    removedText = "",
    overrides: Partial<DocumentEditTransaction> = {},
): DocumentEditTransaction {
    const cursor = offset + insertedText.length;
    return {
        documentId: "",
        expectedRevision: 0n,
        operations: [{ offset, insertedText, removedText }],
        selectionBefore: table.selection,
        selectionAfter: { anchor: cursor, focus: cursor },
        origin: "typing",
        coalesceWithPrevious: false,
        ...overrides,
    };
}

describe("piece table construction", () => {
    it("starts empty by default", () => {
        const table = new PieceTable();
        expect(table.size).toBe(0);
        expect(table.empty).toBe(true);
        expect(table.text()).toBe("");
        expect(table.selection).toEqual({ anchor: 0, focus: 0 });
        expect(table.canUndo).toBe(false);
        expect(table.canRedo).toBe(false);
    });

    it("copies initial text and keeps selection snapshots isolated", () => {
        const table = new PieceTable("héllo\r\nworld");
        expect(table.size).toBe(12);
        expect(table.empty).toBe(false);
        table.setSelection({ anchor: 1, focus: 3 });
        const snapshot = table.selection;
        snapshot.anchor = 9;
        expect(table.selection).toEqual({ anchor: 1, focus: 3 });
    });

    it.each(["bad \ud800", "bad \udc00", "a\ud800b"])(
        "rejects unpaired surrogates in the initial text",
        (text) => {
            expect(() => new PieceTable(text)).toThrow("Text contains an unpaired surrogate.");
        },
    );

    it("accepts paired surrogates", () => {
        const table = new PieceTable("a😀b");
        expect(table.size).toBe(4);
    });
});

describe("selection validation", () => {
    const table = new PieceTable("a😀b");

    it.each([
        [-1, 0],
        [0, 99],
        [2, 2],
        [1.5, 1],
    ])("rejects selection %s..%s", (anchor, focus) => {
        expect(() => table.setSelection({ anchor, focus })).toThrow(
            "Selection must be within the document and on Unicode code point boundaries.",
        );
    });

    it("accepts code point boundaries", () => {
        table.setSelection({ anchor: 0, focus: 3 });
        expect(table.selection).toEqual({ anchor: 0, focus: 3 });
    });
});

describe("editing transactions", () => {
    it("returns a no-op result for an empty transaction", () => {
        const table = new PieceTable("first\nsecond");
        table.setSelection({ anchor: 6, focus: 6 });
        const result = table.apply(transaction(table, 0, "", "", { operations: [] }));
        expect(result.operationCount).toBe(0);
        expect(result.invalidatedParagraphs).toEqual({ start: 6, end: 12 });
        expect(result.selection).toEqual({ anchor: 6, focus: 6 });
    });

    it("inserts and removes text and invalidates touched paragraphs", () => {
        const table = new PieceTable("first\nsecond");
        const result = table.replace({ start: 5, end: 6 }, "\n\n");
        expect(table.text()).toBe("first\n\nsecond");
        expect(result.operationCount).toBe(1);
        expect(result.selection).toEqual({ anchor: 7, focus: 7 });
        expect(result.invalidatedParagraphs).toEqual({ start: 0, end: 13 });
    });

    it("applies multiple operations atomically", () => {
        const table = new PieceTable("ab");
        const result = table.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: [
                { offset: 1, insertedText: "X", removedText: "" },
                { offset: 0, insertedText: "Y", removedText: "" },
            ],
            selectionBefore: table.selection,
            selectionAfter: { anchor: 3, focus: 3 },
            origin: "user",
            coalesceWithPrevious: false,
        });
        expect(table.text()).toBe("YaXb");
        expect(result.operationCount).toBe(2);
        expect(result.invalidatedParagraphs).toEqual({ start: 0, end: 4 });
    });

    it("rolls back when the removed text no longer matches", () => {
        const table = new PieceTable("abcdef");
        expect(() => table.apply(transaction(table, 1, "X", "zz"))).toThrow(
            "The text removed by the edit no longer matches.",
        );
        expect(table.text()).toBe("abcdef");
        expect(table.size).toBe(6);
    });

    it("rolls back when the resulting selection is invalid", () => {
        const table = new PieceTable("abc");
        expect(() =>
            table.apply(
                transaction(table, 0, "X", "", {
                    selectionAfter: { anchor: 20, focus: 0 },
                }),
            ),
        ).toThrow("Selection must be within the document and on Unicode code point boundaries.");
        expect(table.text()).toBe("abc");
    });

    it("can be constructed without history", () => {
        const table = new PieceTable("abc", false);
        table.replace({ start: 0, end: 1 }, "x");
        expect(table.text()).toBe("xbc");
        expect(table.canUndo).toBe(false);
        expect(() => table.undo()).toThrow("Nothing to undo.");
    });

    it.each([[{ start: 2, end: 1 }], [{ start: -1, end: 2 }], [{ start: 0, end: 99 }]])(
        "rejects the invalid replacement range %j",
        (range) => {
            const table = new PieceTable("abcdef");
            expect(() => table.replace(range, "x")).toThrow("Invalid edit range.");
        },
    );

    it("rejects transactions with ranges outside the document", () => {
        const table = new PieceTable("abc");
        expect(() => table.apply(transaction(table, -1, "x"))).toThrow(
            "Edit range must be within the document and on Unicode code point boundaries.",
        );
        expect(table.text()).toBe("abc");
    });

    it("rejects replacement ranges split across surrogates", () => {
        const table = new PieceTable("a😀b");
        expect(() => table.replace({ start: 2, end: 3 }, "x")).toThrow("Invalid edit range.");
    });
});

describe("multi-range replacement", () => {
    it("is a no-op for an empty list", () => {
        const table = new PieceTable("abc");
        expect(table.replaceRanges([]).operationCount).toBe(0);
        expect(table.text()).toBe("abc");
    });

    it("applies unordered non-overlapping ranges and maps the selection", () => {
        const table = new PieceTable("abcdef");
        table.setSelection({ anchor: 0, focus: 6 });
        const result = table.replaceRanges([
            { range: { start: 4, end: 5 }, text: "YYYY" },
            { range: { start: 1, end: 2 }, text: "X" },
        ]);
        expect(table.text()).toBe("aXcdYYYYf");
        expect(result.selection).toEqual({ anchor: 0, focus: 9 });
    });

    it("maps offsets inside a replaced range to the inserted text end", () => {
        const table = new PieceTable("abcdef");
        table.setSelection({ anchor: 4, focus: 4 });
        const result = table.replaceRanges([{ range: { start: 4, end: 5 }, text: "YYYY" }]);
        expect(result.selection).toEqual({ anchor: 8, focus: 8 });
    });

    it("rejects overlapping ranges", () => {
        const table = new PieceTable("abcdef");
        expect(() =>
            table.replaceRanges([
                { range: { start: 1, end: 3 }, text: "x" },
                { range: { start: 2, end: 4 }, text: "y" },
            ]),
        ).toThrow("Edit ranges must not overlap.");
        expect(() =>
            table.replaceRanges([
                { range: { start: 2, end: 4 }, text: "x" },
                { range: { start: 2, end: 3 }, text: "y" },
            ]),
        ).toThrow("Edit ranges must not overlap.");
    });

    it("rejects invalid ranges and text", () => {
        const table = new PieceTable("abcdef");
        expect(() => table.replaceRanges([{ range: { start: 3, end: 2 }, text: "x" }])).toThrow(
            "Edit range must be within the document and on Unicode code point boundaries.",
        );
        expect(() =>
            table.replaceRanges([{ range: { start: 0, end: 1 }, text: "\ud800" }]),
        ).toThrow("Text contains an unpaired surrogate.");
    });
});

describe("replacing from a text snapshot", () => {
    it("returns a no-op when the text is unchanged", () => {
        const table = new PieceTable("same");
        table.setSelection({ anchor: 2, focus: 2 });
        const result = table.applyTextSnapshot("same");
        expect(result.operationCount).toBe(0);
        expect(result.invalidatedParagraphs).toEqual({ start: 0, end: 4 });
    });

    it("applies an insertion and deletion diff", () => {
        const table = new PieceTable("abc");
        expect(table.applyTextSnapshot("abXc").selection).toEqual({ anchor: 3, focus: 3 });
        expect(table.text()).toBe("abXc");
        expect(table.applyTextSnapshot("ac").selection).toEqual({ anchor: 1, focus: 1 });
        expect(table.text()).toBe("ac");
    });

    it("keeps surrogate pairs intact when the diff starts inside one", () => {
        const table = new PieceTable("😀");
        table.applyTextSnapshot("😁");
        expect(table.text()).toBe("😁");
    });

    it("walks out of a diff boundary inside a surrogate pair", () => {
        const table = new PieceTable("a\uD835\uDC00");
        table.applyTextSnapshot("b\uD801\uDC00");
        expect(table.text()).toBe("b\uD801\uDC00");
    });

    it("honors an explicit selection, origin, and coalescing flag", () => {
        const table = new PieceTable("abc");
        table.applyTextSnapshot("abd", { anchor: 1, focus: 2 }, "paste", true);
        expect(table.selection).toEqual({ anchor: 1, focus: 2 });
        expect(table.text()).toBe("abd");
    });

    it("rejects snapshot text with unpaired surrogates", () => {
        const table = new PieceTable("abc");
        expect(() => table.applyTextSnapshot("\udc00")).toThrow(
            "Text contains an unpaired surrogate.",
        );
    });
});

describe("search and replace all", () => {
    it("finds non-overlapping matches", () => {
        const table = new PieceTable("ababa");
        expect(table.findAll("")).toEqual([]);
        expect(table.findAll("aba")).toEqual([
            { start: 0, end: 3 },
            { start: 2, end: 5 },
        ]);
        expect(table.findAll("zzz")).toEqual([]);
    });

    it("rejects queries with unpaired surrogates", () => {
        const table = new PieceTable("abc");
        expect(() => table.findAll("\ud800")).toThrow("Text contains an unpaired surrogate.");
    });

    it("replaces all non-overlapping matches", () => {
        const table = new PieceTable("aaa");
        const result = table.replaceAll("aa", "b");
        expect(table.text()).toBe("ba");
        expect(result.selection).toEqual({ anchor: 2, focus: 2 });
    });

    it("grows the selection when replacements are longer", () => {
        const table = new PieceTable("a-a");
        table.replaceAll("-", "---");
        expect(table.text()).toBe("a---a");
        expect(table.selection).toEqual({ anchor: 5, focus: 5 });
    });

    it("is a no-op when nothing matches", () => {
        const table = new PieceTable("abc");
        const result = table.replaceAll("z", "y");
        expect(result.operationCount).toBe(0);
        expect(table.text()).toBe("abc");
    });

    it("rejects empty queries and invalid replacements", () => {
        const table = new PieceTable("abc");
        expect(() => table.replaceAll("", "x")).toThrow(
            "Find and replace requires non-empty search text.",
        );
        expect(() => table.replaceAll("a", "\ud800")).toThrow(
            "Text contains an unpaired surrogate.",
        );
    });
});

describe("undo and redo", () => {
    it("throws when there is nothing to undo or redo", () => {
        const table = new PieceTable("abc");
        expect(() => table.undo()).toThrow("Nothing to undo.");
        expect(() => table.redo()).toThrow("Nothing to redo.");
    });

    it("restores text and selection through undo and redo", () => {
        const table = new PieceTable("abc");
        table.setSelection({ anchor: 1, focus: 2 });
        table.replace({ start: 1, end: 2 }, "XYZ");
        expect(table.text()).toBe("aXYZc");
        expect(table.canUndo).toBe(true);
        expect(table.canRedo).toBe(false);
        expect(table.undo()).toEqual({
            invalidatedParagraphs: { start: 0, end: 3 },
            selection: { anchor: 1, focus: 2 },
            operationCount: 1,
        });
        expect(table.text()).toBe("abc");
        expect(table.canRedo).toBe(true);
        expect(table.redo().selection).toEqual({ anchor: 4, focus: 4 });
        expect(table.text()).toBe("aXYZc");
        expect(table.canUndo).toBe(true);
    });

    it("drops the redo stack after a new edit", () => {
        const table = new PieceTable("abc");
        table.replace({ start: 0, end: 1 }, "x");
        table.undo();
        expect(table.canRedo).toBe(true);
        table.replace({ start: 0, end: 1 }, "y");
        expect(table.canRedo).toBe(false);
    });

    it("replays multi-operation history", () => {
        const table = new PieceTable("ab");
        table.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: [
                { offset: 1, insertedText: "X", removedText: "" },
                { offset: 0, insertedText: "Y", removedText: "" },
            ],
            selectionBefore: table.selection,
            selectionAfter: { anchor: 3, focus: 3 },
            origin: "user",
            coalesceWithPrevious: false,
        });
        expect(table.text()).toBe("YaXb");
        table.undo();
        expect(table.text()).toBe("ab");
        table.redo();
        expect(table.text()).toBe("YaXb");
    });
});

describe("edit coalescing", () => {
    it("merges adjacent insertions into one undo step", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        const result = table.apply(transaction(table, 1, "b", "", { coalesceWithPrevious: true }));
        expect(table.text()).toBe("ab");
        expect(result.selection).toEqual({ anchor: 2, focus: 2 });
        table.undo();
        expect(table.text()).toBe("");
        table.redo();
        expect(table.text()).toBe("ab");
        expect(table.selection).toEqual({ anchor: 2, focus: 2 });
    });

    it("merges a deletion that extends backwards", () => {
        const table = new PieceTable("abcdef");
        table.apply(transaction(table, 3, "", "d"));
        table.apply(transaction(table, 2, "", "c", { coalesceWithPrevious: true }));
        expect(table.text()).toBe("abef");
        table.undo();
        expect(table.text()).toBe("abcdef");
    });

    it("merges deletions at the same offset", () => {
        const table = new PieceTable("abc");
        table.apply(transaction(table, 1, "", "b"));
        table.apply(transaction(table, 1, "", "c", { coalesceWithPrevious: true }));
        expect(table.text()).toBe("a");
        table.undo();
        expect(table.text()).toBe("abc");
    });

    it("does not merge when the operation is not flag-enabled", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        table.apply(transaction(table, 1, "b"));
        expect(table.canUndo).toBe(true);
        table.undo();
        expect(table.text()).toBe("a");
    });

    it("does not merge after an explicit selection change", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        table.setSelection({ anchor: 1, focus: 1 });
        table.apply(transaction(table, 1, "b", "", { coalesceWithPrevious: true }));
        table.undo();
        expect(table.text()).toBe("a");
    });

    it("does not merge a first edit with no history", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a", "", { coalesceWithPrevious: true }));
        table.undo();
        expect(table.text()).toBe("");
    });

    it("does not merge across different origins", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        table.apply(
            transaction(table, 1, "b", "", {
                coalesceWithPrevious: true,
                origin: "paste",
            }),
        );
        table.undo();
        expect(table.text()).toBe("a");
    });

    it("does not merge when either edit has multiple operations", () => {
        const table = new PieceTable("ab");
        table.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: [
                { offset: 0, insertedText: "x", removedText: "" },
                { offset: 2, insertedText: "y", removedText: "" },
            ],
            selectionBefore: table.selection,
            selectionAfter: { anchor: 4, focus: 4 },
            origin: "typing",
            coalesceWithPrevious: false,
        });
        table.apply(transaction(table, 4, "z", "", { coalesceWithPrevious: true }));
        table.undo();
        expect(table.text()).toBe("xayb");
        table.apply(transaction(table, 4, "q", "", { coalesceWithPrevious: true }));
        const operations: TextOperation[] = [
            { offset: 4, insertedText: "r", removedText: "" },
            { offset: 5, insertedText: "s", removedText: "" },
        ];
        table.apply({
            documentId: "",
            expectedRevision: 0n,
            operations,
            selectionBefore: table.selection,
            selectionAfter: { anchor: 7, focus: 7 },
            origin: "typing",
            coalesceWithPrevious: true,
        });
        table.undo();
        expect(table.text()).toBe("xaybq");
    });

    it("does not merge when the previous selection moved", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        table.apply(transaction(table, 1, "b", "", { coalesceWithPrevious: true }));
        table.undo();
        expect(table.text()).toBe("");
    });

    it("does not merge across newlines", () => {
        const table = new PieceTable("");
        table.apply(transaction(table, 0, "a"));
        table.apply(transaction(table, 1, "\n", "", { coalesceWithPrevious: true }));
        table.undo();
        expect(table.text()).toBe("a");
    });

    it("does not merge mixed insertions and deletions", () => {
        const table = new PieceTable("ab");
        table.apply(transaction(table, 0, "x", "a"));
        table.apply(transaction(table, 1, "y", "b", { coalesceWithPrevious: true }));
        expect(table.text()).toBe("xy");
        table.undo();
        expect(table.text()).toBe("xb");
    });
});

describe("navigation helpers", () => {
    it("finds paragraph ranges around an offset", () => {
        const table = new PieceTable("first\nsecond\n\nfourth");
        expect(table.paragraphAt(0)).toEqual({ start: 0, end: 6 });
        expect(table.paragraphAt(2)).toEqual({ start: 0, end: 6 });
        expect(table.paragraphAt(6)).toEqual({ start: 6, end: 13 });
        expect(table.paragraphAt(13)).toEqual({ start: 13, end: 14 });
        expect(table.paragraphAt(14)).toEqual({ start: 14, end: 20 });
        expect(table.paragraphAt(-5)).toEqual({ start: 0, end: 6 });
        expect(table.paragraphAt(999)).toEqual({ start: 14, end: 20 });
        expect(new PieceTable("plain").paragraphAt(2)).toEqual({ start: 0, end: 5 });
    });

    it("moves by code point", () => {
        const table = new PieceTable("a😀b");
        expect(table.previousCodePoint(0)).toBe(0);
        expect(table.previousCodePoint(1)).toBe(0);
        expect(table.previousCodePoint(3)).toBe(1);
        expect(table.previousCodePoint(4)).toBe(3);
        expect(table.nextCodePoint(4)).toBe(4);
        expect(table.nextCodePoint(1)).toBe(3);
        expect(table.nextCodePoint(3)).toBe(4);
    });

    it("rejects code point offsets inside surrogate pairs", () => {
        const table = new PieceTable("a😀b");
        expect(() => table.previousCodePoint(2)).toThrow("Invalid Unicode boundary.");
        expect(() => table.nextCodePoint(2)).toThrow("Invalid Unicode boundary.");
    });

    it("moves by grapheme cluster", () => {
        const table = new PieceTable("e\u0301x😀");
        expect(table.previousGrapheme(0)).toBe(0);
        expect(table.previousGrapheme(2)).toBe(0);
        expect(table.previousGrapheme(3)).toBe(2);
        expect(table.previousGrapheme(5)).toBe(3);
        expect(table.nextGrapheme(0)).toBe(2);
        expect(table.nextGrapheme(2)).toBe(3);
        expect(table.nextGrapheme(3)).toBe(5);
        expect(table.nextGrapheme(5)).toBe(5);
    });

    it("rejects grapheme offsets inside surrogate pairs", () => {
        const table = new PieceTable("a😀b");
        expect(() => table.previousGrapheme(2)).toThrow("Invalid Unicode boundary.");
        expect(() => table.nextGrapheme(2)).toThrow("Invalid Unicode boundary.");
    });

    it("requires Intl.Segmenter for grapheme navigation", () => {
        const table = new PieceTable("abc");
        const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
        Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
        try {
            expect(() => table.nextGrapheme(0)).toThrow(
                "Grapheme navigation requires Intl.Segmenter support.",
            );
        } finally {
            if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
        }
    });
});
