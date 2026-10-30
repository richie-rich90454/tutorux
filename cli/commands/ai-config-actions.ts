import { dirname, resolve } from "node:path";
import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  AI_MODEL_CATALOG_TTL_SECONDS,
  aiModelProtocolFamily,
  buildAiModelCatalogRow,
  catalogAgeSeconds,
  catalogFreshness,
  structuredOutputCapability,
  streamingCapability,
  withCatalogFreshness,
  type AiModelCatalogRow,
} from "../../frontend/ai/catalog-metadata";
import { hasAiModelCatalog, loadAiModelCatalog } from "../../frontend/ai/model-catalog";
import {
  createProviderConfigurationRecord,
  deterministicUuid,
  isEmbeddedGgufProvider,
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
import { estimateGgufMemory, inspectCliModel } from "./model";
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

export async function modelStructuredOutputSupport(
  snapshot: ArchiveSnapshot,
  providerId: string,
  model: string,
): Promise<boolean> {
  const direct = await snapshot.getRecord(
    RecordType.settings,
    await deterministicUuid(`ai-model:${providerId}:${model}`),
  );
  if (direct && field(direct, "structured_output_support") === "supported") return true;
  const cached =
    readCatalogCache(
      await snapshot.getRecord(
        RecordType.settings,
        await deterministicUuid(`ai-model-cache:${providerId}`),
      ),
    ) ?? (await readLegacyCatalog(snapshot, providerId));
  return (
    cached?.models.some(
      (row) => row.model_id === model && row.structured_output_support === "supported",
    ) ?? false
  );
}

export async function aiModelsAction(
  action: "models" | "test",
  path: string,
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  const provider = providerById(requiredOption(args, "provider"));
  if (!provider) throw new CliError("Choose a supported AI provider.");
  if (isEmbeddedGgufProvider(provider.id)) {
    return aiEmbeddedModelsAction(action, path, snapshot, args, provider.id);
  }
  const cacheId = await deterministicUuid(`ai-model-cache:${provider.id}`);
  const cachedRecord = await snapshot.getRecord(RecordType.settings, cacheId);
  const cached =
    readCatalogCache(cachedRecord) ?? (await readLegacyCatalog(snapshot, provider.id));
  const refreshRequested = args.flags.has("refresh");
  const refreshIfStale = args.flags.has("refresh-if-stale");
  if (action === "models" && !refreshRequested) {
    if (!cached) {
      if (!refreshIfStale) throw new CliError(`No cached models for ${provider.id}. Retry with --refresh.`);
    } else if (!refreshIfStale || catalogFreshness(cached.checkedAtUs) === "fresh") {
      const rows = cached.models.map((row) =>
        withCatalogFreshness(row, cached.checkedAtUs, Date.now() * 1000),
      );
      return {
        result: rows,
        message: catalogMessage(provider.name, cached.source, rows),
      };
    }
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

  if (action === "test") {
    if (!provider.local && !credential)
      throw new CliError("A provider API key is required for model discovery.");
    const models = await discoverCliAiModels(provider.id, field(validated, "endpoint"), credential);
    return {
      result: { provider: provider.id, status: "connected", model_count: models.length },
      message: `Connected to ${provider.name}; ${models.length} model(s) available.`,
    };
  }

  const checkedAtUs = timestampNow();
  const nowUs = Date.now() * 1000;
  let rows: AiModelCatalogRow[];
  let source: string;
  let status: string;
  if (hasAiModelCatalog(provider.id)) {
    try {
      const catalog = await loadAiModelCatalog(provider.id, { refresh: true });
      rows = catalog.models.map((model) =>
        buildAiModelCatalogRow(
          {
            providerId: provider.id,
            modelId: model.id,
            owner: model.owner,
            protocolFamily: aiModelProtocolFamily(provider.id, model.id),
            contextWindow: model.contextWindow,
            maximumOutputTokens: model.maximumOutputTokens,
            inputModalities: model.inputModalities,
            outputModalities: model.outputModalities,
            structuredOutputSupport: structuredOutputCapability(provider.id, model.id),
            streamingSupport: streamingCapability(provider.id),
            toolSupport: model.toolSupport,
            tokenizer: model.tokenizer,
            inputCost: model.inputCost,
            outputCost: model.outputCost,
            availabilityStatus: model.status,
            metadataSource: "models.dev",
            catalogSource: "models.dev",
            discoveredAtUs: checkedAtUs,
          },
          checkedAtUs,
          nowUs,
        ),
      );
      source = "models.dev";
      status = catalog.freshness === "stale-cache-fallback" ? "stale-cache-fallback" : "models-dev";
    } catch (cause) {
      if (cached) {
        const fallbackRows = cached.models.map((row) =>
          withCatalogFreshness(row, cached.checkedAtUs, nowUs),
        );
        return {
          result: fallbackRows,
          message: `${catalogMessage(provider.name, "last-cache", fallbackRows)}\nRefresh failed; using the last archive catalog.`,
        };
      }
      throw cause instanceof Error ? cause : new Error("The public model catalog is unavailable.");
    }
  } else {
    if (!provider.local && !credential)
      throw new CliError("A provider API key is required for model discovery.");
    const models = await discoverCliAiModels(provider.id, field(validated, "endpoint"), credential);
    rows = models.map((model) =>
      buildAiModelCatalogRow(
        {
          providerId: provider.id,
          modelId: model.id,
          owner: model.owner ?? provider.name,
          protocolFamily: aiModelProtocolFamily(provider.id, model.id),
          structuredOutputSupport: structuredOutputCapability(provider.id, model.id),
          streamingSupport: streamingCapability(provider.id),
          metadataSource: "provider-api",
          catalogSource: "provider-api",
          discoveredAtUs: checkedAtUs,
        },
        checkedAtUs,
        nowUs,
      ),
    );
    source = "provider-api";
    status = "fresh";
  }
  const change: ArchiveRecord = {
    type: RecordType.settings,
    id: cacheId,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map([
      ["record_role", "ai-model-cache"],
      ["provider_id", provider.id],
      ["updated_at_us", checkedAtUs],
      ["catalog_checked_at_us", checkedAtUs],
      ["catalog_source", source],
      ["catalog_status", status],
      ["catalog_ttl_seconds", AI_MODEL_CATALOG_TTL_SECONDS.toString()],
    ]),
    blob: new TextEncoder().encode(
      JSON.stringify({ version: 2, models: rows, checked_at_us: checkedAtUs, source, status }),
    ),
  };
  return {
    changes: [change],
    result: rows,
    message: catalogMessage(provider.name, source, rows),
  };
}

interface CachedAiCatalog {
  checkedAtUs: string;
  source: string;
  status: string;
  models: AiModelCatalogRow[];
}

function readCatalogCache(record: ArchiveRecord | null): CachedAiCatalog | null {
  if (!record || field(record, "_deleted") === "true") return null;
  const checkedAtUs =
    field(record, "catalog_checked_at_us") || field(record, "updated_at_us") || timestampNow();
  const source = field(record, "catalog_source") || "last-cache";
  const status = field(record, "catalog_status") || "cached";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(record.blob));
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    return {
      checkedAtUs,
      source,
      status,
      models: parsed.flatMap((item) => {
        if (!isObject(item) || typeof item["id"] !== "string" || !item["id"]) return [];
        return [
          buildAiModelCatalogRow(
            {
              providerId: field(record, "provider_id"),
              modelId: item["id"],
              metadataSource: "provider-api",
              catalogSource: source,
              discoveredAtUs: checkedAtUs,
            },
            checkedAtUs,
          ),
        ];
      }),
    };
  }
  if (!isObject(parsed) || !Array.isArray(parsed["models"])) return null;
  const rows = parsed["models"].flatMap((item) =>
    isObject(item) && typeof item["model_id"] === "string"
      ? [item as unknown as AiModelCatalogRow]
      : [],
  );
  return {
    checkedAtUs:
      typeof parsed["checked_at_us"] === "string" ? parsed["checked_at_us"] : checkedAtUs,
    source: typeof parsed["source"] === "string" ? parsed["source"] : source,
    status: typeof parsed["status"] === "string" ? parsed["status"] : status,
    models: rows,
  };
}

