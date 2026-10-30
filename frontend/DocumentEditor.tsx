import {
    For,
    Index,
    Show,
    createEffect,
    createMemo,
    createSignal,
    untrack,
    type JSX,
} from "solid-js";
import {
    JOURNAL_NOTE_BLOCK_KINDS,
    MAX_JOURNAL_NOTE_BLOCKS,
    type JournalNoteBlock,
    type JournalNoteBlockKind,
} from "./domain/records";
import { formatMarkdownSelection, type InlineMarkdownFormat } from "./domain/markdown-shortcuts";
import {
    DOCX_MIME,
    renderNoteDocx,
    renderNoteHtml,
    renderNoteMarkdown,
} from "./domain/document-export";
import { platform } from "@platform";
import { PieceTable } from "./domain/piece-table";
import "./document-editor.css";

const blockLabels: Record<JournalNoteBlockKind, string> = {
    paragraph: "Paragraph",
    heading: "Section heading",
    "bullet-list": "Bulleted list",
    "numbered-list": "Numbered list",
    checklist: "Checklist",
    quote: "Quote",
    code: "Code",
};

const blockHints: Record<JournalNoteBlockKind, string> = {
    paragraph: "Write a clear thought or observation…",
    heading: "Name this part of your reflection…",
    "bullet-list": "One item per line…",
    "numbered-list": "One step per line…",
    checklist: "One check-in per line…",
    quote: "Capture the words worth remembering…",
    code: "Add a worked example or short notation…",
};

const inlineFormatting: readonly {
    format: InlineMarkdownFormat;
    label: string;
    key?: string;
}[] = [
    { format: "bold", label: "Bold", key: "B" },
    { format: "italic", label: "Italic", key: "I" },
    { format: "strike", label: "Strike" },
    { format: "code", label: "Code" },
    { format: "link", label: "Link", key: "K" },
];

function sameBlock(a: JournalNoteBlock, b: JournalNoteBlock): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
        aKeys.length === bKeys.length &&
        aKeys.every(
            (key) =>
                bKeys.includes(key) &&
                (a as JournalNoteBlock & Record<string, unknown>)[key] ===
                    (b as JournalNoteBlock & Record<string, unknown>)[key],
        )
    );
}

interface DocumentPatch {
    index: number;
    before: JournalNoteBlock[];
    after: JournalNoteBlock[];
    textBlockId: string | undefined;
    time: number;
}

/** A single document history stores only affected blocks, not full document snapshots. */
class DocumentHistory {
    private blocks: JournalNoteBlock[];
    private table: PieceTable;
    private undoEntries: DocumentPatch[] = [];
    private redoEntries: DocumentPatch[] = [];
    private grouping = false;

    constructor(blocks: readonly JournalNoteBlock[]) {
        this.blocks = [...blocks];
        this.table = new PieceTable(this.documentText(this.blocks), false);
    }
    get canUndo(): boolean {
        return this.undoEntries.length > 0;
    }
    get canRedo(): boolean {
        return this.redoEntries.length > 0;
    }
    breakGroup(): void {
        this.grouping = false;
    }
    reset(blocks: readonly JournalNoteBlock[]): void {
        this.blocks = [...blocks];
        this.table = new PieceTable(this.documentText(this.blocks), false);
        this.undoEntries = [];
        this.redoEntries = [];
        this.grouping = false;
    }
    matches(blocks: readonly JournalNoteBlock[]): boolean {
        return (
            blocks.length === this.blocks.length &&
            blocks.every((block, index) => {
                const current = this.blocks[index]!;
                return sameBlock(block, current);
            })
        );
    }
    editText(index: number, value: string): JournalNoteBlock[] | null {
        const block = this.blocks[index];
        if (!block || block.text === value) return null;
        const next = [...this.blocks];
        next[index] = { ...block, text: value };
        return this.change(next, block.id);
    }

