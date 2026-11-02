import { buttonQuiet, cn } from "./ui";
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
        queueMicrotask(() => untrack(() => selectMatch(selected)));
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
                preview.className = cn(
                    "note-print-preview",
                    "print:[&_blockquote]:border-l-[3px] print:[&_blockquote]:border-l-[#4a6870] print:[&_blockquote]:ml-0 print:[&_blockquote]:pl-px print:[&_blockquote]:whitespace-pre-wrap print:[html.note-printing_&]:text-[#202820] print:[html.note-printing_&]:block print:[html.note-printing_&]:[font:11pt/1.6_sans-serif] hidden",
                );
                preview.append(printable.cloneNode(true));
                document.body.append(preview);
                document.documentElement.classList.add(
                    "note-printing",
                    "print:[html&:where(.note-printing)_body_>_:not(.note-print-preview)]:hidden!",
                );
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
            class={cn(
                "document-editor",
                "max-[520px]:p-2 bg-surface-subtle rounded-[5px] border border-line grid gap-[9px] min-w-0 p-2.5",
            )}
            aria-label="Note document editor"
            onKeyDown={(event) => {
                if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
                if (
                    event.target instanceof HTMLElement &&
                    event.target.closest(".document-editor-find")
                )
                    return;
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
            <div
                class={cn(
                    "document-editor-toolbar",
                    "max-[520px]:items-start max-[520px]:flex-col items-center border-b border-b-line-soft flex flex-wrap gap-2.5 justify-between pt-px pr-px pb-[7px] pl-px",
                )}
            >
                <div class={cn("document-editor-summary", "items-center flex gap-2")}>
                    <span
                        class={cn(
                            "document-editor-mark",
                            "bg-[color-mix(in_srgb,_var(--accent)_9%,_var(--surface))] rounded-[5px] border border-[color-mix(in_srgb,_var(--accent)_24%,_var(--line))] text-accent grid text-[18px] h-[27px] leading-[1] place-items-center w-[27px]",
                        )}
                        aria-hidden="true"
                    >
                        ¶
                    </span>
                    <div class="grid gap-0.5">
                        <strong class="text-ink-soft text-xs font-[650]">Document</strong>
                        <small class="text-faint text-xs">
                            {props.blocks.length} {props.blocks.length === 1 ? "block" : "blocks"}
                        </small>
                    </div>
                </div>
                <div
                    class={cn(
                        "document-editor-tools",
                        "max-[520px]:ml-0 items-center flex gap-[3px]",
                    )}
                >
                    <button
                        class={cn("button button-quiet", buttonQuiet)}
                        type="button"
                        onClick={openFind}
                        title="Find in notes (Ctrl or Command + F)"
                    >
                        Find
                    </button>
                    <button
                        class={cn("button button-quiet", buttonQuiet)}
                        type="button"
                        onClick={undo}
                        disabled={!canUndo()}
                        title="Undo (Ctrl or Command + Z)"
                    >
                        Undo
                    </button>
                    <button
                        class={cn("button button-quiet", buttonQuiet)}
                        type="button"
                        onClick={redo}
                        disabled={!canRedo()}
                        title="Redo (Ctrl or Command + Shift + Z)"
                    >
                        Redo
                    </button>
                    <details class={cn("document-export-menu", "relative")}>
                        <summary class={cn("button button-quiet", buttonQuiet)}>Export</summary>
                        <div
                            class={cn(
                                "document-export-options",
                                "bg-surface rounded-[5px] border border-line shadow-none grid min-w-[145px] p-[5px] absolute right-0 top-[100%] z-[2]",
                            )}
                        >
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("markdown")}
                                class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] focus-visible:bg-surface-subtle hover:bg-surface-subtle bg-transparent rounded-[5px] border-0 cursor-pointer text-xs p-2 text-left text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                            >
                                Markdown
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("html")}
                                class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] focus-visible:bg-surface-subtle hover:bg-surface-subtle bg-transparent rounded-[5px] border-0 cursor-pointer text-xs p-2 text-left text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                            >
                                HTML
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("docx")}
                                class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] focus-visible:bg-surface-subtle hover:bg-surface-subtle bg-transparent rounded-[5px] border-0 cursor-pointer text-xs p-2 text-left text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                            >
                                Word document
                            </button>
                            <button
                                type="button"
                                disabled={exporting()}
                                onClick={() => void exportDocument("pdf")}
                                class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] focus-visible:bg-surface-subtle hover:bg-surface-subtle bg-transparent rounded-[5px] border-0 cursor-pointer text-xs p-2 text-left text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                            >
                                PDF / Print
                            </button>
                        </div>
                    </details>
                </div>
                <div
                    class={cn(
                        "document-editor-add",
                        "max-[520px]:w-full items-center flex gap-1.5",
                    )}
                >
                    <label
                        class={cn("sr-only", "[clip-path:inset(50%)]")}
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
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line text-ink-soft text-xs h-[29px] max-w-[180px] min-w-0 pt-0 pr-[23px] pb-0 pl-2 max-[520px]:flex-1 max-[520px]:max-w-none"
                    >
                        <For each={JOURNAL_NOTE_BLOCK_KINDS}>
                            {(kind) => <option value={kind}>{blockLabels[kind]}</option>}
                        </For>
                    </select>
                    <button
                        class={cn(
                            "button button-outline document-editor-add-button",
                            "active:translate-y-px items-center rounded-[7px] border border-transparent cursor-pointer inline-flex font-semibold gap-2 justify-center no-underline transition-colors whitespace-nowrap hover:bg-surface-inset hover:border-line-strong bg-surface border-line-strong text-xs min-h-[29px] py-0 px-2.5 focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56",
                        )}
                        type="button"
                        disabled={props.blocks.length >= MAX_JOURNAL_NOTE_BLOCKS}
                        onClick={addBlock}
                    >
                        Add block
                    </button>
                </div>
            </div>

            <div
                class={cn(
                    "document-editor-formatting",
                    "items-center flex flex-wrap gap-2 py-0 px-px",
                )}
                role="group"
                aria-label="Format selected note text"
            >
                <span class="text-faint text-xs">Format selection</span>
                <div class="items-center flex flex-wrap gap-1">
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
                                    class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-faint focus-visible:bg-surface-subtle focus-visible:border-[color-mix(in_srgb,_var(--accent)_42%,_var(--line))] hover:bg-surface-subtle hover:border-[color-mix(in_srgb,_var(--accent)_42%,_var(--line))] items-center bg-surface rounded-[5px] border border-line-soft cursor-pointer inline-flex text-xs gap-1.5 min-h-[27px] py-[3px] px-[7px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                                >
                                    <span class="text-faint text-xs">{item.label}</span>
                                    <Show when={shortcut}>
                                        <kbd class="text-faint text-xs">{shortcut}</kbd>
                                    </Show>
                                </button>
                            );
                        }}
                    </For>
                </div>
            </div>

            <Show when={finding()}>
                <div
                    class={cn(
                        "document-find",
                        "document-editor-find items-end bg-surface-subtle border-b border-b-line flex flex-wrap gap-[0.5rem] p-[0.75rem]",
                    )}
                    role="search"
                    aria-label="Find and replace in notes"
                >
                    <label class="text-muted grid flex-[1_1_10rem] text-[0.75rem] gap-[0.25rem]">
                        Find
                        <input
                            ref={(element) => (findInput = element)}
                            value={query()}
                            onInput={(event) => {
                                setQuery(event.currentTarget.value);
                                setMatchIndex(-1);
                            }}
                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line-strong text-ink min-w-0 py-[0.4rem] px-[0.5rem]"
                        />
                    </label>
                    <label class="text-muted grid flex-[1_1_10rem] text-[0.75rem] gap-[0.25rem]">
                        Replace with
                        <input
                            value={replacement()}
                            onInput={(event) => setReplacement(event.currentTarget.value)}
                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line-strong text-ink min-w-0 py-[0.4rem] px-[0.5rem]"
                        />
                    </label>
                    <span aria-live="polite">
                        {matches().length} {matches().length === 1 ? "match" : "matches"}
                    </span>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={() => selectMatch(matchIndex() - 1)}
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line py-[0.4rem] px-[0.6rem] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                    >
                        Previous
                    </button>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={() => selectMatch(matchIndex() + 1)}
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line py-[0.4rem] px-[0.6rem] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                    >
                        Next
                    </button>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={replaceMatch}
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line py-[0.4rem] px-[0.6rem] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                    >
                        Replace
                    </button>
                    <button
                        type="button"
                        disabled={!matches().length}
                        onClick={replaceAll}
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line py-[0.4rem] px-[0.6rem] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                    >
                        Replace all
                    </button>
                    <button
                        type="button"
                        onClick={() => setFinding(false)}
                        aria-label="Close find and replace"
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface rounded-[5px] border border-line py-[0.4rem] px-[0.6rem] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                    >
                        Close
                    </button>
                </div>
            </Show>

            <div class={cn("document-editor-pages", "grid gap-[7px] min-w-0")}>
                <Show
                    when={props.blocks.length > 0}
                    fallback={
                        <div
                            class={cn(
                                "document-editor-empty",
                                "items-center bg-[color-mix(in_srgb,_var(--surface)_65%,_transparent)] rounded-[5px] border border-dashed border-line text-muted flex gap-[9px] min-h-[74px] p-3",
                            )}
                        >
                            <span
                                aria-hidden="true"
                                class="bg-surface rounded-full text-accent grid text-[15px] h-[25px] place-items-center w-[25px]"
                            >
                                ＋
                            </span>
                            <p class="text-faint text-xs leading-[1.5] m-0">
                                Your document is clear. Add a block when you are ready to begin.
                            </p>
                        </div>
                    }
                >
                    <Index each={props.blocks}>
                        {(block, index) => (
                            <article
                                class={cn(
                                    "document-block",
                                    "focus-within:border-[color-mix(in_srgb,_var(--accent)_50%,_var(--line))] focus-within:shadow-none bg-surface rounded-[5px] border border-line-soft min-w-0 overflow-hidden transition-colors",
                                )}
                                data-kind={block().kind}
                            >
                                <div
                                    class={cn(
                                        "document-block-heading",
                                        "items-center bg-[color-mix(in_srgb,_var(--surface-subtle)_68%,_var(--surface))] border-b border-b-line-soft flex gap-[7px] min-h-[34px] pt-1 pr-1.5 pb-1 pl-[9px]",
                                    )}
                                >
                                    <span
                                        class={cn(
                                            "document-block-number",
                                            "text-faint flex-none text-xs tabular-nums tracking-[0.06em] w-[22px]",
                                        )}
                                    >
                                        {String(index + 1).padStart(2, "0")}
                                    </span>
                                    <label
                                        class={cn("sr-only", "[clip-path:inset(50%)]")}
                                        for={editorId(index)}
                                    >
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
                                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] bg-surface border-transparent rounded-[5px] border border-line text-ink-soft text-xs h-[29px] max-w-[180px] min-w-0 pl-[7px] pt-0 pr-[23px] pb-0 pl-2"
                                    >
                                        <For each={JOURNAL_NOTE_BLOCK_KINDS}>
                                            {(kind) => (
                                                <option value={kind}>{blockLabels[kind]}</option>
                                            )}
                                        </For>
                                    </select>
                                    <div
                                        class={cn(
                                            "document-block-actions",
                                            "items-center flex gap-0.5",
                                        )}
                                    >
                                        <button
                                            type="button"
                                            aria-label={`Split block ${index + 1} at cursor`}
                                            disabled={
                                                props.blocks.length >= MAX_JOURNAL_NOTE_BLOCKS
                                            }
                                            onClick={() => splitBlock(index)}
                                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-line-strong focus-visible:bg-surface focus-visible:text-ink hover:bg-surface hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid text-xs h-[24px] p-0 place-items-center w-[24px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
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
                                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-line-strong focus-visible:bg-surface focus-visible:text-ink hover:bg-surface hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid text-xs h-[24px] p-0 place-items-center w-[24px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                                        >
                                            Merge
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Move block ${index + 1} up`}
                                            disabled={index === 0}
                                            onClick={() => moveBlock(index, -1)}
                                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-line-strong focus-visible:bg-surface focus-visible:text-ink hover:bg-surface hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid text-xs h-[24px] p-0 place-items-center w-[24px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Move block ${index + 1} down`}
                                            disabled={index === props.blocks.length - 1}
                                            onClick={() => moveBlock(index, 1)}
                                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-line-strong focus-visible:bg-surface focus-visible:text-ink hover:bg-surface hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid text-xs h-[24px] p-0 place-items-center w-[24px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56"
                                        >
                                            ↓
                                        </button>
                                        <button
                                            class={cn(
                                                "document-block-remove",
                                                "hover:text-[var(--danger,_#a85343)] focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:text-line-strong focus-visible:bg-surface focus-visible:text-ink hover:bg-surface hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid text-xs h-[24px] p-0 place-items-center w-[24px] text-inherit disabled:cursor-not-allowed! disabled:opacity-0.56",
                                            )}
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
                                    class="focus-visible:outline-offset-0.5 [.document-block[data-kind$='list']_&]:bg-none [.document-block[data-kind$='list']_&]:bg-[position:11px_15px] [.document-block[data-kind$='list']_&]:bg-repeat-y [.document-block[data-kind$='list']_&]:bg-[size:1px_1.75em] [.document-block[data-kind$='list']_&]:pl-[19px] [.document-block[data-kind='checklist']_&]:bg-none [.document-block[data-kind='checklist']_&]:bg-[position:11px_15px] [.document-block[data-kind='checklist']_&]:bg-repeat-y [.document-block[data-kind='checklist']_&]:bg-[size:1px_1.75em] [.document-block[data-kind='checklist']_&]:pl-[19px] [.document-block[data-kind='code']_&]:bg-[color-mix(in_srgb,_var(--surface-subtle)_76%,_var(--surface))] [.document-block[data-kind='code']_&]:text-ink-soft [.document-block[data-kind='code']_&]:text-xs [.document-block[data-kind='code']_&]:tab-[2] [.document-block[data-kind='heading']_&]:text-ink [.document-block[data-kind='heading']_&]:text-sm [.document-block[data-kind='heading']_&]:font-[650] [.document-block[data-kind='heading']_&]:tracking-[-0.02em] [.document-block[data-kind='heading']_&]:min-h-14 [.document-block[data-kind='quote']_&]:border-l-[3px] [.document-block[data-kind='quote']_&]:border-l-[color-mix(in_srgb,_var(--accent)_48%,_var(--line))] [.document-block[data-kind='quote']_&]:text-muted [.document-block[data-kind='quote']_&]:text-xs [.document-block[data-kind='quote']_&]:italic focus-visible:outline-none bg-transparent rounded-[5px] border-0 text-ink-soft block text-xs leading-[1.75] min-h-[78px] outline-none pt-[11px] pr-[13px] pb-3 pl-[15px] resize-y w-full"
                                />
                            </article>
                        )}
                    </Index>
                </Show>
            </div>
            <Show when={exportError()}>
                <p class={cn("document-editor-error", "text-danger text-xs m-0")} role="alert">
                    {exportError()}
                </p>
            </Show>
            <p
                class={cn(
                    "document-editor-footnote",
                    "text-faint text-xs leading-[1.5] m-0 py-0 px-0.5",
                )}
            >
                Changes save with this record and stay inside your workspace.
            </p>
        </section>
    );
}
