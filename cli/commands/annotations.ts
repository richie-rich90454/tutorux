import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  duplicateAnnotationRecord,
  makeAnnotationRecord,
  removeAnnotationRecord,
  updateAnnotationRecord,
  validateAnnotationPriority,
  validateAnnotationType,
  type AnnotationInput,
} from "../../frontend/domain/annotations";
import {
  formatTranscriptTimestampUs,
  parseTranscriptTimestamp,
} from "../../frontend/domain/transcript";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import {
  CliError,
  emit,
  field,
  parseBoundedOption,
  parseIntegerField,
  requiredOption,
  requiredPosition,
} from "./shared";
import { getLiveRecordAtPath, requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";
import { runTranscriptionPlan } from "./transcripts";

export async function runAnnotationCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (action === "plan") return runTranscriptionPlan(path, args, output, true);
  const json = args.flags.has("json");
  if (action === "add") {
    const sessionId = requiredOption(args, "session");
    const start = requiredOption(args, "at");
    const content = args.options.get("text");
    if (content === undefined) throw new CliError("--text is required.");
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const record = makeAnnotationRecord({
      sessionId,
      start,
      end: args.options.get("end") ?? start,
      type: validateAnnotationType(requiredOption(args, "type")),
      priority: validateAnnotationPriority(args.options.get("priority") ?? "normal"),
      title: args.options.get("title") ?? "",
      content,
    });
    const [saved] = await mutateArchive(path, [record]);
    const savedRecord = saved ?? record;
    emit(
      output,
      toPlainRecord(savedRecord),
      `Added ${field(savedRecord, "type")} annotation (${savedRecord.id}).`,
      json,
    );
    return 0;
  }

  if (action === "list") {
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      records = await snapshot.listRecords(
        RecordType.annotation,
        args.flags.has("include-deleted"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const sessionId = args.options.get("session");
    if (sessionId)
      records = records.filter((record) => field(record, "session_id") === sessionId.toLowerCase());
    records.sort((left, right) => {
      const a = parseIntegerField(field(left, "start_time_us"));
      const b = parseIntegerField(field(right, "start_time_us"));
      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
    });
    const rows = records.map(toPlainRecord);
    emit(output, rows, `${rows.length} annotation${rows.length === 1 ? "" : "s"}.`, json);
    return 0;
  }

  if (action === "link" || action === "unlink") {
    const id = requiredPosition(args, 0, "annotation ID");
    const targetType = requiredOption(args, "to").toLowerCase();
    const targetId = requiredOption(args, "target-id");
    const targetRecordType =
      targetType === "asset"
        ? RecordType.assetMetadata
        : targetType === "evidence"
          ? RecordType.evidenceNode
          : null;
    if (targetRecordType === null) {
      throw new CliError("Annotations can link to assets or evidence nodes.");
    }
    const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
    const target = await getLiveRecordAtPath(path, targetRecordType, targetId);
    const annotationSession = field(current, "session_id");
    const targetSession = field(target, "session_id");
    if (targetSession && annotationSession !== targetSession) {
      throw new CliError("An annotation cannot link to a record from a different session.");
    }
    const fieldName = targetType === "asset" ? "linked_asset_ids" : "linked_evidence_ids";
    const linked = new Set(
      field(current, fieldName)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (action === "link") linked.add(targetId.toLowerCase());
    else linked.delete(targetId.toLowerCase());
    const fields = new Map(current.fields);
    fields.set(fieldName, [...linked].join(","));
    const updated = { ...current, fields };
    const [saved] = await mutateArchive(path, [updated]);
    emit(
      output,
      toPlainRecord(saved ?? updated),
      action === "link" ? "Annotation link added." : "Annotation link removed.",
      json,
    );
    return 0;
  }

  if (action === "merge") {
    const ids = args.positionals;
    if (ids.length < 2) throw new CliError("Provide at least two annotation IDs to merge.");
    const uniqueIds = new Set(ids.map((value) => value.toLowerCase()));
    if (uniqueIds.size !== ids.length)
      throw new CliError("Each annotation ID may appear only once in a merge.");
    const snapshot = await openForCommand(path);
    let annotations: ArchiveRecord[];
    try {
      annotations = [];
      for (const id of ids) {
        const record = await snapshot.getRecord(RecordType.annotation, id);
        if (!record || field(record, "_deleted") === "true") {
          throw new CliError(`Annotation was not found: ${id}`);
        }
        annotations.push(record);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const first = annotations[0]!;
    const sessionId = field(first, "session_id");
    const type = field(first, "type");
    const priority = field(first, "priority");
    const contents: string[] = [];
    const titles: string[] = [];
    const mergedLinks = new Map<string, Set<string>>([
      ["linked_asset_ids", new Set()],
      ["linked_evidence_ids", new Set()],
      ["source_segment_ids", new Set()],
    ]);
    let latestEnd = parseIntegerField(field(first, "end_time_us"));
    let previousStart = -1n;
    for (const record of annotations) {
      if (field(record, "session_id") !== sessionId) {
        throw new CliError("All annotations must belong to the same session.");
      }
      if (field(record, "type") !== type || field(record, "priority") !== priority) {
        throw new CliError("Annotations must have the same type and priority to merge.");
      }
      const start = parseIntegerField(field(record, "start_time_us"));
      if (start < previousStart) throw new CliError("Provide annotations in chronological order.");
      previousStart = start;
      latestEnd =
        latestEnd > parseIntegerField(field(record, "end_time_us"))
          ? latestEnd
          : parseIntegerField(field(record, "end_time_us"));
      contents.push(field(record, "content"));
      const title = field(record, "title");
      if (title && !titles.includes(title)) titles.push(title);
      for (const [key, values] of mergedLinks) {
        for (const value of field(record, key)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)) {
          values.add(value);
        }
      }
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const mergedFields = new Map(first.fields);
    mergedFields.set("content", contents.join(args.options.get("separator") ?? "\n"));
    mergedFields.set("start_time_us", parseIntegerField(field(first, "start_time_us")).toString());
    mergedFields.set("end_time_us", latestEnd.toString());
    mergedFields.set("merged_titles", titles.join("\n"));
    mergedFields.set("source_annotation_ids", ids.map((value) => value.toLowerCase()).join(","));
    for (const [key, values] of mergedLinks) mergedFields.set(key, [...values].join(","));
    mergedFields.set("updated_at_us", timestamp);
    const changes: ArchiveRecord[] = [{ ...first, fields: mergedFields }];
    for (const record of annotations.slice(1)) {
      changes.push(removeAnnotationRecord(record));
    }
    const [saved] = await mutateArchive(path, changes);
    const resultRecord = saved ?? { ...first, fields: mergedFields };
    emit(output, toPlainRecord(resultRecord), `Merged ${annotations.length} annotations.`, json);
    return 0;
  }

  const id = requiredPosition(args, 0, "annotation ID");
  if (action === "history" || action === "restore") {
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.annotation, id, limit);
      if (history.length === 0) throw new CliError(`Annotation was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toPlainRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No annotation revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Annotation history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      const timestamp = (BigInt(Date.now()) * 1000n).toString();
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestamp);
      fields.set("human_edited_at_us", timestamp);
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored]);
      emit(
        output,
        toPlainRecord(saved ?? restored),
        `Annotation revision ${revision} restored (${(saved ?? restored).id}).`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
  if (action === "split") {
    const before = args.options.get("before");
    const after = args.options.get("after");
    if (before === undefined || after === undefined) {
      throw new CliError("--before and --after are required.");
    }
    if (!before || !after || before + after !== field(current, "content")) {
      throw new CliError(
        "The before and after text must be non-empty and exactly preserve the original annotation.",
      );
    }
    const originalStart = parseIntegerField(field(current, "start_time_us"));
    const originalEnd = parseIntegerField(field(current, "end_time_us"));
    const requestedTime = args.options.get("at");
    if (!requestedTime && originalStart !== originalEnd) {
      throw new CliError("Splitting a time range requires --at within the annotation.");
    }
    const splitTime = requestedTime ? parseTranscriptTimestamp(requestedTime) : originalStart;
    if (
      splitTime < originalStart ||
      splitTime > originalEnd ||
      (originalStart !== originalEnd && (splitTime === originalStart || splitTime === originalEnd))
    ) {
      throw new CliError("The split time must be inside the annotation range.");
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const firstFields = new Map(current.fields);
    firstFields.set("content", before);
    firstFields.set("end_time_us", splitTime.toString());
    firstFields.set("updated_at_us", timestamp);
    const first: ArchiveRecord = { ...current, fields: firstFields };
    const duplicate = duplicateAnnotationRecord(current);
    const secondFields = new Map(duplicate.fields);
    secondFields.set("content", after);
    secondFields.set("start_time_us", splitTime.toString());
    secondFields.set("end_time_us", originalEnd.toString());
    secondFields.set("created_at_us", timestamp);
    secondFields.set("updated_at_us", timestamp);
    const second: ArchiveRecord = { ...duplicate, fields: secondFields };
    const saved = await mutateArchive(path, [first, second]);
    const savedFirst = saved[0] ?? first;
    const savedSecond = saved[1] ?? second;
    emit(
      output,
      { first: toPlainRecord(savedFirst), second: toPlainRecord(savedSecond) },
      `Annotation split into ${savedFirst.id} and ${savedSecond.id}.`,
      json,
    );
    return 0;
  }
  if (action === "show") {
    emit(output, toPlainRecord(current), `${field(current, "type")} (${current.id})`, json);
    return 0;
  }
  let updated: ArchiveRecord;
  if (action === "remove") {
    updated = removeAnnotationRecord(current);
  } else if (action === "duplicate") {
    updated = duplicateAnnotationRecord(current);
  } else if (action === "prioritize" || action === "update") {
    const options =
      action === "prioritize"
        ? ["priority"]
        : ["text", "title", "priority", "type", "at", "start", "end"];
    if (!options.some((name) => args.options.has(name))) {
      throw new CliError(`Provide an annotation field to ${action}.`);
    }
    const currentStart = parseIntegerField(field(current, "start_time_us"));
    const currentEnd = parseIntegerField(field(current, "end_time_us"));
    const at = args.options.get("at");
    const input: AnnotationInput = {
      sessionId: args.options.get("session") ?? field(current, "session_id"),
      start: args.options.get("start") ?? at ?? formatTranscriptTimestampUs(currentStart),
      end: args.options.get("end") ?? at ?? formatTranscriptTimestampUs(currentEnd),
      type: validateAnnotationType(args.options.get("type") ?? field(current, "type")),
      priority: validateAnnotationPriority(
        args.options.get("priority") ?? field(current, "priority"),
      ),
      title: args.options.get("title") ?? field(current, "title"),
      content: args.options.get("text") ?? field(current, "content"),
    };
    updated = updateAnnotationRecord(current, input);
  } else {
    throw new CliError(`annotation ${action} is not implemented in the TypeScript CLI yet.`);
  }
  const [saved] = await mutateArchive(path, [updated]);
  emit(
    output,
    toPlainRecord(saved ?? updated),
    `Annotation ${action} completed (${(saved ?? updated).id}).`,
    json,
  );
  return 0;
}
