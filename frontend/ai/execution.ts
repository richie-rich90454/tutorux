import { newUuid, RecordType, type ArchiveRecord } from "../archive/format";
import { makeGuideRecord } from "../domain/guides";
import type { AiRequestPreview } from "./request";
import {
    AI_RESPONSE_PREVIEW_CHARACTER_LIMIT,
    createAiGuideProposal,
    extractAiResponseMetadata,
    extractAiResponseText,
    type AiExecutionSummary,
} from "./response";
import type { AiCredentialStorage, AiTransportRequest, AiTransportResult } from "../platform/types";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface AiExecutionResult {
    job: ArchiveRecord;
    guide: ArchiveRecord | null;
    summary: AiExecutionSummary;
}

export interface AiExecutionInput {
    packageJob: ArchiveRecord;
    expectedTemplateId: string;
    preview: AiRequestPreview;
    confirmedEndpoint: string;
    confirmedBodyHash: string;
    credential: string;
    credentialStorage?: AiCredentialStorage;
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
    let responseTooLarge = false;
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
            credentialStorage:
                input.credentialStorage ?? (preview.localOnly ? "none" : "encrypted-archive"),
            credential: input.credential,
        },
        (chunk) => {
            const remaining = MAX_RESPONSE_BYTES - receivedBytes;
            const copy = chunk.subarray(0, Math.max(0, remaining)).slice();
            chunks.push(copy);
            receivedBytes += copy.byteLength;
            if (copy.byteLength < chunk.byteLength) responseTooLarge = true;
            if (copy.byteLength > 0) input.onProgress(receivedBytes);
        },
    );
    const responseBytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        responseBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    chunks.length = 0;

    const jobId = newUuid();
    const nowUs = (BigInt(Date.now()) * 1000n).toString();
    const responseHash = await sha256Hex(responseBytes);
    const responseMetadata = extractAiResponseMetadata(preview.providerId, responseBytes);
    const consentFields: [string, string][] = preview.localOnly
        ? []
        : [
              ["outbound_consent_hash", preview.requestBodyHash],
              ["outbound_confirmed_at_us", nowUs],
              [
                  "outbound_consent_method",
                  preview.providerId === "replicate"
                      ? "explicit-replicate-prediction-lifecycle"
                      : "explicit-body-sha256",
              ],
          ];
    const replicateSchemaFields: [string, string][] = preview.replicateInputSchema
        ? [["replicate_model_schema_version", preview.replicateInputSchema.version]]
        : [];
    const createJob = (
        status: string,
        guideId: string | null,
        schemaValid: boolean,
        sourceValidation: AiExecutionSummary["sourceValidation"],
        warnings: readonly string[],
        errorCode = "",
        errorMessage = "",
        retryAfter = "",
    ): ArchiveRecord => {
        const fields = new Map<string, string>([
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
            ["response_content_type", transport.contentType],
            [
                "response_complete",
                transport.complete && !responseTooLarge && transport.responseBytes === receivedBytes
                    ? "true"
                    : "false",
            ],
            ["response_sha256", responseHash],
            ["response_bytes", responseBytes.byteLength.toString()],
            ["guide_id", guideId ?? ""],
            ["schema_valid", schemaValid ? "true" : "false"],
            ["source_validation", sourceValidation],
            ["warnings", warnings.join("\n")],
            ["error_code", errorCode],
            ["error_message", errorMessage],
            ["retry_after", retryAfter],
            ["provider_response_id", responseMetadata.providerResponseId],
            ["max_output_tokens", preview.maxOutputTokens.toString()],
            ["created_at_us", nowUs],
            ...consentFields,
            ...replicateSchemaFields,
        ]);
        for (const key of ["error_code", "error_message", "retry_after", "provider_response_id"]) {
            if (!fields.get(key)) fields.delete(key);
        }
        return {
            type: RecordType.aiJob,
            id: jobId,
            revision: 0n,
            previousOffset: 0n,
            fields,
            blob: responseBytes,
        };
    };
    const createSummary = (
        status: string,
        guideId: string | null,
        schemaValid: boolean,
        sourceValidation: AiExecutionSummary["sourceValidation"],
        responseText: string,
        warnings: string[],
    ): AiExecutionSummary => ({
        jobId,
        status,
        providerName: preview.providerName,
        model: preview.model,
        guideId,
        schemaValid,
        sourceValidation,
        responseText: responseText.slice(0, AI_RESPONSE_PREVIEW_CHARACTER_LIMIT),
        responseTextTruncated: responseText.length > AI_RESPONSE_PREVIEW_CHARACTER_LIMIT,
        responseBytes: responseBytes.byteLength,
        warnings,
    });
    const failure = (
        status: string,
        message: string,
        errorCode: string,
        retryAfter = responseMetadata.retryAfter,
    ): AiExecutionResult => {
        const warnings = [message];
        const schemaValid = false;
        const sourceValidation: AiExecutionSummary["sourceValidation"] = "not-available";
        const errorMessage = responseMetadata.errorMessage || message;
        return {
            job: createJob(
                status,
                null,
                schemaValid,
                sourceValidation,
                warnings,
                errorCode || responseMetadata.errorCode,
                errorMessage,
                retryAfter,
            ),
            guide: null,
            summary: createSummary(status, null, schemaValid, sourceValidation, "", warnings),
        };
    };
    const buildGuide = (
        responseText: string,
    ): {
        guide: ArchiveRecord;
        schemaValid: boolean;
        sourceValidation: AiExecutionSummary["sourceValidation"];
        warnings: string[];
    } => {
        const proposal = createAiGuideProposal(
            responseText,
            input.session.id,
            input.expectedTemplateId,
        );
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
                warnings.push(
                    "The guide has no source references. Add evidence links before approval.",
                );
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
        return {
            guide,
            schemaValid: proposal.schemaValid && sourceValidation !== "failed",
            sourceValidation,
            warnings,
        };
    };

    if (transport.cancelled) {
        const cancellationMessage =
            transport.errorMessage ??
            "Generation was cancelled. The received partial response was saved for export.";
        if (responseBytes.byteLength > 0) {
            try {
                const partialText = extractAiResponseText(
                    preview.providerId,
                    responseBytes,
                    preview.model,
                    true,
                );
                const built = buildGuide(partialText);
                built.warnings.unshift(
                    "Generation was cancelled; the partial response is an unapproved draft that needs review.",
                );
                const status = "cancelled-with-partial-output";
                return {
                    job: createJob(
                        status,
                        built.guide.id,
                        built.schemaValid,
                        built.sourceValidation,
                        built.warnings,
                        "operation_cancelled",
                        cancellationMessage,
                        responseMetadata.retryAfter,
                    ),
                    guide: built.guide,
                    summary: createSummary(
                        status,
                        built.guide.id,
                        built.schemaValid,
                        built.sourceValidation,
                        partialText,
                        built.warnings,
                    ),
                };
            } catch {
                // The partial bytes did not contain decodable text; keep the raw response only.
            }
        }
        return failure("cancelled", cancellationMessage, "operation_cancelled");
    }
    if (responseTooLarge || !transport.complete || transport.responseBytes !== receivedBytes) {
        return failure(
            "response-partial",
            transport.errorMessage ??
                "The response stream was interrupted or exceeded the 16 MiB limit. The received raw bytes were saved for export.",
            responseTooLarge ? "response_too_large" : "response_partial",
        );
    }
    if (transport.status < 200 || transport.status >= 300) {
        const message =
            responseMetadata.errorMessage ||
            transport.errorMessage ||
            (preview.providerId === "replicate" && [401, 403].includes(transport.status)
                ? "Replicate rejected the API token or model access. Its raw response was saved for export."
                : preview.providerId === "replicate" && transport.status === 429
                  ? "Replicate rate limited the prediction. Its raw response was saved for export."
                  : preview.providerId === "replicate" && transport.status === 408
                    ? "Replicate prediction exceeded the five-minute wait limit. Its latest raw response was saved for export."
                    : `The provider returned HTTP ${transport.status}. Its raw response was saved for export.`);
        return failure(
            "provider-error",
            message,
            responseMetadata.errorCode || `provider_http_${transport.status}`,
        );
    }
    const contentType = transport.contentType.trim().toLowerCase();
    if (contentType !== "application/json" && contentType !== preview.accept) {
        return failure(
            "response-needs-correction",
            "The provider returned an unsupported response format. Its raw bytes were saved for export.",
            "response_content_type_unsupported",
        );
    }

    let responseText: string;
    try {
        responseText = extractAiResponseText(preview.providerId, responseBytes, preview.model);
    } catch (cause) {
        return failure(
            "response-needs-correction",
            `${cause instanceof Error ? cause.message : "The provider response could not be decoded."} Raw bytes were saved for export.`,
            "response_decode_failed",
        );
    }
    const built = buildGuide(responseText);
    const status =
        built.schemaValid && built.sourceValidation === "passed"
            ? "response-needs-review"
            : "response-needs-correction";
    const job = createJob(
        status,
        built.guide.id,
        built.schemaValid,
        built.sourceValidation,
        built.warnings,
    );
    return {
        job,
        guide: built.guide,
        summary: createSummary(
            status,
            built.guide.id,
            built.schemaValid,
            built.sourceValidation,
            responseText,
            built.warnings,
        ),
    };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const stableBytes = bytes.slice();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", stableBytes.buffer));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
