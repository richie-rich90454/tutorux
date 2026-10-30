import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { ArchiveRecord } from "./archive/format";
import {
  aiPackageText,
  isAiImageAttachmentCandidate,
  MAX_AI_IMAGE_ATTACHMENT_BYTES,
  MAX_AI_IMAGE_ATTACHMENT_COUNT,
  type AiPackageSummary,
} from "./ai/package";
import { createAiMultipartHandoff } from "./ai/multipart";
import { hasAiModelCatalog, loadAiModelCatalog, type AiCatalogModel } from "./ai/model-catalog";
import type { AiRequestPreview } from "./ai/request";
import type { ReplicateModelInputSchema } from "./ai/replicate-schema";
import { AI_RESPONSE_PREVIEW_CHARACTER_LIMIT, type AiExecutionSummary } from "./ai/response";
import { cancelReplicatePrediction } from "./ai/replicate";
import {
  AI_PROVIDERS,
  isEmbeddedGgufProvider,
  providerById,
  type AiProviderConfigurationInput,
} from "./ai/providers";
import type { AiCredentialStorage, BinaryExportSource } from "./platform/types";
import {
  cancelEmbeddedAiGeneration,
  embeddedModelRuntimeAvailable,
  loadEmbeddedModel,
  readEmbeddedModelStatus,
  selectAndInspectEmbeddedModel,
  unloadEmbeddedModel,
  type EmbeddedModelInfo,
  type EmbeddedModelStatus,
} from "./platform/embedded-ai";
import { GUIDE_TEMPLATES, type GuideTemplate } from "./domain/guides";
import { guideTemplateFromRecord } from "./domain/templates";
import "./ai.css";

interface AiPageProps {
  archiveId: string;
  sessions: readonly ArchiveRecord[];
  assets: readonly ArchiveRecord[];
  customTemplates: readonly ArchiveRecord[];
  jobs: readonly ArchiveRecord[];
  providerSettings: readonly ArchiveRecord[];
  credentials: readonly ArchiveRecord[];
  encrypted: boolean;
  disabled: boolean;
  busy: boolean;
  execution: AiExecutionSummary | null;
  onClearExecution: () => void;
  onPrepare: (
    sessionId: string,
    templateId: string,
    attachmentIds: readonly string[],
  ) => Promise<AiPackageSummary>;
  onCreateRequestPreview: (
    packageJob: ArchiveRecord,
    providerId: string,
    credentialStorage: AiCredentialStorage,
    replicateInputSchema?: ReplicateModelInputSchema,
  ) => Promise<AiRequestPreview>;
  onInspectReplicateModel: (
    providerId: string,
    model: string,
    credentialStorage: AiCredentialStorage,
  ) => Promise<ReplicateModelInputSchema>;
  onSave: (summary: AiPackageSummary) => Promise<boolean>;
  onLoad: (jobId: string) => Promise<ArchiveRecord | null>;
  onExportTextFile: (
    suggestedName: string,
    contents: string,
    mimeType: string,
  ) => Promise<string | null>;
  onExportBinaryFile: (
    suggestedName: string,
    contents: BinaryExportSource,
    mimeType: string,
  ) => Promise<string | null>;
  onSend: (
    packageJob: ArchiveRecord,
    expectedTemplateId: string,
    preview: AiRequestPreview,
    confirmedEndpoint: string,
    confirmedBodyHash: string,
    credentialStorage: AiCredentialStorage,
    onProgress: (responseBytes: number) => void,
  ) => Promise<void>;
  onSaveProvider: (input: AiProviderConfigurationInput) => Promise<boolean>;
  systemCredentialStoreAvailable: boolean;
  hasSystemCredential: (providerId: string) => Promise<boolean>;
  onSaveCredential: (
    providerId: string,
    value: string,
    storage: AiCredentialStorage,
  ) => Promise<boolean>;
  onRemoveCredential: (providerId: string, storage: AiCredentialStorage) => Promise<boolean>;
}