    replaceTextRange(
        index: number,
        range: { start: number; end: number },
        replacement: string,
    ): JournalNoteBlock[] | null {
        const block = this.blocks[index];
        if (!block) return null;
        if (block.text.slice(range.start, range.end) === replacement) return null;
        const start = this.blockOffset(index);
        this.table.replace(
            { start: start + range.start, end: start + range.end },
            replacement,
            "document-replace",
        );
        const next = [...this.blocks];
        next[index] = {
            ...block,
            text: block.text.slice(0, range.start) + replacement + block.text.slice(range.end),
        };
        return this.change(next, undefined, true);
    }

    findAll(query: string): { block: number; start: number; end: number }[] {
        if (!query) return [];
        const offsets = this.blockOffsets();
        const blockRanges = this.blocks.map((block, index) => ({
            block: index,
            start: offsets[index]!,
            end: offsets[index]! + block.text.length,
        }));
        let documentMatches: { start: number; end: number }[];
        try {
            documentMatches = this.table.findAll(query);
        } catch {
            return [];
        }
        const matches: { block: number; start: number; end: number }[] = [];
        const lastEndByBlock = new Map<number, number>();
        let blockIndex = 0;
        for (const match of documentMatches) {
            while (blockIndex < blockRanges.length && blockRanges[blockIndex]!.end <= match.start)
                blockIndex += 1;
            const range = blockRanges[blockIndex];
            if (!range || match.start < range.start || match.end > range.end) continue;
            if (match.start < (lastEndByBlock.get(range.block) ?? range.start)) continue;
            matches.push({
                block: range.block,
                start: match.start - range.start,
                end: match.end - range.start,
            });
            lastEndByBlock.set(range.block, match.end);
        }
        return matches;
    }

    replaceAll(query: string, replacement: string): JournalNoteBlock[] | null {
        if (!query || query === replacement) return null;
        const matches = this.findAll(query);
        if (!matches.length) return null;
        const offsets = this.blockOffsets();
        const absoluteMatches = matches.map((match) => {
            const start = offsets[match.block]!;
            return {
                range: { start: start + match.start, end: start + match.end },
                text: replacement,
            };
        });
        this.table.replaceRanges(absoluteMatches, "document-replace-all");
        const matchesByBlock = new Map<number, typeof matches>();
        matches.forEach((match) => {
            const blockMatches = matchesByBlock.get(match.block) ?? [];
            blockMatches.push(match);
            matchesByBlock.set(match.block, blockMatches);
        });
        const next = this.blocks.map((block, index) => {
            const blockMatches = matchesByBlock.get(index);
            if (!blockMatches) return block;
            let text = block.text;
            for (const match of [...blockMatches].reverse()) {
                text = text.slice(0, match.start) + replacement + text.slice(match.end);
            }
            return { ...block, text };
        });
        return this.change(next, undefined, true);
    }

