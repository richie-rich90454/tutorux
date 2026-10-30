import { randomUUID } from "node:crypto";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  JOURNAL_NOTE_BLOCK_KINDS,
  notesEditState,
  updateOwnerNotes,
  type JournalNoteBlock,
  type JournalNoteBlockKind,
} from "../../frontend/domain/records";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { CliError, emit, field, parseBoundedOption, requiredOption } from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

/** Split note text into paragraphs and preserve block IDs for unchanged text, matching the C++ CLI. */
export function reconcileJournalNoteBlocks(
  existing: readonly JournalNoteBlock[],
  text: string,
): JournalNoteBlock[] {
  const paragraphs: string[] = [];
  if (text) {
    let paragraphStart = 0;
    for (let index = 0; index < text.length; ) {
      if (text[index] !== "\n") {
        index += 1;
        continue;
      }
      let nextLine = index + 1;
      while (nextLine < text.length && [" ", "\t", "\r"].includes(text[nextLine]!)) nextLine += 1;
      if (nextLine >= text.length || text[nextLine] !== "\n") {
        index += 1;
        continue;
      }
      if (index > paragraphStart) paragraphs.push(text.slice(paragraphStart, index));
      index = nextLine + 1;
      while (index < text.length && text[index] === "\n") index += 1;
      paragraphStart = index;
    }
    if (paragraphStart < text.length) paragraphs.push(text.slice(paragraphStart));
  }
  if (paragraphs.length > 10_000)
    throw new CliError("A notes document cannot exceed 10,000 blocks.");

  const existingByText = new Map<string, number[]>();
  existing.forEach((block, index) => {
    const matches = existingByText.get(block.text) ?? [];
    matches.push(index);
    existingByText.set(block.text, matches);
  });
  const used = new Set<number>();
  const matches: Array<number | undefined> = paragraphs.map((paragraph) => {
    const index = existingByText.get(paragraph)?.find((candidate) => !used.has(candidate));
    if (index === undefined) return undefined;
    used.add(index);
    return index;
  });
  const unmatchedExisting = existing.flatMap((_, index) => (used.has(index) ? [] : [index]));
  const unmatchedParagraphs = matches.flatMap((match, index) =>
    match === undefined ? [index] : [],
  );
  const paired = Math.min(unmatchedExisting.length, unmatchedParagraphs.length);
  for (let index = 0; index < paired; index += 1) {
    matches[unmatchedParagraphs[index]!] = unmatchedExisting[index];
  }
  return paragraphs.map((paragraph, index) => {
    const matched = matches[index];
    const block = matched === undefined ? undefined : existing[matched];
    return block
      ? { ...block, text: paragraph }
      : { id: randomUUID(), kind: "paragraph" as const, text: paragraph };
  });
}

