import {
    bodyText,
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    card,
    chip,
    cn,
    eyebrow,
    heading1,
    heading2,
    heading3,
    helperText,
    inputBase,
    labelBase,
    selectBase,
    textareaBase,
} from "./ui";
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
import {
    listOllamaInstalledModels,
    testAiProviderConnection,
    type AiConnectionTest,
    type OllamaInstalledModel,
} from "./ai/ollama";
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
    onImportResponse?: (
        file: File,
        sessionId: string,
        templateId: string,
    ) => Promise<{
        jobId: string;
        guideId: string;
        status: string;
        warnings: readonly string[];
    }>;
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
    const [catalogCapability, setCatalogCapability] = createSignal<"all" | "vision" | "tools">(
        "all",
    );
    let catalogRequestVersion = 0;
    let catalogController: AbortController | undefined;
    const [providerMessage, setProviderMessage] = createSignal("");
    const [ollamaModels, setOllamaModels] = createSignal<readonly OllamaInstalledModel[]>([]);
    const [ollamaListing, setOllamaListing] = createSignal(false);
    const [connectionTest, setConnectionTest] = createSignal<AiConnectionTest | null>(null);
    const [connectionTesting, setConnectionTesting] = createSignal(false);
    const [importingResponse, setImportingResponse] = createSignal(false);
    const [importMessage, setImportMessage] = createSignal("");
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
        const query = catalogQuery().trim().toLowerCase();
        const capability = catalogCapability();
        return catalogModels()
            .filter((model) => {
                if (
                    capability === "vision" &&
                    !model.inputModalities.some(
                        (modality) => modality === "image" || modality === "video",
                    )
                ) {
                    return false;
                }
                if (capability === "tools" && model.toolSupport !== true) return false;
                return (
                    !query ||
                    model.id.toLowerCase().includes(query) ||
                    model.owner.toLowerCase().includes(query) ||
                    (model.tokenizer?.toLowerCase().includes(query) ?? false)
                );
            })
            .slice(0, 100);
    });
    createEffect(() => {
        if (props.systemCredentialStoreAvailable && !credentialStorageTouched) {
            setCredentialStorage("system-keychain");
        } else if (
            !props.systemCredentialStoreAvailable &&
            credentialStorage() === "system-keychain"
        ) {
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
        setOllamaModels([]);
        setConnectionTest(null);
        setImportMessage("");
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
                (left.fields.get("filename") ?? "").localeCompare(
                    right.fields.get("filename") ?? "",
                ),
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
            setMessage(
                cause instanceof Error ? cause.message : "The package could not be prepared.",
            );
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
            if (!job)
                throw new Error("That AI record is no longer available in the active archive.");
            const isPackage = job.fields.get("mode") === "manual";
            const text = isPackage ? aiPackageText(job) : undefined;
            const filename = `Tutorux-AI-${job.fields.get("session_id") ?? job.id}.${isPackage ? "json" : "txt"}`;
            const location = text
                ? await props.onExportTextFile(filename, text, "application/json")
                : await props.onExportBinaryFile(
                      filename,
                      job.blob.slice(),
                      "application/octet-stream",
                  );
            if (location)
                setMessage(`Exported AI ${isPackage ? "package" : "response"} to ${location}.`);
        } catch (cause) {
            setMessage(
                cause instanceof Error ? cause.message : "The package could not be exported.",
            );
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
            const location = await props.onExportTextFile(
                filename,
                handoff.markdown,
                "text/markdown",
            );
            if (location) {
                setMessage(
                    `Exported an ordered handoff with ${handoff.transcriptPartCount} transcript parts and ${handoff.promptCount} prompts (${formatBytes(handoff.outputBytes)}) to ${location}.`,
                );
            }
        } catch (cause) {
            setMessage(
                cause instanceof Error
                    ? cause.message
                    : "The multipart handoff could not be exported.",
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
                setProviderMessage(
                    "Provider settings saved. No connection test or request was made.",
                );
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
                    ? `${result.models.length.toLocaleString("en-US")} cached model records are shown because the catalog could not be reached. Metadata may be stale; verify availability and capabilities with your provider.`
                    : `${result.models.length.toLocaleString("en-US")} public model records loaded. Catalog metadata is informational and may be out of date; verify availability and capabilities with your provider.`,
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
            const saved = await props.onSaveCredential(
                currentProvider().id,
                credentialInput(),
                storage,
            );
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

    async function listInstalledOllamaModels(): Promise<void> {
        setOllamaListing(true);
        setProviderMessage("");
        setOllamaModels([]);
        try {
            const models = await listOllamaInstalledModels(providerEndpoint());
            setOllamaModels(models);
            setProviderMessage(
                models.length
                    ? `Ollama reported ${models.length} installed model${models.length === 1 ? "" : "s"}. Choose one to use its exact name.`
                    : "Ollama is reachable but reported no installed models.",
            );
        } catch (cause) {
            setProviderMessage(
                cause instanceof Error
                    ? cause.message
                    : "Ollama installed models could not be listed.",
            );
        } finally {
            setOllamaListing(false);
        }
    }

    async function checkProviderConnection(): Promise<void> {
        setConnectionTesting(true);
        setConnectionTest(null);
        setProviderMessage("");
        try {
            const result = await testAiProviderConnection(currentProvider().id, providerEndpoint());
            setConnectionTest(result);
            setProviderMessage(result.detail);
        } catch (cause) {
            setProviderMessage(
                cause instanceof Error
                    ? cause.message
                    : "The provider connection could not be checked.",
            );
        } finally {
            setConnectionTesting(false);
        }
    }

    async function importExternalResponse(file: File | undefined): Promise<void> {
        if (!file) return;
        setImportMessage("");
        if (!props.onImportResponse) {
            setImportMessage(
                "External response import needs the archive-connected desktop host. The selected file was not read.",
            );
            return;
        }
        if (file.size < 1 || file.size > 16 * 1024 * 1024) {
            setImportMessage("Choose a response file between 1 byte and 16 MiB.");
            return;
        }
        if (!sessionId()) {
            setImportMessage("Choose a session before importing an external response.");
            return;
        }
        setImportingResponse(true);
        try {
            const imported = await props.onImportResponse(
                file,
                sessionId(),
                templateId() === "auto" ? "general" : templateId(),
            );
            setImportMessage(
                `Imported response as ${imported.status}. Job ${imported.jobId.slice(0, 8)} and guide ${imported.guideId.slice(0, 8)} are saved for review.${imported.warnings.length ? ` ${imported.warnings.join(" ")}` : ""}`,
            );
        } catch (cause) {
            setImportMessage(
                cause instanceof Error
                    ? cause.message
                    : "The external response could not be imported.",
            );
        } finally {
            setImportingResponse(false);
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
                cause instanceof Error
                    ? cause.message
                    : "The selected GGUF model could not be inspected.",
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
        setEmbeddedMessage(
            "Cancellation requested. The runtime stops after its current model step.",
        );
        await cancelEmbeddedAiGeneration().catch((cause: unknown) => {
            setEmbeddedMessage(
                cause instanceof Error ? cause.message : "Local generation could not be canceled.",
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
            setRequestPreviewMessage(
                "Save provider settings and a model before reviewing a request.",
            );
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
                cause instanceof Error
                    ? cause.message
                    : "The provider request preview could not be built.",
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
                cause instanceof Error
                    ? cause.message
                    : "The provider request could not be completed.",
            );
        } finally {
            setSending(false);
            setCancelRequested(false);
            if ((preview.attachedAssets ?? preview.attachedImages).length > 0) {
                setRequestPreview(null);
                setSendConfirmed(false);
            }
        }
    }

    return (
        <div
            class={cn(
                "page-body ai-page",
                "mx-auto grid w-full max-w-[1120px] gap-5 px-5 pt-5 pb-[78px] sm:px-7 sm:pt-7 sm:pb-8 lg:px-9 lg:pb-10",
            )}
        >
            <section
                class={cn(
                    "record-heading ai-heading",
                    "mb-0 flex flex-wrap items-center justify-between gap-5 max-[760px]:items-start",
                )}
            >
                <div>
                    <span class={cn("eyebrow", eyebrow, "text-accent")}>Private by default</span>
                    <h1 class={cn(heading1, "mt-1.5")}>AI workspace</h1>
                    <p class={cn(bodyText, "mt-2 max-w-[610px] text-muted")}>
                        Prepare a source-linked study-guide handoff. Packages stay in your archive
                        until you choose to export or send them.
                    </p>
                </div>
                <div
                    class={cn(
                        "ai-state-pill",
                        "inline-flex items-center gap-2 self-start rounded-[5px] border border-line bg-surface px-2.5 py-2 text-xs font-semibold whitespace-nowrap text-muted",
                    )}
                >
                    <span class={"h-[7px] w-[7px] rounded-full bg-accent"} />
                    {props.execution
                        ? "Response saved"
                        : props.busy && isEmbeddedGgufProvider(currentProvider().id)
                          ? "Generating offline"
                          : props.busy
                            ? "Sending request"
                            : "No request sent"}
                </div>
            </section>

            <section
                class={cn("ai-intro-card", card, "flex items-start gap-3.5 px-5 py-[18px]")}
                aria-label="Package privacy summary"
            >
                <div
                    class={cn(
                        "ai-intro-icon",
                        "grid size-[34px] shrink-0 place-items-center rounded-[5px] bg-accent-soft text-[21px] leading-none text-accent",
                    )}
                    aria-hidden="true"
                >
                    ✳
                </div>
                <div>
                    <strong class={"block text-[13px] font-bold text-ink"}>
                        Review first. Share only when you choose.
                    </strong>
                    <p class={"mt-1.5 max-w-[830px] text-xs leading-relaxed text-muted"}>
                        A package contains the selected session, its transcripts, observations,
                        evidence, material names, and limited learning-profile context. It excludes
                        private tutor notes and material file bytes. Preparing or saving it makes no
                        network request.
                    </p>
                </div>
            </section>

            <section
                class={cn(
                    "ai-panel ai-provider-panel",
                    "grid min-w-0 gap-4 rounded-[5px] border border-accent/20 bg-surface p-[22px] max-[520px]:p-[17px]",
                )}
                aria-labelledby="ai-provider-title"
            >
                <div
                    class={cn(
                        "ai-panel-heading",
                        "flex flex-wrap items-start justify-between gap-[18px]",
                    )}
                >
                    <div>
                        <span class={eyebrow}>Local setup · no connection test</span>
                        <h2 id="ai-provider-title" class={cn(heading2, "mt-1")}>
                            Provider settings
                        </h2>
                    </div>
                    <span
                        class={cn(
                            "ai-provider-status",
                            "rounded-[5px] border border-line bg-surface-subtle px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-muted",
                        )}
                    >
                        {savedProvider() ? "Configured" : "Not configured"}
                    </span>
                </div>
                <p
                    class={cn(
                        "ai-provider-intro",
                        "max-w-[700px] text-xs leading-relaxed text-muted",
                    )}
                >
                    Save a provider and model for a future reviewed request. This setup does not
                    connect to a service or send session data.
                </p>
                <div class={cn("ai-form-grid", "mt-[18px] grid gap-4 min-[761px]:grid-cols-2")}>
                    <label class={cn("ai-field", labelBase)}>
                        <span>Provider</span>
                        <select
                            aria-label="AI provider"
                            value={providerId()}
                            disabled={props.disabled || props.busy}
                            onChange={(event) => {
                                setProviderMessage("");
                                setProviderId(event.currentTarget.value);
                            }}
                            class={selectBase}
                        >
                            <For
                                each={AI_PROVIDERS.filter(
                                    (provider) =>
                                        embeddedAvailable || !isEmbeddedGgufProvider(provider.id),
                                )}
                            >
                                {(provider) => <option value={provider.id}>{provider.name}</option>}
                            </For>
                        </select>
                    </label>
                    <label class={cn("ai-field", labelBase)}>
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
                                props.disabled ||
                                props.busy ||
                                isEmbeddedGgufProvider(currentProvider().id)
                            }
                            onInput={(event) => {
                                setProviderModel(event.currentTarget.value);
                                setRequestPreview(null);
                                setRequestPreviewMessage("");
                                setSendConfirmed(false);
                                props.onClearExecution();
                            }}
                            class={inputBase}
                        />
                    </label>
                    <label class={cn("ai-field ai-provider-endpoint", labelBase, "sm:col-span-2")}>
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
                                props.disabled ||
                                props.busy ||
                                isEmbeddedGgufProvider(currentProvider().id)
                            }
                            onInput={(event) => {
                                setProviderEndpoint(event.currentTarget.value);
                                setRequestPreview(null);
                                setRequestPreviewMessage("");
                                setSendConfirmed(false);
                                props.onClearExecution();
                            }}
                            class={inputBase}
                        />
                    </label>
                </div>
                <div
                    class={cn(
                        "ai-review-actions",
                        "mt-[18px] flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end",
                    )}
                >
                    <button
                        class={cn("button button-outline", buttonOutline)}
                        type="button"
                        disabled={props.disabled || props.busy || connectionTesting()}
                        onClick={() => void checkProviderConnection()}
                    >
                        {connectionTesting() ? "Testing connection…" : "Test provider connection"}
                    </button>
                    <Show when={currentProvider().id === "ollama"}>
                        <button
                            class={cn("button button-outline", buttonOutline)}
                            type="button"
                            disabled={props.disabled || props.busy || ollamaListing()}
                            onClick={() => void listInstalledOllamaModels()}
                        >
                            {ollamaListing()
                                ? "Listing installed models…"
                                : "List installed Ollama models"}
                        </button>
                    </Show>
                    <span aria-live="polite" class={cn(helperText, "self-center")}>
                        {connectionTest()
                            ? connectionTest()!.detail
                            : "Connection checks send no archive data and do not read saved API keys."}
                    </span>
                </div>
                <Show when={ollamaModels().length > 0}>
                    <div class={cn("ai-model-catalog-results", "grid gap-2")}>
                        <div
                            class={cn("ai-model-catalog-count", "text-xs tabular-nums text-faint")}
                        >
                            Installed Ollama models · choose one to fill the model ID
                        </div>
                        <div
                            class={cn(
                                "ai-model-catalog-list",
                                "grid max-h-[380px] gap-1.5 overflow-auto overscroll-contain p-0.5",
                            )}
                            role="listbox"
                            aria-label="Installed Ollama models"
                        >
                            <For each={ollamaModels()}>
                                {(model) => (
                                    <button
                                        class={cn(
                                            "ai-model-catalog-option",
                                            "grid w-full gap-2 rounded-[5px] border border-line bg-surface px-3 py-[11px] text-left text-ink-soft transition-colors hover:border-accent/50 hover:bg-accent-soft/40 aria-selected:border-accent/50 aria-selected:bg-accent-soft/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                                        )}
                                        type="button"
                                        role="option"
                                        aria-selected={providerModel() === model.name}
                                        onClick={() => {
                                            setProviderModel(model.name);
                                            setRequestPreview(null);
                                            setSendConfirmed(false);
                                            setProviderMessage(
                                                `${model.name} selected. Save provider settings to use it.`,
                                            );
                                        }}
                                    >
                                        <span
                                            class={cn(
                                                "ai-model-catalog-option-heading",
                                                "flex min-w-0 flex-wrap items-start justify-between gap-3",
                                            )}
                                        >
                                            <strong
                                                class={"break-words text-xs font-semibold text-ink"}
                                            >
                                                {model.name}
                                            </strong>
                                            <span class={"shrink-0 text-xs text-muted"}>
                                                {model.family || "unknown family"}
                                            </span>
                                        </span>
                                        <span
                                            class={cn(
                                                "ai-model-catalog-tags",
                                                "flex flex-wrap gap-1.5",
                                            )}
                                        >
                                            <Show when={model.parameterSize}>
                                                <span class={chip}>{model.parameterSize}</span>
                                            </Show>
                                            <Show when={model.quantization}>
                                                <span class={chip}>{model.quantization}</span>
                                            </Show>
                                            <Show when={model.sizeBytes !== null}>
                                                <span class={chip}>
                                                    {formatBytes(model.sizeBytes!)}
                                                </span>
                                            </Show>
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>
                <section
                    class={cn(
                        "ai-model-catalog",
                        "mt-[17px] grid gap-2.5 rounded-[5px] border border-line-soft bg-surface-subtle p-[15px]",
                    )}
                    aria-labelledby="ai-model-catalog-title"
                >
                    <div
                        class={cn(
                            "ai-model-catalog-heading",
                            "flex flex-wrap items-center justify-between gap-3 max-[520px]:flex-col max-[520px]:items-start",
                        )}
                    >
                        <div>
                            <span class={eyebrow}>Optional · public metadata only</span>
                            <h3 id="ai-model-catalog-title" class={cn(heading3, "mt-1")}>
                                Model catalog
                            </h3>
                        </div>
                        <button
                            class={cn(
                                "button button-outline",
                                buttonOutline,
                                "min-h-[34px] text-xs max-[520px]:w-full",
                            )}
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
                    <p class={cn("ai-model-catalog-intro", helperText)}>
                        Browse public model metadata from models.dev. This sends only a fixed
                        catalog request: no archive data, session text, endpoint, or API key. You
                        can always enter a model ID above.
                    </p>
                    <Show when={catalogVisible()}>
                        <div
                            id="ai-model-catalog-browser"
                            class={cn(
                                "ai-model-catalog-browser",
                                "grid gap-[11px] border-t border-line-soft pt-3",
                            )}
                        >
                            <div
                                class={cn(
                                    "ai-model-catalog-tools",
                                    "grid grid-cols-1 items-end gap-2.5 min-[521px]:grid-cols-2 min-[761px]:grid-cols-[minmax(0,1fr)_170px_auto]",
                                )}
                            >
                                <label class={cn("ai-field ai-model-catalog-search", labelBase)}>
                                    <span>Filter models</span>
                                    <input
                                        type="search"
                                        value={catalogQuery()}
                                        placeholder="Search model, publisher, or tokenizer"
                                        onInput={(event) =>
                                            setCatalogQuery(event.currentTarget.value)
                                        }
                                        disabled={catalogLoading() || catalogModels().length === 0}
                                        class={inputBase}
                                    />
                                </label>
                                <label class={cn("ai-field ai-model-catalog-filter", labelBase)}>
                                    <span>Capability</span>
                                    <select
                                        value={catalogCapability()}
                                        disabled={catalogLoading() || catalogModels().length === 0}
                                        onChange={(event) =>
                                            setCatalogCapability(
                                                event.currentTarget.value as
                                                    | "all"
                                                    | "vision"
                                                    | "tools",
                                            )
                                        }
                                        class={selectBase}
                                    >
                                        <option value="all">All listed models</option>
                                        <option value="vision">Image or video input</option>
                                        <option value="tools">Tool calling</option>
                                    </select>
                                </label>
                                <button
                                    class={cn(
                                        "button button-quiet ai-model-catalog-refresh",
                                        buttonQuiet,
                                        "min-h-[37px] text-xs",
                                    )}
                                    type="button"
                                    disabled={
                                        catalogLoading() || !hasAiModelCatalog(currentProvider().id)
                                    }
                                    onClick={() => void openModelCatalog(true)}
                                >
                                    {catalogLoading() ? "Loading…" : "Refresh catalog"}
                                </button>
                            </div>
                            <Show when={catalogLoading()}>
                                <p class={cn("ai-model-catalog-status", helperText)} role="status">
                                    Loading public model metadata…
                                </p>
                            </Show>
                            <Show when={catalogMessage()}>
                                <p class={cn("ai-model-catalog-status", helperText)} role="status">
                                    {catalogMessage()}
                                </p>
                            </Show>
                            <Show when={catalogModels().length > 0}>
                                <div class={cn("ai-model-catalog-results", "grid gap-2")}>
                                    <div
                                        class={cn(
                                            "ai-model-catalog-count",
                                            "text-xs tabular-nums text-faint",
                                        )}
                                        aria-live="polite"
                                    >
                                        Showing{" "}
                                        {visibleCatalogModels().length.toLocaleString("en-US")} of{" "}
                                        {catalogModels().length.toLocaleString("en-US")} listed
                                        models
                                        {visibleCatalogModels().length === 100
                                            ? " · refine the search to see more"
                                            : ""}
                                    </div>
                                    <div
                                        class={cn(
                                            "ai-model-catalog-list",
                                            "grid max-h-[380px] gap-1.5 overflow-auto overscroll-contain p-0.5",
                                        )}
                                        role="listbox"
                                        aria-label="Public provider models"
                                    >
                                        <For each={visibleCatalogModels()}>
                                            {(model) => (
                                                <button
                                                    class={cn(
                                                        "ai-model-catalog-option",
                                                        "grid w-full gap-2 rounded-[5px] border border-line bg-surface px-3 py-[11px] text-left text-ink-soft transition-colors hover:border-accent/50 hover:bg-accent-soft/40 aria-selected:border-accent/50 aria-selected:bg-accent-soft/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                                                    )}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={providerModel() === model.id}
                                                    onClick={() => chooseCatalogModel(model)}
                                                >
                                                    <span
                                                        class={cn(
                                                            "ai-model-catalog-option-heading",
                                                            "flex min-w-0 flex-wrap items-start justify-between gap-3",
                                                        )}
                                                    >
                                                        <strong
                                                            class={
                                                                "break-words text-xs font-semibold text-ink"
                                                            }
                                                        >
                                                            {model.id}
                                                        </strong>
                                                        <span class={"shrink-0 text-xs text-muted"}>
                                                            {model.owner}
                                                        </span>
                                                    </span>
                                                    <span
                                                        class={cn(
                                                            "ai-model-catalog-tags",
                                                            "flex flex-wrap gap-1.5",
                                                        )}
                                                    >
                                                        <span class={chip}>{model.status}</span>
                                                        <Show when={model.contextWindow}>
                                                            {(tokens) => (
                                                                <span class={chip}>
                                                                    {tokens().toLocaleString(
                                                                        "en-US",
                                                                    )}{" "}
                                                                    context
                                                                </span>
                                                            )}
                                                        </Show>
                                                        <Show when={model.maximumOutputTokens}>
                                                            {(tokens) => (
                                                                <span class={chip}>
                                                                    {tokens().toLocaleString(
                                                                        "en-US",
                                                                    )}{" "}
                                                                    max output
                                                                </span>
                                                            )}
                                                        </Show>
                                                        <Show
                                                            when={model.inputModalities.length > 0}
                                                        >
                                                            <span class={chip}>
                                                                in:{" "}
                                                                {model.inputModalities.join(", ")}
                                                            </span>
                                                        </Show>
                                                        <Show
                                                            when={model.outputModalities.length > 0}
                                                        >
                                                            <span class={chip}>
                                                                out:{" "}
                                                                {model.outputModalities.join(", ")}
                                                            </span>
                                                        </Show>
                                                        <Show when={model.toolSupport === true}>
                                                            <span class={chip}>tool calling</span>
                                                        </Show>
                                                        <Show
                                                            when={
                                                                model.inputCost !== null ||
                                                                model.outputCost !== null
                                                            }
                                                        >
                                                            <span class={chip}>
                                                                Catalog pricing values · in{" "}
                                                                {formatCatalogPrice(
                                                                    model.inputCost,
                                                                )}{" "}
                                                                · out{" "}
                                                                {formatCatalogPrice(
                                                                    model.outputCost,
                                                                )}
                                                            </span>
                                                        </Show>
                                                    </span>
                                                    <span
                                                        class={cn(
                                                            "ai-model-catalog-source",
                                                            "text-xs text-faint",
                                                        )}
                                                    >
                                                        Metadata by models.dev · availability is not
                                                        verified
                                                    </span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                    <Show when={visibleCatalogModels().length === 0}>
                                        <p class={cn("ai-model-catalog-empty", helperText)}>
                                            No models match these filters. Try a broader search.
                                        </p>
                                    </Show>
                                </div>
                            </Show>
                        </div>
                    </Show>
                </section>
                <div
                    class={cn(
                        "ai-provider-protocol",
                        "mt-3 flex flex-wrap justify-between gap-3 text-xs text-faint max-[520px]:flex-col max-[520px]:items-start",
                    )}
                >
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
                    <div
                        class={cn(
                            "ai-credential-box",
                            "mt-[17px] flex flex-col gap-[18px] rounded-[5px] border border-line-soft bg-surface-subtle p-[15px] sm:flex-row sm:items-start sm:justify-between",
                        )}
                    >
                        <div class={cn("ai-credential-copy", "grid gap-1.5 sm:basis-[260px]")}>
                            <strong class={"text-xs font-semibold text-ink-soft"}>API key</strong>
                            <span class={"text-xs leading-relaxed text-muted"}>
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
                        <fieldset
                            class={cn(
                                "ai-credential-storage",
                                "grid gap-2 border-0 p-0 sm:min-w-[190px] sm:basis-[220px] max-[520px]:w-full",
                            )}
                        >
                            <legend class={"text-xs font-semibold text-faint"}>
                                Store this key in
                            </legend>
                            <Show when={props.systemCredentialStoreAvailable}>
                                <label
                                    class={
                                        "flex items-start gap-2 text-xs leading-snug text-ink-soft"
                                    }
                                >
                                    <input
                                        type="radio"
                                        name="ai-credential-storage"
                                        value="system-keychain"
                                        checked={credentialStorage() === "system-keychain"}
                                        disabled={props.disabled || props.busy}
                                        onChange={() => chooseCredentialStorage("system-keychain")}
                                        class={"mt-0.5 accent-accent"}
                                    />
                                    <span>
                                        System credential store{" "}
                                        <small class={"block text-xs text-muted"}>
                                            This device · recommended
                                        </small>
                                    </span>
                                </label>
                            </Show>
                            <label
                                class={"flex items-start gap-2 text-xs leading-snug text-ink-soft"}
                            >
                                <input
                                    type="radio"
                                    name="ai-credential-storage"
                                    value="encrypted-archive"
                                    checked={credentialStorage() === "encrypted-archive"}
                                    disabled={props.disabled || props.busy || !props.encrypted}
                                    onChange={() => chooseCredentialStorage("encrypted-archive")}
                                    class={"mt-0.5 accent-accent"}
                                />
                                <span>
                                    Encrypted archive{" "}
                                    <small class={"block text-xs text-muted"}>
                                        Portable with this archive
                                    </small>
                                </span>
                            </label>
                        </fieldset>
                        <Show
                            when={credentialSaved()}
                            fallback={
                                <div
                                    class={cn(
                                        "ai-credential-editor",
                                        "grid w-full gap-2.5 sm:max-w-[430px] sm:basis-[430px]",
                                    )}
                                >
                                    <input
                                        aria-label="Provider API key"
                                        type="password"
                                        autocomplete="new-password"
                                        spellcheck={false}
                                        value={credentialInput()}
                                        maxlength={4096}
                                        placeholder="Paste an API key"
                                        disabled={
                                            props.disabled || props.busy || !canSaveCredential()
                                        }
                                        onInput={(event) =>
                                            setCredentialInput(event.currentTarget.value)
                                        }
                                        class={inputBase}
                                    />
                                    <label
                                        class={cn(
                                            "ai-review-consent ai-credential-consent",
                                            "flex items-start gap-2.5 text-xs leading-relaxed text-ink-soft",
                                        )}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={credentialConfirmed()}
                                            disabled={
                                                props.disabled || props.busy || !canSaveCredential()
                                            }
                                            onChange={(event) =>
                                                setCredentialConfirmed(event.currentTarget.checked)
                                            }
                                            class={"mt-2 size-[15px] shrink-0 accent-accent"}
                                        />
                                        <span>
                                            {credentialStorage() === "system-keychain"
                                                ? "I understand this key will be stored in the operating-system credential store for this device."
                                                : "I understand this key will be stored inside the encrypted archive."}
                                        </span>
                                    </label>
                                    <button
                                        class={cn(
                                            "button button-outline",
                                            buttonOutline,
                                            "justify-self-start text-xs",
                                        )}
                                        type="button"
                                        disabled={
                                            props.disabled ||
                                            props.busy ||
                                            !canSaveCredential() ||
                                            !credentialInput()
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
                                class={cn(
                                    "button button-quiet ai-remove-key",
                                    buttonQuiet,
                                    "justify-self-start text-xs max-[520px]:w-full",
                                )}
                                type="button"
                                disabled={props.disabled || props.busy}
                                onClick={() => void removeCredential()}
                            >
                                Remove saved key
                            </button>
                        </Show>
                    </div>
                </Show>
                <div
                    class={cn(
                        "ai-provider-footer",
                        "mt-[18px] flex flex-col gap-5 border-t border-line-soft pt-4 sm:flex-row sm:items-center sm:justify-between",
                    )}
                >
                    <p class={"max-w-[620px] text-xs leading-relaxed text-muted"}>
                        {isEmbeddedGgufProvider(currentProvider().id)
                            ? "The model file remains at its selected location. Tutorux stores a local model reference in this archive; model prompts are evaluated inside the desktop process and are never sent to a service."
                            : `${currentProvider().description}. Endpoint and model settings are archive records; API keys use the selected secure store. System-stored keys are available to Tutorux on this device; encrypted-archive keys move with the archive.`}
                    </p>
                    <button
                        class={cn(
                            "button button-primary",
                            buttonPrimary,
                            "shrink-0 self-start sm:self-auto",
                        )}
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => void saveProvider()}
                    >
                        Save provider settings
                    </button>
                </div>
                <Show when={providerMessage()}>
                    <p class={cn("ai-message", helperText, "mt-3.5")} role="status">
                        {providerMessage()}
                    </p>
                </Show>
                <Show when={embeddedAvailable}>
                    <section
                        class={cn(
                            "ai-embedded-model",
                            "mt-5 grid gap-[13px] rounded-[5px] border border-accent/20 bg-accent-soft/40 p-[18px]",
                        )}
                        aria-labelledby="ai-embedded-model-title"
                    >
                        <div
                            class={cn(
                                "ai-panel-heading",
                                "flex flex-wrap items-start justify-between gap-[18px]",
                            )}
                        >
                            <div>
                                <span class={eyebrow}>On this device · no downloads</span>
                                <h3 id="ai-embedded-model-title" class={cn(heading3, "mt-1")}>
                                    In-process GGUF model
                                </h3>
                            </div>
                            <span
                                class={cn(
                                    "ai-provider-status",
                                    "rounded-[5px] border border-line bg-surface-subtle px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-muted",
                                )}
                            >
                                {embeddedStatus()?.loaded ? "Loaded" : "Not loaded"}
                            </span>
                        </div>
                        <p class={"max-w-[720px] text-xs leading-relaxed text-muted"}>
                            Choose a GGUF file you already have. Tutorux validates the file and
                            keeps inference inside the app. Model memory uses a conservative
                            estimate with a 64 GiB ceiling.
                        </p>
                        <div
                            class={cn(
                                "ai-embedded-model-controls",
                                "flex flex-wrap items-center gap-3",
                            )}
                        >
                            <button
                                class={cn("button button-outline", buttonOutline)}
                                type="button"
                                disabled={props.disabled || props.busy || embeddedBusy()}
                                onClick={() => void chooseEmbeddedModel()}
                            >
                                {embeddedModel() ? "Choose another GGUF file" : "Choose GGUF model"}
                            </button>
                            <Show when={embeddedModel()}>
                                {(model) => (
                                    <div
                                        class={cn(
                                            "ai-embedded-model-details",
                                            "grid gap-1 text-xs text-muted sm:min-w-[280px]",
                                        )}
                                    >
                                        <strong class={"text-xs font-semibold text-ink-soft"}>
                                            {model().name}
                                        </strong>
                                        <span>
                                            {model().architecture} ·{" "}
                                            {formatBytes(model().fileSizeBytes)} ·{" "}
                                            {model().tensorCount.toLocaleString("en-US")} tensors
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
                            <div
                                class={cn(
                                    "ai-form-grid ai-embedded-limits",
                                    "grid items-end gap-2.5 min-[761px]:grid-cols-[minmax(150px,1fr)_140px_auto]",
                                )}
                            >
                                <label class={cn("ai-field", labelBase)}>
                                    <span>Context tokens (32–32,768)</span>
                                    <input
                                        type="number"
                                        min="32"
                                        max="32768"
                                        step="256"
                                        value={embeddedContextTokens()}
                                        disabled={props.disabled || props.busy || embeddedBusy()}
                                        onInput={(event) =>
                                            setEmbeddedContextTokens(event.currentTarget.value)
                                        }
                                        class={inputBase}
                                    />
                                </label>
                                <label class={cn("ai-field", labelBase)}>
                                    <span>CPU threads (1–16)</span>
                                    <input
                                        type="number"
                                        min="1"
                                        max="16"
                                        step="1"
                                        value={embeddedCpuThreads()}
                                        disabled={props.disabled || props.busy || embeddedBusy()}
                                        onInput={(event) =>
                                            setEmbeddedCpuThreads(event.currentTarget.value)
                                        }
                                        class={inputBase}
                                    />
                                </label>
                                <button
                                    class={cn(
                                        "button button-primary",
                                        buttonPrimary,
                                        "max-[760px]:w-full",
                                    )}
                                    type="button"
                                    disabled={props.disabled || props.busy || embeddedBusy()}
                                    onClick={() => void loadSelectedEmbeddedModel()}
                                >
                                    Load model locally
                                </button>
                            </div>
                        </Show>
                        <Show when={embeddedStatus()?.loaded}>
                            <div
                                class={cn(
                                    "ai-embedded-model-active",
                                    "flex flex-wrap items-center gap-3",
                                )}
                            >
                                <span class={"basis-full text-xs leading-relaxed text-muted"}>
                                    {embeddedStatus()?.name} ·{" "}
                                    {embeddedStatus()?.contextTokens?.toLocaleString("en-US")}{" "}
                                    context · {embeddedStatus()?.cpuThreads} CPU threads ·{" "}
                                    {formatBytes(embeddedStatus()?.memoryEstimateBytes ?? 0)}{" "}
                                    estimated
                                </span>
                                <button
                                    class={cn("button button-outline", buttonOutline)}
                                    type="button"
                                    disabled={props.disabled || props.busy || embeddedBusy()}
                                    onClick={() => void useEmbeddedModel()}
                                >
                                    Use in reviewed AI requests
                                </button>
                                <button
                                    class={cn("button button-quiet", buttonQuiet)}
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
                                class={cn(
                                    "button button-quiet ai-embedded-cancel",
                                    buttonQuiet,
                                    "justify-self-start text-danger",
                                )}
                                type="button"
                                onClick={() => void cancelLocalGeneration()}
                            >
                                Cancel local generation
                            </button>
                        </Show>
                        <Show when={embeddedMessage()}>
                            <p class={cn("ai-message", helperText)} role="status">
                                {embeddedMessage()}
                            </p>
                        </Show>
                    </section>
                </Show>
            </section>

            <section
                class={cn("ai-panel", card, "grid gap-4 p-[22px] max-[520px]:p-[17px]")}
                aria-labelledby="ai-prepare-title"
            >
                <div
                    class={cn(
                        "ai-panel-heading",
                        "flex flex-wrap items-start justify-between gap-[18px]",
                    )}
                >
                    <div>
                        <span class={eyebrow}>No API key required</span>
                        <h2 id="ai-prepare-title" class={cn(heading2, "mt-1")}>
                            Prepare a guide package
                        </h2>
                    </div>
                    <span
                        class={cn(
                            "ai-step-marker",
                            "flex items-center gap-[7px] pt-1 text-xs tracking-[0.08em] tabular-nums text-faint",
                        )}
                    >
                        01 <i class={"h-px w-3.5 bg-line-strong"} /> 02{" "}
                        <i class={"h-px w-3.5 bg-line-strong"} /> 03
                    </span>
                </div>
                <div
                    class={cn(
                        "ai-form-grid",
                        "mt-6 grid gap-4 min-[761px]:grid-cols-[minmax(0,1.2fr)_minmax(270px,0.8fr)]",
                    )}
                >
                    <label class={cn("ai-field", labelBase)}>
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
                            class={selectBase}
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
                    <label class={cn("ai-field", labelBase)}>
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
                            class={selectBase}
                        >
                            <option value="auto">
                                Choose from student preference and session subject
                            </option>
                            <For each={templates()}>
                                {(template) => <option value={template.id}>{template.name}</option>}
                            </For>
                        </select>
                    </label>
                </div>
                <fieldset
                    class={cn(
                        "ai-image-picker",
                        "mt-[18px] grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3.5",
                    )}
                    disabled={props.disabled || props.busy || !sessionId()}
                >
                    <legend class={"px-1 text-xs font-bold text-ink-soft"}>
                        Include session images in a reviewed AI request
                    </legend>
                    <p class={"text-xs leading-relaxed text-muted"}>
                        Images stay in your archive until you review and authorize a provider
                        request. Select up to {MAX_AI_IMAGE_ATTACHMENT_COUNT} PNG, JPEG, or WebP
                        images, {formatBytes(MAX_AI_IMAGE_ATTACHMENT_BYTES)} total. Image requests
                        require a vision-capable model; for Ollama, choose a vision model.
                    </p>
                    <Show
                        when={sessionImages().length > 0}
                        fallback={
                            <span
                                class={cn("ai-image-empty", "text-xs leading-relaxed text-muted")}
                            >
                                This session has no eligible image materials.
                            </span>
                        }
                    >
                        <div class={cn("ai-image-options", "grid gap-2 min-[761px]:grid-cols-2")}>
                            <For each={sessionImages()}>
                                {(asset) => {
                                    const filename =
                                        asset.fields.get("filename") || "Untitled image";
                                    const size = Number(asset.fields.get("byte_size") ?? 0);
                                    const checked = () =>
                                        selectedImageIds().includes(asset.id.toLowerCase());
                                    const capacityExceeded = () =>
                                        !checked() &&
                                        (selectedImages().length >= MAX_AI_IMAGE_ATTACHMENT_COUNT ||
                                            selectedImageBytes() + size >
                                                MAX_AI_IMAGE_ATTACHMENT_BYTES);
                                    return (
                                        <label
                                            class={cn(
                                                "ai-image-option",
                                                "flex cursor-pointer items-start gap-2.5 rounded-[5px] border border-line bg-surface p-2.5 text-ink-soft transition-colors has-[:checked]:border-accent/60 has-[:checked]:bg-accent-soft/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55",
                                            )}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={checked()}
                                                disabled={capacityExceeded()}
                                                onChange={(event) => {
                                                    const next = new Set(selectedImageIds());
                                                    if (event.currentTarget.checked)
                                                        next.add(asset.id.toLowerCase());
                                                    else next.delete(asset.id.toLowerCase());
                                                    setSelectedImageIds([...next]);
                                                    setReview(null);
                                                    setReviewed(false);
                                                    setRequestPreview(null);
                                                    setSendConfirmed(false);
                                                }}
                                                class={"mt-0.5 shrink-0 accent-accent"}
                                            />
                                            <span
                                                class={cn(
                                                    "ai-image-option-copy",
                                                    "grid min-w-0 gap-[3px]",
                                                )}
                                            >
                                                <strong
                                                    class={
                                                        "truncate text-xs font-semibold text-ink"
                                                    }
                                                >
                                                    {filename}
                                                </strong>
                                                <small class={"truncate text-xs text-muted"}>
                                                    {formatBytes(size)} ·{" "}
                                                    {asset.fields.get("mime_type")}
                                                </small>
                                            </span>
                                        </label>
                                    );
                                }}
                            </For>
                        </div>
                    </Show>
                    <span
                        class={cn(
                            "ai-image-selection-count",
                            "justify-self-end text-xs tabular-nums text-muted",
                        )}
                        aria-live="polite"
                    >
                        {selectedImages().length} selected · {formatBytes(selectedImageBytes())}
                    </span>
                </fieldset>
                <div
                    class={cn(
                        "ai-form-footer",
                        "mt-5 flex flex-col gap-5 border-t border-line-soft pt-4 sm:flex-row sm:items-center sm:justify-between",
                    )}
                >
                    <p class={"text-xs leading-relaxed text-muted"}>
                        Session source text is treated as untrusted content in the package
                        instructions.
                    </p>
                    <button
                        class={cn("button button-primary", buttonPrimary, "max-[520px]:w-full")}
                        type="button"
                        disabled={props.disabled || props.busy || !sessionId()}
                        onClick={() => void prepare()}
                    >
                        {props.busy ? "Preparing…" : "Prepare for review"}
                        <span aria-hidden="true">→</span>
                    </button>
                </div>
                <Show when={message()}>
                    <p class={cn("ai-message", helperText, "mt-3.5")} role="status">
                        {message()}
                    </p>
                </Show>
            </section>

            <Show when={review()}>
                {(summary) => (
                    <section
                        class={cn(
                            "ai-review-card",
                            "grid min-w-0 gap-4 rounded-[5px] border border-accent/30 bg-surface p-[22px] max-[520px]:p-[17px]",
                        )}
                        aria-labelledby="ai-review-title"
                    >
                        <div
                            class={cn(
                                "ai-review-heading",
                                "flex flex-wrap items-start justify-between gap-[18px]",
                            )}
                        >
                            <div>
                                <span class={eyebrow}>Package ready for your review</span>
                                <h2 id="ai-review-title" class={cn(heading2, "mt-1")}>
                                    {summary().guideTemplateName}
                                </h2>
                            </div>
                            <span
                                class={cn(
                                    "ai-hash-label",
                                    "max-w-[240px] truncate text-xs text-muted max-[520px]:max-w-[126px]",
                                )}
                            >
                                SHA-256 · {summary().contentHash.slice(0, 16)}…
                            </span>
                        </div>
                        <div
                            class={cn(
                                "ai-review-stats",
                                "my-[21px] grid grid-cols-2 gap-px overflow-hidden rounded-[5px] border border-line bg-line min-[761px]:grid-cols-6",
                            )}
                        >
                            <ReviewStat label="Transcript cues" value={summary().transcriptCount} />
                            <ReviewStat label="Observations" value={summary().annotationCount} />
                            <ReviewStat label="Evidence items" value={summary().evidenceCount} />
                            <ReviewStat label="Material names" value={summary().assetCount} />
                            <ReviewStat
                                label="Images for request"
                                value={summary().attachedImages.length}
                            />
                            <ReviewStat
                                label="Package size"
                                value={formatBytes(summary().byteLength)}
                            />
                        </div>
                        <details
                            class={cn("ai-json-disclosure", "border-y border-line-soft")}
                            onToggle={(event) =>
                                setShowJson((event.currentTarget as HTMLDetailsElement).open)
                            }
                        >
                            <summary
                                class={"cursor-pointer py-3 text-xs font-semibold text-ink-soft"}
                            >
                                Inspect the complete package JSON
                            </summary>
                            <Show when={showJson()}>
                                <textarea
                                    aria-label="Complete AI package JSON"
                                    readOnly
                                    value={aiPackageText(summary().job)}
                                    class={cn(textareaBase, "max-h-[440px] font-sans")}
                                />
                            </Show>
                        </details>
                        <div
                            class={cn(
                                "ai-request-review-callout",
                                "mt-[15px] flex flex-col gap-[18px] rounded-[5px] border border-line-soft bg-surface-subtle px-[15px] py-3.5 sm:flex-row sm:items-center sm:justify-between",
                            )}
                        >
                            <div>
                                <strong class={"text-xs font-semibold text-ink-soft"}>
                                    Provider request review
                                </strong>
                                <p class={"mt-1 max-w-[580px] text-xs leading-relaxed text-muted"}>
                                    Build the exact request for the saved provider, including
                                    selected image payloads when present. For Replicate, schema
                                    inspection sends only the saved model ID and API key to
                                    Replicate; the study package stays local until you authorize its
                                    prediction request. Browser builds may be blocked by provider
                                    CORS settings.
                                </p>
                            </div>
                            <button
                                class={cn(
                                    "button button-outline",
                                    buttonOutline,
                                    "shrink-0 self-start text-xs sm:self-auto",
                                )}
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
                                <section
                                    class={cn(
                                        "ai-request-preview",
                                        "mt-[13px] grid gap-4 rounded-[5px] border border-accent/30 bg-accent-soft/30 p-[17px]",
                                    )}
                                    aria-labelledby="ai-request-preview-title"
                                >
                                    <div
                                        class={cn(
                                            "ai-request-preview-heading",
                                            "flex flex-wrap items-start justify-between gap-3.5",
                                        )}
                                    >
                                        <div>
                                            <span class={eyebrow}>
                                                {preview().providerId === "replicate"
                                                    ? "SCHEMA CHECK COMPLETE · PREDICTION NOT SENT"
                                                    : "NO REQUEST SENT"}
                                            </span>
                                            <h3
                                                id="ai-request-preview-title"
                                                class={cn(heading3, "mt-1")}
                                            >
                                                Request ready for review
                                            </h3>
                                        </div>
                                        <span
                                            class={cn(
                                                "ai-request-protocol",
                                                "rounded-[5px] border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap text-muted",
                                            )}
                                        >
                                            {preview().providerName}
                                        </span>
                                    </div>
                                    <dl
                                        class={cn(
                                            "ai-request-facts",
                                            "m-0 mt-4 grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(160px,0.7fr)]",
                                        )}
                                    >
                                        <div class={"min-w-0"}>
                                            <dt
                                                class={"text-xs font-bold tracking-wide text-faint"}
                                            >
                                                Method and endpoint
                                            </dt>
                                            <dd
                                                class={
                                                    "mt-1 break-words text-xs leading-normal text-ink-soft"
                                                }
                                            >
                                                {preview().method} {preview().endpoint}
                                            </dd>
                                        </div>
                                        <div class={"min-w-0"}>
                                            <dt
                                                class={"text-xs font-bold tracking-wide text-faint"}
                                            >
                                                Model
                                            </dt>
                                            <dd
                                                class={
                                                    "mt-1 break-words text-xs leading-normal text-ink-soft"
                                                }
                                            >
                                                {preview().model}
                                            </dd>
                                        </div>
                                        <div class={"min-w-0"}>
                                            <dt
                                                class={"text-xs font-bold tracking-wide text-faint"}
                                            >
                                                Authentication
                                            </dt>
                                            <dd
                                                class={
                                                    "mt-1 break-words text-xs leading-normal text-ink-soft"
                                                }
                                            >
                                                {preview().authentication}
                                            </dd>
                                        </div>
                                        <div class={"min-w-0"}>
                                            <dt
                                                class={"text-xs font-bold tracking-wide text-faint"}
                                            >
                                                Exact body SHA-256
                                            </dt>
                                            <dd
                                                class={cn(
                                                    "ai-request-hash",
                                                    "mt-1 break-all text-xs leading-normal text-ink-soft",
                                                )}
                                            >
                                                {preview().requestBodyHash}
                                            </dd>
                                        </div>
                                        <div class={"min-w-0"}>
                                            <dt
                                                class={"text-xs font-bold tracking-wide text-faint"}
                                            >
                                                Package and request size
                                            </dt>
                                            <dd
                                                class={
                                                    "mt-1 break-words text-xs leading-normal text-ink-soft"
                                                }
                                            >
                                                {formatBytes(preview().packageBytes)} package ·{" "}
                                                {formatBytes(preview().requestBytes)} request
                                            </dd>
                                        </div>
                                    </dl>
                                    <Show
                                        when={
                                            (preview().attachedAssets ?? preview().attachedImages)
                                                .length > 0
                                        }
                                    >
                                        <div
                                            class={cn(
                                                "ai-request-images",
                                                "mt-[13px] grid gap-2 rounded-[5px] border border-line-soft bg-surface px-3 py-2.5 text-xs",
                                            )}
                                            aria-label="Attached materials"
                                        >
                                            <strong class={"text-xs font-semibold text-ink-soft"}>
                                                Materials included in this request
                                            </strong>
                                            <For
                                                each={
                                                    preview().attachedAssets ??
                                                    preview().attachedImages
                                                }
                                            >
                                                {(attachment) => (
                                                    <div
                                                        class={
                                                            "flex flex-wrap justify-between gap-x-3 gap-y-1 text-muted"
                                                        }
                                                    >
                                                        <span>
                                                            {attachment.filename} ·{" "}
                                                            {formatBytes(attachment.byteSize)}
                                                            {"kind" in attachment
                                                                ? ` · ${attachment.kind}`
                                                                : " · image"}
                                                        </span>
                                                        <code
                                                            class={
                                                                "break-all font-sans text-xs text-faint"
                                                            }
                                                        >
                                                            SHA-256 · {attachment.contentHash}
                                                        </code>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                    <div
                                        class={cn(
                                            "ai-request-headers",
                                            "mt-[15px] grid gap-1.5 rounded-[5px] border border-line-soft bg-surface px-3 py-2.5 text-xs text-muted",
                                        )}
                                        aria-label="Request headers"
                                    >
                                        <strong class={"text-xs font-semibold text-ink-soft"}>
                                            Headers sent
                                        </strong>
                                        <For each={preview().headers}>
                                            {(header) => (
                                                <span>
                                                    <code class={"font-sans text-ink"}>
                                                        {header.name}
                                                    </code>{" "}
                                                    {header.valueDescription}
                                                </span>
                                            )}
                                        </For>
                                    </div>
                                    <Show
                                        when={
                                            !preview().localOnly && !preview().credentialAvailable
                                        }
                                    >
                                        <p
                                            class={cn(
                                                "ai-request-key-missing",
                                                "mt-3 text-xs leading-relaxed text-danger",
                                            )}
                                            role="status"
                                        >
                                            No API key is saved for this provider. A request cannot
                                            be sent until a key is available in the selected secure
                                            store.
                                        </p>
                                    </Show>
                                    <Show
                                        when={
                                            (preview().attachedAssets ?? preview().attachedImages)
                                                .length === 0
                                        }
                                        fallback={
                                            <p
                                                class={cn(
                                                    "ai-image-body-note",
                                                    "mt-3 rounded-[5px] border border-line-soft bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted",
                                                )}
                                            >
                                                The exact request body hash covers the package text
                                                and attached material bytes. Binary data is sent as
                                                base64 and is omitted from this text preview.
                                            </p>
                                        }
                                    >
                                        <details
                                            class={cn(
                                                "ai-json-disclosure ai-request-body-disclosure",
                                                "mt-3 border-y border-line-soft",
                                            )}
                                        >
                                            <summary
                                                class={
                                                    "cursor-pointer py-3 text-xs font-semibold text-ink-soft"
                                                }
                                            >
                                                Inspect the exact provider request JSON
                                            </summary>
                                            <textarea
                                                aria-label="Exact provider request body"
                                                readOnly
                                                value={preview().requestBody}
                                                class={cn(textareaBase, "max-h-[440px] font-sans")}
                                            />
                                        </details>
                                    </Show>
                                    <p
                                        class={cn(
                                            "ai-request-privacy-note",
                                            "mt-3 text-xs leading-relaxed text-muted",
                                        )}
                                    >
                                        The request body contains the reviewed package text
                                        {(preview().attachedAssets ?? preview().attachedImages)
                                            .length > 0
                                            ? " and attached material bytes"
                                            : ""}
                                        . Authentication secrets stay out of this preview.{" "}
                                        {preview().providerId === "replicate"
                                            ? "The saved key was used only for model-schema inspection; no package was sent."
                                            : "The key is not read during preparation."}
                                    </p>
                                    <Show when={preview().providerId === "replicate"}>
                                        <p
                                            class={cn(
                                                "ai-request-privacy-note",
                                                "mt-3 text-xs leading-relaxed text-muted",
                                            )}
                                        >
                                            The selected input schema is version{" "}
                                            {preview().replicateInputSchema?.version}. The
                                            prediction is pinned to this inspected version.
                                            {preview().replicateInputSchema?.hasSystemPrompt
                                                ? " Tutorux sends the package and system instructions in separate supported fields."
                                                : " Tutorux combines the system instructions with the package in the prompt."}
                                            {preview().replicateInputSchema?.tokenInput
                                                ? ` The reviewed request sets ${preview().replicateInputSchema?.tokenInput} to ${preview().maxOutputTokens.toLocaleString("en-US")}.`
                                                : " This model does not expose a supported output-token limit input."}
                                        </p>
                                        <p
                                            class={cn(
                                                "ai-request-privacy-note",
                                                "mt-3 text-xs leading-relaxed text-muted",
                                            )}
                                        >
                                            Replicate receives one prediction request followed by
                                            status checks until it finishes. You can cancel an
                                            active prediction; Tutorux then sends Replicate a
                                            cancellation request. Before sending, Tutorux checks
                                            that the model schema has not changed. Static browser
                                            builds also depend on the provider allowing requests
                                            from this app’s origin.
                                        </p>
                                    </Show>
                                    <label
                                        class={cn(
                                            "ai-review-consent ai-send-consent",
                                            "mt-4 flex items-start gap-2.5 text-xs leading-relaxed text-ink-soft",
                                        )}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={sendConfirmed()}
                                            disabled={
                                                props.disabled ||
                                                props.busy ||
                                                (!preview().localOnly &&
                                                    !preview().credentialAvailable)
                                            }
                                            onChange={(event) =>
                                                setSendConfirmed(event.currentTarget.checked)
                                            }
                                            class={"mt-0.5 size-[15px] shrink-0 accent-accent"}
                                        />
                                        <span>
                                            {preview().providerId === "replicate" ? (
                                                <>
                                                    I authorize a Replicate prediction request
                                                    containing the reviewed package, bounded status
                                                    checks, and a cancellation request if I cancel
                                                    it. Tutorux will recheck the model schema before
                                                    sending and stop for a fresh review if it
                                                    changed. The initial request is sent to{" "}
                                                    <code class={"break-all text-ink"}>
                                                        {preview().endpoint}
                                                    </code>
                                                    .
                                                </>
                                            ) : (
                                                <>
                                                    I authorize one POST containing the reviewed
                                                    package to {preview().providerName} at{" "}
                                                    <code class={"break-all text-ink"}>
                                                        {preview().endpoint}
                                                    </code>
                                                    .
                                                </>
                                            )}{" "}
                                            The exact request body hash is{" "}
                                            <code class={"break-all text-ink"}>
                                                {preview().requestBodyHash}
                                            </code>
                                            . The complete response, including error or partial
                                            bytes, will be saved in this archive.
                                            {(preview().attachedAssets ?? preview().attachedImages)
                                                .length > 0
                                                ? ` This request also includes ${(preview().attachedAssets ?? preview().attachedImages).length} session material file${(preview().attachedAssets ?? preview().attachedImages).length === 1 ? "" : "s"}; their names and content hashes are listed above.`
                                                : ""}
                                            {preview().localOnly
                                                ? " This sends the package to the loopback Ollama service."
                                                : " This sends the package to the external provider with the saved API key."}
                                        </span>
                                    </label>
                                    <div
                                        class={cn(
                                            "ai-send-actions",
                                            "mt-3 flex flex-col gap-3 sm:flex-row sm:items-center",
                                        )}
                                    >
                                        <button
                                            class={cn("button button-primary", buttonPrimary)}
                                            type="button"
                                            disabled={
                                                props.disabled ||
                                                props.busy ||
                                                sending() ||
                                                !sendConfirmed() ||
                                                !reviewed() ||
                                                (!preview().localOnly &&
                                                    !preview().credentialAvailable)
                                            }
                                            onClick={() => void sendReviewedRequest(summary())}
                                        >
                                            {props.busy
                                                ? "Sending and saving…"
                                                : "Send exact reviewed request"}
                                        </button>
                                        <span
                                            aria-live="polite"
                                            class={"text-xs leading-normal text-muted"}
                                        >
                                            {cancelRequested()
                                                ? "Cancellation requested. Waiting for Replicate to confirm the prediction is stopped…"
                                                : sendProgressBytes() > 0
                                                  ? `${formatBytes(sendProgressBytes())} received`
                                                  : !reviewed()
                                                    ? "Review and allow package storage below before sending."
                                                    : "No request is sent until you select this checkbox and button."}
                                        </span>
                                        <Show
                                            when={
                                                sending() &&
                                                props.busy &&
                                                preview().providerId === "replicate"
                                            }
                                        >
                                            <button
                                                class={cn("button button-quiet", buttonQuiet)}
                                                type="button"
                                                disabled={cancelRequested()}
                                                onClick={() => {
                                                    setCancelRequested(true);
                                                    void cancelReplicatePrediction().catch(
                                                        (cause) => {
                                                            setCancelRequested(false);
                                                            setRequestPreviewMessage(
                                                                cause instanceof Error
                                                                    ? cause.message
                                                                    : "Replicate cancellation could not be requested.",
                                                            );
                                                        },
                                                    );
                                                }}
                                            >
                                                {cancelRequested()
                                                    ? "Cancellation requested…"
                                                    : "Cancel prediction"}
                                            </button>
                                        </Show>
                                    </div>
                                </section>
                            )}
                        </Show>
                        <Show when={requestPreviewMessage()}>
                            <p class={cn("ai-message", helperText, "mt-3.5")} role="status">
                                {requestPreviewMessage()}
                            </p>
                        </Show>
                        <label
                            class={cn(
                                "ai-review-consent",
                                "mt-[17px] flex items-start gap-2.5 text-xs leading-relaxed text-ink-soft",
                            )}
                        >
                            <input
                                type="checkbox"
                                checked={reviewed()}
                                onChange={(event) => setReviewed(event.currentTarget.checked)}
                                class={"mt-0.5 size-[15px] shrink-0 accent-accent"}
                            />
                            <span>
                                I reviewed the package contents and want to store this copy in the
                                selected archive.
                            </span>
                        </label>
                        <div
                            class={cn(
                                "ai-review-actions",
                                "mt-[18px] flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end",
                            )}
                        >
                            <button
                                class={cn("button button-quiet", buttonQuiet)}
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
                                class={cn(
                                    "button button-primary",
                                    buttonPrimary,
                                    "max-[520px]:w-full",
                                )}
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
                    <section
                        class={cn(
                            "ai-generation-result",
                            "mt-3.5 grid gap-[13px] rounded-[5px] border border-accent/25 bg-accent-soft/20 p-[17px]",
                        )}
                        aria-labelledby="ai-generation-result-title"
                    >
                        <div
                            class={cn(
                                "ai-request-preview-heading",
                                "flex flex-wrap items-start justify-between gap-3.5",
                            )}
                        >
                            <div>
                                <span class={eyebrow}>Response saved · review required</span>
                                <h2 id="ai-generation-result-title" class={cn(heading2, "mt-1")}>
                                    {result().guideId
                                        ? "Proposed study guide is ready"
                                        : "Provider response saved for review"}
                                </h2>
                            </div>
                            <span
                                class={cn(
                                    "ai-provider-status",
                                    "rounded-[5px] border border-line bg-surface-subtle px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-muted",
                                )}
                            >
                                {result().status.replaceAll("-", " ")}
                            </span>
                        </div>
                        <p class={"text-xs leading-relaxed text-muted"}>
                            {result().providerName} · {result().model} ·{" "}
                            {formatBytes(result().responseBytes)}
                            {result().guideId
                                ? ` · Guide ${result().guideId?.slice(0, 8)} is an unapproved draft in Study guides.`
                                : " · The exact raw response bytes are saved in this archive for export."}
                        </p>
                        <dl
                            class={cn(
                                "ai-request-facts",
                                "m-0 mt-4 grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(160px,0.7fr)]",
                            )}
                        >
                            <div class={"min-w-0"}>
                                <dt class={"text-xs font-bold tracking-wide text-faint"}>
                                    Guide structure
                                </dt>
                                <dd class={"mt-1 break-words text-xs leading-normal text-ink-soft"}>
                                    {result().guideId
                                        ? result().schemaValid
                                            ? "Structured response"
                                            : "Editable text fallback"
                                        : "No guide draft created"}
                                </dd>
                            </div>
                            <div class={"min-w-0"}>
                                <dt class={"text-xs font-bold tracking-wide text-faint"}>
                                    Source validation
                                </dt>
                                <dd class={"mt-1 break-words text-xs leading-normal text-ink-soft"}>
                                    {result().sourceValidation}
                                </dd>
                            </div>
                            <div class={"min-w-0"}>
                                <dt class={"text-xs font-bold tracking-wide text-faint"}>
                                    Archived job
                                </dt>
                                <dd
                                    class={cn(
                                        "ai-request-hash",
                                        "mt-1 break-all text-xs leading-normal text-ink-soft",
                                    )}
                                >
                                    {result().jobId}
                                </dd>
                            </div>
                        </dl>
                        <Show when={!result().guideId}>
                            <button
                                class={cn(
                                    "button button-outline ai-export-button",
                                    buttonOutline,
                                    "text-xs",
                                )}
                                type="button"
                                disabled={props.disabled || props.busy}
                                onClick={() => void download(result().jobId)}
                            >
                                Export raw response
                            </button>
                        </Show>
                        <Show when={result().warnings.length > 0}>
                            <ul
                                class={cn(
                                    "ai-generation-warnings",
                                    "m-0 grid list-disc gap-1 pl-5 text-xs leading-relaxed text-muted",
                                )}
                            >
                                <For each={result().warnings}>
                                    {(warning) => <li>{warning}</li>}
                                </For>
                            </ul>
                        </Show>
                        <details
                            class={cn(
                                "ai-json-disclosure ai-response-disclosure",
                                "border-y border-line-soft",
                            )}
                            onToggle={(event) =>
                                setShowResponse((event.currentTarget as HTMLDetailsElement).open)
                            }
                        >
                            <summary
                                class={"cursor-pointer py-3 text-xs font-semibold text-ink-soft"}
                            >
                                Inspect generated text
                            </summary>
                            <Show when={showResponse() && result().guideId}>
                                <textarea
                                    aria-label="Generated guide text"
                                    readOnly
                                    value={result().responseText}
                                    class={cn(textareaBase, "max-h-[480px] font-sans")}
                                />
                                <Show when={result().responseTextTruncated}>
                                    <span
                                        class={cn(
                                            "ai-response-truncated",
                                            "mt-2 block text-xs leading-normal text-muted",
                                        )}
                                    >
                                        Showing the first{" "}
                                        {AI_RESPONSE_PREVIEW_CHARACTER_LIMIT.toLocaleString(
                                            "en-US",
                                        )}{" "}
                                        characters. The complete provider response is kept in the
                                        archive.
                                    </span>
                                </Show>
                            </Show>
                        </details>
                        <Show when={result().guideId}>
                            <p
                                class={cn(
                                    "ai-request-privacy-note",
                                    "mt-3 text-xs leading-relaxed text-muted",
                                )}
                            >
                                The generated guide remains a draft. Review every claim,
                                recommendation, citation, and student-facing detail in Study guides
                                before approval.
                            </p>
                        </Show>
                    </section>
                )}
            </Show>

            <section
                class={cn("ai-panel", card, "grid gap-4 p-[22px] max-[520px]:p-[17px]")}
                aria-labelledby="ai-import-response-title"
            >
                <div
                    class={cn(
                        "ai-panel-heading",
                        "flex flex-wrap items-start justify-between gap-[18px]",
                    )}
                >
                    <div>
                        <span class={eyebrow}>External response</span>
                        <h2 id="ai-import-response-title" class={cn(heading2, "mt-1")}>
                            Import a response
                        </h2>
                    </div>
                    <span
                        class={cn(
                            "ai-provider-status",
                            "rounded-[5px] border border-line bg-surface-subtle px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-muted",
                        )}
                    >
                        Review required
                    </span>
                </div>
                <p
                    class={cn(
                        "ai-provider-intro",
                        "max-w-[700px] text-xs leading-relaxed text-muted",
                    )}
                >
                    Import JSON or plain text returned by another AI tool. Tutorux stores the
                    original bytes, creates an unapproved guide draft, and validates source
                    references before review.
                </p>
                <label class={cn("ai-field", labelBase)}>
                    <span>Response file</span>
                    <input
                        type="file"
                        accept=".json,.txt,.md,application/json,text/plain,text/markdown"
                        disabled={props.disabled || props.busy || importingResponse()}
                        onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = "";
                            void importExternalResponse(file);
                        }}
                        class={inputBase}
                    />
                </label>
                <Show when={importingResponse()}>
                    <p class={cn("ai-model-catalog-status", helperText)} role="status">
                        Importing and validating the external response…
                    </p>
                </Show>
                <Show when={importMessage()}>
                    <p class={cn("ai-message", helperText, "mt-3.5")} role="status">
                        {importMessage()}
                    </p>
                </Show>
            </section>

            <section
                class={cn("ai-panel ai-history", card, "grid gap-4 p-[22px] max-[520px]:p-[17px]")}
                aria-labelledby="ai-history-title"
            >
                <div
                    class={cn(
                        "ai-panel-heading",
                        "flex flex-wrap items-start justify-between gap-[18px]",
                    )}
                >
                    <div>
                        <span class={eyebrow}>Kept with your workspace</span>
                        <h2 id="ai-history-title" class={cn(heading2, "mt-1")}>
                            Prepared packages
                        </h2>
                    </div>
                    <span
                        class={cn(
                            "ai-history-count",
                            "rounded-[5px] border border-line px-2 py-1 text-xs text-muted",
                        )}
                    >
                        {latestJobs().length} recent
                    </span>
                </div>
                <Show
                    when={latestJobs().length > 0}
                    fallback={
                        <div
                            class={cn(
                                "ai-empty-state",
                                "grid justify-items-center px-5 pt-[34px] pb-[22px] text-center",
                            )}
                        >
                            <span
                                aria-hidden="true"
                                class={
                                    "grid size-10 place-items-center rounded-[5px] bg-accent-soft text-[23px] text-accent"
                                }
                            >
                                ✳
                            </span>
                            <strong class={"mt-3 text-[13px] font-semibold"}>
                                No packages prepared yet
                            </strong>
                            <p class={"mt-1.5 text-xs leading-relaxed text-muted"}>
                                Choose a session above to create a source-linked package for your
                                review.
                            </p>
                        </div>
                    }
                >
                    <div class={cn("ai-job-list", "mt-4 border-t border-line-soft")}>
                        <For each={latestJobs()}>
                            {(job) => (
                                <div
                                    class={cn(
                                        "ai-job-row",
                                        "flex flex-wrap items-center gap-[13px] border-b border-line-soft py-[13px] max-[520px]:items-start",
                                    )}
                                >
                                    <div
                                        class={cn(
                                            "ai-job-icon",
                                            "grid size-[34px] shrink-0 place-items-center rounded-[5px] bg-accent-soft text-lg text-accent",
                                        )}
                                        aria-hidden="true"
                                    >
                                        ✳
                                    </div>
                                    <div class={cn("ai-job-copy", "grid min-w-0 flex-1 gap-[3px]")}>
                                        <strong class={"truncate text-xs font-semibold"}>
                                            {sessionLabel(
                                                props.sessions,
                                                job.fields.get("session_id") ?? "",
                                            )}
                                        </strong>
                                        <span class={"truncate text-xs text-muted"}>
                                            Saved{" "}
                                            {formatDate(job.fields.get("created_at_us") ?? "")} ·{" "}
                                            {formatBytes(jobSize(job))}
                                        </span>
                                    </div>
                                    <div
                                        class={cn(
                                            "ai-job-actions",
                                            "flex flex-wrap justify-end gap-2 max-[520px]:w-full max-[520px]:justify-start",
                                        )}
                                    >
                                        <button
                                            class={cn(
                                                "button button-outline ai-export-button",
                                                buttonOutline,
                                                "text-xs",
                                            )}
                                            type="button"
                                            disabled={props.disabled || props.busy}
                                            onClick={() => void download(job.id)}
                                        >
                                            Export JSON
                                        </button>
                                        <button
                                            class={cn(
                                                "button button-outline ai-export-button",
                                                buttonOutline,
                                                "text-xs",
                                            )}
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
                <section
                    class={cn(
                        "ai-panel ai-history",
                        card,
                        "grid gap-4 p-[22px] max-[520px]:p-[17px]",
                    )}
                    aria-labelledby="ai-run-history-title"
                >
                    <div
                        class={cn(
                            "ai-panel-heading",
                            "flex flex-wrap items-start justify-between gap-[18px]",
                        )}
                    >
                        <div>
                            <span class={eyebrow}>Review before approval</span>
                            <h2 id="ai-run-history-title" class={cn(heading2, "mt-1")}>
                                Provider responses
                            </h2>
                        </div>
                        <span
                            class={cn(
                                "ai-history-count",
                                "rounded-[5px] border border-line px-2 py-1 text-xs text-muted",
                            )}
                        >
                            {latestRuns().length} recent
                        </span>
                    </div>
                    <div class={cn("ai-job-list", "mt-4 border-t border-line-soft")}>
                        <For each={latestRuns()}>
                            {(job) => (
                                <div
                                    class={cn(
                                        "ai-job-row",
                                        "flex flex-wrap items-center gap-[13px] border-b border-line-soft py-[13px] max-[520px]:items-start",
                                    )}
                                >
                                    <div
                                        class={cn(
                                            "ai-job-icon",
                                            "grid size-[34px] shrink-0 place-items-center rounded-[5px] bg-accent-soft text-lg text-accent",
                                        )}
                                        aria-hidden="true"
                                    >
                                        ✳
                                    </div>
                                    <div class={cn("ai-job-copy", "grid min-w-0 flex-1 gap-[3px]")}>
                                        <strong class={"truncate text-xs font-semibold"}>
                                            {sessionLabel(
                                                props.sessions,
                                                job.fields.get("session_id") ?? "",
                                            )}
                                        </strong>
                                        <span class={"truncate text-xs text-muted"}>
                                            {job.fields.get("provider_id") ?? "Provider"} ·{" "}
                                            {job.fields.get("model_id") ?? "Model unavailable"} ·{" "}
                                            {job.fields.get("status")?.replaceAll("-", " ") ??
                                                "Response saved"}{" "}
                                            · {formatDate(job.fields.get("created_at_us") ?? "")}
                                        </span>
                                    </div>
                                    <button
                                        class={cn(
                                            "button button-outline ai-export-button",
                                            buttonOutline,
                                            "text-xs",
                                        )}
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
        <div
            class={cn(
                "ai-review-stat",
                "min-w-0 bg-surface-subtle px-3.5 py-3 max-[760px]:last:col-span-2",
            )}
        >
            <strong class={"block truncate text-[17px] font-semibold tabular-nums text-ink"}>
                {props.value}
            </strong>
            <span class={"mt-1 block truncate text-xs text-muted"}>{props.label}</span>
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
        return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
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
    const parsed = Number(
        job.fields.get("package_bytes") ?? job.fields.get("response_bytes") ?? "",
    );
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : job.blob.byteLength;
}