    change(
        next: JournalNoteBlock[],
        textBlockId?: string,
        tableAlreadyUpdated = false,
    ): JournalNoteBlock[] {
        let start = 0;
        while (
            start < this.blocks.length &&
            start < next.length &&
            sameBlock(this.blocks[start]!, next[start]!)
        )
            start += 1;
        let oldEnd = this.blocks.length;
        let newEnd = next.length;
        while (
            oldEnd > start &&
            newEnd > start &&
            sameBlock(this.blocks[oldEnd - 1]!, next[newEnd - 1]!)
        ) {
            oldEnd -= 1;
            newEnd -= 1;
        }
        if (start === oldEnd && start === newEnd) return this.blocks;
        if (!tableAlreadyUpdated) {
            const nextText = this.documentText(next);
            if (this.table.text() !== nextText) this.table.applyTextSnapshot(nextText);
        }
        const time = Date.now();
        const patch: DocumentPatch = {
            index: start,
            before: this.blocks.slice(start, oldEnd),
            after: next.slice(start, newEnd),
            textBlockId,
            time,
        };
        const previous = this.undoEntries.at(-1);
        if (
            textBlockId &&
            this.grouping &&
            previous?.textBlockId === textBlockId &&
            previous.index === start &&
            time - previous.time < 800 &&
            patch.before.length === 1 &&
            patch.after.length === 1
        ) {
            previous.after = patch.after;
            previous.time = time;
        } else {
            this.undoEntries.push(patch);
            if (this.undoEntries.length > 100) this.undoEntries.shift();
        }
        this.grouping = Boolean(textBlockId);
        this.redoEntries = [];
        this.blocks = next;
        return next;
    }
    private replay(patch: DocumentPatch, undo: boolean): JournalNoteBlock[] {
        const from = undo ? patch.after : patch.before;
        const to = undo ? patch.before : patch.after;
        const next = [...this.blocks];
        next.splice(patch.index, from.length, ...to);
        this.table.applyTextSnapshot(this.documentText(next));
        this.blocks = next;
        this.grouping = false;
        return next;
    }
    private blockOffset(index: number): number {
        let offset = 0;
        for (let current = 0; current < index; current += 1)
            offset += this.blocks[current]!.text.length;
        return offset;
    }
    private blockOffsets(): number[] {
        const offsets: number[] = [];
        let offset = 0;
        for (const block of this.blocks) {
            offsets.push(offset);
            offset += block.text.length;
        }
        return offsets;
    }
    private documentText(blocks: readonly JournalNoteBlock[]): string {
        return blocks.map((block) => block.text).join("");
    }
    undo(): JournalNoteBlock[] | null {
        const patch = this.undoEntries.pop();
        if (!patch) return null;
        const result = this.replay(patch, true);
        this.redoEntries.push(patch);
        return result;
    }
    redo(): JournalNoteBlock[] | null {
        const patch = this.redoEntries.pop();
        if (!patch) return null;
        const result = this.replay(patch, false);
        this.undoEntries.push(patch);
        return result;
    }
}

