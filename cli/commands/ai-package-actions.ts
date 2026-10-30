import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { createAiPackageRecord } from "../../frontend/ai/package";
import { createAiGuideProposal } from "../../frontend/ai/response";
import { guideRecordsWithEntryLinks, makeGuideRecord } from "../../frontend/domain/guides";
import type { AiActionOutcome } from "./ai-actions";
import { exportAiPackage } from "../ai-export";
import { writeBytesAtomically } from "./archive-io";
import { readGuideScope } from "./guide-helpers";
import {
  CliError,
  field,
  requiredOption,
  requiredPosition,
  sameFileIdentity,
  timestampNow,
} from "./shared";
import { toPlainRecord, requireLiveRecord } from "./record-helpers";
import type { ParsedArguments } from "./shared";

export async function aiPackageAction(
  path: string,
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const format = args.options.get("format") ?? "json";
  if (!["json", "markdown", "md", "parts", "zip"].includes(format))
    throw new CliError("Package format must be json, markdown, parts, or zip.");
  const mode = args.options.get("mode") ?? "manual";
  if (mode !== "manual" && mode !== "local")
    throw new CliError("Package mode must be manual or local.");
  if (mode === "local" && format !== "json")
    throw new CliError("Local packages require JSON format.");
  if (format === "zip" && !args.flags.has("confirm-sensitive"))
    throw new CliError(
      "ZIP packages include session materials; use --confirm-sensitive to export them.",
    );
  const summary = await createAiPackageRecord(
    snapshot,
    requiredOption(args, "session").toLowerCase(),
    args.options.get("template") ?? "auto",
    (args.options.get("image-ids") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const packageJob = {
    ...summary.job,
    fields: new Map(summary.job.fields).set("requested_mode", mode),
  };
  const destination = args.options.get("output");
  if (destination) {
    if (await sameFileIdentity(resolve(destination), path))
      throw new CliError("Package output cannot replace its source archive.");
    await writeBytesAtomically(
      resolve(destination),
      await exportAiPackage(snapshot, summary.job, format),
    );
  }
  return {
    changes: [packageJob],
    result: {
      job_id: summary.job.id,
      session_id: summary.sessionId,
      template_id: summary.guideTemplateId,
      content_hash: summary.contentHash,
      package_bytes: summary.byteLength,
      transcript_segments: summary.transcriptCount,
      annotations: summary.annotationCount,
      evidence: summary.evidenceCount,
      assets: summary.assetCount,
      output: destination ? resolve(destination) : "",
    },
    message: `AI package ${summary.job.id} prepared. SHA-256: ${summary.contentHash}.`,
  };
}

export async function aiJobsAction(snapshot: ArchiveSnapshot): Promise<AiActionOutcome> {
  const jobs = await snapshot.listRecordMetadata(RecordType.aiJob);
  return {
    result: jobs.map(toPlainRecord),
    message: jobs.length
      ? jobs.map((job) => `${job.id}  ${field(job, "status")}  ${field(job, "mode")}`).join("\n")
      : "No AI jobs stored in this archive.",
  };
}

export async function aiCancelAction(
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const job = await requireLiveRecord(
    snapshot,
    RecordType.aiJob,
    requiredPosition(args, 0, "AI job ID"),
  );
  const fields = new Map(job.fields);
  fields.set("status", "cancelled");
  const changed: ArchiveRecord = { ...job, fields };
  return {
    changes: [changed],
    result: toPlainRecord(changed),
    message: `AI job ${job.id} cancelled.`,
  };
}

export async function aiImportAction(
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const sessionId = requiredOption(args, "session").toLowerCase();
  const scope = await readGuideScope(snapshot, sessionId);
  const input = requiredOption(args, "input");
  const bytes = await readFile(resolve(input));
  if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024)
    throw new CliError("Response must be between 1 byte and 16 MiB.");
  const responseText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let responseTemplate = "general";
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "template_id" in parsed &&
      typeof parsed.template_id === "string"
    )
      responseTemplate = parsed.template_id;
  } catch {
    /* Unstructured responses are preserved for review. */
  }
  const proposal = createAiGuideProposal(
    responseText,
    sessionId,
    args.options.get("template") ?? responseTemplate,
  );
  if (args.options.has("title")) proposal.draft.title = args.options.get("title")!;
  let guide: ArchiveRecord;
  let sourceValidation = "passed";
  try {
    guide = makeGuideRecord(proposal.draft, scope);
  } catch {
    sourceValidation = "failed";
    proposal.warnings.push(
      "Some source links need correction; the original response was kept as editable text.",
    );
    guide = makeGuideRecord(
      {
        title: "AI response — review required",
        sessionId,
        templateId: proposal.draft.templateId,
        sections: [
          {
            id: randomUUID(),
            heading: "Generated response — review required",
            blocks: [
              {
                kind: "paragraph",
                text: responseText,
                sourceIds: "",
                stale: false,
                origin: "ai-generated",
              },
            ],
          },
        ],
      },
      scope,
    );
  }
  if (
    sourceValidation === "passed" &&
    !proposal.draft.sections.some((section) =>
      section.blocks.some((block) => block.sourceIds.trim()),
    )
  )
    sourceValidation = "missing-evidence";
  const status =
    proposal.schemaValid && sourceValidation === "passed"
      ? "response-imported"
      : "response-needs-correction";
  const job: ArchiveRecord = {
    type: RecordType.aiJob,
    id: randomUUID(),
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["session_id", sessionId],
      ["mode", "manual"],
      ["status", status],
      ["schema_valid", String(proposal.schemaValid)],
      ["source_validation", sourceValidation],
      ["import_warnings", proposal.warnings.join("\n")],
      ["guide_id", guide.id],
      ["original_filename", basename(input)],
      ["content_hash", createHash("sha256").update(bytes).digest("hex")],
      ["created_at_us", timestampNow()],
    ]),
    blob: new Uint8Array(bytes),
  };
  return {
    changes: guideRecordsWithEntryLinks(guide, null, scope.records).concat(job),
    result: {
      job_id: job.id,
      guide_id: guide.id,
      status,
      schema_valid: proposal.schemaValid,
      source_validation: sourceValidation,
      warnings: proposal.warnings,
    },
    message: `Imported response as unapproved guide ${guide.id} (${status}).`,
  };
}
