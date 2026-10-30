import { randomUUID } from "node:crypto";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  evidenceSourcesAreCurrent,
  EVIDENCE_RELATIONSHIPS,
  extractSessionEvidence,
  makeEvidenceEdge,
  reviewEvidenceRecord,
  restoreEvidenceEdge,
} from "../../frontend/domain/evidence";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { CliError, emit, field, requiredOption, requiredPosition, timestampNow } from "./shared";
import { requireLiveRecord, toPlainRecord, validateEvidenceText } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runEvidenceCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "extract") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = await extractSessionEvidence(snapshot, session);
    } finally {
      await closeSnapshot(snapshot);
    }
    if (records.length === 0) {
      emit(output, [], "No new evidence was found for this session.", json);
      return 0;
    }
    const saved = await mutateArchive(path, records);
    const rows = saved.map(toPlainRecord);
    emit(
      output,
      rows,
      `Added ${rows.length} evidence item(s). Transcript candidates need human review.`,
      json,
    );
    return 0;
  }

  if (action === "create") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const segmentId = requiredOption(args, "source-segment").toLowerCase();
    const type = validateEvidenceText(requiredOption(args, "type"), "Evidence type", 128);
    const title = validateEvidenceText(requiredOption(args, "title"), "Evidence title", 512);
    const content = validateEvidenceText(
      requiredOption(args, "content"),
      "Evidence content",
      16 * 1024 * 1024,
    );
    if (type.length === 0 || title.length === 0 || content.length === 0) {
      throw new CliError("Evidence needs a type, title, and content.");
    }
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const segment = await requireLiveRecord(snapshot, RecordType.transcriptSegment, segmentId);
      if (field(segment, "session_id") !== sessionId) {
        throw new CliError("Choose a transcript segment from the selected session.");
      }
      const priority = args.options.get("priority") ?? "normal";
      if (!"low normal high critical".split(" ").includes(priority)) {
        throw new CliError("Priority must be low, normal, high, or critical.");
      }
      const createdAt = timestampNow();
      record = {
        type: RecordType.evidenceNode,
        id: randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
          ["session_id", sessionId],
          ["student_id", field(session, "student_id")],
          ["type", type.trim().toLowerCase()],
          ["title", title],
          ["content", content],
          ["priority", priority],
          ["origin", "tutor-authored"],
          ["source_annotation_id", ""],
          ["source_segment_ids", segment.id],
          ["source_segment_revision", segment.revision.toString()],
          ["source_segment_revisions", `${segment.id}=${segment.revision}`],
          ["source_asset_ids", ""],
          ["source_speaker_label", field(segment, "speaker_label")],
          ["start_time_us", field(segment, "start_time_us") || "0"],
          ["end_time_us", field(segment, "end_time_us") || "0"],
          ["verification_state", "needs-review"],
          ["created_at_us", createdAt],
        ]),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [record]);
    emit(output, toPlainRecord(saved ?? record), "Evidence added to review.", json);
    return 0;
  }

  if (action === "list" || action === "review") {
    const sessionId = args.options.get("session")?.toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      let records = await snapshot.listRecords(
        RecordType.evidenceNode,
        args.flags.has("include-deleted"),
      );
      if (sessionId)
        records = records.filter((record) => field(record, "session_id") === sessionId);
      if (action === "review") {
        records = records.filter(
          (record) => field(record, "verification_state") !== "human-verified",
        );
      }
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length === 0
          ? action === "review"
            ? "No evidence needs review."
            : "No evidence found."
          : `${rows.length} evidence item${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "graph") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const nodes = (await snapshot.listRecords(RecordType.evidenceNode)).filter(
        (node) => field(node, "session_id").toLowerCase() === sessionId,
      );
      const nodeIds = new Set(nodes.map((node) => node.id.toLowerCase()));
      for (const node of nodes) {
        if (!field(node, "content")) {
          throw new CliError(`Evidence ${node.id} needs a statement.`);
        }
      }
      const edges = await snapshot.listRecords(RecordType.evidenceEdge);
      const contradictions = new Map<
        string,
        { first_evidence_id: string; second_evidence_id: string }
      >();
      let edgeCount = 0;
      for (const edge of edges) {
        const from = field(edge, "from_id").toLowerCase();
        const to = field(edge, "to_id").toLowerCase();
        const fromHere = nodeIds.has(from);
        const toHere = nodeIds.has(to);
        if (!fromHere && !toHere) continue;
        if (!fromHere || !toHere) {
          throw new CliError(
            "An evidence relationship connects a session node to a missing or cross-session node.",
          );
        }
        const relationship = field(edge, "relationship");
        if (from === to || !(EVIDENCE_RELATIONSHIPS as readonly string[]).includes(relationship)) {
          throw new CliError(`Evidence relationship ${edge.id} has invalid endpoints or type.`);
        }
        edgeCount += 1;
        if (relationship === "contradicts") {
          const [first, second] = [from, to].sort();
          contradictions.set(`${first}:${second}`, {
            first_evidence_id: first!,
            second_evidence_id: second!,
          });
        }
      }
      const pairs = [...contradictions.values()].sort(
        (a, b) =>
          a.first_evidence_id.localeCompare(b.first_evidence_id) ||
          a.second_evidence_id.localeCompare(b.second_evidence_id),
      );
      const report = {
        session_id: sessionId,
        node_count: nodes.length,
        edge_count: edgeCount,
        contradiction_count: pairs.length,
        contradictions: pairs,
        valid: true,
      };
      const details = pairs
        .map((pair) => `  ${pair.first_evidence_id} contradicts ${pair.second_evidence_id}`)
        .join("\n");
      emit(
        output,
        report,
        `Evidence graph: ${nodes.length} node(s), ${edgeCount} relationship(s), ${pairs.length} explicit contradiction(s).${details ? `\n${details}` : ""}`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "edges") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const nodes = await snapshot.listRecords(RecordType.evidenceNode);
      const nodeById = new Map(
        nodes
          .filter((node) => field(node, "session_id") === sessionId)
          .map((node) => [node.id, node]),
      );
      const edges = (await snapshot.listRecords(RecordType.evidenceEdge)).filter(
        (edge) => nodeById.has(field(edge, "from_id")) && nodeById.has(field(edge, "to_id")),
      );
      const rows = edges.map((edge) => {
        const from = nodeById.get(field(edge, "from_id"))!;
        const to = nodeById.get(field(edge, "to_id"))!;
        return {
          ...toPlainRecord(edge),
          from_title: field(from, "title") || field(from, "type") || "Evidence",
          to_title: field(to, "title") || field(to, "type") || "Evidence",
        };
      });
      emit(output, rows, `${rows.length} evidence relationship(s).`, json);
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "link") {
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      edge = await makeEvidenceEdge(
        snapshot,
        requiredOption(args, "from"),
        requiredOption(args, "to"),
        requiredOption(args, "relationship"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship created.", json);
    return 0;
  }

  if (action === "restore") {
    const id = requiredPosition(args, 0, "Evidence ID or relationship ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[] = [];
    try {
      const node = await snapshot.getRecord(RecordType.evidenceNode, id);
      if (node && field(node, "_deleted") === "true") {
        const fields = new Map(node.fields);
        fields.delete("_deleted");
        fields.delete("_trash_group_id");
        fields.set("restored_at_us", timestampNow());
        changes.push({ ...node, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge, true);
        for (const edge of edges) {
          if (field(edge, "_deleted") !== "true" || field(edge, "_trash_group_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.delete("_deleted");
          edgeFields.delete("_trash_group_id");
          edgeFields.set("restored_at_us", timestampNow());
          changes.push({ ...edge, fields: edgeFields });
        }
      } else {
        const edge = await snapshot.getRecord(RecordType.evidenceEdge, id);
        if (!edge || field(edge, "_deleted") !== "true") {
          throw new CliError(`Evidence ${id} was not found in Trash.`);
        }
        changes = [await restoreEvidenceEdge(snapshot, edge)];
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes);
    const result = saved.find((record) => record.id.toLowerCase() === id) ?? changes[0]!;
    emit(output, toPlainRecord(result), `Evidence restore complete.`, json);
    return 0;
  }

  if (
    action === "show" ||
    action === "update" ||
    action === "approve" ||
    action === "reject" ||
    action === "verify" ||
    action === "delete"
  ) {
    const id = requiredPosition(args, 0, "Evidence ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let current: ArchiveRecord;
    let changes: ArchiveRecord[] = [];
    try {
      const record = await snapshot.getRecord(RecordType.evidenceNode, id);
      if (!record || field(record, "_deleted") === "true") {
        throw new CliError(`Evidence ${id} was not found in this archive.`);
      }
      current = record;
      if (action === "show") {
        emit(output, toPlainRecord(current), `Evidence ${id}.`, json);
        return 0;
      }
      if (action === "verify") {
        const valid = await evidenceSourcesAreCurrent(snapshot, current);
        emit(
          output,
          { evidence_id: id, source_valid: valid },
          valid
            ? "Evidence sources are current."
            : "Evidence sources are missing, stale, or cross-session.",
          json,
        );
        return valid ? 0 : 2;
      }
      if (action === "approve" || action === "reject") {
        changes = [
          await reviewEvidenceRecord(
            snapshot,
            current,
            action === "approve" ? "human-verified" : "rejected",
          ),
        ];
      } else if (action === "update") {
        const fields = new Map(current.fields);
        const updates = ["title", "content", "type", "priority"] as const;
        let changed = false;
        for (const key of updates) {
          const value = args.options.get(key);
          if (value === undefined) continue;
          const maximumBytes = key === "content" ? 16 * 1024 * 1024 : key === "title" ? 512 : 128;
          const clean = validateEvidenceText(value, `Evidence ${key}`, maximumBytes);
          if (clean.length === 0) throw new CliError(`Evidence ${key} cannot be empty.`);
          fields.set(key, key === "type" ? clean.trim().toLowerCase() : clean);
          changed = true;
        }
        if (!changed) throw new CliError("Provide a title, content, type, or priority to update.");
        const priority = args.options.get("priority");
        if (priority && !"low normal high critical".split(" ").includes(priority)) {
          throw new CliError("Priority must be low, normal, high, or critical.");
        }
        fields.set("verification_state", "needs-review");
        fields.set("reviewed_at_us", "");
        fields.set("updated_at_us", timestampNow());
        changes = [{ ...current, fields }];
      } else if (action === "delete") {
        const deletedAt = timestampNow();
        const fields = new Map(current.fields);
        fields.set("_deleted", "true");
        fields.set("_trash_group_id", id);
        fields.set("deleted_at_us", deletedAt);
        changes.push({ ...current, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge);
        for (const edge of edges) {
          if (field(edge, "from_id") !== id && field(edge, "to_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.set("_deleted", "true");
          edgeFields.set("_trash_group_id", id);
          edgeFields.set("deleted_at_us", deletedAt);
          changes.push({ ...edge, fields: edgeFields });
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes);
    const result = saved.find((record) => record.type === RecordType.evidenceNode) ?? changes[0]!;
    emit(output, toPlainRecord(result), `Evidence ${action} complete.`, json);
    return 0;
  }

  if (action === "unlink") {
    const id = requiredPosition(args, 0, "Evidence relationship ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      const current = await snapshot.getRecord(RecordType.evidenceEdge, id);
      if (!current || field(current, "_deleted") === "true") {
        throw new CliError(`Evidence relationship ${id} was not found.`);
      }
      const fields = new Map(current.fields);
      fields.set("_deleted", "true");
      fields.set("_trash_group_id", id);
      fields.set("deleted_at_us", timestampNow());
      edge = { ...current, fields };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship moved to Trash.", json);
    return 0;
  }

  throw new CliError(`evidence ${action} is not implemented in the TypeScript CLI yet.`);
}
