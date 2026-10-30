import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType } from "../../frontend/archive/format";
import {
  createProviderConfigurationRecord,
  deterministicUuid,
  providerById,
} from "../../frontend/ai/providers";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import { packAiContext } from "../ai-context";
import {
  estimateOllamaContextFit,
  estimateOllamaInputTokenUpperBound,
  inspectOllamaContextLength,
} from "../ai-estimate";
import type { AiActionOutcome } from "./ai-actions";
import { discoverCliAiModels } from "./ai-transport";
import { CliError, field, parseBoundedOption, requiredOption, timestampNow } from "./shared";
import { requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { ParsedArguments } from "./shared";

export async function aiConfigureAction(args: ParsedArguments): Promise<AiActionOutcome> {
  if (args.options.has("api-key"))
    throw new CliError(
      "Use --api-key-env when generating; credentials are not accepted in configuration.",
    );
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider) throw new CliError("Choose a supported AI provider.");
  const configuration = await createProviderConfigurationRecord({
    providerId: provider.id,
    endpoint: args.options.get("endpoint") ?? provider.defaultEndpoint,
    model: args.options.get("model") ?? "",
  });
  return {
    changes: [configuration],
    result: toPlainRecord(configuration),
    message: `Provider ${provider.name} configured.`,
  };
}

export async function aiContextAction(
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const budget = parseBoundedOption(
    args.options.get("token-budget"),
    "token-budget",
    8192,
    1,
    10_000_000,
  );
  const itemLimit = parseBoundedOption(
    args.options.get("max-item-tokens"),
    "max-item-tokens",
    budget,
    1,
    budget,
  );
  const packed = await packAiContext(
    snapshot,
    requiredOption(args, "session").toLowerCase(),
    budget,
    itemLimit,
  );
  return {
    result: packed,
    message: `Context preview: ${packed.used_tokens} / ${budget} estimated tokens; ${packed.included.length} included fragment(s), ${packed.omitted.length} omitted fragment(s).\n${packed.included.map((row) => JSON.stringify(row)).join("\n")}`,
  };
}

export function aiCapabilitiesAction(args: ParsedArguments): AiActionOutcome {
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider) throw new CliError("Choose a supported AI provider.");
  const model = requiredOption(args, "model");
  return {
    result: {
      provider: provider.id,
      model,
      protocol: provider.protocol,
      local: provider.local,
      image_input_supported_by_protocol: [
        "openai",
        "openai-compatible",
        "anthropic",
        "google-gemini",
        "ollama",
      ].includes(provider.id),
      model_capabilities: "unknown",
    },
    message: `${provider.name}: ${provider.protocol}; model-specific capabilities are unknown.`,
  };
}

