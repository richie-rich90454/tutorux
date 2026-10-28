import { For, Index, Show, createSignal, type JSX } from "solid-js";
import {
  JOURNAL_NOTE_BLOCK_KINDS,
  MAX_JOURNAL_NOTE_BLOCKS,
  type JournalNoteBlock,
  type JournalNoteBlockKind,
} from "./domain/records";
import {
  DOCX_MIME,
  renderNoteDocx,
  renderNoteHtml,
  renderNoteMarkdown,
} from "./domain/document-export";
import { platform } from "@platform";
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

export function DocumentEditor(props: {
  label: string;
  blocks: readonly JournalNoteBlock[];
  onChange(blocks: JournalNoteBlock[]): void;
}): JSX.Element {
  const [nextKind, setNextKind] = createSignal<JournalNoteBlockKind>("paragraph");
  const [undoStack, setUndoStack] = createSignal<JournalNoteBlock[][]>([]);
  const [redoStack, setRedoStack] = createSignal<JournalNoteBlock[][]>([]);
  const [exporting, setExporting] = createSignal(false);
  const [exportError, setExportError] = createSignal("");
  let editorElement: HTMLElement | undefined;
  let lastTextEdit: { id: string; time: number } | undefined;
  const editorId = (index: number): string =>
    `document-block-kind-${props.label.replace(/\W+/gu, "-").toLowerCase()}-${index}`;

  function changeBlocks(blocks: JournalNoteBlock[], textBlockId?: string): void {
    const now = Date.now();
    const grouped =
      textBlockId && lastTextEdit?.id === textBlockId && now - lastTextEdit.time < 800;
    if (!grouped) setUndoStack((stack) => [...stack.slice(-99), [...props.blocks]]);
    setRedoStack([]);
    lastTextEdit = textBlockId ? { id: textBlockId, time: now } : undefined;
    props.onChange(blocks);
  }

  function update(index: number, change: Partial<JournalNoteBlock>, textEdit = false): void {
    changeBlocks(
      props.blocks.map((block, current) => (current === index ? { ...block, ...change } : block)),
      textEdit ? props.blocks[index]?.id : undefined,
    );
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

  function undo(): void {
    const stack = undoStack();
    const previous = stack.at(-1);
    if (!previous) return;
    setUndoStack(stack.slice(0, -1));
    setRedoStack((current) => [...current.slice(-99), [...props.blocks]]);
    lastTextEdit = undefined;
    props.onChange([...previous]);
  }

  function redo(): void {
    const stack = redoStack();
    const next = stack.at(-1);
    if (!next) return;
    setRedoStack(stack.slice(0, -1));
    setUndoStack((current) => [...current.slice(-99), [...props.blocks]]);
    lastTextEdit = undefined;
    props.onChange([...next]);
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
            character.codePointAt(0)! < 0x20 || '<>:"/\\|?*'.includes(character) ? "_" : character,
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
          html ? renderNoteHtml(title, props.blocks) : renderNoteMarkdown(title, props.blocks),
          html ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
        );
        if (saved)
          platform.notify(`Document exported as ${html ? "HTML" : "Markdown"}.`, "success");
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
            onClick={undo}
            disabled={!undoStack().length}
            title="Undo (Ctrl or Command + Z)"
          >
            Undo
          </button>
          <button
            class="button button-quiet"
            type="button"
            onClick={redo}
            disabled={!redoStack().length}
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
            onChange={(event) => setNextKind(event.currentTarget.value as JournalNoteBlockKind)}
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
                  <span class="document-block-number">{String(index + 1).padStart(2, "0")}</span>
                  <label class="sr-only" for={editorId(index)}>
                    Block {index + 1} type
                  </label>
                  <select
                    id={editorId(index)}
                    value={block().kind}
                    onChange={(event) =>
                      update(index, { kind: event.currentTarget.value as JournalNoteBlockKind })
                    }
                  >
                    <For each={JOURNAL_NOTE_BLOCK_KINDS}>
                      {(kind) => <option value={kind}>{blockLabels[kind]}</option>}
                    </For>
                  </select>
                  <div class="document-block-actions">
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
                  aria-label={index === 0 ? props.label : `${props.label} block ${index + 1}`}
                  value={block().text}
                  placeholder={blockHints[block().kind]}
                  rows={Math.min(8, Math.max(3, block().text.split("\n").length))}
                  spellcheck="true"
                  onInput={(event) => update(index, { text: event.currentTarget.value }, true)}
                  onBlur={() => {
                    lastTextEdit = undefined;
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
