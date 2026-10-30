import { resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { readAssetBytes } from "../../frontend/domain/assets";
import {
  guideDraftFromRecord,
  guideRecordsWithEntryLinks,
  makeGuideRecord,
  renderGuideHtml,
  renderGuideMarkdown,
  validateGuideForExport,
  type GuideExportImage,
} from "../../frontend/domain/guides";
import {
  guideImageIds,
  renderGuideDocx,
  serializeGuideJson,
} from "../../frontend/domain/guide-export";
import { renderGuidePdf } from "../../frontend/domain/guide-pdf";
import { restoreRecordFromTrash } from "../../frontend/domain/records";
import { decodeGuideWebp } from "../guide-pdf-images";
import {
  closeSnapshot,
  mutateArchive,
  openForCommand,
  writeBytesAtomically,
  writeTextAtomically,
} from "./archive-io";
import { moveGuideToTrash, readGuideEntryScope, readGuideScope } from "./guide-helpers";
import { CliError, emit, field, parseBoundedOption, sameFileIdentity } from "./shared";
import { requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function guideValidateAction(
  path: string,
  id: string,
  args: ParsedArguments,
  output: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await openForCommand(path);
  try {
    const index = parseBoundedOption(args.options.get("revision"), "revision", 0, 0, 10_000);
    const history = await snapshot.getRecordHistory(RecordType.guide, id, index + 1);
    const record = history[index];
    if (!record || field(record, "_deleted") === "true")
      throw new CliError("Study guide revision was not found.");
    let error = "";
    try {
      const draft = guideDraftFromRecord(record);
      const scope = draft.sessionId
        ? await readGuideScope(snapshot, draft.sessionId)
        : await readGuideEntryScope(snapshot, draft.entryId ?? "");
      makeGuideRecord(draft, scope, record);
      validateGuideForExport(record, scope);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Guide validation failed.";
    }
    const report = { guide_id: id, revision: index, valid: !error, error };
    emit(
      output,
      report,
      error
        ? `Guide validation failed: ${error}`
        : "Guide structure and source references are valid.",
      json,
    );
    return error ? 2 : 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function guideCompareAction(
  path: string,
  id: string,
  output: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await openForCommand(path);
  try {
    const history = await snapshot.getRecordHistory(RecordType.guide, id, 2);
    const current = history[0];
    const previous = history[1];
    if (!current || !previous)
      throw new CliError("The guide needs a previous revision to compare.");
    const result = {
      current_title: field(current, "title"),
      previous_title: field(previous, "title"),
      current_revision: "0",
      previous_revision: "1",
      current_markdown: renderGuideMarkdown(current),
      previous_markdown: renderGuideMarkdown(previous),
    };
    emit(
      output,
      result,
      `Revision 0: ${result.current_title}\nRevision 1: ${result.previous_title}\n\n${result.previous_markdown}`,
      json,
    );
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function guideShowOrExportAction(
  action: string,
  path: string,
  id: string,
  args: ParsedArguments,
  output: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await openForCommand(path);
  let record: ArchiveRecord;
  const images = new Map<string, GuideExportImage>();
  const format = (args.options.get("format") ?? "markdown").toLowerCase();
  if (action === "export" && !["markdown", "md", "html", "json", "docx", "pdf"].includes(format)) {
    await closeSnapshot(snapshot);
    throw new CliError("Guide export format must be markdown, html, json, docx, or pdf.");
  }
  try {
    const index = parseBoundedOption(args.options.get("revision"), "revision", 0, 0, 10000);
    if (index === 0) record = await requireLiveRecord(snapshot, RecordType.guide, id);
    else {
      const history = await snapshot.getRecordHistory(RecordType.guide, id, index + 1);
      if (!history[index]) throw new CliError(`Guide history index ${index} was not found.`);
      record = history[index]!;
    }
    if (action === "export" && (format === "html" || format === "docx" || format === "pdf")) {
      for (const assetId of guideImageIds(record)) {
        const metadata = await requireLiveRecord(snapshot, RecordType.assetMetadata, assetId);
        const mimeType = field(metadata, "mime_type");
        if (
          !["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(mimeType)
        ) {
          throw new CliError(`Guide image ${assetId} has an unsupported image format.`);
        }
        images.set(assetId, {
          assetId,
          mimeType,
          bytes: await readAssetBytes(snapshot, metadata),
        });
      }
    }
    if (action === "export") {
      const draft = guideDraftFromRecord(record);
      const scope = draft.sessionId
        ? await readGuideScope(snapshot, draft.sessionId)
        : await readGuideEntryScope(snapshot, draft.entryId ?? "");
      try {
        validateGuideForExport(record, scope);
      } catch (cause) {
        throw new CliError(cause instanceof Error ? cause.message : "Guide validation failed.");
      }
    }
  } finally {
    await closeSnapshot(snapshot);
  }
  if (action === "show") {
    if (json) emit(output, toPlainRecord(record), "", true);
    else output.stdout(renderGuideMarkdown(record));
    return 0;
  }
  const outputPath = args.options.get("output");
  if (!outputPath) throw new CliError("--output is required.");
  const destination = resolve(outputPath);
  if (await sameFileIdentity(destination, path))
    throw new CliError("Guide output cannot replace its source archive.");
  if (format === "docx") await writeBytesAtomically(destination, renderGuideDocx(record, images));
  else if (format === "pdf")
    await writeBytesAtomically(destination, await renderGuidePdf(record, images, decodeGuideWebp));
  else {
    const contents =
      format === "html"
        ? renderGuideHtml(record, images)
        : format === "json"
          ? serializeGuideJson(record)
          : renderGuideMarkdown(record);
    await writeTextAtomically(destination, contents);
  }
  emit(
    output,
    { id: record.id, output: destination, format },
    `Exported study guide to ${destination}.`,
    json,
  );
  return 0;
}

export async function guideHistoryAction(
  path: string,
  id: string,
  args: ParsedArguments,
  output: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await openForCommand(path);
  try {
    const records = await snapshot.getRecordHistory(
      RecordType.guide,
      id,
      parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000),
    );
    const rows = records.map(toPlainRecord);
    emit(output, rows, `${rows.length} guide revision${rows.length === 1 ? "" : "s"}.`, json);
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

export async function guideTrashAction(
  action: string,
  path: string,
  id: string,
  output: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await openForCommand(path);
  let record: ArchiveRecord | null;
  let entries: ArchiveRecord[];
  try {
    record = await snapshot.getRecord(RecordType.guide, id);
    if (!record || (action !== "restore" && field(record, "_deleted") === "true")) {
      throw new CliError(`Study guide ${id} was not found.`);
    }
    if (action === "restore" && field(record, "_deleted") !== "true") {
      throw new CliError(`Study guide ${id} is not in Trash.`);
    }
    entries = await snapshot.listRecords(RecordType.settings);
  } finally {
    await closeSnapshot(snapshot);
  }
  const changed = action === "restore" ? restoreRecordFromTrash(record) : moveGuideToTrash(record);
  await mutateArchive(path, guideRecordsWithEntryLinks(changed, record, entries));
  emit(
    output,
    { id: changed.id, deleted: action !== "restore" },
    action === "restore" ? "Study guide restored." : "Study guide moved to Trash.",
    json,
  );
  return 0;
}