export async function aiEstimateAction(
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  if (args.positionals.length)
    throw new CliError("ai estimate does not accept positional arguments.");
  if (args.flags.has("model")) throw new CliError("--model requires a value.");
  if (args.flags.has("endpoint")) throw new CliError("--endpoint requires a value.");
  if (args.flags.has("max-tokens")) throw new CliError("--max-tokens requires a value.");
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider || provider.id !== "ollama") {
    throw new CliError("Ollama estimation is available only with --provider ollama.");
  }
  const jobIdInput = requiredOption(args, "job");
  const jobId = canonicalizeProgressUuid(jobIdInput);
  if (!jobId) throw new CliError("--job must be a valid UUID.");
  const job = await requireLiveRecord(snapshot, RecordType.aiJob, jobId);
  if (
    (field(job, "mode") !== "local" && field(job, "requested_mode") !== "local") ||
    field(job, "format") !== "json" ||
    field(job, "status") !== "package-ready" ||
    job.blob.byteLength === 0
  ) {
    throw new CliError("Ollama estimation requires a stored local JSON AI package.");
  }
  const maxTokens = parseBoundedOption(
    args.options.get("max-tokens"),
    "max-tokens",
    4096,
    1,
    1_000_000,
  );
  const configuration = await snapshot.getRecord(
    RecordType.settings,
    await deterministicUuid("ai-provider:ollama"),
  );
  const hasConfiguration =
    configuration !== null &&
    field(configuration, "_deleted") !== "true" &&
    field(configuration, "record_role") === "ai-provider";
  const endpoint =
    args.options.get("endpoint") ??
    ((hasConfiguration ? field(configuration, "endpoint") : "") || provider.defaultEndpoint);
  const model =
    args.options.get("model")?.trim() ??
    (hasConfiguration ? field(configuration, "selected_model").trim() : "");
  if (!model) {
    throw new CliError("Choose a model with --model or configure one with 'ai configure --model'.");
  }
  const contextLength = await inspectOllamaContextLength(endpoint, model);
  const inputTokenUpperBound = estimateOllamaInputTokenUpperBound(job.blob.byteLength);
  const contextFit = estimateOllamaContextFit(inputTokenUpperBound, maxTokens, contextLength);
  const displayedContextLength = contextLength === null ? "not reported" : String(contextLength);
  return {
    result: {
      provider: provider.id,
      model,
      job_id: job.id,
      input_token_upper_bound: String(inputTokenUpperBound),
      requested_output_tokens: String(maxTokens),
      context_length: displayedContextLength,
      context_fit: contextFit,
      method: "utf-8-byte upper bound; conservative",
    },
    message:
      `Conservative prompt-token upper bound: ${inputTokenUpperBound}` +
      `\nRequested output tokens: ${maxTokens}` +
      `\nModel context length: ${displayedContextLength}` +
      `\nContext fit: ${contextFit}` +
      "\nEstimate method: UTF-8 byte upper bound; conservative.\n",
  };
}

export async function aiModelsAction(
  action: "models" | "test",
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider) throw new CliError("Choose a supported AI provider.");
  const cacheId = await deterministicUuid(`ai-model-cache:${provider.id}`);
  const cached = await snapshot.getRecord(RecordType.settings, cacheId);
  if (action === "models" && !args.flags.has("refresh") && !args.flags.has("refresh-if-stale")) {
    if (!cached || field(cached, "_deleted") === "true")
      throw new CliError(`No cached models for ${provider.id}. Retry with --refresh.`);
    const models: unknown = JSON.parse(new TextDecoder().decode(cached.blob));
    return { result: models, message: JSON.stringify(models, null, 2) };
  }
  const configuration = await snapshot.getRecord(
    RecordType.settings,
    await deterministicUuid(`ai-provider:${provider.id}`),
  );
  const endpoint = configuration ? field(configuration, "endpoint") : provider.defaultEndpoint;
  const validated = await createProviderConfigurationRecord({
    providerId: provider.id,
    endpoint,
    model: "",
  });
  const envName = args.options.get("api-key-env") ?? provider.credentialKey ?? "";
  if (envName && !/^[A-Za-z_][A-Za-z\d_]*$/u.test(envName))
    throw new CliError("Invalid API key environment variable name.");
  const credentials = snapshot.encrypted ? await snapshot.listRecords(RecordType.settings) : [];
  const stored = credentials.find(
    (record) =>
      field(record, "record_role") === "credential" &&
      field(record, "_deleted") !== "true" &&
      (field(record, "provider_id") === provider.id ||
        field(record, "key") === provider.credentialKey),
  );
  const credential = process.env[envName] ?? (stored ? field(stored, "value") : "");
  if (!provider.local && !credential)
    throw new CliError("A provider API key is required for model discovery.");
  const models = await discoverCliAiModels(provider.id, field(validated, "endpoint"), credential);
  const changes =
    action === "models"
      ? [
          {
            type: RecordType.settings,
            id: cacheId,
            revision: 0n,
            previousOffset: 0n,
            fields: new Map([
              ["record_role", "ai-model-cache"],
              ["provider_id", provider.id],
              ["updated_at_us", timestampNow()],
            ]),
            blob: new TextEncoder().encode(JSON.stringify(models)),
          },
        ]
      : undefined;
  return {
    changes,
    result:
      action === "test"
        ? { provider: provider.id, status: "connected", model_count: models.length }
        : models,
    message:
      action === "test"
        ? `Connected to ${provider.name}; ${models.length} model(s) available.`
        : models.map((model) => model.id).join("\n") || "No models returned.",
  };
}
