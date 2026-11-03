import { describe, expect, it } from "vitest";
import {
    PieceTable,
    type DocumentEditTransaction,
    type TextOperation,
} from "../../../frontend/domain/piece-table";

function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function applyOperation(
    table: PieceTable,
    operation: TextOperation,
    selection: { anchor: number; focus: number },
): void {
    const transaction: DocumentEditTransaction = {
        documentId: "property",
        expectedRevision: 0n,
        operations: [operation],
        selectionBefore: table.selection,
        selectionAfter: selection,
        origin: "typing",
        coalesceWithPrevious: false,
    };
    table.apply(transaction);
}

describe("piece table reference-model properties", () => {
    it("matches a plain-string model for every random edit and round-trips undo/redo", () => {
        for (let seed = 1; seed <= 25; seed += 1) {
            const random = seededRandom(seed);
            const initial = "the quick brown fox jumps over the lazy dog";
            const table = new PieceTable(initial);
            let reference = initial;
            let applied = 0;

            for (let step = 0; step < 40; step += 1) {
                const offset = Math.floor(random() * (reference.length + 1));
                const removeLength = Math.floor(
                    random() * Math.min(4, reference.length - offset + 1),
                );
                const removedText = reference.slice(offset, offset + removeLength);
                const insertedText = "abcdefg ".slice(0, Math.floor(random() * 5));
                if (!removedText && !insertedText) continue;

                const cursor = offset + insertedText.length;
                applyOperation(
                    table,
                    { offset, removedText, insertedText },
                    { anchor: cursor, focus: cursor },
                );
                reference =
                    reference.slice(0, offset) +
                    insertedText +
                    reference.slice(offset + removeLength);
                applied += 1;

                expect(table.text()).toBe(reference);
                expect(table.size).toBe(reference.length);
                expect(table.empty).toBe(reference.length === 0);
            }

            expect(applied).toBeGreaterThan(0);
            for (let index = 0; index < applied; index += 1) table.undo();
            expect(table.text()).toBe(initial);
            expect(table.canUndo).toBe(false);
            for (let index = 0; index < applied; index += 1) table.redo();
            expect(table.text()).toBe(reference);
            expect(table.canRedo).toBe(false);
        }
    });

    it("keeps every applied edit idempotent when immediately undone", () => {
        const random = seededRandom(4242);
        const table = new PieceTable("0123456789");
        let reference = "0123456789";
        for (let step = 0; step < 50; step += 1) {
            const offset = Math.floor(random() * (reference.length + 1));
            const removedText = reference.slice(offset, offset + Math.floor(random() * 3));
            const insertedText = String.fromCharCode(97 + Math.floor(random() * 26));
            const cursor = offset + insertedText.length;
            const before = reference;
            applyOperation(
                table,
                { offset, removedText, insertedText },
                { anchor: cursor, focus: cursor },
            );
            reference =
                reference.slice(0, offset) +
                insertedText +
                reference.slice(offset + removedText.length);
            expect(table.text()).toBe(reference);
            table.undo();
            expect(table.text()).toBe(before);
            expect(table.canRedo).toBe(true);
            reference = before;
        }
    });
});