async function readLegacyCatalog(
  snapshot: ArchiveSnapshot,
  providerId: string,
): Promise<CachedAiCatalog | null> {
  const settings = await snapshot.listRecords(RecordType.settings);
  const models = settings.filter(
    (record) =>
      field(record, "record_role") === "model-catalog" &&
      field(record, "provider_id") === providerId &&
      field(record, "_deleted") !== "true",
  );
  if (models.length === 0) return null;
  const state = settings.find(
    (record) =>
      field(record, "record_role") === "model-catalog-state" &&
      field(record, "provider_id") === providerId &&
      field(record, "_deleted") !== "true",
  );
  const discoveredAtUs = models
    .map((record) => Number(field(record, "discovered_at_us")))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => right - left)[0];
  const checkedAtUs =
    field(state ?? models[0]!, "catalog_checked_at_us") ||
    (discoveredAtUs ? String(discoveredAtUs) : timestampNow());
  const source = field(state ?? models[0]!, "catalog_source") || "provider-api";
  const status = field(state ?? models[0]!, "catalog_status") || "cached";
  const rows = models.map((record) => {
    const base = buildAiModelCatalogRow(
      {
        providerId,
        modelId: field(record, "model_id"),
        owner: field(record, "owner"),
        catalogState: field(record, "catalog_state") || "listed",
        protocolFamily:
          field(record, "protocol_family") ||
          aiModelProtocolFamily(providerId, field(record, "model_id")),
        contextWindow: numericText(field(record, "context_window")),
        maximumOutputTokens: numericText(field(record, "maximum_output_tokens")),
        inputModalities: field(record, "input_modalities").split(",").filter(Boolean),
        outputModalities: field(record, "output_modalities").split(",").filter(Boolean),
        structuredOutputSupport: capabilityStatusValue(
          field(record, "structured_output_support"),
        ),
        streamingSupport: capabilityStatusValue(field(record, "streaming_support")),
        availabilityStatus: field(record, "availability_status"),
        metadataSource: field(record, "metadata_source"),
        catalogSource: source,
        discoveredAtUs: field(record, "discovered_at_us") || checkedAtUs,
      },
      checkedAtUs,
    );
    return {
      ...base,
      ...Object.fromEntries(record.fields),
      catalog_source: field(record, "catalog_source") || source,
      catalog_status: status,
      catalog_ttl_seconds: AI_MODEL_CATALOG_TTL_SECONDS.toString(),
    };
  });
  return { checkedAtUs, source, status, models: rows };
}