export async function runJournalDocumentAction(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const action = args.positionals[0] ?? "";
  const id = args.positionals[1]?.toLowerCase();
  if (
    !id ||
    !["show", "update", "add-block", "remove-block", "restore-block", "move-block"].includes(action)
  )
    throw new CliError("Choose a journal document action and provide a document ID.");
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[];
  try {
    let document = await requireLiveRecord(snapshot, RecordType.settings, id);
    if (field(document, "record_role") !== "journal-notes")
      throw new CliError("Journal notes document was not found.");
    const revision = args.options.get("revision");
    if (revision !== undefined) {
      if (action !== "show")
        throw new CliError("--revision is only supported when showing a document.");
      const index = parseBoundedOption(revision, "revision", -1, 1, 10_000) - 1;
      const history = await snapshot.getRecordHistory(RecordType.settings, id, index + 1);
      if (!history[index]) throw new CliError("Document revision was not found.");
      document = history[index]!;
    }
    const state = notesEditState(document);
    if (!state.editable) throw new CliError("This document uses unsupported structured notes.");
    const blocks = state.blocks.map((block) => ({ ...block }));
    if (action === "show") {
      const shown = {
        document_id: document.id,
        entry_id: field(document, "entry_id"),
        session_id: field(document, "session_id"),
        revision: document.revision.toString(),
        text: blocks.map((block) => block.text).join("\n"),
        blocks_json: JSON.stringify(
          blocks.map((block) => ({ id: block.id, kind: block.kind, text: block.text })),
        ),
        created_at_us: field(document, "created_at_us"),
        updated_at_us: field(document, "updated_at_us"),
        blocks,
      };
      emit(output, shown, blocks.map((block) => block.text).join("\n"), args.flags.has("json"));
      return 0;
    }
    type Removed = { block: JournalNoteBlock; index: number };
    const removed: Removed[] = [];
    const count = parseBoundedOption(
      field(document, "removed_block_count") || undefined,
      "removed block count",
      0,
      0,
      256,
    );
    for (let index = 0; index < count; index++) {
      const prefix = `removed_block_${index}_`;
      const blockId = field(document, `${prefix}id`);
      const kind = field(document, `${prefix}kind`);
      const position = field(document, `${prefix}index`);
      if (
        !blockId ||
        !(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind) ||
        !/^\d+$/u.test(position)
      )
        throw new CliError("Removed block recovery data is invalid.");
      removed.push({
        block: {
          id: blockId,
          kind: kind as JournalNoteBlockKind,
          text: field(document, `${prefix}text`),
        },
        index: Number(position),
      });
    }
    if (!removed.length && field(document, "last_removed_block_id")) {
      const kind = field(document, "last_removed_block_kind");
      const index = field(document, "last_removed_block_index");
      if (!(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind) || !/^\d+$/u.test(index))
        throw new CliError("Legacy block recovery data is invalid.");
      removed.push({
        block: {
          id: field(document, "last_removed_block_id"),
          kind: kind as JournalNoteBlockKind,
          text: field(document, "last_removed_block_text"),
        },
        index: Number(index),
      });
    }
    const readKind = (): JournalNoteBlockKind => {
      const kind = requiredOption(args, "kind");
      if (!(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind))
        throw new CliError("Unsupported note block kind.");
      return kind as JournalNoteBlockKind;
    };
    if (action === "add-block") {
      const index = parseBoundedOption(
        args.options.get("block-index"),
        "block-index",
        blocks.length,
        0,
        blocks.length,
      );
      blocks.splice(index, 0, {
        id: randomUUID(),
        kind: readKind(),
        text: requiredOption(args, "text"),
      });
    } else if (action === "remove-block") {
      const index = blocks.findIndex((block) => block.id === requiredOption(args, "block-id"));
      if (index < 0) throw new CliError("Note block was not found.");
      if (removed.length >= 256)
        throw new CliError("Restore a removed block before deleting more.");
      removed.push({ block: blocks.splice(index, 1)[0]!, index });
    } else if (action === "restore-block") {
      const blockId = requiredOption(args, "block-id");
      const last = removed.at(-1);
      if (!last || last.block.id !== blockId)
        throw new CliError("Restore removed note blocks in reverse order.");
      if (blocks.some((block) => block.id === blockId))
        throw new CliError("The block is already present.");
      removed.pop();
      blocks.splice(Math.min(last.index, blocks.length), 0, last.block);
    } else if (action === "move-block") {
      if (!blocks.length) throw new CliError("There are no note blocks to move.");
      const from = parseBoundedOption(args.options.get("from"), "from", -1, 0, blocks.length - 1);
      const to = parseBoundedOption(args.options.get("to"), "to", -1, 0, blocks.length - 1);
      if (from < 0 || to < 0) throw new CliError("--from and --to are required.");
      blocks.splice(to, 0, blocks.splice(from, 1)[0]!);
    } else if (args.options.has("block-id")) {
      const block = blocks.find((item) => item.id === requiredOption(args, "block-id"));
      if (!block) throw new CliError("Note block was not found.");
      block.text = requiredOption(args, "text");
      if (args.options.has("kind")) block.kind = readKind();
    } else if (args.options.has("text")) {
      blocks.splice(0, blocks.length, ...reconcileJournalNoteBlocks(blocks, args.options.get("text")!));
    } else {
      throw new CliError("Provide --text TEXT, optionally with --block-id ID.");
    }
    const sessionId = field(document, "session_id");
    const ownerId = sessionId || field(document, "entry_id");
    const owner = await requireLiveRecord(
      snapshot,
      sessionId ? RecordType.session : RecordType.settings,
      ownerId,
    );
    changes = updateOwnerNotes(owner, document, blocks);
    const updated = changes.find((record) => record.id === document.id);
    if (!updated) throw new CliError("Unable to update the notes document.");
    const fields = new Map(updated.fields);
    for (const key of fields.keys())
      if (key.startsWith("removed_block_") || key.startsWith("last_removed_block_"))
        fields.delete(key);
    fields.set("removed_block_count", String(removed.length));
    removed.forEach((item, index) => {
      const prefix = `removed_block_${index}_`;
      fields.set(`${prefix}id`, item.block.id);
      fields.set(`${prefix}kind`, item.block.kind);
      fields.set(`${prefix}text`, item.block.text);
      fields.set(`${prefix}index`, String(item.index));
    });
    const last = removed.at(-1);
    if (last) {
      fields.set("last_removed_block_id", last.block.id);
      fields.set("last_removed_block_kind", last.block.kind);
      fields.set("last_removed_block_text", last.block.text);
      fields.set("last_removed_block_index", String(last.index));
    }
    const replacement = { ...updated, fields };
    changes = changes.map((record) => (record.id === updated.id ? replacement : record));
  } finally {
    await closeSnapshot(snapshot);
  }
  const saved = await mutateArchive(path, changes, generation);
  const savedDocument =
    saved.find((record) => record.id === id) ??
    changes.find((record) => record.id === id) ??
    changes[0]!;
  const result = {
    document_id: savedDocument.id,
    entry_id: field(savedDocument, "entry_id"),
    revision: savedDocument.revision.toString(),
    status: "saved",
  };
  emit(output, result, "Journal notes document updated.", args.flags.has("json"));
  return 0;
}