export function AiPage(props: AiPageProps): JSX.Element {
  const [sessionId, setSessionId] = createSignal("");
  const [templateId, setTemplateId] = createSignal("auto");
  const [selectedImageIds, setSelectedImageIds] = createSignal<string[]>([]);
  const [review, setReview] = createSignal<AiPackageSummary | null>(null);
  const [requestPreview, setRequestPreview] = createSignal<AiRequestPreview | null>(null);
  const [requestPreviewMessage, setRequestPreviewMessage] = createSignal("");
  const [replicateSchemaInspecting, setReplicateSchemaInspecting] = createSignal(false);
  const [sendConfirmed, setSendConfirmed] = createSignal(false);
  const [sendProgressBytes, setSendProgressBytes] = createSignal(0);
  const [sending, setSending] = createSignal(false);
  const [cancelRequested, setCancelRequested] = createSignal(false);
  const [showResponse, setShowResponse] = createSignal(false);
  const [reviewed, setReviewed] = createSignal(false);
  const [showJson, setShowJson] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [providerId, setProviderId] = createSignal(AI_PROVIDERS[0]!.id);
  const [providerEndpoint, setProviderEndpoint] = createSignal(AI_PROVIDERS[0]!.defaultEndpoint);
  const [providerModel, setProviderModel] = createSignal("");
  const [catalogVisible, setCatalogVisible] = createSignal(false);
  const [catalogLoading, setCatalogLoading] = createSignal(false);
  const [catalogModels, setCatalogModels] = createSignal<readonly AiCatalogModel[]>([]);
  const [catalogMessage, setCatalogMessage] = createSignal("");
  const [catalogQuery, setCatalogQuery] = createSignal("");
  const [catalogCapability, setCatalogCapability] = createSignal<"all" | "vision" | "tools">("all");
  let catalogRequestVersion = 0;
  let catalogController: AbortController | undefined;
  const [providerMessage, setProviderMessage] = createSignal("");
  const [credentialInput, setCredentialInput] = createSignal("");
  const [credentialConfirmed, setCredentialConfirmed] = createSignal(false);
  const [credentialStorage, setCredentialStorage] =
    createSignal<AiCredentialStorage>("encrypted-archive");
  const [systemCredentialSaved, setSystemCredentialSaved] = createSignal(false);
  const [embeddedModel, setEmbeddedModel] = createSignal<EmbeddedModelInfo | null>(null);
  const [embeddedStatus, setEmbeddedStatus] = createSignal<EmbeddedModelStatus | null>(null);
  const [embeddedContextTokens, setEmbeddedContextTokens] = createSignal("4096");
  const [embeddedCpuThreads, setEmbeddedCpuThreads] = createSignal("4");
  const [embeddedBusy, setEmbeddedBusy] = createSignal(false);
  const [embeddedMessage, setEmbeddedMessage] = createSignal("");
  const embeddedAvailable = embeddedModelRuntimeAvailable();
  let credentialStorageTouched = false;
  onCleanup(() => catalogController?.abort());
  const currentProvider = createMemo(() => providerById(providerId()) ?? AI_PROVIDERS[0]!);
  const savedCredential = createMemo(() =>
    props.credentials.find(
      (record) =>
        record.fields.get("provider_id") === providerId() ||
        record.fields.get("key") === currentProvider().credentialKey,
    ),
  );
  const credentialSaved = createMemo(() =>
    credentialStorage() === "system-keychain" ? systemCredentialSaved() : !!savedCredential(),
  );
  const canSaveCredential = createMemo(() =>
    credentialStorage() === "system-keychain"
      ? props.systemCredentialStoreAvailable
      : props.encrypted,
  );
  const savedProvider = createMemo(() =>
    props.providerSettings.find((record) => {
      const savedProviderId = record.fields.get("provider_id") ?? "";
      return isEmbeddedGgufProvider(providerId())
        ? isEmbeddedGgufProvider(savedProviderId)
        : savedProviderId === providerId();
    }),
  );
  const providerState = createMemo(
    () => {
      const provider = currentProvider();
      const saved = savedProvider();
      return {
        archiveId: props.archiveId,
        providerId: provider.id,
        endpoint: saved?.fields.get("endpoint") || provider.defaultEndpoint,
        model: saved?.fields.get("selected_model") ?? "",
      };
    },
    { archiveId: "", providerId: "", endpoint: "", model: "" },
    {
      equals: (previous, next) =>
        previous.archiveId === next.archiveId &&
        previous.providerId === next.providerId &&
        previous.endpoint === next.endpoint &&
        previous.model === next.model,
    },
  );
  const visibleCatalogModels = createMemo(() => {
    const query = catalogQuery().trim().toLocaleLowerCase();
    const capability = catalogCapability();
    return catalogModels()
      .filter((model) => {
        if (
          capability === "vision" &&
          !model.inputModalities.some((modality) => modality === "image" || modality === "video")
        ) {
          return false;
        }
        if (capability === "tools" && model.toolSupport !== true) return false;
        return (
          !query ||
          model.id.toLocaleLowerCase().includes(query) ||
          model.owner.toLocaleLowerCase().includes(query) ||
          (model.tokenizer?.toLocaleLowerCase().includes(query) ?? false)
        );
      })
      .slice(0, 100);
  });
  createEffect(() => {
    if (props.systemCredentialStoreAvailable && !credentialStorageTouched) {
      setCredentialStorage("system-keychain");
    } else if (!props.systemCredentialStoreAvailable && credentialStorage() === "system-keychain") {
      setCredentialStorage("encrypted-archive");
    }
  });
  createEffect(() => {
    const provider = currentProvider().id;
    if (!props.systemCredentialStoreAvailable) {
      setSystemCredentialSaved(false);
      return;
    }
    let active = true;
    void props
      .hasSystemCredential(provider)
      .then((saved) => {
        if (active) setSystemCredentialSaved(saved);
      })
      .catch(() => {
        if (active) setSystemCredentialSaved(false);
      });
    onCleanup(() => {
      active = false;
    });
  });
  createEffect(() => {
    const configuration = providerState();
    setProviderEndpoint(configuration.endpoint);
    setProviderModel(configuration.model);
    setCredentialInput("");
    setCredentialConfirmed(false);
    setRequestPreview(null);
    setRequestPreviewMessage("");
    setSendConfirmed(false);
    setSendProgressBytes(0);
    catalogRequestVersion += 1;
    catalogController?.abort();
    catalogController = undefined;
    setCatalogVisible(false);
    setCatalogLoading(false);
    setCatalogModels([]);
    setCatalogMessage("");
    setCatalogQuery("");
    setCatalogCapability("all");
  });
  createEffect(() => {
    if (!embeddedAvailable) return;
    let active = true;
    void readEmbeddedModelStatus()
      .then((status) => {
        if (active) setEmbeddedStatus(status);
      })
      .catch(() => {
        if (active) {
          setEmbeddedStatus({
            loaded: false,
            modelId: null,
            name: null,
            pathName: null,
            contextTokens: null,
            cpuThreads: null,
            memoryEstimateBytes: null,
          });
        }
      });
    onCleanup(() => {
      active = false;
    });
  });
  const templates = createMemo<GuideTemplate[]>(() => [
    ...GUIDE_TEMPLATES,
    ...props.customTemplates.map(guideTemplateFromRecord),
  ]);
  const sessionImages = createMemo(() =>
    props.assets
      .filter(
        (asset) =>
          asset.fields.get("session_id")?.toLowerCase() === sessionId().toLowerCase() &&
          isAiImageAttachmentCandidate(asset),
      )
      .sort((left, right) =>
        (left.fields.get("filename") ?? "").localeCompare(right.fields.get("filename") ?? ""),
      ),
  );
  const selectedImages = createMemo(() => {
    const selected = new Set(selectedImageIds());
    return sessionImages().filter((asset) => selected.has(asset.id.toLowerCase()));
  });
  const selectedImageBytes = createMemo(() =>
    selectedImages().reduce(
      (total, asset) => total + Number(asset.fields.get("byte_size") ?? 0),
      0,
    ),
  );
  const latestJobs = createMemo(() =>
    [...props.jobs]
      .filter((job) => job.fields.get("mode") === "manual")
      .sort((left, right) => compareTimestamp(right, left))
      .slice(0, 12),
  );
  const latestRuns = createMemo(() =>
    [...props.jobs]
      .filter((job) => job.fields.get("mode") !== "manual")
      .sort((left, right) => compareTimestamp(right, left))
      .slice(0, 12),
  );

  async function prepare(): Promise<void> {
    setMessage("");
    setReview(null);
    setRequestPreview(null);
    setReviewed(false);
    setSendConfirmed(false);
    setShowJson(false);
    try {
      const summary = await props.onPrepare(sessionId(), templateId(), selectedImageIds());
      setReview(summary);
      setMessage("Package assembled locally. Nothing has been sent or saved yet.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The package could not be prepared.");
    }
  }

  async function saveReview(): Promise<void> {
    const summary = review();
    if (!summary || !reviewed()) return;
    const saved = await props.onSave(summary);
    if (saved) {
      setReview(null);
      setReviewed(false);
      setShowJson(false);
      setRequestPreview(null);
      setSendConfirmed(false);
      setMessage("Reviewed package saved in this archive. No provider was contacted.");
    }
  }

  async function download(jobId: string): Promise<void> {
    try {
      const job = await props.onLoad(jobId);
      if (!job) throw new Error("That AI record is no longer available in the active archive.");
      const isPackage = job.fields.get("mode") === "manual";
      const text = isPackage ? aiPackageText(job) : undefined;
      const filename = `Tutorux-AI-${job.fields.get("session_id") ?? job.id}.${isPackage ? "json" : "txt"}`;
      const location = text
        ? await props.onExportTextFile(filename, text, "application/json")
        : await props.onExportBinaryFile(filename, job.blob.slice(), "application/octet-stream");
      if (location) setMessage(`Exported AI ${isPackage ? "package" : "response"} to ${location}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The package could not be exported.");
    }
  }

  async function downloadMultipart(jobId: string): Promise<void> {
    try {
      const job = await props.onLoad(jobId);
      if (!job || job.fields.get("mode") !== "manual") {
        throw new Error("That AI package is no longer available in the active archive.");
      }
      const handoff = createAiMultipartHandoff(aiPackageText(job));
      const filename = `Tutorux-AI-${job.fields.get("session_id") ?? job.id}.multipart.md`;
      const location = await props.onExportTextFile(filename, handoff.markdown, "text/markdown");
      if (location) {
        setMessage(
          `Exported an ordered handoff with ${handoff.transcriptPartCount} transcript parts and ${handoff.promptCount} prompts (${formatBytes(handoff.outputBytes)}) to ${location}.`,
        );
      }
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "The multipart handoff could not be exported.",
      );
    }
  }

  async function saveProvider(): Promise<void> {
    setProviderMessage("");
    try {
      const input: AiProviderConfigurationInput = {
        providerId: currentProvider().id,
        endpoint: providerEndpoint(),
        model: providerModel(),
      };
      const saved = await props.onSaveProvider(input);
      if (saved)
        setProviderMessage("Provider settings saved. No connection test or request was made.");
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "Provider settings could not be saved.",
      );
    }
  }

  async function openModelCatalog(refresh = false): Promise<void> {
    setCatalogVisible(true);
    setCatalogMessage("");
    if (!hasAiModelCatalog(currentProvider().id)) {
      setCatalogMessage(
        "This provider does not publish a public catalog here. You can still enter its model ID manually.",
      );
      return;
    }
    const requestVersion = ++catalogRequestVersion;
    const requestedProvider = currentProvider().id;
    const controller = new AbortController();
    catalogController?.abort();
    catalogController = controller;
    setCatalogLoading(true);
    try {
      const result = await loadAiModelCatalog(requestedProvider, {
        refresh,
        signal: controller.signal,
      });
      if (requestVersion !== catalogRequestVersion) return;
      setCatalogModels(result.models);
      setCatalogMessage(
        result.freshness === "stale-cache-fallback"
          ? `${result.models.length.toLocaleString()} cached model records are shown because the catalog could not be reached. Metadata may be stale; verify availability and capabilities with your provider.`
          : `${result.models.length.toLocaleString()} public model records loaded. Catalog metadata is informational and may be out of date; verify availability and capabilities with your provider.`,
      );
    } catch (cause) {
      if (requestVersion !== catalogRequestVersion) return;
      setCatalogMessage(
        cause instanceof Error
          ? `${cause.message} Manual model ID entry remains available.`
          : "The public catalog is unavailable. Manual model ID entry remains available.",
      );
    } finally {
      if (catalogController === controller) catalogController = undefined;
      if (requestVersion === catalogRequestVersion) setCatalogLoading(false);
    }
  }

  function chooseCatalogModel(model: AiCatalogModel): void {
    setProviderModel(model.id);
    setRequestPreview(null);
    setRequestPreviewMessage("");
    setSendConfirmed(false);
    props.onClearExecution();
    setCatalogMessage(`${model.id} selected. Save provider settings to use this model.`);
  }

  async function saveCredential(): Promise<void> {
    setProviderMessage("");
    if (!credentialConfirmed()) {
      setProviderMessage("Confirm the selected secure storage before saving this API key.");
      return;
    }
    try {
      const storage = credentialStorage();
      const saved = await props.onSaveCredential(currentProvider().id, credentialInput(), storage);
      if (saved) {
        if (storage === "system-keychain") setSystemCredentialSaved(true);
        setCredentialInput("");
        setCredentialConfirmed(false);
        setRequestPreview(null);
        setSendConfirmed(false);
        setProviderMessage(
          storage === "system-keychain"
            ? "API key saved in the operating-system credential store. Its value is hidden after saving."
            : "API key saved in this encrypted archive. The value is hidden after saving.",
        );
      }
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "The API key could not be saved.",
      );
    }
  }

  async function removeCredential(): Promise<void> {
    setProviderMessage("");
    try {
      const storage = credentialStorage();
      const removed = await props.onRemoveCredential(currentProvider().id, storage);
      if (removed) {
        if (storage === "system-keychain") setSystemCredentialSaved(false);
        setRequestPreview(null);
        setSendConfirmed(false);
        setProviderMessage(
          storage === "system-keychain"
            ? "Saved API key removed from the operating-system credential store."
            : "Saved API key removed from this archive.",
        );
      }
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : "The saved API key could not be removed.",
      );
    }
  }

  async function chooseEmbeddedModel(): Promise<void> {
    setEmbeddedMessage("");
    setEmbeddedBusy(true);
    try {
      const selected = await selectAndInspectEmbeddedModel();
      if (!selected) return;
      setEmbeddedModel(selected);
      setEmbeddedContextTokens(String(selected.contextTokens));
      setEmbeddedCpuThreads(String(Math.min(8, selected.maximumCpuThreads)));
      setEmbeddedMessage(
        "GGUF metadata checked. The model has not been loaded and nothing was downloaded.",
      );
    } catch (cause) {
      setEmbeddedMessage(
        cause instanceof Error ? cause.message : "The selected GGUF model could not be inspected.",
      );
    } finally {
      setEmbeddedBusy(false);
    }
  }

  async function loadSelectedEmbeddedModel(): Promise<void> {
    const selected = embeddedModel();
    if (!selected) return;
    const contextTokens = Number(embeddedContextTokens());
    const cpuThreads = Number(embeddedCpuThreads());
    if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(cpuThreads)) {
      setEmbeddedMessage("Enter whole numbers for context length and CPU threads.");
      return;
    }
    setEmbeddedBusy(true);
    setEmbeddedMessage("Loading the selected model into the local runtime…");
    try {
      const status = await loadEmbeddedModel(
        selected.authorizationToken,
        contextTokens,
        cpuThreads,
      );
      setEmbeddedStatus(status);
      setEmbeddedMessage(
        `${status.name ?? selected.name} is loaded in this app. Prompts stay on this device.`,
      );
    } catch (cause) {
      setEmbeddedMessage(
        cause instanceof Error ? cause.message : "The GGUF model could not be loaded.",
      );
    } finally {
      setEmbeddedBusy(false);
    }
  }

  async function useEmbeddedModel(): Promise<void> {
    const status = embeddedStatus();
    if (!status?.loaded || !status.modelId) return;
    setEmbeddedMessage("");
    try {
      const saved = await props.onSaveProvider({
        providerId: "embedded-gguf",
        endpoint: "tutorux://embedded/generate",
        model: status.modelId,
      });
      if (saved) {
        setProviderId("embedded-gguf");
        setProviderEndpoint("tutorux://embedded/generate");
        setProviderModel(status.modelId);
        setEmbeddedMessage(
          "Saved this offline model as the AI provider for the reviewed generation flow.",
        );
      }
    } catch (cause) {
      setEmbeddedMessage(
        cause instanceof Error
          ? cause.message
          : "The local model could not be saved as the AI provider.",
      );
    }
  }

  async function unloadSelectedEmbeddedModel(): Promise<void> {
    setEmbeddedBusy(true);
    setEmbeddedMessage("");
    try {
      setEmbeddedStatus(await unloadEmbeddedModel());
      setEmbeddedMessage("The local model was unloaded from memory.");
    } catch (cause) {
      setEmbeddedMessage(
        cause instanceof Error ? cause.message : "The local model could not be unloaded.",
      );
    } finally {
      setEmbeddedBusy(false);
    }
  }

  async function cancelLocalGeneration(): Promise<void> {
    setEmbeddedMessage("Cancellation requested. The runtime stops after its current model step.");
    await cancelEmbeddedAiGeneration().catch((cause: unknown) => {
      setEmbeddedMessage(
        cause instanceof Error ? cause.message : "Local generation could not be cancelled.",
      );
    });
  }

  function chooseCredentialStorage(storage: AiCredentialStorage): void {
    credentialStorageTouched = true;
    setCredentialStorage(storage);
    setCredentialInput("");
    setCredentialConfirmed(false);
    setRequestPreview(null);
    setRequestPreviewMessage("");
    setSendConfirmed(false);
    props.onClearExecution();
  }

  async function previewProviderRequest(): Promise<void> {
    const summary = review();
    const configuration = savedProvider();
    setRequestPreview(null);
    setRequestPreviewMessage("");
    setSendConfirmed(false);
    props.onClearExecution();
    if (!summary || !configuration) {
      setRequestPreviewMessage("Save provider settings and a model before reviewing a request.");
      return;
    }
    const storage = credentialStorage();
    let replicateInputSchema: ReplicateModelInputSchema | undefined;
    try {
      if (currentProvider().id === "replicate") {
        setReplicateSchemaInspecting(true);
        setRequestPreviewMessage("Checking the selected model’s supported inputs…");
        replicateInputSchema = await props.onInspectReplicateModel(
          currentProvider().id,
          configuration.fields.get("selected_model") ?? "",
          storage,
        );
      }
      const preview = await props.onCreateRequestPreview(
        summary.job,
        currentProvider().id,
        storage,
        replicateInputSchema,
      );
      setSystemCredentialSaved(storage === "system-keychain" && preview.credentialAvailable);
      setRequestPreview(preview);
      setRequestPreviewMessage("");
    } catch (cause) {
      setRequestPreviewMessage(
        cause instanceof Error ? cause.message : "The provider request preview could not be built.",
      );
    } finally {
      setReplicateSchemaInspecting(false);
    }
  }

  async function sendReviewedRequest(summary: AiPackageSummary): Promise<void> {
    const preview = requestPreview();
    if (!preview || !sendConfirmed() || !reviewed()) {
      setRequestPreviewMessage(
        "Review the package, then confirm the exact provider request before sending.",
      );
      return;
    }
    setRequestPreviewMessage("");
    props.onClearExecution();
    setSendProgressBytes(0);
    setSending(true);
    setCancelRequested(false);
    setShowResponse(false);
    try {
      await props.onSend(
        summary.job,
        summary.guideTemplateId,
        preview,
        preview.endpoint,
        preview.requestBodyHash,
        preview.localOnly ? "none" : credentialStorage(),
        setSendProgressBytes,
      );
      setSendConfirmed(false);
    } catch (cause) {
      setRequestPreviewMessage(
        cause instanceof Error ? cause.message : "The provider request could not be completed.",
      );
    } finally {
      setSending(false);
      setCancelRequested(false);
      if (preview.attachedImages.length > 0) {
        setRequestPreview(null);
        setSendConfirmed(false);
      }
    }
  }

  return (
    <div class="page-body ai-page">
      <section class="record-heading ai-heading">
        <div>
          <span class="eyebrow">PRIVATE BY DEFAULT</span>
          <h1>AI workspace</h1>
          <p>
            Prepare a source-linked study-guide handoff. Packages stay in your archive until you
            choose to export or send them.
          </p>
        </div>
        <div class="ai-state-pill">
          <span />
          {props.execution
            ? "Response saved"
            : props.busy && isEmbeddedGgufProvider(currentProvider().id)
              ? "Generating offline"
              : props.busy
                ? "Sending request"
                : "No request sent"}
        </div>
      </section>

      <section class="ai-intro-card" aria-label="Package privacy summary">
        <div class="ai-intro-icon" aria-hidden="true">
          ✳
        </div>
        <div>
          <strong>Review first. Share only when you choose.</strong>
          <p>
            A package contains the selected session, its transcripts, observations, evidence,
            material names, and limited learning-profile context. It excludes private tutor notes
            and material file bytes. Preparing or saving it makes no network request.
          </p>
        </div>
      </section>

      <section class="ai-panel ai-provider-panel" aria-labelledby="ai-provider-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">LOCAL SETUP · NO CONNECTION TEST</span>
            <h2 id="ai-provider-title">Provider settings</h2>
          </div>
          <span class="ai-provider-status">
            {savedProvider() ? "Configured" : "Not configured"}
          </span>
        </div>
        <p class="ai-provider-intro">
          Save a provider and model for a future reviewed request. This setup does not connect to a
          service or send session data.
        </p>
        <div class="ai-form-grid">
          <label class="ai-field">
            <span>Provider</span>
            <select
              aria-label="AI provider"
              value={providerId()}
              disabled={props.disabled || props.busy}
              onChange={(event) => {
                setProviderMessage("");
                setProviderId(event.currentTarget.value);
              }}
            >
              <For
                each={AI_PROVIDERS.filter(
                  (provider) => embeddedAvailable || !isEmbeddedGgufProvider(provider.id),
                )}
              >
                {(provider) => <option value={provider.id}>{provider.name}</option>}
              </For>
            </select>
          </label>
          <label class="ai-field">
            <span>Model ID</span>
            <input
              aria-label="AI model ID"
              type="text"
              value={providerModel()}
              maxlength={1024}
              placeholder={
                isEmbeddedGgufProvider(currentProvider().id)
                  ? "Load a model below"
                  : "Enter the model ID provided by the service"
              }
              disabled={
                props.disabled || props.busy || isEmbeddedGgufProvider(currentProvider().id)
              }
              onInput={(event) => {
                setProviderModel(event.currentTarget.value);
                setRequestPreview(null);
                setRequestPreviewMessage("");
                setSendConfirmed(false);
                props.onClearExecution();
              }}
            />
          </label>
          <label class="ai-field ai-provider-endpoint">
            <span>Endpoint</span>
            <input
              aria-label="Provider endpoint"
              type="url"
              value={providerEndpoint()}
              maxlength={2048}
              placeholder={
                currentProvider().endpointPlaceholder ||
                currentProvider().defaultEndpoint ||
                "https://provider.example/v1"
              }
              disabled={
                props.disabled || props.busy || isEmbeddedGgufProvider(currentProvider().id)
              }
              onInput={(event) => {
                setProviderEndpoint(event.currentTarget.value);
                setRequestPreview(null);
                setRequestPreviewMessage("");
                setSendConfirmed(false);
                props.onClearExecution();
              }}
            />
          </label>
        </div>
        <section class="ai-model-catalog" aria-labelledby="ai-model-catalog-title">
          <div class="ai-model-catalog-heading">
            <div>
              <span class="eyebrow">OPTIONAL · PUBLIC METADATA ONLY</span>
              <h3 id="ai-model-catalog-title">Model catalog</h3>
            </div>
            <button
              class="button button-outline"
              type="button"
              aria-expanded={catalogVisible()}
              aria-controls="ai-model-catalog-browser"
              disabled={props.disabled || props.busy}
              onClick={() => {
                if (catalogVisible()) {
                  catalogRequestVersion += 1;
                  catalogController?.abort();
                  catalogController = undefined;
                  setCatalogLoading(false);
                  setCatalogVisible(false);
                } else {
                  void openModelCatalog();
                }
              }}
            >
              {catalogVisible()
                ? "Close catalog"
                : hasAiModelCatalog(currentProvider().id)
                  ? "Browse models"
                  : "Catalog unavailable"}
            </button>
          </div>
          <p class="ai-model-catalog-intro">
            Browse public model metadata from models.dev. This sends only a fixed catalog request:
            no archive data, session text, endpoint, or API key. You can always enter a model ID
            above.
          </p>
          <Show when={catalogVisible()}>
            <div id="ai-model-catalog-browser" class="ai-model-catalog-browser">
              <div class="ai-model-catalog-tools">
                <label class="ai-field ai-model-catalog-search">
                  <span>Filter models</span>
                  <input
                    type="search"
                    value={catalogQuery()}
                    placeholder="Search model, publisher, or tokenizer"
                    onInput={(event) => setCatalogQuery(event.currentTarget.value)}
                    disabled={catalogLoading() || catalogModels().length === 0}
                  />
                </label>
                <label class="ai-field ai-model-catalog-filter">
                  <span>Capability</span>
                  <select
                    value={catalogCapability()}
                    disabled={catalogLoading() || catalogModels().length === 0}
                    onChange={(event) =>
                      setCatalogCapability(event.currentTarget.value as "all" | "vision" | "tools")
                    }
                  >
                    <option value="all">All listed models</option>
                    <option value="vision">Image or video input</option>
                    <option value="tools">Tool calling</option>
                  </select>
                </label>
                <button
                  class="button button-quiet ai-model-catalog-refresh"
                  type="button"
                  disabled={catalogLoading() || !hasAiModelCatalog(currentProvider().id)}
                  onClick={() => void openModelCatalog(true)}
                >
                  {catalogLoading() ? "Loading…" : "Refresh catalog"}
                </button>
              </div>
              <Show when={catalogLoading()}>
                <p class="ai-model-catalog-status" role="status">
                  Loading public model metadata…
                </p>
              </Show>
              <Show when={catalogMessage()}>
                <p class="ai-model-catalog-status" role="status">
                  {catalogMessage()}
                </p>
              </Show>
              <Show when={catalogModels().length > 0}>
                <div class="ai-model-catalog-results">
                  <div class="ai-model-catalog-count" aria-live="polite">
                    Showing {visibleCatalogModels().length.toLocaleString()} of{" "}
                    {catalogModels().length.toLocaleString()} listed models
                    {visibleCatalogModels().length === 100
                      ? " · refine the search to see more"
                      : ""}
                  </div>
                  <div
                    class="ai-model-catalog-list"
                    role="listbox"
                    aria-label="Public provider models"
                  >
                    <For each={visibleCatalogModels()}>
                      {(model) => (
                        <button
                          class="ai-model-catalog-option"
                          type="button"
                          role="option"
                          aria-selected={providerModel() === model.id}
                          onClick={() => chooseCatalogModel(model)}
                        >
                          <span class="ai-model-catalog-option-heading">
                            <strong>{model.id}</strong>
                            <span>{model.owner}</span>
                          </span>
                          <span class="ai-model-catalog-tags">
                            <span>{model.status}</span>
                            <Show when={model.contextWindow}>
                              {(tokens) => <span>{tokens().toLocaleString()} context</span>}
                            </Show>
                            <Show when={model.maximumOutputTokens}>
                              {(tokens) => <span>{tokens().toLocaleString()} max output</span>}
                            </Show>
                            <Show when={model.inputModalities.length > 0}>
                              <span>in: {model.inputModalities.join(", ")}</span>
                            </Show>
                            <Show when={model.outputModalities.length > 0}>
                              <span>out: {model.outputModalities.join(", ")}</span>
                            </Show>
                            <Show when={model.toolSupport === true}>
                              <span>tool calling</span>
                            </Show>
                            <Show when={model.inputCost !== null || model.outputCost !== null}>
                              <span>
                                Catalog pricing values · in {formatCatalogPrice(model.inputCost)} ·
                                out {formatCatalogPrice(model.outputCost)}
                              </span>
                            </Show>
                          </span>
                          <span class="ai-model-catalog-source">
                            Metadata by models.dev · availability is not verified
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={visibleCatalogModels().length === 0}>
                    <p class="ai-model-catalog-empty">
                      No models match these filters. Try a broader search.
                    </p>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </section>
        <div class="ai-provider-protocol">
          <span>{currentProvider().protocol}</span>
          <span>
            {isEmbeddedGgufProvider(currentProvider().id)
              ? "On-device only"
              : currentProvider().local
                ? "Loopback only"
                : "HTTPS only"}
          </span>
        </div>
        <Show when={!currentProvider().local}>
          <div class="ai-credential-box">
            <div class="ai-credential-copy">
              <strong>API key</strong>
              <span>
                {credentialSaved()
                  ? credentialStorage() === "system-keychain"
                    ? "A key is saved in this device’s operating-system credential store. Its value is never shown here."
                    : "A key is saved in this encrypted archive. Its value is never shown here."
                  : credentialStorage() === "system-keychain"
                    ? "Save this key in the device’s secure credential store. It stays out of the archive."
                    : props.encrypted
                      ? "Save this key inside the encrypted archive so it travels with the archive."
                      : "Encrypt this archive before saving an API key there."}
              </span>
            </div>
            <fieldset class="ai-credential-storage">
              <legend>Store this key in</legend>
              <Show when={props.systemCredentialStoreAvailable}>
                <label>
                  <input
                    type="radio"
                    name="ai-credential-storage"
                    value="system-keychain"
                    checked={credentialStorage() === "system-keychain"}
                    disabled={props.disabled || props.busy}
                    onChange={() => chooseCredentialStorage("system-keychain")}
                  />
                  <span>
                    System credential store <small>This device · recommended</small>
                  </span>
                </label>
              </Show>
              <label>
                <input
                  type="radio"
                  name="ai-credential-storage"
                  value="encrypted-archive"
                  checked={credentialStorage() === "encrypted-archive"}
                  disabled={props.disabled || props.busy || !props.encrypted}
                  onChange={() => chooseCredentialStorage("encrypted-archive")}
                />
                <span>
                  Encrypted archive <small>Portable with this archive</small>
                </span>
              </label>
            </fieldset>
            <Show
              when={credentialSaved()}
              fallback={
                <div class="ai-credential-editor">
                  <input
                    aria-label="Provider API key"
                    type="password"
                    autocomplete="new-password"
                    spellcheck={false}
                    value={credentialInput()}
                    maxlength={4096}
                    placeholder="Paste an API key"
                    disabled={props.disabled || props.busy || !canSaveCredential()}
                    onInput={(event) => setCredentialInput(event.currentTarget.value)}
                  />
                  <label class="ai-review-consent ai-credential-consent">
                    <input
                      type="checkbox"
                      checked={credentialConfirmed()}
                      disabled={props.disabled || props.busy || !canSaveCredential()}
                      onChange={(event) => setCredentialConfirmed(event.currentTarget.checked)}
                    />
                    <span>
                      {credentialStorage() === "system-keychain"
                        ? "I understand this key will be stored in the operating-system credential store for this device."
                        : "I understand this key will be stored inside the encrypted archive."}
                    </span>
                  </label>
                  <button
                    class="button button-outline"
                    type="button"
                    disabled={
                      props.disabled || props.busy || !canSaveCredential() || !credentialInput()
                    }
                    onClick={() => void saveCredential()}
                  >
                    {credentialStorage() === "system-keychain"
                      ? "Save to system credential store"
                      : "Save key securely"}
                  </button>
                </div>
              }
            >
              <button
                class="button button-quiet ai-remove-key"
                type="button"
                disabled={props.disabled || props.busy}
                onClick={() => void removeCredential()}
              >
                Remove saved key
              </button>
            </Show>
          </div>
        </Show>
        <div class="ai-provider-footer">
          <p>
            {isEmbeddedGgufProvider(currentProvider().id)
              ? "The model file remains at its selected location. Tutorux stores a local model reference in this archive; model prompts are evaluated inside the desktop process and are never sent to a service."
              : `${currentProvider().description}. Endpoint and model settings are archive records; API keys use the selected secure store. System-stored keys are available to Tutorux on this device; encrypted-archive keys move with the archive.`}
          </p>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || props.busy}
            onClick={() => void saveProvider()}
          >
            Save provider settings
          </button>
        </div>
        <Show when={providerMessage()}>
          <p class="ai-message" role="status">
            {providerMessage()}
          </p>
        </Show>
        <Show when={embeddedAvailable}>
          <section class="ai-embedded-model" aria-labelledby="ai-embedded-model-title">
            <div class="ai-panel-heading">
              <div>
                <span class="eyebrow">ON THIS DEVICE · NO DOWNLOADS</span>
                <h3 id="ai-embedded-model-title">In-process GGUF model</h3>
              </div>
              <span class="ai-provider-status">
                {embeddedStatus()?.loaded ? "Loaded" : "Not loaded"}
              </span>
            </div>
            <p>
              Choose a GGUF file you already have. Tutorux validates the file and keeps inference
              inside the app. Model memory uses a conservative estimate with a 64 GiB ceiling.
            </p>
            <div class="ai-embedded-model-controls">
              <button
                class="button button-outline"
                type="button"
                disabled={props.disabled || props.busy || embeddedBusy()}
                onClick={() => void chooseEmbeddedModel()}
              >
                {embeddedModel() ? "Choose another GGUF file" : "Choose GGUF model"}
              </button>
              <Show when={embeddedModel()}>
                {(model) => (
                  <div class="ai-embedded-model-details">
                    <strong>{model().name}</strong>
                    <span>
                      {model().architecture} · {formatBytes(model().fileSizeBytes)} ·{" "}
                      {model().tensorCount.toLocaleString()} tensors
                    </span>
                    <span>
                      Estimated memory at 4,096 context tokens:{" "}
                      {formatBytes(model().estimatedMemoryBytes)}
                    </span>
                  </div>
                )}
              </Show>
            </div>
            <Show when={embeddedModel()}>
              <div class="ai-form-grid ai-embedded-limits">
                <label class="ai-field">
                  <span>Context tokens (32–32,768)</span>
                  <input
                    type="number"
                    min="32"
                    max="32768"
                    step="256"
                    value={embeddedContextTokens()}
                    disabled={props.disabled || props.busy || embeddedBusy()}
                    onInput={(event) => setEmbeddedContextTokens(event.currentTarget.value)}
                  />
                </label>
                <label class="ai-field">
                  <span>CPU threads (1–16)</span>
                  <input
                    type="number"
                    min="1"
                    max="16"
                    step="1"
                    value={embeddedCpuThreads()}
                    disabled={props.disabled || props.busy || embeddedBusy()}
                    onInput={(event) => setEmbeddedCpuThreads(event.currentTarget.value)}
                  />
                </label>
                <button
                  class="button button-primary"
                  type="button"
                  disabled={props.disabled || props.busy || embeddedBusy()}
                  onClick={() => void loadSelectedEmbeddedModel()}
                >
                  Load model locally
                </button>
              </div>
            </Show>
            <Show when={embeddedStatus()?.loaded}>
              <div class="ai-embedded-model-active">
                <span>
                  {embeddedStatus()?.name} · {embeddedStatus()?.contextTokens?.toLocaleString()}{" "}
                  context · {embeddedStatus()?.cpuThreads} CPU threads ·{" "}
                  {formatBytes(embeddedStatus()?.memoryEstimateBytes ?? 0)} estimated
                </span>
                <button
                  class="button button-outline"
                  type="button"
                  disabled={props.disabled || props.busy || embeddedBusy()}
                  onClick={() => void useEmbeddedModel()}
                >
                  Use in reviewed AI requests
                </button>
                <button
                  class="button button-quiet"
                  type="button"
                  disabled={props.busy || embeddedBusy()}
                  onClick={() => void unloadSelectedEmbeddedModel()}
                >
                  Unload model
                </button>
              </div>
            </Show>
            <Show when={props.busy && isEmbeddedGgufProvider(currentProvider().id)}>
              <button
                class="button button-quiet ai-embedded-cancel"
                type="button"
                onClick={() => void cancelLocalGeneration()}
              >
                Cancel local generation
              </button>
            </Show>
            <Show when={embeddedMessage()}>
              <p class="ai-message" role="status">
                {embeddedMessage()}
              </p>
            </Show>
          </section>
        </Show>
      </section>

      <section class="ai-panel" aria-labelledby="ai-prepare-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">NO API KEY REQUIRED</span>
            <h2 id="ai-prepare-title">Prepare a guide package</h2>
          </div>
          <span class="ai-step-marker">
            01 <i /> 02 <i /> 03
          </span>
        </div>
        <div class="ai-form-grid">
          <label class="ai-field">
            <span>Session</span>
            <select
              aria-label="Session to prepare"
              value={sessionId()}
              disabled={props.disabled || props.busy || props.sessions.length === 0}
              onChange={(event) => {
                setSessionId(event.currentTarget.value);
                setSelectedImageIds([]);
                setReview(null);
                setReviewed(false);
                setRequestPreview(null);
                setRequestPreviewMessage("");
                setSendConfirmed(false);
              }}
            >
              <option value="">Choose a session…</option>
              <For each={props.sessions}>
                {(session) => (
                  <option value={session.id}>
                    {session.fields.get("title") ||
                      session.fields.get("subject") ||
                      "Untitled session"}
                    {session.fields.get("started_at_us")
                      ? ` · ${formatDate(session.fields.get("started_at_us") ?? "")}`
                      : ""}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="ai-field">
            <span>Guide structure</span>
            <select
              value={templateId()}
              disabled={props.disabled || props.busy}
              onChange={(event) => {
                setTemplateId(event.currentTarget.value);
                setReview(null);
                setReviewed(false);
                setRequestPreview(null);
                setRequestPreviewMessage("");
                setSendConfirmed(false);
              }}
            >
              <option value="auto">Choose from student preference and session subject</option>
              <For each={templates()}>
                {(template) => <option value={template.id}>{template.name}</option>}
              </For>
            </select>
          </label>
        </div>
        <fieldset class="ai-image-picker" disabled={props.disabled || props.busy || !sessionId()}>
          <legend>Include session images in a reviewed AI request</legend>
          <p>
            Images stay in your archive until you review and authorize a provider request. Select up
            to {MAX_AI_IMAGE_ATTACHMENT_COUNT} PNG, JPEG, or WebP images,{" "}
            {formatBytes(MAX_AI_IMAGE_ATTACHMENT_BYTES)} total. Image requests require a
            vision-capable model; for Ollama, choose a vision model.
          </p>
          <Show
            when={sessionImages().length > 0}
            fallback={
              <span class="ai-image-empty">This session has no eligible image materials.</span>
            }
          >
            <div class="ai-image-options">
              <For each={sessionImages()}>
                {(asset) => {
                  const filename = asset.fields.get("filename") || "Untitled image";
                  const size = Number(asset.fields.get("byte_size") ?? 0);
                  const checked = () => selectedImageIds().includes(asset.id.toLowerCase());
                  const capacityExceeded = () =>
                    !checked() &&
                    (selectedImages().length >= MAX_AI_IMAGE_ATTACHMENT_COUNT ||
                      selectedImageBytes() + size > MAX_AI_IMAGE_ATTACHMENT_BYTES);
                  return (
                    <label class="ai-image-option">
                      <input
                        type="checkbox"
                        checked={checked()}
                        disabled={capacityExceeded()}
                        onChange={(event) => {
                          const next = new Set(selectedImageIds());
                          if (event.currentTarget.checked) next.add(asset.id.toLowerCase());
                          else next.delete(asset.id.toLowerCase());
                          setSelectedImageIds([...next]);
                          setReview(null);
                          setReviewed(false);
                          setRequestPreview(null);
                          setSendConfirmed(false);
                        }}
                      />
                      <span class="ai-image-option-copy">
                        <strong>{filename}</strong>
                        <small>
                          {formatBytes(size)} · {asset.fields.get("mime_type")}
                        </small>
                      </span>
                    </label>
                  );
                }}
              </For>
            </div>
          </Show>
          <span class="ai-image-selection-count" aria-live="polite">
            {selectedImages().length} selected · {formatBytes(selectedImageBytes())}
          </span>
        </fieldset>
        <div class="ai-form-footer">
          <p>Session source text is treated as untrusted content in the package instructions.</p>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || props.busy || !sessionId()}
            onClick={() => void prepare()}
          >
            {props.busy ? "Preparing…" : "Prepare for review"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <Show when={message()}>
          <p class="ai-message" role="status">
            {message()}
          </p>
        </Show>
      </section>

      <Show when={review()}>
        {(summary) => (
          <section class="ai-review-card" aria-labelledby="ai-review-title">
            <div class="ai-review-heading">
              <div>
                <span class="eyebrow">PACKAGE READY FOR YOUR REVIEW</span>
                <h2 id="ai-review-title">{summary().guideTemplateName}</h2>
              </div>
              <span class="ai-hash-label">SHA-256 · {summary().contentHash.slice(0, 16)}…</span>
            </div>
            <div class="ai-review-stats">
              <ReviewStat label="Transcript cues" value={summary().transcriptCount} />
              <ReviewStat label="Observations" value={summary().annotationCount} />
              <ReviewStat label="Evidence items" value={summary().evidenceCount} />
              <ReviewStat label="Material names" value={summary().assetCount} />
              <ReviewStat label="Images for request" value={summary().attachedImages.length} />
              <ReviewStat label="Package size" value={formatBytes(summary().byteLength)} />
            </div>
            <details
              class="ai-json-disclosure"
              onToggle={(event) => setShowJson((event.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>Inspect the complete package JSON</summary>
              <Show when={showJson()}>
                <textarea
                  aria-label="Complete AI package JSON"
                  readOnly
                  value={aiPackageText(summary().job)}
                />
              </Show>
            </details>
            <div class="ai-request-review-callout">
              <div>
                <strong>Provider request review</strong>
                <p>
                  Build the exact request for the saved provider, including selected image payloads
                  when present. For Replicate, schema inspection sends only the saved model ID and
                  API key to Replicate; the study package stays local until you authorize its
                  prediction request. Browser builds may be blocked by provider CORS settings.
                </p>
              </div>
              <button
                class="button button-outline"
                type="button"
                disabled={
                  props.disabled ||
                  props.busy ||
                  sending() ||
                  replicateSchemaInspecting() ||
                  !savedProvider() ||
                  !savedProvider()?.fields.get("selected_model")
                }
                onClick={() => void previewProviderRequest()}
              >
                {replicateSchemaInspecting()
                  ? "Inspecting model inputs…"
                  : currentProvider().id === "replicate"
                    ? "Inspect inputs and preview"
                    : "Preview exact request"}
              </button>
            </div>
            <Show when={requestPreview()}>
              {(preview) => (
                <section class="ai-request-preview" aria-labelledby="ai-request-preview-title">
                  <div class="ai-request-preview-heading">
                    <div>
                      <span class="eyebrow">
                        {preview().providerId === "replicate"
                          ? "SCHEMA CHECK COMPLETE · PREDICTION NOT SENT"
                          : "NO REQUEST SENT"}
                      </span>
                      <h3 id="ai-request-preview-title">Request ready for review</h3>
                    </div>
                    <span class="ai-request-protocol">{preview().providerName}</span>
                  </div>
                  <dl class="ai-request-facts">
                    <div>
                      <dt>Method and endpoint</dt>
                      <dd>
                        {preview().method} {preview().endpoint}
                      </dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>{preview().model}</dd>
                    </div>
                    <div>
                      <dt>Authentication</dt>
                      <dd>{preview().authentication}</dd>
                    </div>
                    <div>
                      <dt>Exact body SHA-256</dt>
                      <dd class="ai-request-hash">{preview().requestBodyHash}</dd>
                    </div>
                    <div>
                      <dt>Package and request size</dt>
                      <dd>
                        {formatBytes(preview().packageBytes)} package ·{" "}
                        {formatBytes(preview().requestBytes)} request
                      </dd>
                    </div>
                  </dl>
                  <Show when={preview().attachedImages.length > 0}>
                    <div class="ai-request-images" aria-label="Attached image materials">
                      <strong>Images included in this request</strong>
                      <For each={preview().attachedImages}>
                        {(image) => (
                          <div>
                            <span>
                              {image.filename} · {formatBytes(image.byteSize)}
                            </span>
                            <code>SHA-256 · {image.contentHash}</code>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="ai-request-headers" aria-label="Request headers">
                    <strong>Headers sent</strong>
                    <For each={preview().headers}>
                      {(header) => (
                        <span>
                          <code>{header.name}</code> {header.valueDescription}
                        </span>
                      )}
                    </For>
                  </div>
                  <Show when={!preview().localOnly && !preview().credentialAvailable}>
                    <p class="ai-request-key-missing" role="status">
                      No API key is saved for this provider. A request cannot be sent until a key is
                      available in the selected secure store.
                    </p>
                  </Show>
                  <Show
                    when={preview().attachedImages.length === 0}
                    fallback={
                      <p class="ai-image-body-note">
                        The exact request body hash covers the package text and selected image
                        bytes. Image data is sent as base64 and is omitted from this text preview.
                      </p>
                    }
                  >
                    <details class="ai-json-disclosure ai-request-body-disclosure">
                      <summary>Inspect the exact provider request JSON</summary>
                      <textarea
                        aria-label="Exact provider request body"
                        readOnly
                        value={preview().requestBody}
                      />
                    </details>
                  </Show>
                  <p class="ai-request-privacy-note">
                    The request body contains the reviewed package text
                    {preview().attachedImages.length > 0 ? " and selected image bytes" : ""}.
                    Authentication secrets stay out of this preview.{" "}
                    {preview().providerId === "replicate"
                      ? "The saved key was used only for model-schema inspection; no package was sent."
                      : "The key is not read during preparation."}
                  </p>
                  <Show when={preview().providerId === "replicate"}>
                    <p class="ai-request-privacy-note">
                      The selected input schema is version {preview().replicateInputSchema?.version}
                      . The prediction is pinned to this inspected version.
                      {preview().replicateInputSchema?.hasSystemPrompt
                        ? " Tutorux sends the package and system instructions in separate supported fields."
                        : " Tutorux combines the system instructions with the package in the prompt."}
                      {preview().replicateInputSchema?.tokenInput
                        ? ` The reviewed request sets ${preview().replicateInputSchema?.tokenInput} to ${preview().maxOutputTokens.toLocaleString()}.`
                        : " This model does not expose a supported output-token limit input."}
                    </p>
                    <p class="ai-request-privacy-note">
                      Replicate receives one prediction request followed by status checks until it
                      finishes. You can cancel an active prediction; Tutorux then sends Replicate a
                      cancellation request. Before sending, Tutorux checks that the model schema has
                      not changed. Static browser builds also depend on the provider allowing
                      requests from this app’s origin.
                    </p>
                  </Show>
                  <label class="ai-review-consent ai-send-consent">
                    <input
                      type="checkbox"
                      checked={sendConfirmed()}
                      disabled={
                        props.disabled ||
                        props.busy ||
                        (!preview().localOnly && !preview().credentialAvailable)
                      }
                      onChange={(event) => setSendConfirmed(event.currentTarget.checked)}
                    />
                    <span>
                      {preview().providerId === "replicate" ? (
                        <>
                          I authorize a Replicate prediction request containing the reviewed
                          package, bounded status checks, and a cancellation request if I cancel it.
                          Tutorux will recheck the model schema before sending and stop for a fresh
                          review if it changed. The initial request is sent to{" "}
                          <code>{preview().endpoint}</code>.
                        </>
                      ) : (
                        <>
                          I authorize one POST containing the reviewed package to{" "}
                          {preview().providerName} at <code>{preview().endpoint}</code>.
                        </>
                      )}{" "}
                      The exact request body hash is <code>{preview().requestBodyHash}</code>. The
                      complete response, including error or partial bytes, will be saved in this
                      archive.
                      {preview().attachedImages.length > 0
                        ? ` This request also includes ${preview().attachedImages.length} selected session image${preview().attachedImages.length === 1 ? "" : "s"}; their names and content hashes are listed above.`
                        : ""}
                      {preview().localOnly
                        ? " This sends the package to the loopback Ollama service."
                        : " This sends the package to the external provider with the saved API key."}
                    </span>
                  </label>
                  <div class="ai-send-actions">
                    <button
                      class="button button-primary"
                      type="button"
                      disabled={
                        props.disabled ||
                        props.busy ||
                        sending() ||
                        !sendConfirmed() ||
                        !reviewed() ||
                        (!preview().localOnly && !preview().credentialAvailable)
                      }
                      onClick={() => void sendReviewedRequest(summary())}
                    >
                      {props.busy ? "Sending and saving…" : "Send exact reviewed request"}
                    </button>
                    <span aria-live="polite">
                      {cancelRequested()
                        ? "Cancellation requested. Waiting for Replicate to confirm the prediction is stopped…"
                        : sendProgressBytes() > 0
                          ? `${formatBytes(sendProgressBytes())} received`
                          : !reviewed()
                            ? "Review and allow package storage below before sending."
                            : "No request is sent until you select this checkbox and button."}
                    </span>
                    <Show when={sending() && props.busy && preview().providerId === "replicate"}>
                      <button
                        class="button button-quiet"
                        type="button"
                        disabled={cancelRequested()}
                        onClick={() => {
                          setCancelRequested(true);
                          void cancelReplicatePrediction().catch((cause) => {
                            setCancelRequested(false);
                            setRequestPreviewMessage(
                              cause instanceof Error
                                ? cause.message
                                : "Replicate cancellation could not be requested.",
                            );
                          });
                        }}
                      >
                        {cancelRequested() ? "Cancellation requested…" : "Cancel prediction"}
                      </button>
                    </Show>
                  </div>
                </section>
              )}
            </Show>
            <Show when={requestPreviewMessage()}>
              <p class="ai-message" role="status">
                {requestPreviewMessage()}
              </p>
            </Show>
            <label class="ai-review-consent">
              <input
                type="checkbox"
                checked={reviewed()}
                onChange={(event) => setReviewed(event.currentTarget.checked)}
              />
              <span>
                I reviewed the package contents and want to store this copy in the selected archive.
              </span>
            </label>
            <div class="ai-review-actions">
              <button
                class="button button-quiet"
                type="button"
                onClick={() => {
                  setReview(null);
                  setRequestPreview(null);
                  setSendConfirmed(false);
                }}
              >
                Discard draft
              </button>
              <button
                class="button button-primary"
                type="button"
                disabled={!reviewed() || props.busy || props.disabled}
                onClick={() => void saveReview()}
              >
                Save reviewed package
              </button>
            </div>
          </section>
        )}
      </Show>

      <Show when={props.execution}>
        {(result) => (
          <section class="ai-generation-result" aria-labelledby="ai-generation-result-title">
            <div class="ai-request-preview-heading">
              <div>
                <span class="eyebrow">RESPONSE SAVED · REVIEW REQUIRED</span>
                <h2 id="ai-generation-result-title">
                  {result().guideId
                    ? "Proposed study guide is ready"
                    : "Provider response saved for review"}
                </h2>
              </div>
              <span class="ai-provider-status">{result().status.replaceAll("-", " ")}</span>
            </div>
            <p>
              {result().providerName} · {result().model} · {formatBytes(result().responseBytes)}
              {result().guideId
                ? ` · Guide ${result().guideId?.slice(0, 8)} is an unapproved draft in Study guides.`
                : " · The exact raw response bytes are saved in this archive for export."}
            </p>
            <dl class="ai-request-facts">
              <div>
                <dt>Guide structure</dt>
                <dd>
                  {result().guideId
                    ? result().schemaValid
                      ? "Structured response"
                      : "Editable text fallback"
                    : "No guide draft created"}
                </dd>
              </div>
              <div>
                <dt>Source validation</dt>
                <dd>{result().sourceValidation}</dd>
              </div>
              <div>
                <dt>Archived job</dt>
                <dd class="ai-request-hash">{result().jobId}</dd>
              </div>
            </dl>
            <Show when={!result().guideId}>
              <button
                class="button button-outline ai-export-button"
                type="button"
                disabled={props.disabled || props.busy}
                onClick={() => void download(result().jobId)}
              >
                Export raw response
              </button>
            </Show>
            <Show when={result().warnings.length > 0}>
              <ul class="ai-generation-warnings">
                <For each={result().warnings}>{(warning) => <li>{warning}</li>}</For>
              </ul>
            </Show>
            <details
              class="ai-json-disclosure ai-response-disclosure"
              onToggle={(event) =>
                setShowResponse((event.currentTarget as HTMLDetailsElement).open)
              }
            >
              <summary>Inspect generated text</summary>
              <Show when={showResponse() && result().guideId}>
                <textarea
                  aria-label="Generated guide text"
                  readOnly
                  value={result().responseText}
                />
                <Show when={result().responseTextTruncated}>
                  <span class="ai-response-truncated">
                    Showing the first {AI_RESPONSE_PREVIEW_CHARACTER_LIMIT.toLocaleString()}{" "}
                    characters. The complete provider response is kept in the archive.
                  </span>
                </Show>
              </Show>
            </details>
            <Show when={result().guideId}>
              <p class="ai-request-privacy-note">
                The generated guide remains a draft. Review every claim, recommendation, citation,
                and student-facing detail in Study guides before approval.
              </p>
            </Show>
          </section>
        )}
      </Show>

      <section class="ai-panel ai-history" aria-labelledby="ai-history-title">
        <div class="ai-panel-heading">
          <div>
            <span class="eyebrow">KEPT WITH YOUR WORKSPACE</span>
            <h2 id="ai-history-title">Prepared packages</h2>
          </div>
          <span class="ai-history-count">{latestJobs().length} recent</span>
        </div>
        <Show
          when={latestJobs().length > 0}
          fallback={
            <div class="ai-empty-state">
              <span aria-hidden="true">✳</span>
              <strong>No packages prepared yet</strong>
              <p>Choose a session above to create a source-linked package for your review.</p>
            </div>
          }
        >
          <div class="ai-job-list">
            <For each={latestJobs()}>
              {(job) => (
                <div class="ai-job-row">
                  <div class="ai-job-icon" aria-hidden="true">
                    ✳
                  </div>
                  <div class="ai-job-copy">
                    <strong>
                      {sessionLabel(props.sessions, job.fields.get("session_id") ?? "")}
                    </strong>
                    <span>
                      Saved {formatDate(job.fields.get("created_at_us") ?? "")} ·{" "}
                      {formatBytes(jobSize(job))}
                    </span>
                  </div>
                  <div class="ai-job-actions">
                    <button
                      class="button button-outline ai-export-button"
                      type="button"
                      disabled={props.disabled || props.busy}
                      onClick={() => void download(job.id)}
                    >
                      Export JSON
                    </button>
                    <button
                      class="button button-outline ai-export-button"
                      type="button"
                      disabled={props.disabled || props.busy}
                      onClick={() => void downloadMultipart(job.id)}
                    >
                      Export multipart handoff
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
      <Show when={latestRuns().length > 0}>
        <section class="ai-panel ai-history" aria-labelledby="ai-run-history-title">
          <div class="ai-panel-heading">
            <div>
              <span class="eyebrow">REVIEW BEFORE APPROVAL</span>
              <h2 id="ai-run-history-title">Provider responses</h2>
            </div>
            <span class="ai-history-count">{latestRuns().length} recent</span>
          </div>
          <div class="ai-job-list">
            <For each={latestRuns()}>
              {(job) => (
                <div class="ai-job-row">
                  <div class="ai-job-icon" aria-hidden="true">
                    ✳
                  </div>
                  <div class="ai-job-copy">
                    <strong>
                      {sessionLabel(props.sessions, job.fields.get("session_id") ?? "")}
                    </strong>
                    <span>
                      {job.fields.get("provider_id") ?? "Provider"} ·{" "}
                      {job.fields.get("model_id") ?? "Model unavailable"} ·{" "}
                      {job.fields.get("status")?.replaceAll("-", " ") ?? "Response saved"} ·{" "}
                      {formatDate(job.fields.get("created_at_us") ?? "")}
                    </span>
                  </div>
                  <button
                    class="button button-outline ai-export-button"
                    type="button"
                    disabled={props.disabled || props.busy}
                    onClick={() => void download(job.id)}
                  >
                    Export response
                  </button>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

function ReviewStat(props: { label: string; value: string | number }): JSX.Element {
  return (
    <div class="ai-review-stat">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function sessionLabel(sessions: readonly ArchiveRecord[], id: string): string {
  const session = sessions.find((item) => item.id.toLowerCase() === id.toLowerCase());
  return session?.fields.get("title") || session?.fields.get("subject") || "Session package";
}

function compareTimestamp(left: ArchiveRecord, right: ArchiveRecord): number {
  const a = parseTimestamp(left.fields.get("created_at_us"));
  const b = parseTimestamp(right.fields.get("created_at_us"));
  return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
}

function parseTimestamp(value: string | undefined): bigint {
  return value && /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

function formatDate(microseconds: string): string {
  try {
    const milliseconds = Number(BigInt(microseconds) / 1000n);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(milliseconds),
    );
  } catch {
    return "date unavailable";
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const megabytes = size / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
}

function formatCatalogPrice(value: number | null): string {
  return value === null
    ? "not listed"
    : `$${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value)}`;
}

function jobSize(job: ArchiveRecord): number {
  const parsed = Number(job.fields.get("package_bytes") ?? job.fields.get("response_bytes") ?? "");
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : job.blob.byteLength;
}
