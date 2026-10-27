import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { makeGuideRecord } from "../domain/guides";
import type { AiRequestPreview } from "./request";
import {
  AI_RESPONSE_PREVIEW_CHARACTER_LIMIT,
  createAiGuideProposal,
  extractAiResponseText,
  type AiExecutionSummary,
} from "./response";
import type { AiTransportRequest, AiTransportResult } from "../platform/types";

export interface AiExecutionResult {
  job: ArchiveRecord;
  guide: ArchiveRecord;
  summary: AiExecutionSummary;
}

export interface AiExecutionInput {
  packageJob: ArchiveRecord;
  expectedTemplateId: string;
  preview: AiRequestPreview;
  confirmedEndpoint: string;
  confirmedBodyHash: string;
  credential: string;
  session: ArchiveRecord;
  sourceRecords: readonly ArchiveRecord[];
  send: (
    request: AiTransportRequest,
    onChunk: (chunk: Uint8Array) => void,
  ) => Promise<AiTransportResult>;
  onProgress: (responseBytes: number) => void;
}

/** Perform one reviewed request and prepare its unapproved, source-checked guide draft. */
export async function executeAiGeneration(input: AiExecutionInput): Promise<AiExecutionResult> {
  const { preview } = input;
  if (input.confirmedBodyHash !== preview.requestBodyHash) {
    throw new Error("Confirm the exact request body hash before sending.");
  }
  if (input.confirmedEndpoint !== preview.endpoint) {
    throw new Error("Confirm the exact provider endpoint before sending.");
  }
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const transport = await input.send(
    {
      providerId: preview.providerId,
      endpoint: preview.endpoint,
      confirmedEndpoint: input.confirmedEndpoint,
      model: preview.model,
      accept: preview.accept,
      requestBody: preview.requestBody,
      requestBodyHash: preview.requestBodyHash,
      confirmedBodyHash: input.confirmedBodyHash,
      credential: input.credential,
    },
    (chunk) => {
      const copy = chunk.slice();
      chunks.push(copy);
      receivedBytes += copy.byteLength;
      input.onProgress(receivedBytes);
    },
  );
  if (transport.responseBytes !== receivedBytes) {
    throw new Error("The provider response stream was incomplete.");
  }
  const responseBytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    responseBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks.length = 0;

  const responseText = extractAiResponseText(preview.providerId, responseBytes);
  const proposal = createAiGuideProposal(responseText, input.session.id, input.expectedTemplateId);
  const warnings = [...proposal.warnings];
  let sourceValidation: AiExecutionSummary["sourceValidation"];
  let guide: ArchiveRecord;
  try {
    guide = makeGuideRecord(proposal.draft, {
      session: input.session,
      records: [...input.sourceRecords],
    });
    const hasReferences = proposal.draft.sections.some((section) =>
      section.blocks.some((block) => block.sourceIds.trim().length > 0),
    );
    sourceValidation = hasReferences ? "passed" : "missing-evidence";
    if (!hasReferences) {
      warnings.push("The guide has no source references. Add evidence links before approval.");
    }
  } catch {
    sourceValidation = "failed";
    warnings.push(
      "Some generated guide content or source links need correction; the response was saved as editable text.",
    );
    guide = makeGuideRecord(
      {
        title: "AI response — review required",
        sessionId: input.session.id,
        templateId: input.expectedTemplateId,
        sections: [
          {
            id: newUuid(),
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
      { session: input.session, records: [...input.sourceRecords] },
    );
  }

  const schemaValid = proposal.schemaValid && sourceValidation !== "failed";
  const status =
    schemaValid && sourceValidation === "passed"
      ? "response-needs-review"
      : "response-needs-correction";
  const responseHash = await sha256Hex(responseBytes);
  const jobId = newUuid();
  const nowUs = (BigInt(Date.now()) * 1000n).toString();
  const consentFields: [string, string][] = preview.localOnly
    ? []
    : [
        ["outbound_consent_hash", preview.requestBodyHash],
        ["outbound_confirmed_at_us", nowUs],
        ["outbound_consent_method", "explicit-body-sha256"],
      ];
  const job: ArchiveRecord = {
    type: RecordType.aiJob,
    id: jobId,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map<string, string>([
      ["session_id", input.session.id],
      ["mode", preview.localOnly ? "local" : "byok"],
      ["status", status],
      ["provider_id", preview.providerId],
      ["model_id", preview.model],
      ["provider_endpoint", preview.endpoint],
      ["source_package_job_id", input.packageJob.id],
      ["request_package_sha256", preview.packageHash],
      ["request_body_sha256", preview.requestBodyHash],
      ["processing_boundary", preview.localOnly ? "loopback-only" : "remote-provider"],
      ["http_status", transport.status.toString()],
      ["response_sha256", responseHash],
      ["response_bytes", responseBytes.byteLength.toString()],
      ["guide_id", guide.id],
      ["schema_valid", schemaValid ? "true" : "false"],
      ["source_validation", sourceValidation],
      ["warnings", warnings.join("\n")],
      ["created_at_us", nowUs],
      ...consentFields,
    ]),
    blob: responseBytes,
  };
  return {
    job,
    guide,
    summary: {
      jobId,
      status,
      providerName: preview.providerName,
      model: preview.model,
      guideId: guide.id,
      schemaValid,
      sourceValidation,
      responseText: responseText.slice(0, AI_RESPONSE_PREVIEW_CHARACTER_LIMIT),
      responseTextTruncated: responseText.length > AI_RESPONSE_PREVIEW_CHARACTER_LIMIT,
      responseBytes: responseBytes.byteLength,
      warnings,
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