export function DocumentEditor(props: {
    label: string;
    blocks: readonly JournalNoteBlock[];
    onChange(blocks: JournalNoteBlock[]): void;
}): JSX.Element {
    const [nextKind, setNextKind] = createSignal<JournalNoteBlockKind>("paragraph");
    const initialBlocks = untrack(() => props.blocks);
    const history = new DocumentHistory(initialBlocks);
    const [historyVersion, setHistoryVersion] = createSignal(0);
    let lastEmitted: readonly JournalNoteBlock[] = initialBlocks;
    createEffect(() => {
        const blocks = props.blocks;
        if (blocks !== lastEmitted && !history.matches(blocks)) {
            history.reset(blocks);
            setHistoryVersion((version) => version + 1);
        }
        lastEmitted = blocks;
    });
    const canUndo = () => {
        historyVersion();
        return history.canUndo;
    };
    const canRedo = () => {
        historyVersion();
        return history.canRedo;
    };
    function publish(blocks: JournalNoteBlock[]): void {
        lastEmitted = blocks;
        setHistoryVersion((version) => version + 1);
        props.onChange(blocks);
    }
    const [exporting, setExporting] = createSignal(false);
    const [exportError, setExportError] = createSignal("");
    const [finding, setFinding] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [replacement, setReplacement] = createSignal("");
    const [matchIndex, setMatchIndex] = createSignal(-1);
    const [focusedBlockIndex, setFocusedBlockIndex] = createSignal<number | null>(null);
    let findInput: HTMLInputElement | undefined;
    let editorElement: HTMLElement | undefined;
    let focusedTextArea: HTMLTextAreaElement | undefined;
    const editorId = (index: number): string =>
        `document-block-kind-${props.label.replace(/\W+/gu, "-").toLowerCase()}-${index}`;
    const matches = createMemo(() => {
        historyVersion();
        const needle = query();
        return history.findAll(needle);
    });
    function openFind(): void {
        setFinding(true);
        queueMicrotask(() => findInput?.focus());
    }
    function selectMatch(index: number): void {
        const list = matches();
        if (!list.length) return;
        const selected = ((index % list.length) + list.length) % list.length;
        setMatchIndex(selected);
        const match = list[selected]!;
        const input = editorElement?.querySelector<HTMLTextAreaElement>(
            `textarea[data-note-block="${match.block}"]`,
        );
        input?.focus();
        input?.setSelectionRange(match.start, match.end);
        input?.scrollIntoView({ block: "nearest" });
    }
    function replaceMatch(): void {
        const match = matches()[Math.max(0, Math.min(matchIndex(), matches().length - 1))];
        if (!match) return;
        const blocks = history.replaceTextRange(
            match.block,
            { start: match.start, end: match.end },
            replacement(),
        );
        if (blocks) publish(blocks);
        const selected = matchIndex();
        queueMicrotask(() => selectMatch(selected));
    }
    function replaceAll(): void {
        const needle = query();
        if (!needle || !matches().length) return;
        const blocks = history.replaceAll(needle, replacement());
        if (blocks) publish(blocks);
        setMatchIndex(-1);
    }

    function changeBlocks(blocks: JournalNoteBlock[]): void {
        publish(history.change(blocks));
    }

    function update(index: number, change: Partial<JournalNoteBlock>): void {
        changeBlocks(
            props.blocks.map((block, current) =>
                current === index ? { ...block, ...change } : block,
            ),
        );
    }

    function editText(index: number, text: string): void {
        const blocks = history.editText(index, text);
        if (blocks) publish(blocks);
    }

    function addBlock(): void {
        changeBlocks([...props.blocks, { id: crypto.randomUUID(), kind: nextKind(), text: "" }]);
    }

    function moveBlock(index: number, direction: -1 | 1): void {
        const destination = index + direction;
        if (destination < 0 || destination >= props.blocks.length) return;
        const blocks = [...props.blocks];
        [blocks[index], blocks[destination]] = [blocks[destination]!, blocks[index]!];
        changeBlocks(blocks);
    }

    function removeBlock(index: number): void {
        changeBlocks(props.blocks.filter((_, current) => current !== index));
    }

    function splitBlock(index: number): void {
        const block = props.blocks[index];
        if (!block || props.blocks.length >= MAX_JOURNAL_NOTE_BLOCKS) return;
        const input = editorElement?.querySelector<HTMLTextAreaElement>(
            `textarea[data-note-block="${index}"]`,
        );
        const position = input?.selectionStart ?? block.text.length;
        const blocks = [...props.blocks];
        blocks.splice(
            index,
            1,
            { ...block, text: block.text.slice(0, position) },
            {
                id: crypto.randomUUID(),
                kind: block.kind,
                text: block.text.slice(position),
            },
        );
        changeBlocks(blocks);
        queueMicrotask(() => {
            const next = editorElement?.querySelector<HTMLTextAreaElement>(
                `textarea[data-note-block="${index + 1}"]`,
            );
            next?.focus();
            next?.setSelectionRange(0, 0);
        });
    }

    function mergeNextBlock(index: number): void {
        const current = props.blocks[index];
        const next = props.blocks[index + 1];
        if (!current || !next || current.kind !== next.kind) return;
        const separator = current.text && next.text ? "\n" : "";
        const blocks = [...props.blocks];
        blocks.splice(index, 2, { ...current, text: current.text + separator + next.text });
        changeBlocks(blocks);
    }

    function undo(): void {
        const blocks = history.undo();
        if (blocks) publish(blocks);
    }

    function redo(): void {
        const blocks = history.redo();
        if (blocks) publish(blocks);
    }

    function canFormatInline(): boolean {
        const focusedIndex = focusedBlockIndex();
        return focusedIndex === null
            ? props.blocks.some((block) => block.kind !== "code")
            : props.blocks[focusedIndex]?.kind !== "code";
    }

    function applyInlineFormat(
        format: InlineMarkdownFormat,
        selectedInput?: HTMLTextAreaElement,
    ): void {
        const fallbackIndex = props.blocks.findIndex((block) => block.kind !== "code");
        const input =
            selectedInput ??
            (focusedTextArea?.isConnected
                ? focusedTextArea
                : fallbackIndex < 0
                  ? undefined
                  : editorElement?.querySelector<HTMLTextAreaElement>(
                        `textarea[data-note-block="${fallbackIndex}"]`,
                    ));
        if (!input) return;
        const index = Number(input.dataset["noteBlock"]);
        const block = props.blocks[index];
        if (!block || block.kind === "code") return;

        const selectionAnchor =
            input.selectionDirection === "backward" ? input.selectionEnd : input.selectionStart;
        const selectionFocus =
            input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
        const formatted = formatMarkdownSelection(
            input.value,
            selectionAnchor,
            selectionFocus,
            format,
        );
        history.breakGroup();
        const blocks = history.editText(index, formatted.text);
        if (!blocks) return;
        publish(blocks);
        history.breakGroup();
        queueMicrotask(() => {
            if (!input.isConnected) return;
            input.focus({ preventScroll: true });
            input.setSelectionRange(
                formatted.selectionStart,
                formatted.selectionEnd,
                formatted.selectionDirection,
            );
        });
    }

    async function exportDocument(format: "markdown" | "html" | "docx" | "pdf"): Promise<void> {
        setExportError("");
        setExporting(true);
        try {
            const title =
                editorElement
                    ?.closest("form")
                    ?.querySelector<HTMLInputElement>('input[name="title"]')
                    ?.value.trim() || props.label;
            const filename =
                [...title]
                    .map((character) =>
                        character.codePointAt(0)! < 0x20 || '<>:"/\\|?*'.includes(character)
                            ? "_"
                            : character,
                    )
                    .join("")
                    .trim()
                    .slice(0, 100) || "notes";
            if (format === "pdf") {
                const printable = new DOMParser()
                    .parseFromString(renderNoteHtml(title, props.blocks), "text/html")
                    .querySelector("main.note-document");
                if (!printable) throw new Error("The document could not be prepared for printing.");
                const preview = document.createElement("div");
                preview.className = "note-print-preview";
                preview.append(printable.cloneNode(true));
                document.body.append(preview);
                document.documentElement.classList.add("note-printing");
                const cleanup = (): void => {
                    preview.remove();
                    document.documentElement.classList.remove("note-printing");
                };
                window.addEventListener("afterprint", cleanup, { once: true });
                try {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    window.print();
                } catch (error) {
                    window.removeEventListener("afterprint", cleanup);
                    cleanup();
                    throw error;
                }
                platform.notify("Choose Save as PDF in the system print dialog.", "success");
            } else if (format === "docx") {
                const saved = await platform.exportBinaryFile(
                    `${filename}.docx`,
                    renderNoteDocx(title, props.blocks),
                    DOCX_MIME,
                );
                if (saved) platform.notify("Document exported as a Word file.", "success");
            } else {
                const html = format === "html";
                const saved = await platform.exportTextFile(
                    `${filename}.${html ? "html" : "md"}`,
                    html
                        ? renderNoteHtml(title, props.blocks)
                        : renderNoteMarkdown(title, props.blocks),
                    html ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
                );
                if (saved)
                    platform.notify(
                        `Document exported as ${html ? "HTML" : "Markdown"}.`,
                        "success",
                    );
            }
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                setExportError(
                    error instanceof Error ? error.message : "The document could not be exported.",
                );
            }
        } finally {
            setExporting(false);
        }
    }

    return (
        <section
            ref={(element) => {
                editorElement = element;
            }}
            class="document-editor"
            aria-label="Note document editor"
            onKeyDown={(event) => {
                if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
                const key = event.key.toLowerCase();
                if (key === "f") {
                    event.preventDefault();
                    event.stopPropagation();
                    openFind();
                    return;
                }
                if (key === "b" || key === "i" || key === "k") {
                    const input =
                        event.target instanceof HTMLTextAreaElement &&
                        event.target.matches("textarea[data-note-block]")
                            ? event.target
                            : event.target instanceof HTMLElement &&
                                event.target.closest(".document-editor-formatting")
                              ? focusedTextArea
                              : undefined;
                    const format = key === "b" ? "bold" : key === "i" ? "italic" : "link";
                    if (
                        input &&
                        props.blocks[Number(input.dataset["noteBlock"])]?.kind !== "code"
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        applyInlineFormat(format, input);
                        return;
                    }
                }
                if (key !== "z" && key !== "y") return;
                event.preventDefault();
                event.stopPropagation();
                if (key === "y" || event.shiftKey) redo();
                else undo();
            }}
        >
            <div class="document-editor-toolbar">
                <div class="document-editor-summary">
                    <span class="document-editor-mark" aria-hidden="true">
                        ¶
                    </span>
                    <div>
                        <strong>Document</strong>
                        <small>
                            {props.blocks.length} {props.blocks.length === 1 ? "block" : "blocks"}
                        </small>
                    </div>
                </div>
                <div class="document-editor-tools">
                    <button
                        class="button button-quiet"
                        type="button"
                        onClick={openFind}
                        title="Find in notes (Ctrl or Command + F)"
                    >
                        Find
                    </button>
                    <button
                        class="button button-quiet"
                        type="button"
                        onClick={undo}
                        disabled={!canUndo()}
                        title="Undo (Ctrl or Command + Z)"
                    >
                        Undo
                    </button>
                    <button
                        class="button button-quiet"
                        type="button"
                        onClick={redo}
                        disabled={!canRedo()}
                        title="Redo (Ctrl or Command + Shift + Z)"
                    >
                        Redo
                    </button>
                    <details class="document-export-menu">
                        <summary class="button button-quiet">Export</summary>
                        <div class="document-export-options">
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("markdown")}
                            >
                                Markdown
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("html")}
                            >
                                HTML
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("docx")}
                            >
                                Word document
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("pdf")}
                            >
                                PDF / Print
                            </button>
                        </div>
                    </details>
                </div>
                <div class="document-editor-add">
                    <label
                        class="sr-only"
                        for={`new-block-kind-${props.label.replace(/\W+/gu, "-").toLowerCase()}`}
                    >
                        New block type
                    </label>
                    <select
                        id={`new-block-kind-${props.label.replace(/\W+/gu, "-").toLowerCase()}`}
                        value={nextKind()}
                        onChange={(event) =>
                            setNextKind(event.currentTarget.value as JournalNoteBlockKind)
                        }
                    >
                        <For each={JOURNAL_NOTE_BLOCK_KINDS}>
                            {(kind) => <option value={kind}>{blockLabels[kind]}</option>}
                        </For>
                    </select>
                    <button
                        class="button button-outline document-editor-add-button"
                        type="button"
                        disabled={props.blocks.length >= MAX_JOURNAL_NOTE_BLOCKS}
                        onClick={addBlock}
                    >
                        Add block
                    </button>
                </div>
            </div>

            <div
                class="document-editor-formatting"
                role="group"
                aria-label="Format selected note text"
            >
                <span>Format selection</span>
                <div>
                    <For each={inlineFormatting}>
                        {(item) => {
                            const shortcut = item.key
                                ? navigator.platform.includes("Mac")
                                    ? `⌘ ${item.key}`
                                    : `Ctrl+${item.key}`
                                : undefined;
                            return (
                                <button
                                    type="button"
                                    disabled={!canFormatInline()}
                                    aria-keyshortcuts={
                                        item.key
                                            ? `Control+${item.key} Meta+${item.key}`
                                            : undefined
                                    }
                                    title={shortcut ? `${item.label} (${shortcut})` : item.label}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => applyInlineFormat(item.format)}
                                >
                                    <span>{item.label}</span>
                                    <Show when={shortcut}>
                                        <kbd>{shortcut}</kbd>
                                    </Show>
                                </button>
                            );
                        }}
                    </For>
                </div>
            </div>

            <Show when={finding()}>
                <div class="document-find" role="search" aria-label="Find and replace in notes">
                    <label>
                        Find
                        <input
                            ref={(element) => (findInput = element)}
                            value={query()}
                            onInput={(event) => {
                                setQuery(event.currentTarget.value);
                                setMatchIndex(-1);
                            }}
                        />
                    </label>
                    <label>
                        Replace with
                        <input
                            value={replacement()}
                            onInput={(event) => setReplacement(event.currentTarget.value)}
                        />
                    </label>
                    <span aria-live="polite">
                        {matches().length} {matches().length === 1 ? "match" : "matches"}
                    </span>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={() => selectMatch(matchIndex() - 1)}
                    >
                        Previous
                    </button>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={() => selectMatch(matchIndex() + 1)}
                    >
                        Next
                    </button>
                    <button type="button" disabled={!matches().length} onClick={replaceMatch}>
                        Replace
                    </button>
                    <button type="button" disabled={!matches().length} onClick={replaceAll}>
                        Replace all
                    </button>
                    <button
                        type="button"
                        onClick={() => setFinding(false)}
                        aria-label="Close find and replace"
                    >
                        Close
                    </button>
                </div>
            </Show>

            <div class="document-editor-pages">
                <Show
                    when={props.blocks.length > 0}
                    fallback={
                        <div class="document-editor-empty">
                            <span aria-hidden="true">＋</span>
                            <p>Your document is clear. Add a block when you are ready to begin.</p>
                        </div>
                    }
                >
                    <Index each={props.blocks}>
                        {(block, index) => (
                            <article class="document-block" data-kind={block().kind}>
                                <div class="document-block-heading">
                                    <span class="document-block-number">
                                        {String(index + 1).padStart(2, "0")}
                                    </span>
                                    <label class="sr-only" for={editorId(index)}>
                                        Block {index + 1} type
                                    </label>
                                    <select
                                        id={editorId(index)}
                                        value={block().kind}
                                        onChange={(event) =>
                                            update(index, {
                                                kind: event.currentTarget
                                                    .value as JournalNoteBlockKind,
                                            })
                                        }
                                    >
                                        <For each={JOURNAL_NOTE_BLOCK_KINDS}>
                                            {(kind) => (
                                                <option value={kind}>{blockLabels[kind]}</option>
                                            )}
                                        </For>
                                    </select>
                                    <div class="document-block-actions">
                                        <button
                                            type="button"
                                            aria-label={`Split block ${index + 1} at cursor`}
                                            disabled={
                                                props.blocks.length >= MAX_JOURNAL_NOTE_BLOCKS
                                            }
                                            onClick={() => splitBlock(index)}
                                        >
                                            Split
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Merge block ${index + 1} with next`}
                                            disabled={
                                                index >= props.blocks.length - 1 ||
                                                block().kind !== props.blocks[index + 1]?.kind
                                            }
                                            onClick={() => mergeNextBlock(index)}
                                        >
                                            Merge
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Move block ${index + 1} up`}
                                            disabled={index === 0}
                                            onClick={() => moveBlock(index, -1)}
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Move block ${index + 1} down`}
                                            disabled={index === props.blocks.length - 1}
                                            onClick={() => moveBlock(index, 1)}
                                        >
                                            ↓
                                        </button>
                                        <button
                                            class="document-block-remove"
                                            type="button"
                                            aria-label={`Remove block ${index + 1}`}
                                            onClick={() => removeBlock(index)}
                                        >
                                            ×
                                        </button>
                                    </div>
                                </div>
                                <textarea
                                    data-note-block={index}
                                    aria-label={
                                        index === 0
                                            ? props.label
                                            : `${props.label} block ${index + 1}`
                                    }
                                    value={block().text}
                                    placeholder={blockHints[block().kind]}
                                    rows={Math.min(8, Math.max(3, block().text.split("\n").length))}
                                    spellcheck="true"
                                    onFocus={(event) => {
                                        focusedTextArea = event.currentTarget;
                                        setFocusedBlockIndex(index);
                                    }}
                                    onInput={(event) => editText(index, event.currentTarget.value)}
                                    onBlur={() => {
                                        history.breakGroup();
                                    }}
                                />
                            </article>
                        )}
                    </Index>
                </Show>
            </div>
            <Show when={exportError()}>
                <p class="document-editor-error" role="alert">
                    {exportError()}
                </p>
            </Show>
            <p class="document-editor-footnote">
                Changes save with this record and stay inside your workspace.
            </p>
        </section>
    );
}
