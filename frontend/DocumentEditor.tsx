import { For, Index, Show, createSignal, type JSX } from "solid-js";
import {
  JOURNAL_NOTE_BLOCK_KINDS,
  MAX_JOURNAL_NOTE_BLOCKS,
  type JournalNoteBlock,
  type JournalNoteBlockKind,
} from "./domain/records";
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
  const editorId = (index: number): string =>
    `document-block-kind-${props.label.replace(/\W+/gu, "-").toLowerCase()}-${index}`;

  function update(index: number, change: Partial<JournalNoteBlock>): void {
    props.onChange(
      props.blocks.map((block, current) => (current === index ? { ...block, ...change } : block)),
    );
  }

  function addBlock(): void {
    props.onChange([...props.blocks, { id: crypto.randomUUID(), kind: nextKind(), text: "" }]);
  }

  function moveBlock(index: number, direction: -1 | 1): void {
    const destination = index + direction;
    if (destination < 0 || destination >= props.blocks.length) return;
    const blocks = [...props.blocks];
    [blocks[index], blocks[destination]] = [blocks[destination]!, blocks[index]!];
    props.onChange(blocks);
  }

  function removeBlock(index: number): void {
    props.onChange(props.blocks.filter((_, current) => current !== index));
  }

  return (
    <section class="document-editor" aria-label="Note document editor">
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
                  onInput={(event) => update(index, { text: event.currentTarget.value })}
                />
              </article>
            )}
          </Index>
        </Show>
      </div>
      <p class="document-editor-footnote">
        Changes save with this record and stay inside your workspace.
      </p>
    </section>
  );
}
