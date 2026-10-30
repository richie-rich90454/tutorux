import { resolve } from "node:path";
import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType } from "../../frontend/archive/format";
import { executeAiGeneration } from "../../frontend/ai/execution";
import { deterministicUuid, providerById } from "../../frontend/ai/providers";
import { createAiRequestPreview } from "../../frontend/ai/request";
import { guideRecordsWithEntryLinks } from "../../frontend/domain/guides";
import type { AiActionOutcome } from "./ai-actions";
import { sendCliAiRequest } from "./ai-transport";
import { writeTextAtomically } from "./archive-io";
import { resolveCliEmbeddedModelReference, sendCliEmbeddedAiRequest } from "../embedded-ai";
import { readGuideScope } from "./guide-helpers";
import { CliError, field, requiredOption, sameFileIdentity } from "./shared";
import { requireLiveRecord } from "./record-helpers";
import type { ParsedArguments } from "./shared";

export async function aiGenerateAction(
  path: string,
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const job = await requireLiveRecord(snapshot, RecordType.aiJob, requiredOption(args, "job"));
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider) throw new CliError("Choose a supported AI provider.");
  if (field(job, "requested_mode") === "local" && !provider.local)
    throw new CliError("A local package can only be sent to a local provider.");
  const config = await requireLiveRecord(
    snapshot,
    RecordType.settings,
    await deterministicUuid(`ai-provider:${provider.id}`),
  );
  const model = args.options.get("model");
  const configuration =
    model === undefined
      ? config
      : { ...config, fields: new Map(config.fields).set("selected_model", model) };
  const tokenValue = args.options.get("max-tokens");
  const tokens = tokenValue === undefined ? undefined : Number(tokenValue);
  const envName = args.options.get("api-key-env");
  if (envName && !/^[A-Za-z_][A-Za-z\d_]*$/u.test(envName))
    throw new CliError("Invalid API key environment variable name.");
  const credentialRecords = snapshot.encrypted
    ? await snapshot.listRecords(RecordType.settings)
    : [];
  const storedCredential = credentialRecords.find(
    (record) =>
      field(record, "record_role") === "credential" &&
      field(record, "_deleted") !== "true" &&
      (field(record, "provider_id") === provider.id ||
        field(record, "key") === provider.credentialKey),
  );
  const credential = envName
    ? (process.env[envName] ?? "")
    : storedCredential
      ? field(storedCredential, "value")
      : "";
  const preview = await createAiRequestPreview(
    job,
    configuration,
    tokens,
    [],
    Boolean(credential),
    snapshot,
  );
  const requestOutput = args.options.get("request-output");
  if (requestOutput) {
    if (await sameFileIdentity(resolve(requestOutput), path))
      throw new CliError("Request output cannot replace its source archive.");
    await writeTextAtomically(resolve(requestOutput), preview.requestBody);
  }
  const result = {
    provider: preview.providerId,
    endpoint: preview.endpoint,
    model: preview.model,
    package_hash: preview.packageHash,
    request_body_hash: preview.requestBodyHash,
    request_bytes: preview.requestBytes,
    local_only: preview.localOnly,
    credential_available: preview.credentialAvailable,
  };
  if (!args.flags.has("confirm-outbound") && !preview.localOnly) {
    return {
      result,
      message: `Review request to ${preview.endpoint}. Request SHA-256: ${preview.requestBodyHash}. Retry with --confirm-outbound --confirm-hash ${preview.requestBodyHash}.`,
    };
  }
  if (
    !preview.localOnly &&
    (!credential || args.options.get("confirm-hash") !== preview.requestBodyHash)
  )
    throw new CliError("Provide a provider API key and confirm the exact request hash.");
  const scope = await readGuideScope(snapshot, field(job, "session_id"));
  const execution = await executeAiGeneration({
    packageJob: job,
    expectedTemplateId: preview.guideTemplateId ?? "general",
    preview,
    confirmedEndpoint: preview.endpoint,
    confirmedBodyHash: preview.requestBodyHash,
    credential,
    session: scope.session,
    sourceRecords: scope.records,
    send: async (request, onChunk) => {
      if (request.providerId !== "embedded-gguf" && request.providerId !== "llama.cpp-embedded")
        return sendCliAiRequest(request, onChunk);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("Local model generation exceeded five minutes.")),
        300_000,
      );
      const cancel = () =>
        controller.abort(new Error("Local model generation was cancelled by Ctrl+C."));
      process.once("SIGINT", cancel);
      try {
        const references = await snapshot.listRecords(RecordType.settings);
        const selection = await resolveCliEmbeddedModelReference(
          references,
          path,
          request.model,
          controller.signal,
        );
        return await sendCliEmbeddedAiRequest(request, selection, onChunk, controller.signal);
      } finally {
        clearTimeout(timeout);
        process.off("SIGINT", cancel);
      }
    },
    onProgress: () => {},
  });
  return {
    changes: execution.guide
      ? [execution.job, ...guideRecordsWithEntryLinks(execution.guide, null, scope.records)]
      : [execution.job],
    result: execution.summary,
    message: `AI job ${execution.job.id}: ${execution.summary.status}.`,
  };
}