function capabilityStatusValue(value: string) {
  return value === "supported" || value === "unsupported" || value === "unknown"
    ? value
    : ("unknown" as const);
}

function catalogMessage(
  providerName: string,
  source: string,
  rows: readonly AiModelCatalogRow[],
): string {
  const checkedAtUs = rows[0]?.catalog_checked_at_us ?? "";
  const age = checkedAtUs ? catalogAgeSeconds(checkedAtUs).toString() : "unknown";
  const freshness = checkedAtUs ? catalogFreshness(checkedAtUs) : "unavailable";
  const status = rows[0]?.catalog_status ?? "unavailable";
  return (
    `Catalog: ${freshness}; age=${age}s; TTL=${AI_MODEL_CATALOG_TTL_SECONDS}s; source=${source}; status=${status}` +
    (rows.length ? `\n${rows.map((row) => `${row.model_id}  ${row.catalog_state}`).join("\n")}` : "\nNo models returned.")
  );
}

async function aiEmbeddedModelsAction(
  action: "models" | "test",
  archivePath: string,
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
  providerId: string,
): Promise<AiActionOutcome> {
  const references = (await snapshot.listRecords(RecordType.settings)).filter(
    (record) =>
      field(record, "record_role") === "model-reference" &&
      field(record, "_deleted") !== "true" &&
      isEmbeddedGgufProvider(field(record, "provider")),
  );
  const requestedModel = args.options.get("model")?.trim() ?? "";
  if (action === "models") {
    const rows: AiModelCatalogRow[] = [];
    for (const reference of references) {
      const modelId = field(reference, "model_id");
      if (!modelId || (requestedModel && modelId !== requestedModel)) continue;
      const modelPath = field(reference, "path");
      const report = modelPath
        ? await inspectCliModel(resolve(dirname(resolve(archivePath)), modelPath)).catch(
            () => null,
          )
        : null;
      const row = buildAiModelCatalogRow(
        {
          providerId: field(reference, "provider") || providerId,
          modelId,
          owner: "embedded",
          catalogState: "user-selected",
          protocolFamily: "embedded-gguf-runtime",
          contextWindow: numericSetting(reference, "context_tokens") ??
            numericText(report?.training_context_tokens),
          inputModalities: ["text"],
          outputModalities: ["text"],
          structuredOutputSupport: "unknown",
          streamingSupport: "unsupported",
          toolSupport: null,
          metadataSource: "model-reference",
          catalogSource: "model-reference",
        },
        timestampNow(),
      );
      rows.push({
        ...row,
        ["path"]: modelPath,
        ["active"]: field(reference, "active"),
        ["architecture"]: report?.architecture ?? "",
        catalog_freshness: "local",
        catalog_status: "user-selected",
        catalog_ttl_seconds: "0",
      });
    }
    return {
      result: rows,
      message:
        rows
          .map(
            (row) =>
              `${row.model_id}  ${row["path"]}${row["active"] === "true" ? "  selected" : ""}`,
          )
          .join("\n") ||
        "No embedded GGUF models are selected in this archive. Use 'model select --provider llama.cpp-embedded --model ID --path FILE'.",
    };
  }

  const selected = references.find(
    (record) =>
      field(record, "active") === "true" &&
      (!requestedModel || field(record, "model_id") === requestedModel),
  );
  if (!selected) {
    throw new CliError("Select an embedded GGUF model before checking the local runtime.");
  }
  const modelPath = field(selected, "path");
  if (!modelPath) throw new CliError("The selected embedded model has no file path.");
  const inspected = await inspectCliModel(resolve(dirname(resolve(archivePath)), modelPath));
  if (!inspected.available) {
    throw new CliError("Selected model path is missing or is not a regular non-symlink file.");
  }
  if (
    inspected.format !== "GGUF" ||
    !inspected.architecture ||
    !inspected.embedding_length ||
    !inspected.layer_count
  ) {
    throw new CliError(
      "The GGUF model is missing a valid architecture or required context metadata.",
    );
  }
  const contextTokens =
    parsePositiveInteger(field(selected, "context_tokens")) ?? 4096;
  const estimate = estimateGgufMemory(inspected, contextTokens);
  const modelId = field(selected, "model_id");
  return {
    result: {
      provider: field(selected, "provider") || providerId,
      model_id: modelId,
      status: "model-file-valid",
      network_request_sent: "false",
      model_loaded: "false",
      architecture: inspected.architecture,
      file_size_bytes: String(inspected.size_bytes ?? 0),
      estimated_memory_bytes_upper_bound: estimate.totalBytesUpperBound,
      memory_estimate_overflowed: estimate.overflowed ? "true" : "false",
      available_memory_bytes: "unknown",
    },
    message: `Embedded model file is valid: ${inspected.name || modelId} (${inspected.architecture}). No model was loaded and no network request was sent.`,
  };
}

function numericSetting(record: ArchiveRecord, name: string): number | null {
  return parsePositiveInteger(field(record, name));
}

function numericText(value: string | undefined): number | null {
  return parsePositiveInteger(value ?? "");
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
