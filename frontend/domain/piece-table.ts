/** Document offsets are UTF-16 code units, matching DOM selection offsets. */
export interface TextRange {
    start: number;
    end: number;
}
export interface TextSelection {
    anchor: number;
    focus: number;
}
export interface TextOperation {
    offset: number;
    insertedText: string;
    removedText: string;
}
export interface TextReplacement {
    range: TextRange;
    text: string;
}
export interface DocumentEditTransaction {
    documentId: string;
    expectedRevision: bigint;
    operations: readonly TextOperation[];
    selectionBefore: TextSelection;
    selectionAfter: TextSelection;
    origin: string;
    coalesceWithPrevious: boolean;
}
export interface EditResult {
    invalidatedParagraphs: TextRange;
    selection: TextSelection;
    operationCount: number;
}

interface Piece {
    buffer: number;
    start: number;
    length: number;
}
interface HistoryEntry {
    operations: TextOperation[];
    before: TextSelection;
    after: TextSelection;
    origin: string;
}

function validText(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                throw new Error("Text contains an unpaired surrogate.");
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw new Error("Text contains an unpaired surrogate.");
        }
    }
}

/** Append-only piece table with atomic transactions and reversible edit history. */
export class PieceTable {
    private buffers: string[];
    private pieces: Piece[];
    private length: number;
    private currentSelection: TextSelection = { anchor: 0, focus: 0 };
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];
    private coalescingAllowed = true;

    constructor(
        initialText = "",
        private readonly historyEnabled = true,
    ) {
        validText(initialText);
        this.buffers = [initialText];
        this.pieces = initialText ? [{ buffer: 0, start: 0, length: initialText.length }] : [];
        this.length = initialText.length;
    }

    get size(): number {
        return this.length;
    }
    get empty(): boolean {
        return this.length === 0;
    }
    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }
    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }
    get selection(): TextSelection {
        return { ...this.currentSelection };
    }
    text(): string {
        return this.pieces
            .map((piece) =>
                this.buffers[piece.buffer]!.slice(piece.start, piece.start + piece.length),
            )
            .join("");
    }

    private boundary(offset: number, text = this.text()): boolean {
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
        if (offset === 0 || offset === text.length) return true;
        const before = text.charCodeAt(offset - 1);
        const after = text.charCodeAt(offset);
        return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
    }

    setSelection(selection: TextSelection): void {
        const text = this.text();
        if (!this.boundary(selection.anchor, text) || !this.boundary(selection.focus, text)) {
            throw new Error(
                "Selection must be within the document and on Unicode code point boundaries.",
            );
        }
        this.currentSelection = { ...selection };
        this.coalescingAllowed = false;
    }

    private split(offset: number): number {
        let position = 0;
        for (let i = 0; i < this.pieces.length; i += 1) {
            const piece = this.pieces[i]!;
            if (offset === position) return i;
            const end = position + piece.length;
            if (offset < end) {
                const left = offset - position;
                this.pieces.splice(
                    i,
                    1,
                    { ...piece, length: left },
                    { ...piece, start: piece.start + left, length: piece.length - left },
                );
                return i + 1;
            }
            position = end;
        }
        return this.pieces.length;
    }

    private replaceRaw(range: TextRange, inserted: string): string {
        const text = this.text();
        validText(inserted);
        if (
            range.start > range.end ||
            !this.boundary(range.start, text) ||
            !this.boundary(range.end, text)
        ) {
            throw new Error(
                "Edit range must be within the document and on Unicode code point boundaries.",
            );
        }
        const removed = text.slice(range.start, range.end);
        const start = this.split(range.start);
        const end = this.split(range.end);
        const replacement: Piece[] = [];
        if (inserted) {
            replacement.push({ buffer: this.buffers.length, start: 0, length: inserted.length });
            this.buffers.push(inserted);
        }
        this.pieces.splice(start, end - start, ...replacement);
        this.length += inserted.length - removed.length;
        return removed;
    }

    apply(transaction: DocumentEditTransaction): EditResult {
        if (!transaction.operations.length)
            return this.result(this.paragraphAt(this.currentSelection.focus), 0);
        const oldPieces = this.pieces.map((piece) => ({ ...piece }));
        const oldBuffersLength = this.buffers.length;
        const oldLength = this.length;
        const operations: TextOperation[] = [];
        let changedStart = this.length;
        let changedEnd = 0;
        try {
            for (const operation of transaction.operations) {
                const removed = this.replaceRaw(
                    {
                        start: operation.offset,
                        end: operation.offset + operation.removedText.length,
                    },
                    operation.insertedText,
                );
                if (removed !== operation.removedText)
                    throw new Error("The text removed by the edit no longer matches.");
                operations.push({ ...operation, removedText: removed });
                changedStart = Math.min(changedStart, operation.offset);
                changedEnd = Math.max(changedEnd, operation.offset + operation.insertedText.length);
            }
            const text = this.text();
            if (
                !this.boundary(transaction.selectionAfter.anchor, text) ||
                !this.boundary(transaction.selectionAfter.focus, text)
            ) {
                throw new Error(
                    "Selection must be within the document and on Unicode code point boundaries.",
                );
            }
        } catch (error) {
            this.pieces = oldPieces;
            this.buffers.length = oldBuffersLength;
            this.length = oldLength;
            throw error;
        }
        const entry: HistoryEntry = {
            operations,
            before: this.selection,
            after: { ...transaction.selectionAfter },
            origin: transaction.origin,
        };
        const previous = this.undoStack.at(-1);
        let coalesced = false;
        if (
            transaction.coalesceWithPrevious &&
            this.coalescingAllowed &&
            previous &&
            previous.origin === entry.origin &&
            previous.operations.length === 1 &&
            operations.length === 1 &&
            previous.after.anchor === entry.before.anchor &&
            previous.after.focus === entry.before.focus
        ) {
            const a = previous.operations[0]!;
            const b = operations[0]!;
            if (!/[\r\n]/u.test(a.insertedText + a.removedText + b.insertedText + b.removedText)) {
                if (
                    !a.removedText &&
                    !b.removedText &&
                    a.insertedText &&
                    b.insertedText &&
                    a.offset + a.insertedText.length === b.offset
                ) {
                    a.insertedText += b.insertedText;
                    coalesced = true;
                } else if (
                    !a.insertedText &&
                    !b.insertedText &&
                    a.removedText &&
                    b.removedText &&
                    b.offset + b.removedText.length === a.offset
                ) {
                    a.offset = b.offset;
                    a.removedText = b.removedText + a.removedText;
                    coalesced = true;
                } else if (
                    !a.insertedText &&
                    !b.insertedText &&
                    a.removedText &&
                    b.removedText &&
                    a.offset === b.offset
                ) {
                    a.removedText += b.removedText;
                    coalesced = true;
                }
            }
            if (coalesced) previous.after = entry.after;
        }
        if (this.historyEnabled && !coalesced) this.undoStack.push(entry);
        this.redoStack = [];
        this.currentSelection = { ...entry.after };
        this.coalescingAllowed = true;
        return this.result(
            {
                start: this.paragraphAt(changedStart).start,
                end: this.paragraphAt(Math.min(changedEnd, this.length)).end,
            },
            operations.length,
        );
    }

    replace(range: TextRange, replacement: string, origin = "user"): EditResult {
        const text = this.text();
        if (
            range.start > range.end ||
            !this.boundary(range.start, text) ||
            !this.boundary(range.end, text)
        )
            throw new Error("Invalid edit range.");
        const cursor = range.start + replacement.length;
        return this.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: [
                {
                    offset: range.start,
                    removedText: text.slice(range.start, range.end),
                    insertedText: replacement,
                },
            ],
            selectionBefore: this.selection,
            selectionAfter: { anchor: cursor, focus: cursor },
            origin,
            coalesceWithPrevious: false,
        });
    }

    /** Apply non-overlapping document ranges as one reversible transaction. */
    replaceRanges(replacements: readonly TextReplacement[], origin = "user"): EditResult {
        if (!replacements.length)
            return this.result(this.paragraphAt(this.currentSelection.focus), 0);
        const text = this.text();
        const ordered = replacements
            .map(({ range, text: insertedText }) => {
                validText(insertedText);
                if (
                    range.start > range.end ||
                    !this.boundary(range.start, text) ||
                    !this.boundary(range.end, text)
                ) {
                    throw new Error(
                        "Edit range must be within the document and on Unicode code point boundaries.",
                    );
                }
                return {
                    offset: range.start,
                    removedText: text.slice(range.start, range.end),
                    insertedText,
                    end: range.end,
                };
            })
            .sort((a, b) => a.offset - b.offset || a.end - b.end);
        for (let index = 1; index < ordered.length; index += 1) {
            if (ordered[index]!.offset < ordered[index - 1]!.end)
                throw new Error("Edit ranges must not overlap.");
        }
        const before = this.selection;
        const mapOffset = (offset: number): number => {
            let delta = 0;
            for (const replacement of ordered) {
                if (offset < replacement.offset) break;
                if (offset <= replacement.end)
                    return replacement.offset + delta + replacement.insertedText.length;
                delta += replacement.insertedText.length - (replacement.end - replacement.offset);
            }
            return offset + delta;
        };
        return this.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: ordered.reverse().map(({ offset, removedText, insertedText }) => ({
                offset,
                removedText,
                insertedText,
            })),
            selectionBefore: before,
            selectionAfter: {
                anchor: mapOffset(before.anchor),
                focus: mapOffset(before.focus),
            },
            origin,
            coalesceWithPrevious: false,
        });
    }

    applyTextSnapshot(
        updatedText: string,
        selectionAfter?: TextSelection,
        origin = "user",
        coalesceWithPrevious = false,
    ): EditResult {
        validText(updatedText);
        const current = this.text();
        if (current === updatedText)
            return this.result(this.paragraphAt(this.currentSelection.focus), 0);
        let start = 0;
        while (
            start < current.length &&
            start < updatedText.length &&
            current[start] === updatedText[start]
        )
            start += 1;
        while (!this.boundary(start, current) || !this.boundary(start, updatedText)) start -= 1;
        let oldEnd = current.length;
        let newEnd = updatedText.length;
        while (
            oldEnd > start &&
            newEnd > start &&
            current[oldEnd - 1] === updatedText[newEnd - 1]
        ) {
            oldEnd -= 1;
            newEnd -= 1;
        }
        while (!this.boundary(oldEnd, current) || !this.boundary(newEnd, updatedText)) {
            oldEnd += 1;
            newEnd += 1;
        }
        const cursor = newEnd;
        return this.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: [
                {
                    offset: start,
                    removedText: current.slice(start, oldEnd),
                    insertedText: updatedText.slice(start, newEnd),
                },
            ],
            selectionBefore: this.selection,
            selectionAfter: selectionAfter ?? { anchor: cursor, focus: cursor },
            origin,
            coalesceWithPrevious,
        });
    }

    findAll(query: string): TextRange[] {
        validText(query);
        if (!query) return [];
        const text = this.text();
        const matches: TextRange[] = [];
        let at = text.indexOf(query);
        while (at !== -1) {
            if (this.boundary(at, text) && this.boundary(at + query.length, text))
                matches.push({ start: at, end: at + query.length });
            at = text.indexOf(query, at + 1);
        }
        return matches;
    }

    replaceAll(query: string, replacement: string, origin = "user"): EditResult {
        if (!query) throw new Error("Find and replace requires non-empty search text.");
        validText(replacement);
        const matches: TextRange[] = [];
        for (const match of this.findAll(query)) {
            if (!matches.length || match.start >= matches[matches.length - 1]!.end)
                matches.push(match);
        }
        if (!matches.length) return this.result(this.paragraphAt(this.currentSelection.focus), 0);
        const end = this.length + matches.length * (replacement.length - query.length);
        return this.apply({
            documentId: "",
            expectedRevision: 0n,
            operations: matches.reverse().map((match) => ({
                offset: match.start,
                removedText: query,
                insertedText: replacement,
            })),
            selectionBefore: this.selection,
            selectionAfter: { anchor: end, focus: end },
            origin,
            coalesceWithPrevious: false,
        });
    }

    private replay(entry: HistoryEntry, inverse: boolean): EditResult {
        const operations = inverse
            ? [...entry.operations].reverse().map((op) => ({
                  offset: op.offset,
                  insertedText: op.removedText,
                  removedText: op.insertedText,
              }))
            : entry.operations;
        let start = this.length;
        let end = 0;
        for (const op of operations) {
            const removed = this.replaceRaw(
                { start: op.offset, end: op.offset + op.removedText.length },
                op.insertedText,
            );
            if (removed !== op.removedText)
                throw new Error("Document history no longer matches the text.");
            start = Math.min(start, op.offset);
            end = Math.max(end, op.offset + op.insertedText.length);
        }
        this.currentSelection = { ...(inverse ? entry.before : entry.after) };
        this.coalescingAllowed = false;
        return this.result(
            {
                start: this.paragraphAt(start).start,
                end: this.paragraphAt(Math.min(end, this.length)).end,
            },
            operations.length,
        );
    }
    undo(): EditResult {
        const entry = this.undoStack.pop();
        if (!entry) throw new Error("Nothing to undo.");
        const result = this.replay(entry, true);
        this.redoStack.push(entry);
        return result;
    }
    redo(): EditResult {
        const entry = this.redoStack.pop();
        if (!entry) throw new Error("Nothing to redo.");
        const result = this.replay(entry, false);
        this.undoStack.push(entry);
        return result;
    }
    private result(invalidatedParagraphs: TextRange, operationCount: number): EditResult {
        return { invalidatedParagraphs, selection: this.selection, operationCount };
    }
    paragraphAt(offset: number): TextRange {
        const text = this.text();
        const at = Math.max(0, Math.min(text.length, offset));
        const start = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
        const next = text.indexOf("\n", at);
        return { start, end: next < 0 ? text.length : next + 1 };
    }
    previousCodePoint(offset: number): number {
        const text = this.text();
        if (!this.boundary(offset, text)) throw new Error("Invalid Unicode boundary.");
        if (!offset) return 0;
        const unit = text.charCodeAt(offset - 1);
        return offset - (unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1);
    }
    nextCodePoint(offset: number): number {
        const text = this.text();
        if (!this.boundary(offset, text)) throw new Error("Invalid Unicode boundary.");
        if (offset === text.length) return offset;
        return offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1);
    }
    private graphemeBoundaries(): number[] {
        const text = this.text();
        const Segmenter = (
            Intl as unknown as {
                Segmenter?: new (
                    locale?: string,
                    options?: { granularity: "grapheme" },
                ) => { segment(value: string): Iterable<{ index: number }> };
            }
        ).Segmenter;
        if (!Segmenter) throw new Error("Grapheme navigation requires Intl.Segmenter support.");
        return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
            .map((segment) => segment.index)
            .concat(text.length);
    }
    previousGrapheme(offset: number): number {
        if (!this.boundary(offset)) throw new Error("Invalid Unicode boundary.");
        const boundaries = this.graphemeBoundaries();
        for (let i = boundaries.length - 1; i >= 0; i -= 1)
            if (boundaries[i]! < offset) return boundaries[i]!;
        return 0;
    }
    nextGrapheme(offset: number): number {
        if (!this.boundary(offset)) throw new Error("Invalid Unicode boundary.");
        return this.graphemeBoundaries().find((boundary) => boundary > offset) ?? this.length;
    }
}
