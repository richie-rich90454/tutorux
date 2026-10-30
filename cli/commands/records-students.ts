import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { CliError, emit, field, requiredPosition, timestampNow } from "./shared";
import {
  getLiveRecordAtPath,
  readableStudentRecord,
  requireLiveRecord,
  studentProfileObject,
  toPlainRecord,
  validateStudentProfileField,
} from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runStudentRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number | null> {
  const json = args.flags.has("json");

  if (group === "student" && action === "show") {
    const studentId = requiredPosition(args, 0, "student ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let student: ArchiveRecord;
    try {
      student = await requireLiveRecord(snapshot, RecordType.student, studentId);
    } finally {
      await closeSnapshot(snapshot);
    }
    emit(output, studentProfileObject(student), readableStudentRecord(student), json);
    return 0;
  }

  if (group === "student" && action === "update") {
    const current = await getLiveRecordAtPath(
      path,
      RecordType.student,
      requiredPosition(args, 0, "student ID"),
    );
    const allowedOptions: Readonly<Record<string, string>> = {
      name: "display_name",
      grade: "grade",
      subjects: "subjects",
      objectives: "learning_objectives",
      "learning-objectives": "learning_objectives",
      difficulties: "known_difficulties",
      "demonstrated-improvements": "demonstrated_improvements",
      notes: "tutor_notes",
      "tutor-notes": "tutor_notes",
      "preferred-guide-template": "preferred_guide_template",
    };
    const selectedOptions = Object.entries(allowedOptions).filter(([option]) =>
      args.options.has(option),
    );
    if (selectedOptions.length === 0) {
      throw new CliError("Provide at least one supported student field to update.");
    }
    const fields = new Map(current.fields);
    for (const [option, fieldName] of selectedOptions) {
      fields.set(fieldName, validateStudentProfileField(fieldName, args.options.get(option)!));
    }
    fields.set("updated_at_us", timestampNow());
    const updated = { ...current, fields };
    const [saved] = await mutateArchive(path, [updated]);
    const record = saved ?? updated;
    emit(
      output,
      toPlainRecord(record),
      `Updated student ${field(record, "display_name")} (${record.id}).`,
      json,
    );
    return 0;
  }

  return null;
}
