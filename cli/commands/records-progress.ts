import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  canonicalizeProgressUuid,
  decodeStudentProgress,
  isStudentProgressClassification,
  normalizeStudentProgressSkill,
  reviewStudentProgressRecord,
  validateProgressEvidence,
} from "../../frontend/domain/student-progress";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import {
  CliError,
  emit,
  field,
  parseIntegerField,
  requiredOption,
  requiredPosition,
} from "./shared";
import { requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runProgressRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number | null> {
  const json = args.flags.has("json");

  if (group === "student" && (action === "history" || action === "progress")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const snapshot = await openForCommand(path);
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = (await snapshot.listRecords(RecordType.session)).filter(
        (session) =>
          canonicalizeProgressUuid(field(session, "student_id")) ===
          canonicalizeProgressUuid(student.id),
      );
      sessions.sort((left, right) => {
        const a = parseIntegerField(field(right, "started_at_us"));
        const b = parseIntegerField(field(left, "started_at_us"));
        return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
      });

      if (action === "history") {
        const rows = sessions.map(toPlainRecord);
        emit(
          output,
          rows,
          rows.length === 0
            ? `No sessions recorded for ${field(student, "display_name") || "this student"}.`
            : `${rows.length} session${rows.length === 1 ? "" : "s"} in ${field(student, "display_name") || "student"} history.`,
          json,
        );
        return 0;
      }

      const progress = decodeStudentProgress(field(student, "progress_classifications"));
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      const classifications = progress.map((item) => {
        let sourceStatus = "valid";
        try {
          validateProgressEvidence(
            student.id,
            item.evidenceSourceIds,
            sessions,
            evidence,
            item.classification,
          );
        } catch {
          sourceStatus = "invalid-or-unavailable";
        }
        return {
          skill: item.skill,
          classification: item.classification,
          evidence_source_ids: item.evidenceSourceIds.join(","),
          reviewed_by: item.reviewedBy,
          reviewed_at_us: item.reviewedAtUs,
          note: item.note,
          claim_label:
            item.classification === "unverified-improvement"
              ? "UNVERIFIED CLAIM: improvement is not established"
              : "Human-reviewed classification",
          human_reviewed: "true",
          source_status: sourceStatus,
        };
      });
      if (json) {
        emit(
          output,
          { student_id: student.id, sessions: sessions.map(toPlainRecord), classifications },
          `${classifications.length} progress classification(s).`,
          true,
        );
      } else {
        const lines = [
          `Progress classifications for ${field(student, "display_name") || "student"}:`,
        ];
        if (classifications.length === 0) {
          lines.push("  No progress classifications have been human-reviewed.");
        }
        for (const item of classifications) {
          lines.push(
            `  ${item.skill} — ${item.classification}${item.classification === "unverified-improvement" ? " [UNVERIFIED CLAIM: improvement is not established]" : ""}${item.source_status === "valid" ? "" : " [SOURCE REFERENCES INVALID OR UNAVAILABLE]"}`,
            `    Evidence: ${item.evidence_source_ids.split(",").join(", ")}`,
            `    Human review: ${item.reviewed_by} at ${item.reviewed_at_us}`,
          );
          if (item.note) lines.push(`    Note: ${item.note}`);
        }
        lines.push("  Sessions:");
        if (sessions.length === 0) lines.push("    No sessions recorded yet.");
        for (const session of sessions) {
          lines.push(
            `    ${session.id}  ${field(session, "subject")} · ${field(session, "title")}`,
          );
        }
        output.stdout(lines.join("\n"));
      }
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "student" && (action === "progress-review" || action === "progress-edit")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const skill = requiredOption(args, "skill");
    const classificationValue = requiredOption(args, "classification");
    if (!isStudentProgressClassification(classificationValue)) {
      throw new CliError(
        "Classification must be newly-observed, recurring, partial-improvement, demonstrated-mastery, unverified-improvement, or not-revisited.",
      );
    }
    const rawIds = requiredOption(args, "evidence-ids");
    const evidenceSourceIds = rawIds.split(",").map((id) => id.trim().toLocaleLowerCase());
    if (evidenceSourceIds.some((id) => !id)) {
      throw new CliError("Evidence IDs must be a comma-separated list without empty items.");
    }
    const reviewedBy = requiredOption(args, "reviewed-by");
    const note = args.options.get("note") ?? "";
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = await snapshot.listRecords(RecordType.session);
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      updated = reviewStudentProgressRecord(
        student,
        { skill, classification: classificationValue, evidenceSourceIds, reviewedBy, note },
        sessions,
        evidence,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [updated]);
    const savedRecord = saved ?? updated;
    const savedItem = decodeStudentProgress(field(savedRecord, "progress_classifications")).find(
      (item) => normalizeStudentProgressSkill(item.skill) === normalizeStudentProgressSkill(skill),
    );
    if (!savedItem) throw new CliError("The saved progress review could not be read back.");
    emit(
      output,
      {
        skill: savedItem.skill,
        classification: savedItem.classification,
        evidence_source_ids: savedItem.evidenceSourceIds.join(","),
        reviewed_by: savedItem.reviewedBy,
        reviewed_at_us: savedItem.reviewedAtUs,
        note: savedItem.note,
        claim_label:
          savedItem.classification === "unverified-improvement"
            ? "UNVERIFIED CLAIM: improvement is not established"
            : "Human-reviewed classification",
        human_reviewed: "true",
        source_status: "valid",
      },
      `Human-reviewed progress saved for ${savedItem.skill}.`,
      json,
    );
    return 0;
  }

  return null;
}
