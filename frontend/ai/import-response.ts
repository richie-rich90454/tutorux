import { RecordType, type ArchiveRecord } from "../archive/format";
import { createAiGuideProposal } from "./response";
import { makeGuideRecord } from "../domain/guides";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface ImportedAiResponse {
    records: ArchiveRecord[];
    jobId: string;
    guideId: string;
    status: string;
    warnings: string[];
}

/** Build an unapproved guide and manual job record from a saved provider response. */
export async function importAiResponseRecords(options: {
    session: ArchiveRecord;
    bytes: Uint8Array;
    filename: string;
    templateId: string;
    records: readonly ArchiveRecord[];
}): Promise<ImportedAiResponse> {
    if (options.bytes.byteLength === 0 || options.bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error("Response must be between 1 byte and 16 MiB.");
    }
    const responseText = new TextDecoder("utf-8", { fatal: true }).decode(options.bytes);
    let responseTemplate = "general";
    try {
        const parsed: unknown = JSON.parse(responseText);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "template_id" in parsed &&
            typeof parsed.template_id === "string"
        ) {
            responseTemplate = parsed.template_id;
        }
    } catch {
        // Unstructured responses are preserved for review.
    }
    const proposal = createAiGuideProposal(
        responseText,
        options.session.id,
        options.templateId === "auto" ? responseTemplate : options.templateId,
    );
    const scope = { session: options.session, records: options.records };
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
                sessionId: options.session.id,
                templateId: proposal.draft.templateId,
                sections: [
                    {
                        id: crypto.randomUUID(),
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
    ) {
        sourceValidation = "missing-evidence";
    }
    const status =
        proposal.schemaValid && sourceValidation === "passed"
            ? "response-imported"
            : "response-needs-correction";
    const jobId = crypto.randomUUID();
    const job: ArchiveRecord = {
        type: RecordType.aiJob,
        id: jobId,
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
            ["session_id", options.session.id.toLowerCase()],
            ["mode", "manual"],
            ["status", status],
            ["schema_valid", String(proposal.schemaValid)],
            ["source_validation", sourceValidation],
            ["import_warnings", proposal.warnings.join("\n")],
            ["guide_id", guide.id],
            ["original_filename", options.filename],
            ["content_hash", await sha256Hex(options.bytes)],
            ["created_at_us", (BigInt(Date.now()) * 1000n).toString()],
        ]),
        blob: options.bytes.slice(),
    };
    return {
        records: [guide, job],
        jobId,
        guideId: guide.id,
        status,
        warnings: proposal.warnings,
    };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
