import {
    buttonDanger,
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    card,
    cardHeading,
    cn,
    dialogBackdrop,
    dialogDescription,
    dialogPanel,
    errorText,
    eyebrow,
    fieldGrid,
    helperText,
    iconButton,
    inputBase,
    labelBase,
    pageBody,
    pageToolbar,
    selectBase,
    statisticCard,
    textareaBase,
} from "./ui";
import { applyDocumentTailwindUtilities } from "./theme";
import {
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup,
    onMount,
    untrack,
    type JSX,
} from "solid-js";
import { render } from "solid-js/web";
import {
    appendRecords,
    appendStagedAssetRecords,
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveBytes,
    openArchiveSource,
    planTrashPurge,
    purgeTrashedArchiveSnapshot,
    verifyArchiveSnapshot,
    verifyArchiveHistory,
    type ArchiveVerificationResult,
    type ArchiveManifest,
    type ArchiveSnapshot,
    type ArchiveTrashPurgePlan,
} from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { DatePicker } from "./DatePicker";
import { MediaPlayer } from "./MediaPlayer";
import { sourceStream, type ArchiveByteSource } from "./archive/source";
import { createAiPackageRecord, type AiPackageSummary } from "./ai/package";
import { createAiRequestPreview, type AiRequestPreview } from "./ai/request";
import { importTranscriptBatches } from "./audio/transcript-import";
import { importCompressedAudioRecords } from "./audio/compressed-import";
import { importAiResponseRecords } from "./ai/import-response";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
    parseReplicateModelInputSchema,
    type ReplicateModelInputSchema,
} from "./ai/replicate-schema";
import { executeAiGeneration } from "./ai/execution";
import type { AiExecutionSummary } from "./ai/response";
import {
    deterministicUuid,
    createProviderConfigurationRecord,
    createProviderCredentialRecord,
    maskCredentialMetadata,
    providerById,
    type AiProviderConfigurationInput,
} from "./ai/providers";
import { MAX_ASSET_BYTES, readAssetBytes, streamAssetBytes } from "./domain/assets";
import {
    browserAssetReadSource,
    prepareStreamingAssetBatchImport,
    prepareStreamingAssetImport,
    type AssetBatchProgress,
} from "./domain/assets-stream";
import { MAX_MATERIAL_AUDIO_PREVIEW_BYTES } from "./domain/asset-waveform";
import { createArchiveStaging } from "./archive/staging";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { configurePdfWorkerSource } from "./domain/document-text";
import {
    buildAudioTrackWavExport,
    buildAudioPreview,
    listSessionAudioTracks,
    type AudioTrackDescriptor,
} from "./domain/audio";
import { makeWaveImportRecordsIncremental } from "./domain/wav";
import { prepareWavImportRecovery } from "./domain/wav-recovery";
import { prepareNativeCaptureRecovery } from "./domain/native-recording-recovery";
import {
    renameRecordingTake,
    renameRecordingTrack,
    setRecordingTrackDeleted,
    setRecordingTakeDeleted,
} from "./domain/recording-takes";
import {
    createSessionPackage,
    importSessionPackage as prepareSessionPackageImport,
} from "./domain/session-packages";
import {
    reviewStudentProgressRecord,
    type StudentProgressClassification,
} from "./domain/student-progress";
import {
    approveGuideRecord,
    GUIDE_TEMPLATES,
    guideDraftFromRecord,
    guideRecordsWithEntryLinks,
    makeGuideRecord,
    renderGuideHtml,
    renderGuideMarkdown,
    type GuideExportImage,
    type GuideDraft,
    type GuideTemplate,
} from "./domain/guides";
import { guideImageIds, renderGuideDocx, serializeGuideJson } from "./domain/guide-export";
import {
    makeCustomGuideTemplateRecord,
    serializeGuideTemplate,
    type GuideTemplateInput,
} from "./domain/templates";
import {
    extractSessionEvidence,
    makeEvidenceRecord,
    makeEvidenceEdge,
    reviewEvidenceRecord,
    restoreEvidenceEdge,
    restoreEvidenceRecordGroup,
    trashEvidenceEdge,
    trashEvidenceRecord,
    updateEvidenceRecord,
    type EvidenceCreateInput,
    type EvidenceUpdateInput,
} from "./domain/evidence";
import {
    duplicateAnnotationRecord,
    makeAnnotationRecord,
    removeAnnotationRecord,
    updateAnnotationRecord,
    type AnnotationInput,
} from "./domain/annotations";
import {
    archiveJournalOrganizerRecord,
    cloneSessionRecords,
    makeJournalRecords,
    moveRecordToTrash,
    makeSessionRecords,
    makeStudentRecord,
    notesEditState,
    readRemovedNoteBlocks,
    restoreRemovedNoteBlock,
    restoreRecordFromTrash,
    restoreJournalOrganizerRecord,
    setSessionArchiveState,
    updateJournalRecords,
    updateOwnerNotes,
    updateSessionRecords,
    updateStudentRecord,
    transitionSessionRecord,
    type JournalInput,
    type JournalNoteBlock,
    type RemovedNoteBlock,
    type SessionCreateOptions,
    type SessionInput,
    type SessionTransitionAction,
    type StudentInput,
} from "./domain/records";
import {
    loadSessionAudioTrashChanges,
    planSessionRestore,
    planSessionTrash,
    type SessionTrashCounts,
    type SessionTrashPlan,
} from "./domain/session-trash";
import { restoreJournalEntryGroup } from "./domain/journal-trash";
import {
    correctTranscriptRecord,
    formatTranscriptExport,
    formatTranscriptTimestampUs,
    mergeTranscriptRecords,
    resolveTranscriptFormat,
    setTranscriptSpeaker,
    setTranscriptLinkedAssets,
    setTranscriptTimestamp,
    setTranscriptVerification,
    splitTranscriptRecord,
    sortTranscriptRecords,
    type TranscriptExportFormat,
} from "./domain/transcript";
import { platform } from "@platform";
import {
    AiPage,
    AnnotationPage,
    ArchiveMaintenance,
    ArchiveSettings,
    ArchiveSettingsCopy,
    AssetPage,
    CommandConsole,
    DiagnosticsReport,
    DocumentEditor,
    EvidencePage,
    GuidesPage,
    RecordPage,
    SanitizedCopy,
    SessionRow,
    TranscriptPage,
    TrashPage,
} from "./lazy-components";
import { Icon, ManagedDialog, type IconName } from "./shared-ui";
import {
    annotationTypeLabel,
    dateParts,
    errorMessage,
    field,
    formatBytes,
    formatTimestamp,
    initials,
    safeBigInt,
    safeJournalColor,
    safeFileName,
} from "./shared-utils";
import type { AiCredentialStorage, BrowserArchiveAutosave } from "./platform/types";
import { keyboardShortcutRows, resolveKeyboardShortcut } from "./domain/keyboard-shortcuts";
import brandLogo from "./assets/tutorux.svg";
import "./styles.css";

configurePdfWorkerSource(pdfWorkerUrl);

type View =
    | "home"
    | "journal"
    | "students"
    | "sessions"
    | "annotations"
    | "transcripts"
    | "guides"
    | "evidence"
    | "assets"
    | "ai"
    | "trash"
    | "archive"
    | "settings";
type DialogKind = "archive" | "student" | "session" | "journal" | "passphrase" | null;
type Tone = "success" | "info" | "error";
type ThemeMode = "system" | "light" | "dark";

export interface Workspace {
    snapshot: ArchiveSnapshot;
    manifest: ArchiveManifest;
    name: string;
    location: string | null;
    students: ArchiveRecord[];
    trashedStudents: ArchiveRecord[];
    trashedAnnotations: ArchiveRecord[];
    trashedGuides: ArchiveRecord[];
    trashedEvidence: ArchiveRecord[];
    sessions: ArchiveRecord[];
    archivedSessions: ArchiveRecord[];
    trashedSessions: ArchiveRecord[];
    audioTracks: AudioTrackDescriptor[];
    trashedRecordingTracks: ArchiveRecord[];
    entries: ArchiveRecord[];
    trashedJournalEntries: ArchiveRecord[];
    journals: ArchiveRecord[];
    collections: ArchiveRecord[];
    tags: ArchiveRecord[];
    trashedJournalOrganizers: ArchiveRecord[];
    guideTemplates: ArchiveRecord[];
    trashedGuideTemplates: ArchiveRecord[];
    trashedRecordingTakes: ArchiveRecord[];
    notesDocuments: ArchiveRecord[];
    guides: ArchiveRecord[];
    annotations: ArchiveRecord[];
    transcripts: ArchiveRecord[];
    assets: ArchiveRecord[];
    evidence: ArchiveRecord[];
    evidenceEdges: ArchiveRecord[];
    trashedEvidenceEdges: ArchiveRecord[];
    aiJobs: ArchiveRecord[];
    settings: ArchiveRecord[];
    providerSettings: ArchiveRecord[];
    credentials: ArchiveRecord[];
    dirty: boolean;
}

interface SessionTrashReview {
    session: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    plan: SessionTrashPlan;
}

export interface TrashPurgeReview {
    snapshot: ArchiveSnapshot;
    plan: ArchiveTrashPurgePlan;
}

interface NotesAutosaveVersion {
    archiveId: string;
    documentId: string;
    revision: bigint | null;
}

interface NotesAutosaveResult {
    documentId: string;
    revision: bigint;
    persisted: boolean;
    diskError?: string;
}

interface ViewDefinition {
    id: View;
    label: string;
    icon: IconName;
    group: "workspace" | "library" | "system";
}

const views: readonly ViewDefinition[] = [
    { id: "journal", label: "Journal", icon: "journal", group: "workspace" },
    { id: "students", label: "Students", icon: "students", group: "workspace" },
    { id: "assets", label: "Materials", icon: "assets", group: "library" },
    { id: "sessions", label: "Sessions", icon: "sessions", group: "workspace" },
    { id: "annotations", label: "Observations", icon: "annotations", group: "workspace" },
    { id: "transcripts", label: "Record", icon: "microphone", group: "workspace" },
    { id: "ai", label: "AI workspace", icon: "spark", group: "workspace" },
    { id: "guides", label: "Study guides", icon: "guides", group: "library" },
    { id: "evidence", label: "Evidence", icon: "evidence", group: "library" },
    { id: "trash", label: "Trash", icon: "trash", group: "library" },
    { id: "archive", label: "Archive health", icon: "archive", group: "system" },
    { id: "settings", label: "Preferences", icon: "settings", group: "system" },
];
const primaryViewIds = ["journal", "students", "sessions", "transcripts", "assets"];
const primaryViews = primaryViewIds.flatMap((id) => {
    const item = views.find((candidate) => candidate.id === id);
    return item ? [item] : [];
});
const contextualViews = views.filter(
    (item) => item.id !== "home" && !primaryViewIds.includes(item.id),
);

const [workspace, setWorkspace] = createSignal<Workspace | null>(null);
const [view, setView] = createSignal<View>("journal");
const [contextualNavOpen, setContextualNavOpen] = createSignal(false);
const [dialog, setDialog] = createSignal<DialogKind>(null);
const [dialogRecord, setDialogRecord] = createSignal<ArchiveRecord | null>(null);
const [pendingDelete, setPendingDelete] = createSignal<ArchiveRecord | null>(null);
const [pendingSessionTrash, setPendingSessionTrash] = createSignal<SessionTrashReview | null>(null);
const [pendingTrashPurge, setPendingTrashPurge] = createSignal<TrashPurgeReview | null>(null);
const [theme, setTheme] = createSignal<"light" | "dark">("light");
const [themeMode, setThemeMode] = createSignal<ThemeMode>("system");
const [loading, setLoading] = createSignal(false);
const [query, setQuery] = createSignal("");
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [commandConsoleOpen, setCommandConsoleOpen] = createSignal(false);
const [paletteQuery, setPaletteQuery] = createSignal("");
const [paletteIndex, setPaletteIndex] = createSignal(0);
const [notice, setNotice] = createSignal<{ message: string; tone: Tone } | null>(null);
const [archiveSaveConflict, setArchiveSaveConflict] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const [selectedTranscriptSessionId, setSelectedTranscriptSessionId] = createSignal("");
const [selectedAnnotationSessionId, setSelectedAnnotationSessionId] = createSignal("");
const [selectedGuideSessionId, setSelectedGuideSessionId] = createSignal("");
const [selectedEvidenceSessionId, setSelectedEvidenceSessionId] = createSignal("");
const [observationPlayback, setObservationPlayback] = createSignal<{
    url: string;
    title: string;
    start: string;
} | null>(null);
const [guideTemplateManagerOpen, setGuideTemplateManagerOpen] = createSignal(false);
const markerTypes: readonly AnnotationInput["type"][] = [
    "important-concept",
    "student-mistake",
    "tutor-correction",
    "explicit-instruction",
    "worked-example",
    "follow-up-priority",
    "general-note",
];
const defaultMarkerKeys = ["1", "2", "3", "4", "5", "6", "m"];
const markerSettingKey = "annotation.quick_marker_shortcuts";

function markerKeys(state: Workspace | null): string[] {
    const value = state?.settings
        .find((record) => field(record, "key") === markerSettingKey)
        ?.fields.get("value");
    const keys = value?.split(",").map((key) => key.toLowerCase());
    return keys && validMarkerKeys(keys, true) ? keys : [...defaultMarkerKeys];
}

function allSessions(state: Workspace): ArchiveRecord[] {
    return [...state.sessions, ...state.archivedSessions];
}

function markerStartTime(session: ArchiveRecord): string {
    let elapsed = safeBigInt(field(session, "recording_duration_us"));
    const started = safeBigInt(field(session, "recording_started_at_us"));
    if (field(session, "recording_state") === "recording" && started > 0n) {
        const now = BigInt(Date.now()) * 1000n;
        elapsed = now > started ? now - started : 0n;
    }
    return formatTranscriptTimestampUs(elapsed);
}

function validMarkerKeys(keys: string[], allowReserved = false): boolean {
    return (
        keys.length === markerTypes.length &&
        keys.every(
            (key) =>
                /^[\x21-\x7e]$/u.test(key) &&
                key !== "," &&
                (allowReserved || !["k", "o", "s", "n"].includes(key)),
        ) &&
        new Set(keys).size === keys.length
    );
}

function isEditableTarget(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
    );
}

function validThemeMode(value: string | undefined | null): value is ThemeMode {
    return value === "light" || value === "dark" || value === "system";
}

function archiveThemeMode(state: Workspace | null): ThemeMode | null {
    const value = state?.settings
        .find((record) => field(record, "key") === "ui.theme")
        ?.fields.get("value");
    return validThemeMode(value) ? value : null;
}

function localThemeFallback(): ThemeMode {
    const saved = localStorage.getItem("tutorux.theme");
    return validThemeMode(saved) ? saved : "system";
}

function applyWorkspaceTheme(state: Workspace | null): void {
    applyThemeMode(archiveThemeMode(state) ?? localThemeFallback(), false);
}

function applyThemeMode(mode: ThemeMode, persist = true): void {
    const resolved =
        mode === "system"
            ? window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light"
            : mode;
    setThemeMode(mode);
    setTheme(resolved);
    document.documentElement.dataset["theme"] = resolved;
    if (persist && !archiveThemeMode(workspace())) localStorage.setItem("tutorux.theme", mode);
}

const activeView = createMemo(
    () => views.find((item) => item.id === view()) ?? views.find((item) => item.id === "journal")!,
);
const currentRecords = createMemo(() => {
    const state = workspace();
    if (!state) return [] as ArchiveRecord[];
    if (view() === "students") return state.students;
    if (view() === "sessions") return [...state.sessions, ...state.archivedSessions];
    if (view() === "annotations") return state.annotations;
    if (view() === "transcripts") return state.transcripts;
    if (view() === "journal") return state.entries;
    if (view() === "guides") return state.guides;
    if (view() === "evidence") return state.evidence;
    if (view() === "assets") return state.assets;
    return [];
});
const filteredRecords = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const records = currentRecords();
    if (!needle) return records;
    const matchingRecords: ArchiveRecord[] = [];
    for (const record of records) {
        let matches = false;
        for (const value of record.fields.values()) {
            if (!value.toLowerCase().includes(needle)) continue;
            matches = true;
            break;
        }
        if (matches) matchingRecords.push(record);
    }
    const state = workspace();
    if (view() !== "journal" || !state) return matchingRecords;
    const matchingEntries = new Set<string>();
    const sessionEntries = new Map(
        [...state.sessions, ...state.archivedSessions].map((session) => [
            session.id.toLowerCase(),
            field(session, "entry_id").toLowerCase(),
        ]),
    );
    for (const record of [...state.notesDocuments, ...state.guides, ...state.transcripts]) {
        let matches = false;
        for (const value of record.fields.values()) {
            if (!value.toLowerCase().includes(needle)) continue;
            matches = true;
            break;
        }
        if (!matches) continue;
        const entry =
            field(record, "entry_id").toLowerCase() ||
            sessionEntries.get(field(record, "session_id").toLowerCase());
        if (entry) matchingEntries.add(entry);
    }
    const matchingRecordIds = new Set(matchingRecords.map((record) => record.id.toLowerCase()));
    return records.filter(
        (record) =>
            matchingRecordIds.has(record.id.toLowerCase()) ||
            matchingEntries.has(record.id.toLowerCase()),
    );
});

function App(): JSX.Element {
    const [lastAiExecution, setLastAiExecution] = createSignal<{
        archiveId: string;
        summary: AiExecutionSummary;
    } | null>(null);
    const [guidePrintContent, setGuidePrintContent] = createSignal<HTMLElement | null>(null);
    const [systemCredentialStoreAvailable, setSystemCredentialStoreAvailable] = createSignal(false);
    createEffect(() => {
        const execution = lastAiExecution();
        const active = workspace();
        if (
            execution &&
            (!active || active.snapshot.locked || active.snapshot.header.id !== execution.archiveId)
        ) {
            setLastAiExecution(null);
        }
    });
    createEffect(
        on(
            view,
            (current) => {
                if (current !== "trash") setPendingTrashPurge(null);
            },
            { defer: true },
        ),
    );
    let noticeTimer = 0;
    let removeNativeCommandListener: (() => void) | undefined;
    let nativeCommandListenerDisposed = false;
    let launchArchiveQueue: Promise<void> = Promise.resolve();
    let pageSearchInput: HTMLInputElement | undefined;
    let mainContentElement: HTMLElement | undefined;
    let contextualNavMenuElement: HTMLDivElement | undefined;
    let navigationFocusFrame = 0;
    let browserAutosaveBinding:
        | { archiveId: string; capability: BrowserArchiveAutosave; authorized: boolean }
        | undefined;

    onMount(() => {
        if (platform.kind === "desktop") {
            void platform
                .aiCredentialStoreAvailable()
                .then(setSystemCredentialStoreAvailable)
                .catch(() => setSystemCredentialStoreAvailable(false));
        }
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        applyThemeMode(localThemeFallback(), false);
        const updateSystemTheme = (): void => {
            if (themeMode() === "system") applyThemeMode("system", false);
        };
        mediaQuery.addEventListener("change", updateSystemTheme);

        const receiveNotice = (event: Event): void => {
            const detail = (event as CustomEvent<{ message: string; tone?: Tone }>).detail;
            announce(detail.message, detail.tone ?? "info");
        };
        const handleKeys = (event: KeyboardEvent): void => {
            const active = workspace();
            const action = resolveKeyboardShortcut(event, {
                platform: platform.kind,
                pageSearchAvailable: Boolean(pageSearchInput?.isConnected),
                pageSearchFocused: event.target === pageSearchInput,
                page: view(),
                editableTarget: isEditableTarget(event.target),
                modalOpen: Boolean(
                    dialog() ||
                    pendingDelete() ||
                    pendingSessionTrash() ||
                    pendingTrashPurge() ||
                    commandConsoleOpen(),
                ),
                paletteOpen: paletteOpen(),
                markerKeys: markerKeys(active),
                markerEnabled: Boolean(
                    active && allSessions(active).length && active.snapshot.canMutate && !busy(),
                ),
            });
            if (!action) return;
            event.preventDefault();
            switch (action.type) {
                case "quick-actions":
                    if (paletteOpen()) closePalette();
                    else openPalette();
                    break;
                case "open-archive":
                    void openArchive();
                    break;
                case "save-archive":
                    void saveCurrentArchiveFromAction();
                    break;
                case "new-session":
                    openDialog("session");
                    break;
                case "find":
                    pageSearchInput?.focus();
                    pageSearchInput?.select();
                    break;
                case "preferences":
                    navigateToView("settings");
                    break;
                case "toggle-appearance":
                    toggleTheme();
                    break;
                case "quick-marker":
                    window.dispatchEvent(
                        new CustomEvent("tutorux:quick-marker", {
                            detail: markerTypes[action.index]!,
                        }),
                    );
                    break;
            }
        };
        const handleQuickMarker = (event: Event): void => {
            // The mounted Observations page owns the marker note field; elsewhere the
            // global shortcut still records the marker for the selected session.
            if (view() === "annotations") return;
            const detail = (event as CustomEvent<string>).detail;
            if (!markerTypes.includes(detail as AnnotationInput["type"])) return;
            const current = workspace();
            if (!current || !current.snapshot.canMutate || busy()) return;
            const session = allSessions(current).find(
                (item) => item.id === selectedAnnotationSessionId(),
            );
            if (!session) {
                announce("Select a session before using quick markers.", "info");
                return;
            }
            void saveAnnotation(
                {
                    sessionId: session.id,
                    start: markerStartTime(session),
                    end: "",
                    type: detail as AnnotationInput["type"],
                    priority: "normal",
                    title: annotationTypeLabel(detail),
                    content: "",
                },
                null,
            );
        };
        if (platform.kind === "desktop" && platform.onNativeCommand) {
            void platform
                .onNativeCommand((command) =>
                    untrack(() => {
                        switch (command) {
                            case "open":
                                void openArchive();
                                break;
                            case "save":
                                void saveCurrentArchiveFromAction();
                                break;
                            case "quick-actions":
                                if (paletteOpen()) closePalette();
                                else openPalette();
                                break;
                            case "preferences":
                                navigateToView("settings");
                                break;
                            case "toggle-appearance":
                                toggleTheme();
                                break;
                            case "open-launch-archive":
                                void openPendingLaunchArchives();
                                break;
                        }
                    }),
                )
                .then((unlisten) => {
                    if (nativeCommandListenerDisposed) unlisten();
                    else removeNativeCommandListener = unlisten;
                    void openPendingLaunchArchives();
                })
                .catch((error: unknown) => announce(errorMessage(error), "error"));
        }
        if (platform.kind === "desktop" && platform.openLaunchArchive) {
            void openPendingLaunchArchives();
        }
        const handlePointerDown = (event: PointerEvent): void => {
            if (!contextualNavOpen()) return;
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (contextualNavMenuElement?.contains(target)) return;
            if (target instanceof Element && target.closest(".contextual-nav-toggle")) return;
            setContextualNavOpen(false);
        };
        window.addEventListener("tutorux:notice", receiveNotice);
        window.addEventListener("tutorux:quick-marker", handleQuickMarker);
        window.addEventListener("keydown", handleKeys);
        window.addEventListener("pointerdown", handlePointerDown, true);
        onCleanup(() => {
            window.removeEventListener("tutorux:notice", receiveNotice);
            window.removeEventListener("tutorux:quick-marker", handleQuickMarker);
            window.removeEventListener("keydown", handleKeys);
            window.removeEventListener("pointerdown", handlePointerDown, true);
            mediaQuery.removeEventListener("change", updateSystemTheme);
            window.clearTimeout(noticeTimer);
            window.cancelAnimationFrame(navigationFocusFrame);
            nativeCommandListenerDisposed = true;
            removeNativeCommandListener?.();
            const playback = observationPlayback();
            if (playback) URL.revokeObjectURL(playback.url);
            setObservationPlayback(null);
            workspace()?.snapshot.lock();
        });
    });

    function announce(message: string, tone: Tone = "info"): void {
        setNotice({ message, tone });
        window.clearTimeout(noticeTimer);
        noticeTimer = window.setTimeout(() => setNotice(null), 4200);
    }

    async function readWorkspace(
        snapshot: ArchiveSnapshot,
        name: string,
        location: string | null,
        dirty = false,
    ): Promise<Workspace> {
        const manifest = await snapshot.getManifest();
        if (snapshot.locked) {
            return {
                snapshot,
                manifest,
                name,
                location,
                dirty,
                students: [],
                trashedStudents: [],
                trashedAnnotations: [],
                trashedGuides: [],
                trashedEvidence: [],
                sessions: [],
                archivedSessions: [],
                trashedSessions: [],
                audioTracks: [],
                trashedRecordingTracks: [],
                entries: [],
                trashedJournalEntries: [],
                journals: [],
                collections: [],
                tags: [],
                trashedJournalOrganizers: [],
                guideTemplates: [],
                trashedGuideTemplates: [],
                trashedRecordingTakes: [],
                notesDocuments: [],
                guides: [],
                annotations: [],
                transcripts: [],
                assets: [],
                evidence: [],
                evidenceEdges: [],
                trashedEvidenceEdges: [],
                aiJobs: [],
                settings: [],
                providerSettings: [],
                credentials: [],
            };
        }
        const [
            allStudents,
            sessions,
            settings,
            guides,
            allAnnotations,
            transcripts,
            assets,
            evidence,
            evidenceEdges,
            aiJobs,
        ] = await Promise.all([
            snapshot.listRecords(RecordType.student, true),
            snapshot.listRecords(RecordType.session, true),
            snapshot.listRecords(RecordType.settings, true),
            snapshot.listRecords(RecordType.guide, true),
            snapshot.listRecords(RecordType.annotation, true),
            snapshot.listRecords(RecordType.transcriptSegment),
            snapshot.listRecords(RecordType.assetMetadata, true),
            snapshot.listRecords(RecordType.evidenceNode, true),
            snapshot.listRecords(RecordType.evidenceEdge, true),
            snapshot.listRecordMetadata(RecordType.aiJob),
        ]);
        const liveSessions = alive(sessions);
        const trashedSessionIds = new Set(
            sessions
                .filter((record) => record.fields.get("_deleted") === "true")
                .map((record) => record.id.toLowerCase()),
        );
        const liveAssets = alive(assets);
        const indexedAudioTracks = snapshot.audioTrackIdsBySession();
        return {
            snapshot,
            manifest,
            name,
            location,
            dirty,
            students: alive(allStudents),
            trashedStudents: allStudents.filter(
                (record) => record.fields.get("_deleted") === "true",
            ),
            trashedAnnotations: allAnnotations.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    !record.fields.get("_trash_group_id"),
            ),
            trashedGuides: guides.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    !record.fields.get("_trash_group_id"),
            ),
            trashedEvidence: evidence.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    !trashedSessionIds.has(field(record, "_trash_group_id").toLowerCase()),
            ),
            sessions: liveSessions.filter((record) => record.fields.get("archived") !== "true"),
            archivedSessions: liveSessions.filter(
                (record) => record.fields.get("archived") === "true",
            ),
            trashedSessions: sessions.filter((record) => record.fields.get("_deleted") === "true"),
            audioTracks: liveSessions.flatMap((session) =>
                listSessionAudioTracks(
                    session,
                    assets,
                    indexedAudioTracks.get(session.id.toLowerCase()) ?? [],
                ),
            ),
            trashedRecordingTracks: assets.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    record.fields.get("record_role") === "audio-track" &&
                    record.fields.get("_trash_group_id")?.toLowerCase() === record.id.toLowerCase(),
            ),
            entries: alive(settings).filter(
                (record) => record.fields.get("record_role") === "journal-entry",
            ),
            trashedJournalEntries: settings.filter(
                (record) =>
                    record.fields.get("record_role") === "journal-entry" &&
                    record.fields.get("_deleted") === "true",
            ),
            journals: alive(settings).filter(
                (record) => record.fields.get("record_role") === "journal",
            ),
            collections: alive(settings).filter(
                (record) => record.fields.get("record_role") === "journal-collection",
            ),
            tags: alive(settings).filter(
                (record) => record.fields.get("record_role") === "journal-tag",
            ),
            trashedJournalOrganizers: settings.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    ["journal-collection", "journal-tag"].includes(
                        record.fields.get("record_role") ?? "",
                    ),
            ),
            guideTemplates: alive(settings).filter(
                (record) =>
                    record.fields.get("record_role") === "guide-template" &&
                    !record.fields.get("builtin_template_id"),
            ),
            trashedGuideTemplates: settings.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    record.fields.get("record_role") === "guide-template" &&
                    !record.fields.get("builtin_template_id"),
            ),
            trashedRecordingTakes: assets.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    record.fields.get("record_role") === "recording-take",
            ),
            notesDocuments: alive(settings).filter(
                (record) => record.fields.get("record_role") === "journal-notes",
            ),
            guides: alive(guides),
            annotations: alive(allAnnotations),
            transcripts: alive(transcripts),
            assets: liveAssets,
            evidence: alive(evidence),
            evidenceEdges: alive(evidenceEdges),
            trashedEvidenceEdges: evidenceEdges.filter(
                (record) =>
                    record.fields.get("_deleted") === "true" &&
                    record.fields.get("_trash_group_id")?.toLowerCase() === record.id.toLowerCase(),
            ),
            aiJobs,
            settings: alive(settings).filter(
                (record) => field(record, "record_role") === "setting",
            ),
            providerSettings: alive(settings).filter(
                (record) => record.fields.get("record_role") === "ai-provider",
            ),
            credentials: settings
                .filter(
                    (record) =>
                        record.fields.get("record_role") === "credential" &&
                        record.fields.get("_deleted") !== "true",
                )
                .map(maskCredentialMetadata),
        };
    }

    async function acceptArchive(
        source: ArchiveByteSource,
        name: string,
        location: string | null,
        browserAutosave?: BrowserArchiveAutosave,
    ): Promise<void> {
        setLoading(true);
        let accepted = false;
        try {
            const snapshot = await openArchiveSource(source);
            const next = await readWorkspace(snapshot, name, location);
            const previous = workspace();
            setWorkspace(next);
            setArchiveSaveConflict(false);
            applyWorkspaceTheme(next);
            browserAutosaveBinding = browserAutosave
                ? {
                      archiveId: snapshot.header.id.toLowerCase(),
                      capability: browserAutosave,
                      authorized: false,
                  }
                : undefined;
            if (previous && previous.snapshot !== snapshot) previous.snapshot.lock();
            setPendingSessionTrash(null);
            setPendingTrashPurge(null);
            accepted = true;
            setView("journal");
            setQuery("");
            if (previous && previous.snapshot.source !== source) {
                await previous.snapshot.source.close?.().catch(() => undefined);
            }
            announce(`Opened ${next.manifest.displayName}.`, "success");
        } catch (error) {
            if (!accepted) await source.close?.().catch(() => undefined);
            announce(errorMessage(error), "error");
        } finally {
            setLoading(false);
        }
    }

    function openPendingLaunchArchives(): Promise<void> {
        if (platform.kind !== "desktop" || !platform.openLaunchArchive) return Promise.resolve();
        const drain = async (): Promise<void> => {
            while (true) {
                const selected = await platform.openLaunchArchive?.();
                if (!selected) return;
                await acceptArchive(selected.source, selected.name, selected.location);
            }
        };
        const next = (): Promise<void> =>
            drain().catch((error: unknown) => announce(errorMessage(error), "error"));
        launchArchiveQueue = launchArchiveQueue.then(next, next);
        return launchArchiveQueue;
    }

    async function unlockCurrentArchive(passphrase: string): Promise<void> {
        const state = workspace();
        if (!state?.snapshot.locked) return;
        setBusy(true);
        let unlocked: ArchiveSnapshot | undefined;
        try {
            unlocked = await state.snapshot.unlock(passphrase);
            const next = await readWorkspace(unlocked, state.name, state.location, state.dirty);
            if (workspace()?.snapshot !== state.snapshot) {
                unlocked.lock();
                return;
            }
            setWorkspace(next);
            setArchiveSaveConflict(false);
            applyWorkspaceTheme(next);
            setView("journal");
            announce(
                "Archive unlocked; commit, index pages, and manifest authentication passed.",
                "success",
            );
        } catch (error) {
            unlocked?.lock();
            throw error;
        } finally {
            setBusy(false);
        }
    }

    function lockCurrentArchive(): void {
        const state = workspace();
        if (!state?.snapshot.encrypted || state.snapshot.locked) return;
        state.snapshot.lock();
        setWorkspace({
            ...state,
            students: [],
            trashedStudents: [],
            trashedAnnotations: [],
            trashedGuides: [],
            sessions: [],
            archivedSessions: [],
            trashedSessions: [],
            audioTracks: [],
            entries: [],
            trashedJournalEntries: [],
            journals: [],
            collections: [],
            tags: [],
            trashedJournalOrganizers: [],
            guideTemplates: [],
            trashedGuideTemplates: [],
            notesDocuments: [],
            guides: [],
            annotations: [],
            transcripts: [],
            assets: [],
            evidence: [],
            evidenceEdges: [],
            trashedEvidenceEdges: [],
            providerSettings: [],
            credentials: [],
        });
        setDialog(null);
        setDialogRecord(null);
        setPendingDelete(null);
        setPendingSessionTrash(null);
        setPendingTrashPurge(null);
        setSelectedTranscriptSessionId("");
        setSelectedAnnotationSessionId("");
        setSelectedEvidenceSessionId("");
        setQuery("");
        setView("journal");
        announce("Archive locked.", "success");
    }

    async function openArchive(): Promise<void> {
        try {
            const selected = await platform.openArchive();
            if (!selected) return;
            await acceptArchive(
                selected.source,
                selected.name,
                selected.location,
                selected.autosave,
            );
        } catch (error) {
            if (isCancelled(error)) return;
            announce(errorMessage(error), "error");
        }
    }

    async function refreshArchiveAfterCommand(
        source: ArchiveByteSource,
        location: string | null,
    ): Promise<void> {
        const current = workspace();
        if (
            !current ||
            current.snapshot.source !== source ||
            current.location !== location ||
            platform.kind !== "desktop" ||
            !location ||
            !platform.reopenArchiveAtPath
        ) {
            return;
        }

        let refreshedSource: ArchiveByteSource | undefined;
        let refreshedSnapshot: ArchiveSnapshot | undefined;
        try {
            const reopened = await platform.reopenArchiveAtPath(location);
            refreshedSource = reopened.source;
            refreshedSnapshot = await openArchiveSource(reopened.source);
            const next = await readWorkspace(refreshedSnapshot, reopened.name, reopened.location);
            if (workspace() !== current) {
                refreshedSnapshot.lock();
                await refreshedSource.close?.().catch(() => undefined);
                return;
            }

            setWorkspace(next);
            setArchiveSaveConflict(false);
            applyWorkspaceTheme(next);
            browserAutosaveBinding = undefined;
            current.snapshot.lock();
            setPendingSessionTrash(null);
            setPendingTrashPurge(null);
            setDialog(null);
            setDialogRecord(null);
            setPendingDelete(null);
            setView("journal");
            await current.snapshot.source.close?.().catch(() => undefined);
            announce(
                refreshedSnapshot.locked
                    ? "The archive was refreshed. Unlock it again to continue."
                    : "The archive was refreshed with the command's changes.",
                "success",
            );
        } catch (error) {
            refreshedSnapshot?.lock();
            await refreshedSource?.close?.().catch(() => undefined);
            if (workspace() !== current) return;
            current.snapshot.lock();
            setWorkspace(null);
            applyWorkspaceTheme(null);
            browserAutosaveBinding = undefined;
            setPendingSessionTrash(null);
            setPendingTrashPurge(null);
            setDialog(null);
            setDialogRecord(null);
            setPendingDelete(null);
            setView("journal");
            await current.snapshot.source.close?.().catch(() => undefined);
            announce(
                `The command changed this archive, but Tutorux could not reopen it. Reopen the archive before continuing. ${errorMessage(error)}`,
                "error",
            );
        }
    }

    async function createArchive(
        name: string,
        description: string,
        passphrase = "",
    ): Promise<void> {
        if (busy()) return;
        if (!name.trim()) throw new Error("Give this archive a name before creating it.");
        const suggestedName = `${safeFileName(name)}.tux`;
        let openedSnapshot: ArchiveSnapshot | undefined;
        let snapshot: ArchiveSnapshot | undefined;
        let accepted = false;
        setBusy(true);
        try {
            const location = await platform.createArchiveLocation(suggestedName);
            if (!location) return;
            const bytes = passphrase
                ? await createEncryptedArchiveBytes(name.trim(), description.trim(), passphrase)
                : await createArchiveBytes(name.trim(), description.trim());
            openedSnapshot = await openArchiveBytes(bytes);
            snapshot = passphrase ? await openedSnapshot.unlock(passphrase) : openedSnapshot;
            const savedLocation = await platform.saveArchive(
                snapshot.source,
                suggestedName,
                location,
            );
            const next = await readWorkspace(snapshot, suggestedName, savedLocation);
            const previous = workspace();
            setWorkspace(next);
            setArchiveSaveConflict(false);
            applyWorkspaceTheme(next);
            browserAutosaveBinding = undefined;
            accepted = true;
            if (previous && previous.snapshot !== snapshot) previous.snapshot.lock();
            if (previous && previous.snapshot.source !== snapshot.source) {
                await previous.snapshot.source.close?.().catch(() => undefined);
            }
            setPendingSessionTrash(null);
            setView("journal");
            setDialog(null);
            setDialogRecord(null);
            announce(`Created ${name.trim()}.`, "success");
        } finally {
            if (!accepted) {
                snapshot?.lock();
                if (openedSnapshot && openedSnapshot !== snapshot) openedSnapshot.lock();
                await openedSnapshot?.source.close?.().catch(() => undefined);
            }
            setBusy(false);
        }
    }

    async function saveCurrentArchive(): Promise<void> {
        await saveArchive(false);
    }

    async function saveCurrentArchiveFromAction(): Promise<void> {
        if (archiveSaveConflict()) {
            await saveCurrentArchiveAs();
            return;
        }
        await saveCurrentArchive();
    }

    async function saveCurrentArchiveAs(): Promise<void> {
        await saveArchive(true);
    }

    async function saveArchive(asNewCopy: boolean): Promise<void> {
        const state = workspace();
        if (!state || busy()) return;
        setBusy(true);
        try {
            const path = await platform.saveArchive(
                state.snapshot.source,
                asNewCopy ? recoveredArchiveName(state.name) : state.name,
                asNewCopy ? null : state.location,
            );
            if (!path) return;
            if (platform.kind === "browser") browserAutosaveBinding = undefined;
            setWorkspace({
                ...state,
                location: platform.kind === "desktop" ? path : null,
                dirty: false,
            });
            setArchiveSaveConflict(false);
            announce(
                asNewCopy ? "A separate copy of your archive is saved." : "Your archive is saved.",
                "success",
            );
        } catch (error) {
            if (isArchiveSaveConflictMessage(errorMessage(error))) {
                setArchiveSaveConflict(true);
            }
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    function markArchiveSnapshotPersisted(snapshot: ArchiveSnapshot): void {
        const current = workspace();
        if (
            !current ||
            current.snapshot !== snapshot ||
            current.snapshot.header.id.toLowerCase() !== snapshot.header.id.toLowerCase() ||
            current.snapshot.commit.generation !== snapshot.commit.generation ||
            current.snapshot.commit.offset !== snapshot.commit.offset
        ) {
            return;
        }

        // Audio checkpoints publish the full current archive generation. Only clear the
        // workspace indicator while that exact snapshot is still active; any later edit
        // receives a new snapshot and remains dirty.
        if (current.dirty) setWorkspace({ ...current, dirty: false });
    }

    async function renameArchiveDisplayName(displayName: string): Promise<boolean> {
        const current = workspace();
        if (!current) {
            announce("Create or open an archive before renaming it.", "error");
            return false;
        }
        if (!current.snapshot.canMutate) {
            announce(
                current.snapshot.locked
                    ? "Unlock this archive before editing it."
                    : "This archive cannot be edited in its current state.",
                "error",
            );
            return false;
        }
        const name = displayName.trim();
        if (!name) {
            announce("Archive name must not be empty.", "error");
            return false;
        }
        if (name.length > 200) {
            announce("Archive names must be 200 characters or fewer.", "error");
            return false;
        }

        try {
            const manifest = await current.snapshot.getRecord(
                RecordType.settings,
                current.snapshot.header.id,
            );
            if (manifest?.fields.get("record_role") !== "archive-manifest") {
                throw new Error("The archive manifest is missing or invalid.");
            }
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error("The active archive changed while its name was being updated.");
            }
            const fields = new Map(manifest.fields);
            fields.set("display_name", name);
            return await addRecords(
                [{ ...manifest, fields }],
                "Archive name updated in the workspace. Save the workspace to write it to disk.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function addRecords(
        records: readonly ArchiveRecord[],
        successMessage = "Added to your archive. Save to write the new generation to disk.",
    ): Promise<boolean> {
        const current = workspace();
        if (!current) {
            announce("Create or open an archive before adding records.", "error");
            return false;
        }
        if (!current.snapshot.canMutate) {
            announce(
                current.snapshot.locked
                    ? "Unlock this archive before editing it."
                    : "This archive cannot be edited in its current state.",
                "error",
            );
            return false;
        }
        setBusy(true);
        let nextSnapshot: ArchiveSnapshot | undefined;
        try {
            nextSnapshot = await appendRecords(current.snapshot, records);
            const updated = await readWorkspace(nextSnapshot, current.name, current.location, true);
            if (workspace()?.snapshot !== current.snapshot) {
                nextSnapshot.lock();
                return false;
            }
            setWorkspace(updated);
            applyWorkspaceTheme(updated);
            if (nextSnapshot !== current.snapshot) current.snapshot.lock();
            setView(view());
            announce(successMessage, "success");
            setDialog(null);
            setDialogRecord(null);
            setPendingDelete(null);
            setPendingSessionTrash(null);
            setPendingTrashPurge(null);
            return true;
        } catch (error) {
            if (nextSnapshot && workspace()?.snapshot !== nextSnapshot) nextSnapshot.lock();
            announce(errorMessage(error), "error");
            return false;
        } finally {
            setBusy(false);
        }
    }

    async function applyArchiveMaintenance(
        original: ArchiveSnapshot,
        replacement: ArchiveSnapshot,
    ): Promise<boolean> {
        const current = workspace();
        if (!current || current.snapshot !== original || busy()) return false;
        setBusy(true);
        try {
            const updated = await readWorkspace(replacement, current.name, current.location, true);
            if (workspace()?.snapshot !== original) return false;
            setWorkspace(updated);
            applyWorkspaceTheme(updated);
            announce(
                "Archive changes are ready. Save the workspace to write them to disk.",
                "success",
            );
            return true;
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        } finally {
            setBusy(false);
        }
    }

    async function enableNotesAutosave(): Promise<boolean> {
        const state = workspace();
        const binding = browserAutosaveBinding;
        if (!state || !binding || binding.archiveId !== state.snapshot.header.id.toLowerCase())
            return true;
        // This call is made directly from the checkbox event, before yielding.
        const permission = await binding.capability.requestPermission();
        if (browserAutosaveBinding !== binding || workspace()?.snapshot !== state.snapshot)
            return false;
        binding.authorized = permission;
        return permission;
    }

    async function autosaveNotes(
        owner: ArchiveRecord,
        version: NotesAutosaveVersion,
        blocks: readonly JournalNoteBlock[],
    ): Promise<NotesAutosaveResult> {
        const current = workspace();
        if (!current || current.snapshot.locked || !current.snapshot.canMutate)
            throw new Error("Unlock a writable archive before autosaving notes.");
        if (busy()) throw new Error("Wait for the current archive operation to finish.");
        if (current.snapshot.header.id.toLowerCase() !== version.archiveId.toLowerCase())
            throw new Error(
                "The active archive changed. Reopen this record to continue autosaving.",
            );
        const owners =
            owner.type === RecordType.session
                ? [...current.sessions, ...current.archivedSessions]
                : current.entries;
        const latestOwner = owners.find((item) => item.id.toLowerCase() === owner.id.toLowerCase());
        if (!latestOwner) throw new Error("This record is no longer available in the archive.");
        const documentId = field(latestOwner, "notes_document_id");
        const document =
            current.notesDocuments.find(
                (item) => item.id.toLowerCase() === documentId.toLowerCase(),
            ) ?? null;
        if (
            documentId.toLowerCase() !== version.documentId.toLowerCase() ||
            (document?.revision ?? null) !== version.revision
        ) {
            throw new Error("These notes changed elsewhere. Reopen the record before autosaving.");
        }
        const changes = updateOwnerNotes(latestOwner, document, blocks);
        const changedDocument = changes.find(
            (item) =>
                item.type === RecordType.settings && field(item, "record_role") === "journal-notes",
        );
        if (!changedDocument) throw new Error("The notes document could not be prepared.");

        setBusy(true);
        let nextSnapshot: ArchiveSnapshot | undefined;
        let accepted = false;
        try {
            nextSnapshot = await appendRecords(current.snapshot, changes);
            const updated = await readWorkspace(nextSnapshot, current.name, current.location, true);
            if (workspace()?.snapshot !== current.snapshot)
                throw new Error("The active archive changed while notes were being saved.");
            const savedDocument = updated.notesDocuments.find(
                (item) => item.id === changedDocument.id,
            );
            if (!savedDocument) throw new Error("The saved notes document could not be reopened.");
            setWorkspace(updated);
            accepted = true;
            current.snapshot.lock();

            let persisted = false;
            let diskError: string | undefined;
            if (platform.kind === "desktop" && current.location) {
                try {
                    const location = await platform.saveArchive(
                        nextSnapshot.source,
                        current.name,
                        current.location,
                    );
                    persisted = Boolean(location);
                    if (persisted && workspace()?.snapshot === nextSnapshot) {
                        setWorkspace({ ...updated, location, dirty: false });
                        setArchiveSaveConflict(false);
                    }
                } catch (error) {
                    diskError = errorMessage(error);
                    if (isArchiveSaveConflictMessage(diskError)) {
                        setArchiveSaveConflict(true);
                    }
                    announce(
                        "Notes are saved in the workspace, but the archive file could not be updated.",
                        "error",
                    );
                }
            } else if (platform.kind === "browser") {
                const binding = browserAutosaveBinding;
                if (
                    binding?.authorized &&
                    binding.archiveId === current.snapshot.header.id.toLowerCase()
                ) {
                    let rebased: ArchiveSnapshot | undefined;
                    try {
                        const source = await binding.capability.save(nextSnapshot.source);
                        rebased = await nextSnapshot.openNextGeneration(source);
                        if (
                            browserAutosaveBinding !== binding ||
                            workspace()?.snapshot !== nextSnapshot ||
                            rebased.header.id !== nextSnapshot.header.id ||
                            rebased.commit.generation !== nextSnapshot.commit.generation ||
                            rebased.commit.offset !== nextSnapshot.commit.offset
                        ) {
                            throw new Error(
                                "The active archive changed while the saved file was reopening.",
                            );
                        }
                        setWorkspace({ ...updated, snapshot: rebased, dirty: false });
                        nextSnapshot.lock();
                        persisted = true;
                    } catch (error) {
                        rebased?.lock();
                        binding.authorized = false;
                        diskError = errorMessage(error);
                        if (isArchiveSaveConflictMessage(diskError)) {
                            setArchiveSaveConflict(true);
                        }
                        announce(
                            "Notes are saved in the workspace, but the archive file could not be updated.",
                            "error",
                        );
                    }
                }
            }
            return {
                documentId: savedDocument.id,
                revision: savedDocument.revision,
                persisted,
                ...(diskError ? { diskError } : {}),
            };
        } catch (error) {
            if (!accepted) nextSnapshot?.lock();
            throw error;
        } finally {
            setBusy(false);
        }
    }

    async function prepareAiPackage(
        sessionId: string,
        templateId: string,
        attachmentIds: readonly string[],
    ): Promise<AiPackageSummary> {
        const current = workspace();
        if (!current) throw new Error("Create or open an archive before preparing a package.");
        if (current.snapshot.locked || !current.snapshot.canMutate) {
            throw new Error("Unlock this archive before preparing a package.");
        }
        if (busy()) throw new Error("Wait for the current archive operation to finish.");
        setBusy(true);
        try {
            const summary = await createAiPackageRecord(
                current.snapshot,
                sessionId,
                templateId,
                attachmentIds,
            );
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error("The active archive changed while the package was being prepared.");
            }
            return summary;
        } finally {
            setBusy(false);
        }
    }

    async function createAiProviderPreview(
        packageJob: ArchiveRecord,
        providerId: string,
        credentialStorage: AiCredentialStorage,
        replicateInputSchema?: ReplicateModelInputSchema,
    ): Promise<AiRequestPreview> {
        const current = workspace();
        if (!current || current.snapshot.locked) {
            throw new Error("Unlock the archive before reviewing an AI request.");
        }
        const providerMetadata = current.providerSettings.find(
            (record) => record.fields.get("provider_id") === providerId,
        );
        if (!providerMetadata)
            throw new Error("Save the selected provider settings before previewing.");
        const providerConfiguration = await current.snapshot.getRecord(
            RecordType.settings,
            providerMetadata.id,
        );
        if (!providerConfiguration)
            throw new Error("The saved provider settings could not be loaded.");
        const useSystemCredentialStore = credentialStorage === "system-keychain";
        const hasSystemCredential =
            useSystemCredentialStore &&
            platform.kind === "desktop" &&
            (await platform.hasAiCredential(providerId));
        return createAiRequestPreview(
            packageJob,
            providerConfiguration,
            undefined,
            useSystemCredentialStore ? [] : current.credentials,
            hasSystemCredential,
            current.snapshot,
            replicateInputSchema,
        );
    }

    async function inspectReplicateModelForAiProvider(
        providerId: string,
        model: string,
        credentialStorage: AiCredentialStorage,
    ): Promise<ReplicateModelInputSchema> {
        let current = workspace();
        if (!current || current.snapshot.locked) {
            throw new Error("Unlock the archive before inspecting a Replicate model.");
        }
        const inspectionSnapshot = current.snapshot;
        if (providerId !== "replicate") {
            throw new Error("Model-schema inspection is available only for Replicate.");
        }
        const providerMetadata = current.providerSettings.find(
            (record) => record.fields.get("provider_id") === providerId,
        );
        if (!providerMetadata)
            throw new Error("Save Replicate settings before inspecting a model.");
        const providerConfiguration = await current.snapshot.getRecord(
            RecordType.settings,
            providerMetadata.id,
        );
        if (
            !providerConfiguration ||
            providerConfiguration.fields.get("selected_model") !== model
        ) {
            throw new Error("The saved Replicate model changed. Save it again before previewing.");
        }

        let credential = "";
        if (credentialStorage === "system-keychain") {
            if (
                platform.kind !== "desktop" ||
                !systemCredentialStoreAvailable() ||
                !(await platform.hasAiCredential(providerId))
            ) {
                throw new Error(
                    "Save the Replicate API token in the system credential store first.",
                );
            }
        } else if (credentialStorage === "encrypted-archive") {
            if (!current.snapshot.encrypted) {
                throw new Error("Save the Replicate API token in an encrypted archive first.");
            }
            const metadata = current.credentials.find(
                (record) =>
                    record.fields.get("provider_id") === providerId ||
                    record.fields.get("key") === providerById(providerId)?.credentialKey,
            );
            if (!metadata)
                throw new Error("Save the Replicate API token before inspecting the model.");
            const savedCredential = await current.snapshot.getRecord(
                RecordType.settings,
                metadata.id,
            );
            if (
                !savedCredential ||
                savedCredential.fields.get("record_role") !== "credential" ||
                savedCredential.fields.get("_deleted") === "true" ||
                savedCredential.fields.get("provider_id") !== providerId
            ) {
                throw new Error(
                    "The saved Replicate API token could not be verified in this archive.",
                );
            }
            credential = savedCredential.fields.get("value") ?? "";
            if (!credential) throw new Error("The saved Replicate API token is empty.");
        } else {
            throw new Error("Choose a secure Replicate credential store before model inspection.");
        }

        const chunks: Uint8Array[] = [];
        let receivedBytes = 0;
        const result = await platform.inspectReplicateModel(
            { model, credentialStorage, credential },
            (chunk) => {
                receivedBytes += chunk.byteLength;
                if (receivedBytes > 8 * 1024 * 1024) {
                    throw new Error("The Replicate model schema exceeded the 8 MiB limit.");
                }
                chunks.push(chunk.slice());
            },
        );
        current = workspace();
        if (!current || current.snapshot !== inspectionSnapshot) {
            // The active archive may change during a network request; schema results are bound to it.
            throw new Error("The active archive changed during model inspection. Review again.");
        }
        if (result.errorMessage) throw new Error(result.errorMessage);
        if (result.status === 401 || result.status === 403) {
            throw new Error("Replicate rejected the API token or model access.");
        }
        if (result.status === 429) throw new Error("Replicate is rate limiting model inspection.");
        if (result.status < 200 || result.status >= 300) {
            throw new Error(`Replicate model inspection returned HTTP ${result.status}.`);
        }
        if (
            !result.complete ||
            result.responseBytes !== receivedBytes ||
            result.contentType.trim().toLowerCase() !== "application/json"
        ) {
            throw new Error("Replicate returned an incomplete or non-JSON model schema.");
        }
        const bytes = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return parseReplicateModelInputSchema(bytes, model);
    }

    async function saveAiPackage(summary: AiPackageSummary): Promise<boolean> {
        return addRecords(
            [summary.job],
            "Reviewed AI package saved in this archive. Save the archive to write it to disk.",
        );
    }

    async function importAiResponse(
        file: File,
        sessionId: string,
        templateId: string,
    ): Promise<{ jobId: string; guideId: string; status: string; warnings: readonly string[] }> {
        const state = workspace();
        const session = state
            ? allSessions(state).find(
                  (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
              )
            : undefined;
        if (!state || !session) throw new Error("Choose a session before importing a response.");
        if (state.snapshot.locked || !state.snapshot.canMutate) {
            throw new Error("Unlock this archive before importing an AI response.");
        }
        const imported = await importAiResponseRecords({
            session,
            bytes: new Uint8Array(await file.arrayBuffer()),
            filename: file.name,
            templateId,
            records: [
                ...state.sessions,
                ...state.transcripts,
                ...state.annotations,
                ...state.evidence,
                ...state.assets,
                ...state.notesDocuments,
            ],
        });
        if (
            !(await addRecords(
                imported.records,
                `Imported external AI response as ${imported.status}.`,
            ))
        ) {
            throw new Error("The imported response could not be added to the workspace.");
        }
        return {
            jobId: imported.jobId,
            guideId: imported.guideId,
            status: imported.status,
            warnings: imported.warnings,
        };
    }

    async function sendAiProviderRequest(
        packageDraft: ArchiveRecord,
        expectedTemplateId: string,
        preview: AiRequestPreview,
        confirmedEndpoint: string,
        confirmedBodyHash: string,
        credentialStorage: AiCredentialStorage,
        onProgress: (responseBytes: number) => void,
    ): Promise<void> {
        let current = workspace();
        if (!current || current.snapshot.locked || !current.snapshot.canMutate) {
            throw new Error("Unlock an editable archive before sending a provider request.");
        }
        if (busy()) throw new Error("Wait for the current archive operation to finish.");
        if (
            confirmedBodyHash !== preview.requestBodyHash ||
            confirmedEndpoint !== preview.endpoint
        ) {
            throw new Error("Confirm the exact provider endpoint and request body before sending.");
        }
        if (
            packageDraft.type !== RecordType.aiJob ||
            packageDraft.fields.get("mode") !== "manual"
        ) {
            throw new Error("The reviewed package is no longer available.");
        }

        const existingPackage = await current.snapshot.getRecord(RecordType.aiJob, packageDraft.id);
        if (existingPackage) {
            if (
                existingPackage.fields.get("content_hash") !==
                packageDraft.fields.get("content_hash")
            ) {
                throw new Error("The package changed after review. Prepare and review it again.");
            }
        } else if (
            !(await addRecords([packageDraft], "Reviewed AI package saved in this archive."))
        ) {
            throw new Error("The reviewed package could not be saved to the active archive.");
        }

        current = workspace();
        if (!current || current.snapshot.locked || !current.snapshot.canMutate) {
            throw new Error(
                "The active archive changed before the provider request could be sent.",
            );
        }
        const savedPackage = await current.snapshot.getRecord(RecordType.aiJob, packageDraft.id);
        if (!savedPackage)
            throw new Error("The reviewed package could not be reloaded from the archive.");
        const providerMetadata = current.providerSettings.find(
            (record) => record.fields.get("provider_id") === preview.providerId,
        );
        if (!providerMetadata)
            throw new Error("Save the selected provider settings again before sending.");
        const providerConfiguration = await current.snapshot.getRecord(
            RecordType.settings,
            providerMetadata.id,
        );
        if (!providerConfiguration)
            throw new Error("The saved provider settings could not be loaded.");
        const useSystemCredentialStore = credentialStorage === "system-keychain";
        const hasSystemCredential =
            useSystemCredentialStore &&
            platform.kind === "desktop" &&
            (await platform.hasAiCredential(preview.providerId));
        const freshReplicateSchema =
            preview.providerId === "replicate"
                ? await inspectReplicateModelForAiProvider(
                      preview.providerId,
                      preview.model,
                      credentialStorage,
                  )
                : undefined;
        const freshPreview = await createAiRequestPreview(
            savedPackage,
            providerConfiguration,
            preview.maxOutputTokens,
            useSystemCredentialStore ? [] : current.credentials,
            hasSystemCredential,
            current.snapshot,
            freshReplicateSchema,
        );
        if (
            freshPreview.providerId !== preview.providerId ||
            freshPreview.endpoint !== preview.endpoint ||
            freshPreview.guideTemplateId !== expectedTemplateId ||
            freshPreview.model !== preview.model ||
            freshPreview.replicateInputSchema?.version !== preview.replicateInputSchema?.version ||
            freshPreview.requestBodyHash !== preview.requestBodyHash ||
            freshPreview.requestBody !== preview.requestBody ||
            freshPreview.packageHash !== preview.packageHash ||
            confirmedBodyHash !== freshPreview.requestBodyHash
        ) {
            throw new Error(
                "The provider settings or package changed after review. Review a fresh request.",
            );
        }

        const sessionId = savedPackage.fields.get("session_id") ?? "";
        const session = [...current.sessions, ...current.archivedSessions].find(
            (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
        );
        if (!session) throw new Error("The session for this AI package is no longer available.");
        let credential = "";
        if (!freshPreview.localOnly) {
            if (!freshPreview.credentialAvailable) {
                throw new Error("Save an API key in the selected secure store before sending.");
            }
            if (credentialStorage === "system-keychain") {
                if (platform.kind !== "desktop" || !systemCredentialStoreAvailable()) {
                    throw new Error("The operating-system credential store is not available.");
                }
            } else if (credentialStorage === "encrypted-archive") {
                if (!current.snapshot.encrypted) {
                    throw new Error(
                        "Save a provider key inside an encrypted archive before sending.",
                    );
                }
                const metadata = current.credentials.find(
                    (record) =>
                        record.fields.get("provider_id") === freshPreview.providerId ||
                        record.fields.get("key") ===
                            providerById(freshPreview.providerId)?.credentialKey,
                );
                if (!metadata)
                    throw new Error("Save an API key in this encrypted archive before sending.");
                const savedCredential = await current.snapshot.getRecord(
                    RecordType.settings,
                    metadata.id,
                );
                if (
                    !savedCredential ||
                    savedCredential.fields.get("record_role") !== "credential" ||
                    savedCredential.fields.get("_deleted") === "true" ||
                    savedCredential.fields.get("provider_id") !== freshPreview.providerId
                ) {
                    throw new Error(
                        "The saved API key could not be verified in this encrypted archive.",
                    );
                }
                credential = savedCredential.fields.get("value") ?? "";
                if (!credential)
                    throw new Error("The saved API key is empty. Save it again before sending.");
            } else {
                throw new Error("Choose a secure credential store before sending.");
            }
        }

        if (workspace()?.snapshot !== current.snapshot) {
            throw new Error(
                "The active archive changed after review. Prepare and review the request again.",
            );
        }
        setLastAiExecution(null);
        setBusy(true);
        try {
            const execution = await executeAiGeneration({
                packageJob: savedPackage,
                expectedTemplateId,
                preview: freshPreview,
                confirmedEndpoint,
                confirmedBodyHash,
                credentialStorage,
                credential,
                session,
                sourceRecords: guideSourceRecords(current),
                send: (request, onChunk) => platform.sendAiRequest(request, onChunk),
                onProgress,
            });
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error(
                    "The active archive changed while the provider responded. Reopen it before saving the result.",
                );
            }
            const responseRecords = execution.guide
                ? [execution.job, execution.guide]
                : [execution.job];
            const savedMessage = execution.guide
                ? "AI response saved as an unapproved guide draft."
                : "The raw provider response was saved in this archive for export.";
            if (!(await addRecords(responseRecords, savedMessage))) {
                throw new Error("The provider response could not be saved in the active archive.");
            }
            setLastAiExecution({
                archiveId: current.snapshot.header.id,
                summary: execution.summary,
            });
        } finally {
            setBusy(false);
        }
    }

    async function loadAiPackage(jobId: string): Promise<ArchiveRecord | null> {
        const current = workspace();
        if (!current || current.snapshot.locked) return null;
        return current.snapshot.getRecord(RecordType.aiJob, jobId);
    }

    async function saveAiProvider(input: AiProviderConfigurationInput): Promise<boolean> {
        const provider = providerById(input.providerId);
        const record = await createProviderConfigurationRecord(input);
        return addRecords(
            [record],
            `Saved ${provider?.name ?? "AI provider"} settings. No connection was made.`,
        );
    }

    async function saveAiCredential(
        providerId: string,
        value: string,
        storage: AiCredentialStorage,
    ): Promise<boolean> {
        if (storage === "system-keychain") {
            if (platform.kind !== "desktop" || !systemCredentialStoreAvailable()) {
                throw new Error("The operating-system credential store is not available.");
            }
            await platform.saveAiCredential(providerId, value);
            return true;
        }
        const current = workspace();
        if (!current) throw new Error("Create or open an archive before saving an API key.");
        const record = await createProviderCredentialRecord(
            providerId,
            value,
            current.snapshot.encrypted,
        );
        return addRecords([record], "API key saved in the encrypted archive.");
    }

    async function removeAiCredential(
        providerId: string,
        storage: AiCredentialStorage,
    ): Promise<boolean> {
        if (storage === "system-keychain") {
            if (platform.kind !== "desktop") {
                throw new Error("System keychain storage is available only in the desktop app.");
            }
            await platform.removeAiCredential(providerId);
            return true;
        }
        const current = workspace();
        if (!current || current.snapshot.locked || !current.snapshot.canMutate) {
            throw new Error("Unlock this archive before removing a saved API key.");
        }
        const credentialKey = providerById(providerId)?.credentialKey;
        const metadata = current.credentials.find(
            (record) =>
                record.fields.get("provider_id") === providerId ||
                (typeof credentialKey === "string" && record.fields.get("key") === credentialKey),
        );
        if (!metadata) return false;
        const credential = await current.snapshot.getRecord(RecordType.settings, metadata.id);
        if (!credential || credential.fields.get("record_role") !== "credential") {
            throw new Error("The saved API key could not be found in this archive.");
        }
        const fields = new Map(credential.fields);
        fields.set("_deleted", "true");
        return addRecords([{ ...credential, fields }], "Saved API key removed from this archive.");
    }

    async function changeCurrentPassphrase(
        currentPassphrase: string,
        newPassphrase: string,
    ): Promise<void> {
        const current = workspace();
        if (!current || !current.snapshot.encrypted) {
            throw new Error("Open an encrypted archive before changing its passphrase.");
        }
        if (!current.snapshot.canMutate) {
            throw new Error("Unlock this archive before changing its passphrase.");
        }
        if (busy()) throw new Error("Wait for the current archive operation to finish.");

        setBusy(true);
        let nextSnapshot: ArchiveSnapshot | undefined;
        let accepted = false;
        try {
            nextSnapshot = await current.snapshot.changePassphrase(
                currentPassphrase,
                newPassphrase,
            );
            const updated = await readWorkspace(nextSnapshot, current.name, current.location, true);
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error(
                    "The active archive changed while its passphrase was being updated.",
                );
            }
            setWorkspace(updated);
            current.snapshot.lock();
            accepted = true;
            announce(
                "Passphrase changed. Save this workspace to update the passphrase on disk.",
                "success",
            );
            closeDialog();
        } finally {
            if (!accepted) nextSnapshot?.lock();
            setBusy(false);
        }
    }

    async function enableCurrentEncryption(newPassphrase: string): Promise<void> {
        const current = workspace();
        if (!current || current.snapshot.encrypted) {
            throw new Error("Open a plaintext archive before enabling encryption.");
        }
        if (!current.snapshot.canMutate) {
            throw new Error("This archive cannot be encrypted in its current state.");
        }
        if (busy()) throw new Error("Wait for the current archive operation to finish.");

        setBusy(true);
        let nextSnapshot: ArchiveSnapshot | undefined;
        let accepted = false;
        try {
            nextSnapshot = await current.snapshot.enableEncryption(newPassphrase);
            const updated = await readWorkspace(nextSnapshot, current.name, current.location, true);
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error("The active archive changed while encryption was being enabled.");
            }
            setWorkspace(updated);
            current.snapshot.lock();
            accepted = true;
            await current.snapshot.source.close?.().catch(() => undefined);
            announce(
                "Encryption enabled. Save the workspace to replace the archive file.",
                "success",
            );
        } finally {
            if (!accepted) nextSnapshot?.lock();
            setBusy(false);
        }
    }

    async function transitionSession(
        session: ArchiveRecord,
        action: SessionTransitionAction,
    ): Promise<void> {
        if (busy()) return;
        try {
            const messages: Record<SessionTransitionAction, string> = {
                start: "Session started.",
                complete: "Session completed.",
                review: "Session marked as reviewed.",
                resume: "Session resumed.",
            };
            await addRecords([transitionSessionRecord(session, action)], messages[action]);
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function duplicateSession(session: ArchiveRecord): Promise<void> {
        const current = workspace();
        if (!current || busy()) return;
        try {
            const linkedEntryId = field(session, "entry_id");
            const linkedEntry = linkedEntryId
                ? (current.entries.find(
                      (entry) => entry.id.toLowerCase() === linkedEntryId.toLowerCase(),
                  ) ?? null)
                : null;
            const records = cloneSessionRecords(session, linkedEntry, {
                ensureJournalRoot: current.journals.length === 0,
            });
            const copy = records[0]!;
            await addRecords(
                records,
                `Session duplicated as “${field(copy, "title", "Untitled session")}”.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function exportSessionPackageFile(session: ArchiveRecord): Promise<void> {
        const current = workspace();
        if (!current || busy()) return;
        let packageSnapshot: ArchiveSnapshot | undefined;
        setBusy(true);
        try {
            packageSnapshot = await createSessionPackage(current.snapshot, session.id);
            const filename = `${safeFileName(field(session, "title", "Session"))}-session.tux`;
            const location = await platform.exportBinaryFile(
                filename,
                async () => sourceStream(packageSnapshot!.source),
                "application/x-tutorux",
            );
            if (location) announce(`Exported session package to ${location}.`, "success");
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            packageSnapshot?.lock();
            await packageSnapshot?.source.close?.();
            setBusy(false);
        }
    }

    async function importSessionPackageFile(studentId?: string): Promise<void> {
        const current = workspace();
        if (!current || busy()) return;
        let opened: Awaited<ReturnType<typeof platform.openArchive>> = null;
        let packageSnapshot: ArchiveSnapshot | undefined;
        setBusy(true);
        try {
            opened = await platform.openArchive();
            if (!opened) return;
            packageSnapshot = await openArchiveSource(opened.source);
            const imported = await prepareSessionPackageImport(
                packageSnapshot,
                current.snapshot,
                studentId,
            );
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error(
                    "The active archive changed while the session package was being read.",
                );
            }
            const importedSession = imported.records.find(
                (record) => record.type === RecordType.session && record.id === imported.sessionId,
            );
            if (!importedSession)
                throw new Error("The imported session package has no session record.");
            await addRecords(
                imported.records,
                `Imported session “${field(importedSession, "title", "Tutoring session")}”. Save to write the new generation to disk.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            packageSnapshot?.lock();
            await (packageSnapshot?.source ?? opened?.source)?.close?.();
            setBusy(false);
        }
    }

    async function updateSessionArchiveState(
        session: ArchiveRecord,
        archived: boolean,
    ): Promise<void> {
        if (busy()) return;
        try {
            await addRecords(
                [setSessionArchiveState(session, archived)],
                archived
                    ? "Session moved to the archive."
                    : "Session returned to current sessions.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function updateStudent(
        input: StudentInput,
        current: ArchiveRecord | null,
    ): Promise<void> {
        if (!current) {
            await addRecords([makeStudentRecord(input)]);
            return;
        }
        await addRecords([updateStudentRecord(current, input)], "Student profile updated.");
    }

    async function saveStudentProgress(input: {
        student: ArchiveRecord;
        skill: string;
        classification: StudentProgressClassification;
        evidenceSourceIds: string[];
        reviewedBy: string;
        note: string;
    }): Promise<boolean> {
        const state = workspace();
        if (!state) {
            announce("Open an archive before reviewing student progress.", "error");
            return false;
        }
        try {
            const record = reviewStudentProgressRecord(
                input.student,
                {
                    skill: input.skill,
                    classification: input.classification,
                    evidenceSourceIds: input.evidenceSourceIds,
                    reviewedBy: input.reviewedBy,
                    note: input.note,
                },
                state.sessions,
                state.evidence,
            );
            return await addRecords([record], "Tutor progress review saved.");
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function trashStudent(record: ArchiveRecord): Promise<void> {
        await addRecords([moveRecordToTrash(record)], "Student moved to Trash.");
    }

    async function trashAnnotation(record: ArchiveRecord): Promise<void> {
        await addRecords([removeAnnotationRecord(record)], "Observation moved to Trash.");
    }

    async function restoreStudent(record: ArchiveRecord): Promise<void> {
        await addRecords([restoreRecordFromTrash(record)], "Student restored from Trash.");
    }

    async function restoreJournalEntry(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const records = await restoreJournalEntryGroup(state.snapshot, record.id);
            await addRecords(records, "Journal entry and its notes restored from Trash.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function restoreTrashedAnnotation(record: ArchiveRecord): Promise<void> {
        await addRecords([restoreRecordFromTrash(record)], "Observation restored from Trash.");
    }

    async function restoreEvidence(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const changes = await restoreEvidenceRecordGroup(state.snapshot, record);
            await addRecords(changes, "Evidence and its relationships restored.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function restoreTrashedEvidenceEdge(edge: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const restored = await restoreEvidenceEdge(state.snapshot, edge);
            await addRecords([restored], "Evidence relationship restored.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function restoreTrashedNoteBlock(block: RemovedNoteBlock): Promise<void> {
        const state = workspace();
        if (!state) return;
        const document = state.notesDocuments.find(
            (item) => item.id.toLowerCase() === block.documentId.toLowerCase(),
        );
        if (!document) {
            announce("The notes containing this block are no longer available.", "error");
            return;
        }
        try {
            await addRecords(
                [restoreRemovedNoteBlock(document, block.id)],
                "Note block restored to its original position.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function reviewSessionTrash(session: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state || busy()) return;
        let plan: SessionTrashPlan;
        setBusy(true);
        try {
            plan = await planSessionTrash(state.snapshot, session);
        } catch (error) {
            announce(errorMessage(error), "error");
            return;
        } finally {
            setBusy(false);
        }
        if (workspace()?.snapshot !== state.snapshot) {
            announce(
                "The active archive changed. Review the session deletion scope again.",
                "error",
            );
            return;
        }
        setPendingSessionTrash({ session, snapshot: state.snapshot, plan });
    }

    async function confirmSessionTrash(): Promise<void> {
        const review = pendingSessionTrash();
        const state = workspace();
        if (!review || !state || busy()) return;
        if (state.snapshot !== review.snapshot) {
            setPendingSessionTrash(null);
            announce(
                "The active archive changed. Review the session deletion scope again.",
                "error",
            );
            return;
        }

        let changes: ArchiveRecord[];
        setBusy(true);
        try {
            const audioChanges = await loadSessionAudioTrashChanges(
                review.snapshot,
                review.session.id,
                review.plan.audioChunkRecords,
            );
            changes = [...review.plan.changes, ...audioChanges];
        } catch (error) {
            announce(errorMessage(error), "error");
            return;
        } finally {
            setBusy(false);
        }
        if (workspace()?.snapshot !== review.snapshot) {
            setPendingSessionTrash(null);
            announce(
                "The active archive changed. Review the session deletion scope again.",
                "error",
            );
            return;
        }
        await addRecords(
            changes,
            "Session group moved to recoverable Trash. Journal links will reconnect when you restore it; save to keep the change on disk.",
        );
    }

    async function restoreSessionGroup(session: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state || busy()) return;
        let changes: ArchiveRecord[];
        setBusy(true);
        try {
            changes = await planSessionRestore(state.snapshot, session);
        } catch (error) {
            announce(errorMessage(error), "error");
            return;
        } finally {
            setBusy(false);
        }
        if (workspace()?.snapshot !== state.snapshot) {
            announce("The active archive changed. Reopen Trash and try again.", "error");
            return;
        }
        await addRecords(
            changes,
            "Session group and journal links restored. Save to keep the change on disk.",
        );
    }

    async function beginTrashPurge(): Promise<void> {
        const state = workspace();
        if (!state || busy()) return;
        let plan: ArchiveTrashPurgePlan;
        setBusy(true);
        try {
            plan = await planTrashPurge(state.snapshot);
        } catch (error) {
            announce(errorMessage(error), "error");
            return;
        } finally {
            setBusy(false);
        }
        if (workspace()?.snapshot !== state.snapshot) {
            announce("The active archive changed. Review Trash again before purging.", "error");
            return;
        }
        setPendingTrashPurge({ snapshot: state.snapshot, plan });
    }

    async function confirmTrashPurge(): Promise<void> {
        const review = pendingTrashPurge();
        const state = workspace();
        if (!review || !state || busy()) return;
        if (state.snapshot !== review.snapshot) {
            setPendingTrashPurge(null);
            announce("The active archive changed. Review Trash again before purging.", "error");
            return;
        }
        if (review.plan.blockers.length > 0 || review.plan.opaqueRecords > 0) return;

        setBusy(true);
        let replacement: ArchiveSnapshot | undefined;
        try {
            const purge = await purgeTrashedArchiveSnapshot(review.snapshot);
            replacement = purge.snapshot;
            const updated = await readWorkspace(replacement, state.name, state.location, true);
            if (workspace()?.snapshot !== review.snapshot) {
                replacement.lock();
                replacement = undefined;
                setPendingTrashPurge(null);
                announce(
                    "The active archive changed. Reopen Trash and review the purge again.",
                    "error",
                );
                return;
            }
            setWorkspace(updated);
            if (replacement !== state.snapshot) state.snapshot.lock();
            applyWorkspaceTheme(updated);
            setPendingTrashPurge(null);
            announce(
                "Trashed records and their revisions are permanently removed from this workspace. Material content is preserved. Save the archive to publish the purge.",
                "success",
            );
            replacement = undefined;
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            replacement?.lock();
            setBusy(false);
        }
    }

    function guideSourceRecords(state: Workspace): ArchiveRecord[] {
        return [
            ...state.sessions,
            ...state.archivedSessions,
            ...state.students,
            ...state.entries,
            ...state.notesDocuments,
            ...state.transcripts,
            ...state.annotations,
            ...state.assets,
            ...state.evidence,
        ];
    }

    async function saveGuide(draft: GuideDraft, current: ArchiveRecord | null): Promise<boolean> {
        const state = workspace();
        if (!state) {
            announce("Open an archive before creating a study guide.", "error");
            return false;
        }
        try {
            const session = draft.sessionId
                ? [...state.sessions, ...state.archivedSessions].find(
                      (item) => item.id === draft.sessionId,
                  )
                : undefined;
            const entry = !draft.sessionId
                ? state.entries.find((item) => item.id === draft.entryId)
                : undefined;
            if (!session && !entry)
                throw new Error(
                    "Restore the source journal entry or session before saving this guide.",
                );
            const record = makeGuideRecord(
                draft,
                {
                    ...(session ? { session } : {}),
                    ...(entry ? { entry } : {}),
                    records: guideSourceRecords(state),
                },
                current,
            );
            return await addRecords(
                guideRecordsWithEntryLinks(record, current, state.entries),
                current ? "Study guide updated." : "Study guide draft added to the archive.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function restoreGuideVersion(
        selected: ArchiveRecord,
        reviewed: ArchiveRecord,
    ): Promise<boolean> {
        const state = workspace();
        const current = state?.guides.find((guide) => guide.id === reviewed.id);
        if (!state || !current || current.revision !== reviewed.revision) {
            announce("The guide changed. Review its history again before restoring.", "error");
            return false;
        }
        try {
            const draft = guideDraftFromRecord(selected);
            draft.sessionId = field(current, "session_id");
            draft.entryId = field(current, "entry_id");
            return await saveGuide(draft, current);
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function restoreSessionVersion(
        current: ArchiveRecord,
        previous: ArchiveRecord,
    ): Promise<boolean> {
        const state = workspace();
        const latest = [...(state?.sessions ?? []), ...(state?.archivedSessions ?? [])].find(
            (item) => item.id === current.id,
        );
        if (!latest || latest.revision !== current.revision) {
            announce("The session changed. Review its history again before restoring.", "error");
            return false;
        }
        try {
            const { restoreSessionDetails } = await import("./SessionVersionHistory");
            return await addRecords(
                [restoreSessionDetails(latest, previous)],
                "Session details restored.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function approveGuide(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const draft = guideDraftFromRecord(record);
            const session = draft.sessionId
                ? [...state.sessions, ...state.archivedSessions].find(
                      (item) => item.id === draft.sessionId,
                  )
                : undefined;
            const entry = !draft.sessionId
                ? state.entries.find((item) => item.id === draft.entryId)
                : undefined;
            if (!session && !entry) {
                throw new Error(
                    "Restore the source journal entry or session before approving this guide.",
                );
            }
            const checked = makeGuideRecord(
                draft,
                {
                    ...(session ? { session } : {}),
                    ...(entry ? { entry } : {}),
                    records: guideSourceRecords(state),
                },
                record,
            );
            await addRecords(
                guideRecordsWithEntryLinks(approveGuideRecord(checked), record, state.entries),
                "Study guide approved.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function trashGuide(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            await addRecords(
                guideRecordsWithEntryLinks(moveRecordToTrash(record), record, state.entries),
                "Study guide moved to Trash.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function restoreGuide(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            await addRecords(
                guideRecordsWithEntryLinks(restoreRecordFromTrash(record), record, state.entries),
                "Study guide restored from Trash.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function saveGuideTemplate(
        input: GuideTemplateInput,
        current: ArchiveRecord | null,
    ): Promise<boolean> {
        const record = makeCustomGuideTemplateRecord(input, current);
        return await addRecords(
            [record],
            current
                ? "Study guide template updated."
                : "Study guide template added to the archive.",
        );
    }

    async function trashGuideTemplate(record: ArchiveRecord): Promise<void> {
        await addRecords([moveRecordToTrash(record)], "Template moved to Trash.");
    }

    async function restoreGuideTemplate(record: ArchiveRecord): Promise<void> {
        await addRecords([restoreRecordFromTrash(record)], "Template restored.");
    }

    async function exportGuideTemplate(template: GuideTemplate): Promise<void> {
        try {
            const filename = `${
                template.name
                    .normalize("NFKD")
                    .replace(/[^\w.-]+/gu, "-")
                    .replace(/^-+|-+$/gu, "") || "tutorux-template"
            }.json`;
            const path = await platform.exportTextFile(
                filename,
                serializeGuideTemplate(template),
                "application/json",
            );
            if (path) announce("Template JSON exported.", "success");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function exportGuide(
        record: ArchiveRecord,
        format: "markdown" | "html" | "json" | "docx" | "pdf",
    ): Promise<void> {
        setBusy(true);
        let finishPrint: (() => void) | undefined;
        try {
            const filename = safeFileName(field(record, "title", "study-guide"));
            const images =
                format === "html" || format === "docx" || format === "pdf"
                    ? await loadGuideExportImages(record)
                    : new Map<string, GuideExportImage>();
            if (format === "pdf") {
                const printable = new DOMParser()
                    .parseFromString(renderGuideHtml(record, images), "text/html")
                    .querySelector("main.document");
                if (!printable)
                    throw new Error("The study guide could not be prepared for printing.");
                finishPrint = (): void => {
                    document.documentElement.classList.remove("guide-printing");
                    setGuidePrintContent(null);
                };
                setGuidePrintContent(printable.cloneNode(true) as HTMLElement);
                document.documentElement.classList.add(
                    "guide-printing",
                    ..."print:bg-white! print:text-[#18211b]! print:h-auto! print:m-0! print:min-h-0! print:min-w-0! print:overflow-visible! print:w-auto! print:[&_#root]:bg-white! print:[&_#root]:text-[#18211b]! print:[&_#root]:h-auto! print:[&_#root]:m-0! print:[&_#root]:min-h-0! print:[&_#root]:min-w-0! print:[&_#root]:overflow-visible! print:[&_#root]:w-auto! print:[&_body]:bg-white! print:[&_body]:text-[#18211b]! print:[&_body]:h-auto! print:[&_body]:m-0! print:[&_body]:min-h-0! print:[&_body]:min-w-0! print:[&_body]:overflow-visible! print:[&_body]:w-auto!".split(
                        /\s+/u,
                    ),
                );
                window.addEventListener("afterprint", finishPrint, { once: true });
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                window.print();
                announce(
                    "The system print dialog is ready. Choose Save as PDF to export this guide.",
                    "success",
                );
                return;
            }
            if (format === "docx") {
                const path = await platform.exportBinaryFile(
                    `${filename}.docx`,
                    renderGuideDocx(record, images),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                );
                if (path) announce("Study guide exported as a Word document.", "success");
                return;
            }
            if (format === "json") {
                const path = await platform.exportTextFile(
                    `${filename}.json`,
                    serializeGuideJson(record),
                    "application/json;charset=utf-8",
                );
                if (path) announce("Study guide record exported as JSON.", "success");
                return;
            }
            const isHtml = format === "html";
            const path = await platform.exportTextFile(
                `${filename}.${isHtml ? "html" : "md"}`,
                isHtml ? renderGuideHtml(record, images) : renderGuideMarkdown(record),
                isHtml ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
            );
            if (path)
                announce(`Study guide exported as ${isHtml ? "HTML" : "Markdown"}.`, "success");
        } catch (error) {
            if (finishPrint) window.removeEventListener("afterprint", finishPrint);
            document.documentElement.classList.remove("guide-printing");
            setGuidePrintContent(null);
            if (!isCancelled(error)) announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function loadGuideExportImages(
        record: ArchiveRecord,
    ): Promise<ReadonlyMap<string, GuideExportImage>> {
        const state = workspace();
        const ids = guideImageIds(record);
        if (ids.length === 0) return new Map();
        if (!state || state.snapshot.locked)
            throw new Error("Unlock the archive before exporting guides with images.");
        const images = new Map<string, GuideExportImage>();
        for (const assetId of ids) {
            const metadata = state.assets.find((asset) => asset.id.toLowerCase() === assetId);
            if (!metadata || field(metadata, "_deleted") === "true")
                throw new Error(`Guide image ${assetId} is missing from this archive.`);
            const mimeType = field(metadata, "mime_type");
            if (
                !["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(
                    mimeType,
                )
            )
                throw new Error("Only PNG, JPEG, GIF, and WebP guide images can be exported.");
            images.set(assetId, {
                assetId,
                mimeType,
                bytes: await readAssetBytes(state.snapshot, metadata),
            });
        }
        return images;
    }

    async function saveAnnotation(
        input: AnnotationInput,
        current: ArchiveRecord | null,
    ): Promise<boolean> {
        try {
            return await addRecords(
                [current ? updateAnnotationRecord(current, input) : makeAnnotationRecord(input)],
                current ? "Observation updated." : "Observation added to the session.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function playObservationFromTimestamp(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const sessionId = field(record, "session_id").toLowerCase();
            const session = [...state.sessions, ...state.archivedSessions].find(
                (item) => item.id.toLowerCase() === sessionId,
            );
            if (!session) throw new Error("The linked session is not available.");
            const track = state.audioTracks.find((item) => item.sessionId === sessionId);
            if (!track) throw new Error("This session has no playable audio track.");
            const startTimeUs = field(record, "start_time_us", "0") || "0";
            const preview = await buildAudioPreview(
                state.snapshot,
                session.id,
                track.id,
                startTimeUs,
            );
            const previous = observationPlayback();
            if (previous) URL.revokeObjectURL(previous.url);
            const url = URL.createObjectURL(
                new Blob([preview.wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }),
            );
            setObservationPlayback({
                url,
                title: field(
                    record,
                    "title",
                    annotationTypeLabel(field(record, "type", "observation")),
                ),
                start: formatTranscriptTimestampUs(safeBigInt(startTimeUs)),
            });
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function getAnnotationHistory(record: ArchiveRecord): Promise<ArchiveRecord[]> {
        const state = workspace();
        if (!state) return [];
        try {
            return await state.snapshot.getRecordHistory(RecordType.annotation, record.id);
        } catch (error) {
            announce(errorMessage(error), "error");
            return [];
        }
    }

    async function getTranscriptHistory(record: ArchiveRecord): Promise<ArchiveRecord[]> {
        const state = workspace();
        if (!state) return [];
        try {
            return await state.snapshot.getRecordHistory(RecordType.transcriptSegment, record.id);
        } catch (error) {
            announce(errorMessage(error), "error");
            return [];
        }
    }

    async function restoreAnnotationRevision(
        record: ArchiveRecord,
        historyIndex: number,
    ): Promise<boolean> {
        const state = workspace();
        if (!state) return false;
        try {
            if (!Number.isInteger(historyIndex) || historyIndex < 1 || historyIndex > 10_000) {
                throw new Error("Choose an earlier observation version to restore.");
            }
            const history = await state.snapshot.getRecordHistory(
                RecordType.annotation,
                record.id,
                historyIndex + 1,
            );
            const revision = history[historyIndex];
            if (!revision) throw new Error("That observation version could not be found.");
            const fields = new Map(revision.fields);
            fields.delete("_deleted");
            fields.delete("deleted_at_us");
            const timestamp = (BigInt(Date.now()) * 1000n).toString();
            fields.set("restored_from_revision", historyIndex.toString());
            fields.set("updated_at_us", timestamp);
            fields.set("human_edited_at_us", timestamp);
            return await addRecords(
                [{ ...revision, fields }],
                `Observation restored from version ${historyIndex}.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function importTranscript(file: File, sessionId: string): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find((record) => record.id === sessionId)
            : undefined;
        if (!state || !session) {
            announce("Choose a session before importing a transcript.", "error");
            return;
        }
        if (state.snapshot.locked || !state.snapshot.canMutate) {
            announce("Unlock this archive before importing transcript cues.", "error");
            return;
        }
        setBusy(true);
        let pendingSnapshot: ArchiveSnapshot | undefined;
        try {
            const format = resolveTranscriptFormat("auto", file.name);
            let snapshot = state.snapshot;
            pendingSnapshot = snapshot;
            const result = await importTranscriptBatches({
                source: file.stream() as AsyncIterable<Uint8Array>,
                format,
                sessionId: session.id.toLowerCase(),
                filename: file.name,
                expectedGeneration: snapshot.commit.generation,
                commit: async (records, expectedGeneration) => {
                    if (snapshot.commit.generation !== expectedGeneration) {
                        throw new Error(
                            "The archive changed while transcript cues were being imported.",
                        );
                    }
                    snapshot = await appendRecords(snapshot, records);
                    pendingSnapshot = snapshot;
                    return [...records];
                },
            });
            if (result.imported === 0) {
                if (snapshot !== state.snapshot) snapshot.lock();
                pendingSnapshot = undefined;
                announce("No transcript cues were found in that file.", "info");
                return;
            }
            const fields = new Map(session.fields);
            fields.set("processing_state", "review-required");
            fields.set(
                "processing_detail",
                "Imported transcript is provisional and ready for tutor review.",
            );
            fields.set("processing_updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            snapshot = await appendRecords(snapshot, [{ ...session, fields }]);
            if (workspace()?.snapshot !== state.snapshot) {
                snapshot.lock();
                throw new Error(
                    "The active archive changed while the transcript was being imported.",
                );
            }
            const updated = await readWorkspace(snapshot, state.name, state.location, true);
            setWorkspace(updated);
            applyWorkspaceTheme(updated);
            state.snapshot.lock();
            pendingSnapshot = undefined;
            setView(view());
            if (result.error) {
                announce(
                    `Imported ${result.imported} provisional transcript cues before the file could not be fully read: ${errorMessage(result.error)}`,
                    "error",
                );
            } else {
                announce(`Imported ${result.imported} provisional transcript cues.`, "success");
            }
        } catch (error) {
            if (pendingSnapshot && pendingSnapshot !== workspace()?.snapshot)
                pendingSnapshot.lock();
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function importCompressedAudioFile(
        sessionId: string,
        allowAdditionalTrack: boolean,
    ): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find((record) => record.id === sessionId)
            : undefined;
        if (!state || !session) {
            announce("Choose a session before importing audio.", "error");
            return;
        }
        if (state.snapshot.locked || !state.snapshot.canMutate) {
            announce("Unlock this archive before importing audio.", "error");
            return;
        }
        try {
            const selected = await openFileDialog({
                multiple: false,
                directory: false,
                filters: [{ name: "Compressed audio", extensions: ["flac", "mp3", "m4a"] }],
            });
            if (!selected || Array.isArray(selected)) return;
            if (workspace()?.snapshot !== state.snapshot) {
                throw new Error("The active archive changed while the audio picker was open.");
            }
            setBusy(true);
            const tracks = state.audioTracks.filter(
                (track) => track.sessionId === session.id.toLowerCase(),
            );
            const imported = await importCompressedAudioRecords(session, selected, {
                allowAdditionalTrack,
                knownTrackIds: tracks.map((track) => track.id),
            });
            await addRecords(
                imported.records,
                `Imported ${selected.split(/[\\/]/u).pop() ?? "audio"} as a ${imported.sampleRateHz.toLocaleString("en-US")} Hz audio track.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function importWave(
        file: File,
        sessionId: string,
        allowAdditionalTrack: boolean,
    ): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find((record) => record.id === sessionId)
            : undefined;
        if (!state || !session) {
            announce("Choose a session before importing audio.", "error");
            return;
        }
        if (state.snapshot.locked) {
            announce("Unlock this archive before importing audio.", "error");
            return;
        }
        setBusy(true);
        let pendingSnapshot: ArchiveSnapshot | undefined;
        try {
            const tracks = state.audioTracks.filter(
                (track) => track.sessionId === session.id.toLowerCase(),
            );
            let snapshot = state.snapshot;
            pendingSnapshot = snapshot;
            const imported = await makeWaveImportRecordsIncremental({
                session,
                file,
                allowAdditionalTrack,
                knownTrackIds: tracks.map((track) => track.id),
                expectedGeneration: snapshot.commit.generation,
                commit: async (records, expectedGeneration) => {
                    if (snapshot.commit.generation !== expectedGeneration) {
                        throw new Error("The archive changed while audio was being imported.");
                    }
                    snapshot = await appendRecords(snapshot, records);
                    pendingSnapshot = snapshot;
                    return [...records];
                },
            });
            if (workspace()?.snapshot !== state.snapshot) {
                snapshot.lock();
                throw new Error("The active archive changed while audio was being imported.");
            }
            const updated = await readWorkspace(snapshot, state.name, state.location, true);
            setWorkspace(updated);
            applyWorkspaceTheme(updated);
            state.snapshot.lock();
            pendingSnapshot = undefined;
            setView(view());
            announce(
                `Imported ${file.name} as a ${imported.sampleRateHz.toLocaleString("en-US")} Hz audio track.`,
                "success",
            );
        } catch (error) {
            if (pendingSnapshot && pendingSnapshot !== workspace()?.snapshot) {
                if (workspace()?.snapshot === state.snapshot) {
                    const updated = await readWorkspace(
                        pendingSnapshot,
                        state.name,
                        state.location,
                        true,
                    );
                    setWorkspace(updated);
                    applyWorkspaceTheme(updated);
                    state.snapshot.lock();
                    setView(view());
                } else {
                    pendingSnapshot.lock();
                }
            }
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function recoverWavImport(sessionId: string): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find(
                  (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
              )
            : undefined;
        if (!state || !session || state.snapshot.locked || !state.snapshot.canMutate || busy()) {
            announce(
                "Open a writable archive and choose an available session before recovering audio.",
                "error",
            );
            return;
        }
        const snapshot = state.snapshot;
        try {
            const recovery = await prepareWavImportRecovery(snapshot, session);
            if (busy() || workspace()?.snapshot !== snapshot)
                throw new Error("The archive changed while audio recovery was being prepared.");
            await addRecords(recovery.records, recovery.message);
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function recoverNativeAudio(sessionId: string): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find(
                  (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
              )
            : undefined;
        if (!state || !session || state.snapshot.locked || !state.snapshot.canMutate || busy()) {
            announce(
                "Open a writable archive and choose an available session before recovering audio.",
                "error",
            );
            return;
        }
        const snapshot = state.snapshot;
        try {
            const recovery = await prepareNativeCaptureRecovery(snapshot, session);
            if (busy() || workspace()?.snapshot !== snapshot)
                throw new Error("The archive changed while audio recovery was being prepared.");
            await addRecords(recovery.records, recovery.message);
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function exportAudioTrack(
        sessionId: string,
        trackId: string,
        trackLabel: string,
        fillGapsWithSilence: boolean,
    ): Promise<void> {
        const state = workspace();
        if (!state) return;
        if (state.snapshot.locked) {
            announce("Unlock this archive before exporting recordings.", "error");
            return;
        }
        setBusy(true);
        try {
            const label = trackLabel.replace(/\.wav$/iu, "");
            const name = `${safeFileName(label)}.wav`;
            const location = await platform.exportBinaryFile(
                name,
                async () => {
                    const audioExport = await buildAudioTrackWavExport(
                        state.snapshot,
                        sessionId,
                        trackId,
                        {
                            fillGapsWithSilence,
                        },
                    );
                    if (platform.kind === "browser" && audioExport.rf64) {
                        throw new Error(
                            "RF64 WAV exports over 4 GiB require Tutorux for desktop. Browser downloads cannot safely save files this large.",
                        );
                    }
                    return audioExport.stream;
                },
                "audio/wav",
            );
            if (location)
                announce(
                    `Exported audio track${fillGapsWithSilence ? " with timeline silence" : ""} to ${location}.`,
                    "success",
                );
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function saveRecordingTakeName(take: ArchiveRecord, label: string): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const updated = await renameRecordingTake(state.snapshot, take.id, label);
            await addRecords([updated], "Recording take renamed.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function saveRecordingTrackName(
        track: AudioTrackDescriptor,
        label: string,
    ): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const updated = await renameRecordingTrack(state.snapshot, track.id, label);
            await addRecords([updated], "Recording track renamed.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function changeRecordingTrackTrash(
        track: { id: string },
        deleted: boolean,
    ): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const updates = await setRecordingTrackDeleted(state.snapshot, track.id, deleted);
            await addRecords(
                updates,
                deleted
                    ? "Recording track and its timeline data moved to Trash."
                    : "Recording track restored.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function changeRecordingTakeTrash(take: ArchiveRecord, deleted: boolean): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const updates = await setRecordingTakeDeleted(state.snapshot, take.id, deleted);
            await addRecords(
                updates,
                deleted
                    ? "Recording take and its linked audio moved to Trash."
                    : "Recording take and its linked audio restored.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function installStreamedMaterial(
        state: Workspace,
        imported: { records: () => AsyncGenerator<ArchiveRecord> },
        message: string,
        metadataFields?: Map<string, string>,
    ): Promise<void> {
        const staging = await createArchiveStaging();
        async function* records(): AsyncGenerator<ArchiveRecord> {
            for await (const record of imported.records()) {
                yield metadataFields && record.type === RecordType.assetMetadata
                    ? { ...record, fields: metadataFields }
                    : record;
            }
        }
        let next: ArchiveSnapshot | undefined;
        let installed = false;
        try {
            next = await appendStagedAssetRecords(state.snapshot, records(), staging);
            const updated = await readWorkspace(next, state.name, state.location, true);
            if (workspace()?.snapshot !== state.snapshot)
                throw new Error("The active archive changed during material import.");
            setWorkspace(updated);
            installed = true;
            state.snapshot.lock();
            announce(message, "success");
        } finally {
            if (!installed) {
                next?.lock();
                await staging.abort().catch(() => undefined);
            }
        }
    }

    async function importAssets(
        files: readonly File[],
        sessionId: string,
        onProgress: AssetBatchProgress,
    ): Promise<boolean> {
        const state = workspace();
        if (!state || state.snapshot.locked || busy()) {
            announce("Open and unlock an archive before importing materials.", "error");
            return false;
        }
        if (
            sessionId &&
            ![...state.sessions, ...state.archivedSessions].some(
                (session) => session.id.toLowerCase() === sessionId.toLowerCase(),
            )
        ) {
            announce(
                "The selected session is no longer available. Choose another session.",
                "error",
            );
            return false;
        }
        setBusy(true);
        try {
            const imported = await prepareStreamingAssetBatchImport(
                state.snapshot,
                files.map(browserAssetReadSource),
                sessionId,
                onProgress,
            );
            await installStreamedMaterial(
                state,
                imported,
                `Added ${imported.items.length.toLocaleString("en-US")} ${imported.items.length === 1 ? "material" : "materials"} to the archive.${imported.deduplicatedCount ? ` ${imported.deduplicatedCount.toLocaleString("en-US")} ${imported.deduplicatedCount === 1 ? "material reuses" : "materials reuse"} verified content already stored here.` : ""} Save to write the changes to disk.`,
            );
            return true;
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        } finally {
            setBusy(false);
        }
    }

    async function importCapturedAudio(
        file: File,
        sessionId: string,
        consentAtUs: string,
    ): Promise<void> {
        const state = workspace();
        if (!state || state.snapshot.locked || busy()) {
            announce("Open and unlock an archive before saving a recording.", "error");
            return;
        }
        if (
            !allSessions(state).some(
                (session) => session.id.toLowerCase() === sessionId.toLowerCase(),
            )
        ) {
            announce(
                "The selected session is no longer available. Choose another session.",
                "error",
            );
            return;
        }
        if (file.size > MAX_ASSET_BYTES) {
            announce("Recordings are limited to 256 MiB in this version.", "error");
            return;
        }
        setBusy(true);
        try {
            const imported = await prepareStreamingAssetImport(
                state.snapshot,
                browserAssetReadSource(file),
                sessionId,
            );
            const fields = new Map(imported.metadata.fields);
            const mimeType = field(imported.metadata, "mime_type");
            if (mimeType === "video/webm" && file.name.toLowerCase().endsWith(".webm"))
                fields.set("mime_type", "audio/webm");
            if (!mimeType.startsWith("audio/") && mimeType !== "video/webm")
                throw new Error("The recording format is not recognized as audio.");
            fields.set("capture_source", "browser-microphone");
            fields.set("capture_consent_at_us", consentAtUs);
            fields.set("capture_consent_policy", "1");
            await installStreamedMaterial(
                state,
                imported,
                `Saved ${file.name} as a session audio material.`,
                fields,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function exportAsset(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state || state.snapshot.locked) {
            announce("Unlock an archive before exporting materials.", "error");
            return;
        }
        setBusy(true);
        try {
            const name = safeFileName(field(record, "filename") || `material-${record.id}`);
            const location = await platform.exportBinaryFile(
                name,
                () => Promise.resolve(streamAssetBytes(state.snapshot, record)),
                field(record, "mime_type", "application/octet-stream"),
            );
            if (location) announce(`Exported ${name}.`, "success");
        } catch (error) {
            announce(errorMessage(error), "error");
        } finally {
            setBusy(false);
        }
    }

    async function loadAssetPreview(
        record: ArchiveRecord,
    ): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
        const state = workspace();
        if (!state || state.snapshot.locked) return null;
        const mimeType = field(record, "mime_type", "application/octet-stream");
        const byteSize = Number(field(record, "byte_size"));
        if (
            mimeType.startsWith("audio/") &&
            (!Number.isSafeInteger(byteSize) ||
                byteSize < 0 ||
                byteSize > MAX_MATERIAL_AUDIO_PREVIEW_BYTES)
        ) {
            announce(
                "Audio previews are limited to 24 MiB. Export the original file to use another player.",
                "error",
            );
            return null;
        }
        setBusy(true);
        try {
            return {
                bytes: await readAssetBytes(state.snapshot, record),
                mimeType,
            };
        } catch (error) {
            announce(errorMessage(error), "error");
            return null;
        } finally {
            setBusy(false);
        }
    }

    async function extractEvidence(sessionId: string): Promise<void> {
        const state = workspace();
        const session = state
            ? allSessions(state).find((record) => record.id === sessionId)
            : undefined;
        if (!state || !session) {
            announce("Choose a session before extracting evidence.", "error");
            return;
        }
        try {
            const records = await extractSessionEvidence(state.snapshot, session);
            if (records.length === 0) {
                announce("No new evidence was found for this session.", "info");
                return;
            }
            await addRecords(
                records,
                `Added ${records.length} evidence item${records.length === 1 ? "" : "s"}. Transcript candidates are waiting for review.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function reviewEvidence(
        record: ArchiveRecord,
        outcome: "human-verified" | "rejected",
    ): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const updated = await reviewEvidenceRecord(state.snapshot, record, outcome);
            await addRecords(
                [updated],
                outcome === "human-verified"
                    ? "Evidence source checked and approved."
                    : field(record, "verification_state") === "human-verified"
                      ? "Evidence approval withdrawn."
                      : "Evidence candidate rejected.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function updateEvidence(
        record: ArchiveRecord,
        input: EvidenceUpdateInput,
    ): Promise<boolean> {
        const state = workspace();
        if (!state) return false;
        try {
            const updated = updateEvidenceRecord(record, input);
            return await addRecords(
                [updated],
                "Evidence updated. Review the source again before approval.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function trashEvidence(record: ArchiveRecord): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const changes = await trashEvidenceRecord(state.snapshot, record);
            await addRecords(changes, "Evidence and its relationships moved to Trash.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function linkEvidence(fromId: string, toId: string, relationship: string): Promise<void> {
        const state = workspace();
        if (!state) return;
        try {
            const edge = await makeEvidenceEdge(state.snapshot, fromId, toId, relationship);
            await addRecords([edge], "Evidence relationship added to the session graph.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function createEvidence(
        sessionId: string,
        segmentId: string,
        input: EvidenceCreateInput,
    ): Promise<boolean> {
        const state = workspace();
        if (!state) return false;
        try {
            const evidence = await makeEvidenceRecord(state.snapshot, sessionId, segmentId, input);
            return await addRecords([evidence], "Tutor-authored evidence added to source review.");
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function removeEvidenceEdge(edge: ArchiveRecord): Promise<void> {
        try {
            await addRecords([trashEvidenceEdge(edge)], "Evidence relationship removed.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function exportTranscript(
        sessionId: string,
        format: TranscriptExportFormat,
    ): Promise<void> {
        try {
            const state = workspace();
            if (!state) throw new Error("Open an archive before exporting a transcript.");
            if (state.snapshot.locked)
                throw new Error("Unlock this archive before exporting transcript cues.");
            const session = allSessions(state).find((record) => record.id === sessionId);
            if (!session) throw new Error("Choose a session before exporting its transcript.");
            const records = sortTranscriptRecords(
                state.transcripts.filter((record) => field(record, "session_id") === sessionId),
            );
            const text = formatTranscriptExport(records, format);
            const extension = format === "text" ? "txt" : format;
            const mimeType = format === "json" ? "application/json" : "text/plain;charset=utf-8";
            const location = await platform.exportTextFile(
                `${safeFileName(field(session, "title", "session"))}-transcript.${extension}`,
                text,
                mimeType,
            );
            if (location) announce(`Transcript exported to ${location}.`, "success");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function saveTranscriptCue(
        record: ArchiveRecord,
        text: string,
        start: string,
        end: string,
        speaker: string,
    ): Promise<void> {
        try {
            let updated = correctTranscriptRecord(record, text);
            if (start.trim() || end.trim()) updated = setTranscriptTimestamp(updated, start, end);
            if (speaker.trim()) updated = setTranscriptSpeaker(updated, speaker);
            await addRecords([updated], "Transcript correction saved.");
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function verifyTranscriptCue(record: ArchiveRecord): Promise<void> {
        try {
            await addRecords(
                [setTranscriptVerification(record, "human-verified")],
                "Transcript cue marked as human verified.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
        }
    }

    async function restoreTranscriptRevision(
        record: ArchiveRecord,
        historyIndex: number,
    ): Promise<boolean> {
        const state = workspace();
        if (!state) return false;
        try {
            if (!Number.isInteger(historyIndex) || historyIndex < 1 || historyIndex > 10_000) {
                throw new Error("Choose an earlier transcript version to restore.");
            }
            const history = await state.snapshot.getRecordHistory(
                RecordType.transcriptSegment,
                record.id,
                historyIndex + 1,
            );
            const revision = history[historyIndex];
            if (!revision) throw new Error("That transcript version could not be found.");
            const fields = new Map(revision.fields);
            fields.delete("_deleted");
            fields.delete("deleted_at_us");
            fields.set("restored_from_revision", historyIndex.toString());
            fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            return await addRecords(
                [{ ...revision, fields }],
                `Transcript cue restored from version ${historyIndex}.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function splitTranscriptCue(
        record: ArchiveRecord,
        beforeText: string,
        afterText: string,
        splitAt?: string,
    ): Promise<boolean> {
        try {
            return await addRecords(
                splitTranscriptRecord(record, beforeText, afterText, splitAt),
                "Transcript cue split into two adjacent segments.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function mergeTranscriptCues(records: readonly ArchiveRecord[]): Promise<boolean> {
        try {
            return await addRecords(
                mergeTranscriptRecords(records),
                `Merged ${records.length} transcript cues. The absorbed cues can be restored from Trash.`,
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function linkTranscriptAssets(
        record: ArchiveRecord,
        assetIds: readonly string[],
    ): Promise<boolean> {
        const state = workspace();
        if (!state) return false;
        try {
            return await addRecords(
                [setTranscriptLinkedAssets(record, assetIds, state.assets)],
                "Transcript material links updated.",
            );
        } catch (error) {
            announce(errorMessage(error), "error");
            return false;
        }
    }

    async function saveMarkerKeys(keys: string[]): Promise<boolean> {
        const state = workspace();
        const normalized = keys.map((key) => key.toLowerCase());
        if (!state || !validMarkerKeys(normalized)) {
            announce(
                "Choose seven unique printable keys, excluding comma and K, O, S, or N.",
                "error",
            );
            return false;
        }
        const current = state.settings.find((record) => field(record, "key") === markerSettingKey);
        const fields = new Map(current?.fields ?? []);
        fields.set("record_role", "setting");
        fields.set("key", markerSettingKey);
        fields.set("value", normalized.join(","));
        fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
        return addRecords(
            [
                {
                    type: RecordType.settings,
                    id: current?.id ?? (await deterministicUuid(`setting:${markerSettingKey}`)),
                    revision: current?.revision ?? 0n,
                    previousOffset: current?.previousOffset ?? 0n,
                    blob: current?.blob ?? new Uint8Array(),
                    fields,
                },
            ],
            "Observation shortcuts updated.",
        );
    }

    function openDialog(kind: Exclude<DialogKind, null>): void {
        setDialogRecord(null);
        setDialog(kind);
    }

    function closeDialog(): void {
        setDialog(null);
        setDialogRecord(null);
    }

    function editStudent(record: ArchiveRecord): void {
        editRecord("student", record);
    }

    function editRecord(kind: "student" | "session" | "journal", record: ArchiveRecord): void {
        setDialogRecord(record);
        setDialog(kind);
    }

    function toggleTheme(): void {
        const next = theme() === "light" ? "dark" : "light";
        void saveThemeMode(next);
    }

    function chooseThemeMode(mode: ThemeMode): void {
        void saveThemeMode(mode);
    }

    async function saveThemeMode(mode: ThemeMode): Promise<void> {
        if (!validThemeMode(mode)) return;
        if (busy()) {
            announce(
                "Wait for the current archive operation to finish before changing appearance.",
                "info",
            );
            return;
        }
        const current = workspace();
        const hadArchiveTheme = archiveThemeMode(current) !== null;
        applyThemeMode(mode, false);
        if (!current) {
            localStorage.setItem("tutorux.theme", mode);
            return;
        }
        if (!current.snapshot.canMutate) {
            if (!hadArchiveTheme) localStorage.setItem("tutorux.theme", mode);
            announce(
                current.snapshot.locked
                    ? "Appearance changed on this device. Unlock the archive to save it with the archive."
                    : "Appearance changed for this session. This archive is read-only, so its saved preference could not be changed.",
                "info",
            );
            return;
        }

        try {
            const existing = current.settings.find((record) => field(record, "key") === "ui.theme");
            const stableId = await deterministicUuid("setting:ui.theme");
            const latest =
                existing ?? (await current.snapshot.getRecord(RecordType.settings, stableId));
            if (workspace()?.snapshot !== current.snapshot) {
                throw new Error(
                    "The active archive changed while its appearance preference was being saved.",
                );
            }
            if (busy()) {
                announce(
                    "Wait for the current archive operation to finish before saving appearance.",
                    "info",
                );
                return;
            }
            const fields = new Map(latest?.fields ?? []);
            fields.delete("_deleted");
            fields.delete("deleted_at_us");
            fields.set("record_role", "setting");
            fields.set("key", "ui.theme");
            fields.set("value", mode);
            fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            const saved = await addRecords(
                [
                    {
                        type: RecordType.settings,
                        id: latest?.id ?? stableId,
                        revision: latest?.revision ?? 0n,
                        previousOffset: latest?.previousOffset ?? 0n,
                        blob: latest?.blob ?? new Uint8Array(),
                        fields,
                    },
                ],
                "Appearance preference saved with this archive.",
            );
            if (!saved && !hadArchiveTheme && workspace()?.snapshot === current.snapshot) {
                localStorage.setItem("tutorux.theme", mode);
            }
        } catch (error) {
            if (!hadArchiveTheme && workspace()?.snapshot === current.snapshot) {
                localStorage.setItem("tutorux.theme", mode);
            }
            announce(errorMessage(error), "error");
        }
    }

    function navigateToView(nextView: View): void {
        const active = workspace();
        const firstSessionId = active ? (allSessions(active)[0]?.id ?? "") : "";
        if (nextView === "transcripts" && !selectedTranscriptSessionId())
            setSelectedTranscriptSessionId(firstSessionId);
        if (nextView === "annotations" && !selectedAnnotationSessionId())
            setSelectedAnnotationSessionId(firstSessionId);
        if (nextView === "evidence" && !selectedEvidenceSessionId())
            setSelectedEvidenceSessionId(firstSessionId);
        setView(nextView);
        setContextualNavOpen(false);
        setQuery("");
        window.cancelAnimationFrame(navigationFocusFrame);
        navigationFocusFrame = window.requestAnimationFrame(() => {
            mainContentElement?.focus({ preventScroll: true });
        });
    }

    let paletteReturnFocus: HTMLElement | null = null;
    function openPalette(): void {
        if (paletteOpen()) return;
        paletteReturnFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPaletteQuery("");
        setPaletteIndex(0);
        setPaletteOpen(true);
    }

    function closePalette(restoreFocus = true): void {
        setPaletteOpen(false);
        setPaletteQuery("");
        setPaletteIndex(0);
        const returnFocus = paletteReturnFocus;
        paletteReturnFocus = null;
        if (restoreFocus) {
            if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
            else mainContentElement?.focus({ preventScroll: true });
        }
    }

    const actions = [
        ...(platform.kind === "desktop"
            ? [
                  {
                      label: "Open command console",
                      detail: "Run a Tutorux CLI command in this archive",
                      icon: "more" as const,
                      run: () => {
                          closePalette();
                          setCommandConsoleOpen(true);
                      },
                  },
              ]
            : []),
        {
            label: "Create a new archive",
            detail: "Start a portable workspace",
            icon: "archive" as const,
            run: () => {
                closePalette();
                openDialog("archive");
            },
        },
        {
            label: "Open an archive",
            detail: "Choose a .tux file",
            icon: "folder" as const,
            run: () => {
                closePalette();
                void openArchive();
            },
        },
        {
            label: "Add a journal entry",
            detail: "Capture a teaching note",
            icon: "journal" as const,
            run: () => {
                closePalette();
                openDialog("journal");
            },
        },
        {
            label: "Add a student",
            detail: "Create a learner profile",
            icon: "students" as const,
            run: () => {
                closePalette();
                openDialog("student");
            },
        },
        {
            label: "Add a session",
            detail: "Record a tutoring session",
            icon: "sessions" as const,
            run: () => {
                closePalette();
                openDialog("session");
            },
        },
        {
            label: "Prepare an AI guide package",
            detail: "Review a private, source-linked handoff",
            icon: "spark" as const,
            run: () => {
                closePalette(false);
                navigateToView("ai");
            },
        },
        {
            label: "Save archive",
            detail: "Save your current workspace",
            icon: "archive" as const,
            run: () => {
                closePalette();
                void saveCurrentArchiveFromAction();
            },
        },
        {
            label: "Switch appearance",
            detail: "Switch between light and dark",
            icon: "moon" as const,
            run: () => {
                toggleTheme();
                closePalette();
            },
        },
    ];
    const navigationActions = views.map((item) => ({
        label: `Go to ${item.label}`,
        detail: "Open workspace page",
        icon: item.icon,
        run: () => {
            closePalette(false);
            navigateToView(item.id);
        },
    }));
    const matchingActions = createMemo(() => {
        const needle = paletteQuery().trim().toLowerCase();
        return [...actions, ...navigationActions].filter((action) =>
            `${action.label} ${action.detail}`.toLowerCase().includes(needle),
        );
    });
    function handlePaletteKeys(event: KeyboardEvent): void {
        const matches = matchingActions();
        const palette = event.currentTarget;
        const actionButtons =
            palette instanceof HTMLElement
                ? [...palette.querySelectorAll<HTMLButtonElement>(".palette-action")]
                : [];
        const focusedAction =
            document.activeElement instanceof HTMLButtonElement
                ? actionButtons.indexOf(document.activeElement)
                : -1;
        if (event.key === "ArrowDown" && matches.length > 0) {
            event.preventDefault();
            const nextIndex = (Math.max(focusedAction, paletteIndex()) + 1) % matches.length;
            setPaletteIndex(nextIndex);
            if (focusedAction >= 0) actionButtons[nextIndex]?.focus();
        } else if (event.key === "ArrowUp" && matches.length > 0) {
            event.preventDefault();
            const nextIndex =
                (Math.max(focusedAction, paletteIndex()) + matches.length - 1) % matches.length;
            setPaletteIndex(nextIndex);
            if (focusedAction >= 0) actionButtons[nextIndex]?.focus();
        } else if (event.key === "Enter") {
            if (focusedAction >= 0) return;
            event.preventDefault();
            matches[paletteIndex()]?.run();
        }
    }

    return (
        <div class="app-frame bg-canvas grid grid-rows-[minmax(0,_1fr)] h-dvh min-h-screen overflow-hidden w-full print:[html.guide-printing_&]:bg-white! print:[html.guide-printing_&]:block! print:[html.guide-printing_&]:min-h-0! print:[html.guide-printing_&]:overflow-visible!">
            <a
                class="skip-link focus-visible:outline-offset-[3px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent bg-surface rounded-[5px] border border-line-strong shadow-none text-ink left-3 py-2.5 px-3.5 fixed top-3 translate-y-[calc(-100%_-_18px)] z-50 hover:border-accent focus-visible:translate-y-[0]"
                href="#main-content"
            >
                Skip to main content
            </a>
            <div
                class={cn(
                    `workspace-frame ${workspace() ? "has-archive" : "no-archive"}`,
                    "grid grid-cols-[238px_minmax(0,_1fr)] h-full min-h-[calc(100vh_-_68px)] w-full min-[901px]:max-[1120px]:grid-cols-[210px_minmax(0,_1fr)] min-[1121px]:max-[1160px]:grid-cols-[214px_minmax(0,_1fr)] max-sm:grid-cols-[minmax(0,_1fr)] max-sm:grid-rows-[1fr_55px] max-sm:min-h-[calc(100vh_-_58px)] min-[651px]:max-[900px]:grid-cols-[70px_minmax(0,_1fr)]",
                )}
            >
                <aside
                    class={cn(
                        `sidebar ${workspace() ? "has-archive" : "no-archive"}`,
                        "bg-canvas border-r border-r-line flex flex-col gap-0 h-full min-h-[calc(100vh_-_68px)] overflow-visible pt-5 px-3.5 pb-3 relative w-full z-6 print:hidden max-[1120px]:pl-3 max-[1120px]:pr-3 max-[1160px]:pl-2.5 max-[1160px]:pr-2.5 max-sm:items-center max-sm:bg-surface max-sm:border-r-0 max-sm:border-t max-sm:border-t-line max-sm:bottom-0 max-sm:flex-row max-sm:h-14 max-sm:justify-center max-sm:left-0 max-sm:min-h-14 max-sm:pt-1 max-sm:px-[max(8px,_env(safe-area-inset-left))] max-sm:pb-[calc(4px_+_env(safe-area-inset-bottom))] max-sm:fixed max-sm:right-0 max-sm:w-full max-sm:z-10 max-[820px]:pl-2 max-[820px]:pr-2 max-[900px]:items-center max-[900px]:pt-4 max-[900px]:px-2 max-[900px]:pb-2.5",
                    )}
                    aria-label="Workspace navigation"
                >
                    <Show
                        when={workspace()}
                        fallback={
                            <section
                                class="sidebar-empty-archive border-b border-b-line grid gap-2 mt-0.5 mx-0 mb-3.5 pt-0.5 px-0 pb-3.5 max-sm:hidden"
                                aria-label="Archive actions"
                            >
                                <span class="sidebar-section-label text-muted text-xs font-medium tracking-normal leading-[1.4] pt-0 px-1.5 pb-0.5 normal-case">
                                    Archive
                                </span>
                                <button
                                    class="sidebar-action text-ink-soft font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent rounded-[5px] border border-transparent cursor-pointer flex text-[13px] font-medium gap-2.5 min-h-9.5 min-w-0 py-0 px-2.5 text-left hover:bg-surface-inset hover:border-line-soft hover:text-ink"
                                    type="button"
                                    onClick={() => void openArchive()}
                                    disabled={loading()}
                                >
                                    <Icon name="folder" />
                                    <span class="">Open archive</span>
                                </button>
                                <button
                                    class="sidebar-action sidebar-action-primary text-ink font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-surface rounded-[5px] border border-line-strong cursor-pointer flex text-[13px] font-medium gap-2.5 min-h-9.5 min-w-0 py-0 px-2.5 text-left hover:bg-surface-inset hover:border-line-soft hover:text-ink"
                                    type="button"
                                    onClick={() => openDialog("archive")}
                                    disabled={loading()}
                                >
                                    <Icon name="plus" />
                                    <span class="">Create archive</span>
                                </button>
                            </section>
                        }
                    >
                        <div class="sidebar-archive border-b border-b-line mb-3.5 pb-3 max-sm:hidden">
                            <button
                                class="sidebar-workspace text-ink font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-b border-b-line-soft rounded-[5px] border-0 cursor-pointer flex gap-2.5 m-0 mt-0 mx-0 mb-5 min-h-15 min-w-0 py-0.5 px-1 pt-1 pb-3 text-left w-full max-sm:hidden max-[900px]:border-0 max-[900px]:justify-center max-[900px]:mb-4.5 max-[900px]:p-0 hover:bg-surface-inset"
                                type="button"
                                onClick={() => void openArchive()}
                                title="Open another archive"
                            >
                                <span
                                    class="workspace-monogram bg-surface-inset rounded-[5px] border border-accent/15 text-accent grid flex-none text-xs font-bold h-9 place-items-center w-9"
                                    aria-hidden="true"
                                >
                                    <Icon name="archive" />
                                </span>
                                <span class="workspace-switcher-copy grid flex-1 gap-1 min-w-0 max-[900px]:hidden">
                                    <span class={cn(eyebrow, "eyebrow")}>Active archive</span>
                                    <strong class="text-ink text-sm font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
                                        {workspace()!.manifest.displayName}
                                    </strong>
                                </span>
                                <Icon name="chevron" />
                            </button>
                            <div
                                class="sidebar-archive-status items-center text-muted flex text-xs gap-2 leading-[1.35] min-h-6 pt-1.5 px-1.5 pb-0"
                                aria-live="polite"
                            >
                                <span
                                    class={cn(
                                        "status-dot",
                                        archiveSaveConflict()
                                            ? "bg-danger"
                                            : workspace()?.dirty
                                              ? "bg-warning"
                                              : "bg-accent",
                                        "rounded-full shadow-none flex-none h-2 w-2",
                                    )}
                                    aria-hidden="true"
                                />
                                <span class="">
                                    {archiveSaveConflict()
                                        ? "Archive changed on disk"
                                        : workspace()?.snapshot.locked
                                          ? "Archive locked"
                                          : workspace()?.dirty
                                            ? "Unsaved changes"
                                            : "Archive ready"}
                                </span>
                            </div>
                            <Show when={workspace()?.dirty}>
                                <button
                                    class={cn(
                                        buttonPrimary,
                                        "button button-primary sidebar-save-archive text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 justify-start mt-2 w-full",
                                    )}
                                    type="button"
                                    onClick={() => void saveCurrentArchiveFromAction()}
                                    disabled={busy() || workspace()?.snapshot.locked}
                                >
                                    <Icon name="archive" />
                                    <span class="">
                                        {archiveSaveConflict()
                                            ? "Save as new copy"
                                            : "Save archive"}
                                    </span>
                                </button>
                            </Show>
                        </div>
                    </Show>

                    <button
                        class="sidebar-search text-ink-soft font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-surface border-transparent rounded-[5px] border cursor-pointer flex text-[13px] font-medium gap-2.5 justify-start mb-4 min-h-9.5 min-w-0 py-0 px-2.5 text-left w-full max-sm:hidden hover:bg-surface-inset hover:border-line-soft hover:text-ink"
                        type="button"
                        onClick={openPalette}
                        aria-label="Open quick actions"
                        aria-keyshortcuts="Control+K Meta+K"
                    >
                        <Icon name="search" />
                        <span class="flex-1">Search Tutorux</span>
                        <kbd class="bg-surface-subtle rounded-[5px] border border-line text-muted py-0.5 px-1.5 whitespace-nowrap">
                            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K
                        </kbd>
                    </button>

                    <Show when={workspace()}>
                        <nav
                            class="nav-groups content-start grid gap-1.5 max-sm:items-center max-sm:flex max-sm:gap-0.5 max-sm:w-full min-[641px]:max-[650px]:flex min-[641px]:max-[650px]:gap-0 min-[641px]:max-[650px]:w-full min-[651px]:max-[900px]:gap-3.5 min-[651px]:max-[900px]:w-full"
                            aria-label="Primary navigation"
                        >
                            <span class="nav-group-title text-muted text-xs font-bold tracking-normal leading-[1.4] pt-0 px-2.5 pb-1 normal-case max-sm:hidden min-[641px]:max-[650px]:hidden min-[651px]:max-[900px]:hidden">
                                Workspace
                            </span>
                            <For each={primaryViews}>
                                {(item) => (
                                    <button
                                        class={cn(
                                            "nav-item",
                                            "text-muted font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent rounded-[5px] border border-transparent cursor-pointer flex text-sm font-medium gap-2.5 h-9.5 min-w-0 py-0 px-2.5 relative text-left transition-colors duration-150 max-sm:content-center max-sm:grid max-sm:flex-1 max-sm:text-[10px] max-sm:gap-0.5 max-sm:h-11.5 max-sm:justify-items-center max-sm:leading-[1.15] max-sm:max-w-19 max-sm:min-w-0 max-sm:py-1 max-sm:px-0.5 max-sm:w-auto min-[641px]:max-[650px]:h-10.5 min-[641px]:max-[650px]:w-11 min-[651px]:max-[820px]:h-9 min-[821px]:max-[900px]:h-10.5 max-[900px]:justify-center min-[641px]:max-[900px]:p-0 min-[651px]:max-[900px]:w-11 max-[900px]:before:-left-1.5 before:bg-transparent before:rounded-[5px] before:content-[''] before:h-4.5 before:left-0 before:absolute before:w-0.5 hover:bg-surface-inset hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent",
                                        )}
                                        type="button"
                                        aria-label={item.label}
                                        aria-current={view() === item.id ? "page" : undefined}
                                        onClick={() => navigateToView(item.id)}
                                    >
                                        <Icon name={item.icon} />
                                        <span class="max-sm:inline min-[641px]:max-[900px]:hidden">
                                            {item.label}
                                        </span>
                                    </button>
                                )}
                            </For>
                            <div
                                class="contextual-navigation relative max-sm:block max-sm:flex-1 max-sm:min-w-0 max-sm:relative"
                                onFocusOut={(event) => {
                                    if (
                                        !(event.relatedTarget instanceof Node) ||
                                        !event.currentTarget.contains(event.relatedTarget)
                                    ) {
                                        setContextualNavOpen(false);
                                    }
                                }}
                            >
                                <button
                                    class={cn(
                                        "nav-item contextual-nav-toggle",
                                        contextualViews.some((item) => item.id === view())
                                            ? "bg-accent-soft text-accent"
                                            : "",
                                        "text-muted font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent rounded-[5px] border border-transparent cursor-pointer flex text-sm font-medium gap-2.5 h-9.5 min-w-0 py-0 px-2.5 relative text-left transition-colors duration-150 max-sm:content-center max-sm:grid max-sm:flex-1 max-sm:text-[10px] max-sm:gap-0.5 max-sm:h-11.5 max-sm:justify-items-center max-sm:leading-[1.15] max-sm:max-w-19 max-sm:min-w-0 max-sm:py-1 max-sm:px-0.5 max-sm:w-auto min-[641px]:max-[650px]:h-10.5 min-[641px]:max-[650px]:w-11 min-[651px]:max-[820px]:h-9 min-[821px]:max-[900px]:h-10.5 max-[900px]:justify-center min-[641px]:max-[900px]:p-0 min-[651px]:max-[900px]:w-11 max-[900px]:before:-left-1.5 before:bg-transparent before:rounded-[5px] before:content-[''] before:h-4.5 before:left-0 before:absolute before:w-0.5 hover:bg-surface-inset hover:text-ink",
                                    )}
                                    type="button"
                                    aria-label="More workspaces"
                                    aria-haspopup="menu"
                                    aria-expanded={contextualNavOpen()}
                                    onClick={() => {
                                        const open = !contextualNavOpen();
                                        setContextualNavOpen(open);
                                        if (open)
                                            queueMicrotask(() =>
                                                contextualNavMenuElement
                                                    ?.querySelector<HTMLButtonElement>(
                                                        '[role="menuitem"]',
                                                    )
                                                    ?.focus(),
                                            );
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape") {
                                            setContextualNavOpen(false);
                                            return;
                                        }
                                        if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                                            return;
                                        event.preventDefault();
                                        setContextualNavOpen(true);
                                        queueMicrotask(() => {
                                            const items =
                                                contextualNavMenuElement?.querySelectorAll<HTMLButtonElement>(
                                                    '[role="menuitem"]',
                                                );
                                            const item =
                                                event.key === "ArrowDown"
                                                    ? items?.[0]
                                                    : items?.[items.length - 1];
                                            item?.focus();
                                        });
                                    }}
                                >
                                    <Icon name="more" />
                                    <span class="max-sm:inline min-[641px]:max-[900px]:hidden">
                                        More
                                    </span>
                                    <Icon name="chevron" />
                                </button>
                                <Show when={contextualNavOpen()}>
                                    <div
                                        ref={(element) => (contextualNavMenuElement = element)}
                                        class="contextual-nav-menu bg-surface rounded-[5px] border border-line-strong left-[calc(100%_+_7px)] max-h-[min(560px,_calc(100dvh_-_32px))] overflow-y-auto p-1.5 absolute top-0 w-full max-w-[268px] z-30 max-sm:rounded-[10px] max-sm:bottom-[calc(58px_+_8px)] max-sm:left-auto max-sm:max-h-[calc(100dvh_-_96px)] max-sm:fixed max-sm:right-2.5 max-sm:top-auto max-sm:w-full max-sm:max-w-[320px]"
                                        role="menu"
                                        aria-label="More workspaces"
                                        onKeyDown={(event) => {
                                            if (event.key === "Escape") {
                                                setContextualNavOpen(false);
                                                event.preventDefault();
                                                return;
                                            }
                                            const items = Array.from(
                                                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                                    '[role="menuitem"]',
                                                ),
                                            );
                                            if (!items.length) return;
                                            const current = items.indexOf(
                                                document.activeElement as HTMLButtonElement,
                                            );
                                            let next: number;
                                            if (event.key === "ArrowDown")
                                                next =
                                                    current < 0 ? 0 : (current + 1) % items.length;
                                            else if (event.key === "ArrowUp")
                                                next =
                                                    current <= 0 ? items.length - 1 : current - 1;
                                            else if (event.key === "Home") next = 0;
                                            else if (event.key === "End") next = items.length - 1;
                                            else return;
                                            event.preventDefault();
                                            items[next]?.focus();
                                        }}
                                    >
                                        <For each={contextualViews}>
                                            {(item) => (
                                                <button
                                                    class={cn(
                                                        "contextual-nav-item",
                                                        "text-ink-soft font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent rounded-[5px] border border-transparent cursor-pointer flex text-[13px] gap-2.5 min-h-9 py-0 px-2.5 text-left w-full hover:bg-surface-inset hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent",
                                                    )}
                                                    type="button"
                                                    role="menuitem"
                                                    aria-label={item.label}
                                                    aria-current={
                                                        view() === item.id ? "page" : undefined
                                                    }
                                                    onClick={() => navigateToView(item.id)}
                                                >
                                                    <Icon name={item.icon} />
                                                    <span class="">{item.label}</span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                        </nav>
                    </Show>

                    <div class="sidebar-bottom border-t border-t-line grid gap-2 mt-auto pt-3 max-sm:hidden min-[641px]:max-[650px]:hidden min-[651px]:max-[900px]:hidden">
                        <button
                            class="sidebar-appearance text-ink-soft font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent rounded-[5px] border border-transparent cursor-pointer flex text-[13px] font-medium gap-2.5 min-h-9.5 min-w-0 py-0 px-2.5 text-left w-full hover:bg-surface-inset hover:border-line-soft hover:text-ink"
                            type="button"
                            onClick={toggleTheme}
                            aria-label={`Switch to ${theme() === "light" ? "dark" : "light"} appearance`}
                            aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
                        >
                            <Icon name={theme() === "light" ? "moon" : "sun"} />
                            <span class="">
                                {theme() === "light" ? "Dark appearance" : "Light appearance"}
                            </span>
                        </button>
                    </div>
                </aside>

                <main
                    class="main-content bg-canvas h-full min-h-[calc(100vh_-_68px)] min-w-0 overflow-auto w-full max-sm:row-[1] max-sm:min-h-[calc(100vh_-_113px)] focus-visible:outline-offset-[-3px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40"
                    id="main-content"
                    tabindex="-1"
                    ref={(element) => (mainContentElement = element)}
                    onClick={() => setContextualNavOpen(false)}
                >
                    <Show when={workspace()}>
                        <div class={cn(pageToolbar, "page-toolbar print:hidden")}>
                            <div class="breadcrumbs items-center text-muted flex text-[13px] gap-2.5">
                                <span class="">Workspace</span>
                                <Icon name="chevron" />
                                <strong class="text-ink-soft font-semibold">
                                    {activeView().label}
                                </strong>
                            </div>
                            <div class="toolbar-actions items-center flex gap-2 max-sm:gap-1.5">
                                <Show
                                    when={
                                        view() === "students" ||
                                        view() === "sessions" ||
                                        view() === "annotations" ||
                                        view() === "transcripts" ||
                                        view() === "journal" ||
                                        view() === "assets" ||
                                        view() === "guides"
                                    }
                                >
                                    <label class="inline-search items-center bg-surface rounded-[5px] border border-line-strong text-muted flex gap-2 h-8.5 py-0 px-2.5 w-57.5 max-sm:w-[min(52vw,_200px)] max-sm:h-7.5 min-[641px]:max-[650px]:w-[min(150px,_36vw)]">
                                        <Icon name="search" />
                                        <input
                                            ref={(element) => (pageSearchInput = element)}
                                            value={query()}
                                            onInput={(event) => setQuery(event.currentTarget.value)}
                                            placeholder={`Search ${activeView().label.toLowerCase()}…`}
                                            aria-label={`Search ${activeView().label}`}
                                            aria-keyshortcuts="Control+F Meta+F"
                                            class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 placeholder:text-faint bg-transparent border-0 text-ink text-[13px] min-w-0 w-full max-sm:text-xs"
                                        />
                                        <kbd class="inline-search-shortcut bg-surface-subtle rounded-[5px] border border-line-soft text-muted flex-none text-xs leading-none py-0.5 px-1.5 whitespace-nowrap">
                                            {navigator.platform.includes("Mac") ? "⌘F" : "Ctrl F"}
                                        </kbd>
                                    </label>
                                </Show>
                            </div>
                        </div>
                    </Show>

                    <Show when={!workspace()}>
                        <Welcome
                            loading={loading()}
                            onCreate={() => openDialog("archive")}
                            onOpen={() => void openArchive()}
                        />
                    </Show>
                    <Show when={workspace()}>
                        {(state) => (
                            <>
                                <Show when={state().snapshot.locked}>
                                    <section class="locked-banner locked-panel items-center bg-[var(--warning)] rounded-[5px] border border-[var(--warning)] text-[var(--warning)] flex gap-3 mt-4.5 mx-7.5 mb-0 py-3.5 px-4 max-sm:ml-3 max-sm:mr-3 flex-wrap">
                                        <Icon name="shield" />
                                        <div class="locked-copy flex-[1_1_230px] min-w-55">
                                            <strong class="text-xs">
                                                This archive is encrypted
                                            </strong>
                                            <p class="text-muted text-xs leading-relaxed mt-1 mx-0 mb-0">
                                                Enter its passphrase to authenticate the archive and
                                                unlock its records.
                                            </p>
                                        </div>
                                        <UnlockArchivePanel
                                            onUnlock={unlockCurrentArchive}
                                            busy={busy()}
                                        />
                                    </section>
                                </Show>
                                <Show when={view() === "home"}>
                                    <Overview
                                        state={state()}
                                        onNavigate={navigateToView}
                                        onCreate={openDialog}
                                        onOpen={() => void openArchive()}
                                    />
                                </Show>
                                <Show when={view() === "students"}>
                                    <RecordPage
                                        kind="students"
                                        records={filteredRecords()}
                                        state={state()}
                                        busy={busy()}
                                        onWriteRecords={(records, message) =>
                                            addRecords(records, message)
                                        }
                                        onAdd={() => openDialog("student")}
                                        onEdit={editStudent}
                                        onTrash={(record) => setPendingDelete(record)}
                                        onProgressReview={saveStudentProgress}
                                    />
                                </Show>
                                <Show when={view() === "sessions"}>
                                    <RecordPage
                                        kind="sessions"
                                        records={filteredRecords()}
                                        state={state()}
                                        busy={busy()}
                                        onRestoreSessionVersion={restoreSessionVersion}
                                        onAdd={() => openDialog("session")}
                                        onEdit={(record) => editRecord("session", record)}
                                        onTrash={(record) => void reviewSessionTrash(record)}
                                        onTransition={(record, action) =>
                                            void transitionSession(record, action)
                                        }
                                        onClone={(record) => void duplicateSession(record)}
                                        onExportSessionPackage={(record) =>
                                            void exportSessionPackageFile(record)
                                        }
                                        onImportSessionPackage={(studentId) =>
                                            void importSessionPackageFile(studentId)
                                        }
                                        onArchive={(record, archived) =>
                                            void updateSessionArchiveState(record, archived)
                                        }
                                        onOpenTranscript={(record) => {
                                            setSelectedTranscriptSessionId(record.id);
                                            navigateToView("transcripts");
                                        }}
                                        onOpenObservations={(record) => {
                                            setSelectedAnnotationSessionId(record.id);
                                            navigateToView("annotations");
                                        }}
                                        onOpenStudyGuide={(record) => {
                                            setSelectedGuideSessionId(record.id);
                                            navigateToView("guides");
                                        }}
                                    />
                                </Show>
                                <Show when={view() === "transcripts"}>
                                    <TranscriptPage
                                        snapshot={state().snapshot}
                                        sessions={allSessions(state())}
                                        records={filteredRecords()}
                                        assets={state().assets}
                                        tracks={state().audioTracks}
                                        recordingTakes={state().assets.filter(
                                            (record) =>
                                                record.fields.get("record_role") ===
                                                "recording-take",
                                        )}
                                        trashedRecordingTakes={state().trashedRecordingTakes}
                                        trashedRecordingTracks={state().trashedRecordingTracks}
                                        selectedSessionId={selectedTranscriptSessionId()}
                                        disabled={
                                            state().snapshot.locked ||
                                            !state().snapshot.canMutate ||
                                            busy()
                                        }
                                        onSelectSession={setSelectedTranscriptSessionId}
                                        onNewSession={() => openDialog("session")}
                                        onImport={(file, sessionId) =>
                                            void importTranscript(file, sessionId)
                                        }
                                        onImportAudio={(file, sessionId, allowAdditionalTrack) =>
                                            void importWave(file, sessionId, allowAdditionalTrack)
                                        }
                                        onImportCompressedAudio={(
                                            sessionId,
                                            allowAdditionalTrack,
                                        ) =>
                                            void importCompressedAudioFile(
                                                sessionId,
                                                allowAdditionalTrack,
                                            )
                                        }
                                        onRecoverAudio={(sessionId) =>
                                            void recoverWavImport(sessionId)
                                        }
                                        onRecoverNativeAudio={(sessionId) =>
                                            void recoverNativeAudio(sessionId)
                                        }
                                        onRecordAudio={(file, sessionId, consentAtUs) =>
                                            importCapturedAudio(file, sessionId, consentAtUs)
                                        }
                                        onExportAudio={(
                                            sessionId,
                                            trackId,
                                            label,
                                            fillGapsWithSilence,
                                        ) =>
                                            void exportAudioTrack(
                                                sessionId,
                                                trackId,
                                                label,
                                                fillGapsWithSilence,
                                            )
                                        }
                                        onRenameRecordingTake={(take, label) =>
                                            void saveRecordingTakeName(take, label)
                                        }
                                        onRenameRecordingTrack={(track, label) =>
                                            void saveRecordingTrackName(track, label)
                                        }
                                        onTrashRecordingTrack={(track) =>
                                            void changeRecordingTrackTrash(track, true)
                                        }
                                        onRestoreRecordingTrack={(track) =>
                                            void changeRecordingTrackTrash(track, false)
                                        }
                                        onTrashRecordingTake={(take) =>
                                            void changeRecordingTakeTrash(take, true)
                                        }
                                        onRestoreRecordingTake={(take) =>
                                            void changeRecordingTakeTrash(take, false)
                                        }
                                        onSaveMix={(snapshot, records, message) =>
                                            workspace()?.snapshot === snapshot
                                                ? addRecords(records, message)
                                                : Promise.resolve(false)
                                        }
                                        onCheckpointPersisted={markArchiveSnapshotPersisted}
                                        onSaveWhisper={(records, message, snapshot) =>
                                            workspace()?.snapshot === snapshot
                                                ? addRecords(records, message)
                                                : Promise.resolve(false)
                                        }
                                        onExport={(sessionId, format) =>
                                            void exportTranscript(sessionId, format)
                                        }
                                        onSave={saveTranscriptCue}
                                        onVerify={verifyTranscriptCue}
                                        onHistory={getTranscriptHistory}
                                        onRestore={restoreTranscriptRevision}
                                        onSplit={splitTranscriptCue}
                                        onMerge={mergeTranscriptCues}
                                        onLinkAssets={linkTranscriptAssets}
                                    />
                                </Show>
                                <Show when={view() === "ai"}>
                                    <AiPage
                                        archiveId={state().snapshot.header.id}
                                        sessions={[
                                            ...state().sessions,
                                            ...state().archivedSessions,
                                        ]}
                                        assets={state().assets}
                                        customTemplates={state().guideTemplates}
                                        jobs={state().aiJobs}
                                        providerSettings={state().providerSettings}
                                        credentials={state().credentials}
                                        systemCredentialStoreAvailable={systemCredentialStoreAvailable()}
                                        hasSystemCredential={platform.hasAiCredential}
                                        encrypted={state().snapshot.encrypted}
                                        disabled={
                                            state().snapshot.locked || !state().snapshot.canMutate
                                        }
                                        busy={busy()}
                                        execution={
                                            lastAiExecution()?.archiveId ===
                                            state().snapshot.header.id
                                                ? (lastAiExecution()?.summary ?? null)
                                                : null
                                        }
                                        onClearExecution={() => setLastAiExecution(null)}
                                        onPrepare={prepareAiPackage}
                                        onCreateRequestPreview={createAiProviderPreview}
                                        onInspectReplicateModel={inspectReplicateModelForAiProvider}
                                        onSave={saveAiPackage}
                                        onLoad={loadAiPackage}
                                        onExportTextFile={(name, contents, mimeType) =>
                                            platform.exportTextFile(name, contents, mimeType)
                                        }
                                        onExportBinaryFile={(name, contents, mimeType) =>
                                            platform.exportBinaryFile(name, contents, mimeType)
                                        }
                                        onSend={sendAiProviderRequest}
                                        onImportResponse={importAiResponse}
                                        onSaveProvider={saveAiProvider}
                                        onSaveCredential={saveAiCredential}
                                        onRemoveCredential={removeAiCredential}
                                    />
                                </Show>
                                <Show when={view() === "annotations"}>
                                    <AnnotationPage
                                        icon={Icon}
                                        sessions={allSessions(state())}
                                        records={filteredRecords()}
                                        assets={state().assets}
                                        evidence={state().evidence}
                                        onWriteRecords={(records, message) =>
                                            addRecords(records, message)
                                        }
                                        selectedSessionId={selectedAnnotationSessionId()}
                                        disabled={
                                            state().snapshot.locked ||
                                            !state().snapshot.canMutate ||
                                            busy()
                                        }
                                        onSelectSession={setSelectedAnnotationSessionId}
                                        onSave={saveAnnotation}
                                        onRemove={(record) => setPendingDelete(record)}
                                        onDuplicate={(record) =>
                                            addRecords(
                                                [duplicateAnnotationRecord(record)],
                                                "Observation duplicated.",
                                            )
                                        }
                                        onNewSession={() => openDialog("session")}
                                        onHistory={getAnnotationHistory}
                                        onRestore={restoreAnnotationRevision}
                                        onPlayFromTimestamp={(record) =>
                                            void playObservationFromTimestamp(record)
                                        }
                                    />
                                </Show>
                                <Show when={view() === "journal"}>
                                    <RecordPage
                                        kind="journal"
                                        records={filteredRecords()}
                                        state={state()}
                                        busy={busy()}
                                        onWriteRecords={(records, message) =>
                                            addRecords(records, message)
                                        }
                                        onAdd={() => openDialog("journal")}
                                        onEdit={(record) => editRecord("journal", record)}
                                        onSaveOrganizer={(record, message) =>
                                            addRecords([record], message)
                                        }
                                        onArchiveOrganizer={(record) =>
                                            void addRecords(
                                                archiveJournalOrganizerRecord(
                                                    record,
                                                    state().entries,
                                                ),
                                                "Label archived. Its links can be restored with the label.",
                                            )
                                        }
                                        onRestoreOrganizer={(record) =>
                                            void addRecords(
                                                restoreJournalOrganizerRecord(
                                                    record,
                                                    state().entries,
                                                ),
                                                "Label restored with its previous entry links.",
                                            )
                                        }
                                    />
                                </Show>
                                <Show when={view() === "guides"}>
                                    <GuidesPage
                                        snapshot={state().snapshot}
                                        records={filteredRecords()}
                                        sessions={[
                                            ...state().sessions,
                                            ...state().archivedSessions,
                                        ]}
                                        entries={state().entries}
                                        students={state().students}
                                        sourceRecords={guideSourceRecords(state())}
                                        customTemplates={state().guideTemplates}
                                        trashedTemplates={state().trashedGuideTemplates}
                                        templateManagerOpen={guideTemplateManagerOpen()}
                                        initialSessionId={selectedGuideSessionId()}
                                        onToggleTemplateManager={() =>
                                            setGuideTemplateManagerOpen((open) => !open)
                                        }
                                        disabled={!state().snapshot.canMutate}
                                        busy={busy()}
                                        onOpenSessions={() => navigateToView("sessions")}
                                        onSave={saveGuide}
                                        onRestoreVersion={restoreGuideVersion}
                                        onApprove={(record) => void approveGuide(record)}
                                        onTrash={(record) => void trashGuide(record)}
                                        onExport={(record, format) =>
                                            void exportGuide(record, format)
                                        }
                                        onSaveTemplate={saveGuideTemplate}
                                        onTrashTemplate={(record) =>
                                            void trashGuideTemplate(record)
                                        }
                                        onRestoreTemplate={(record) =>
                                            void restoreGuideTemplate(record)
                                        }
                                        onExportTemplate={(template) =>
                                            void exportGuideTemplate(template)
                                        }
                                    />
                                </Show>
                                <Show when={view() === "evidence"}>
                                    <EvidencePage
                                        snapshot={state().snapshot}
                                        sessions={allSessions(state())}
                                        records={filteredRecords()}
                                        edges={state().evidenceEdges}
                                        transcripts={state().transcripts}
                                        assets={state().assets}
                                        selectedSessionId={selectedEvidenceSessionId()}
                                        disabled={
                                            state().snapshot.locked ||
                                            !state().snapshot.canMutate ||
                                            busy()
                                        }
                                        onSelectSession={setSelectedEvidenceSessionId}
                                        onExtract={extractEvidence}
                                        onCreate={createEvidence}
                                        onReview={reviewEvidence}
                                        onLink={linkEvidence}
                                        onUnlink={(edge) => void removeEvidenceEdge(edge)}
                                        onUpdate={updateEvidence}
                                        onTrash={(record) => void trashEvidence(record)}
                                    />
                                </Show>
                                <Show when={view() === "assets"}>
                                    <AssetPage
                                        records={filteredRecords()}
                                        sessions={state().sessions}
                                        snapshot={state().snapshot}
                                        onWriteRecords={(records, message) =>
                                            addRecords(records, message)
                                        }
                                        disabled={
                                            state().snapshot.locked ||
                                            !state().snapshot.canMutate ||
                                            busy()
                                        }
                                        onImport={importAssets}
                                        onPreview={loadAssetPreview}
                                        onExport={(record) => void exportAsset(record)}
                                    />
                                </Show>
                                <Show when={view() === "trash"}>
                                    <TrashPage
                                        records={state().trashedStudents}
                                        journalEntries={state().trashedJournalEntries}
                                        annotations={state().trashedAnnotations}
                                        guides={state().trashedGuides}
                                        evidence={state().trashedEvidence}
                                        evidenceEdges={state().trashedEvidenceEdges}
                                        noteBlocks={state().notesDocuments.flatMap(
                                            (document) => readRemovedNoteBlocks(document) ?? [],
                                        )}
                                        sessions={state().trashedSessions}
                                        onRestore={(record) => void restoreStudent(record)}
                                        onRestoreJournalEntry={(record) =>
                                            void restoreJournalEntry(record)
                                        }
                                        onRestoreAnnotation={(record) =>
                                            void restoreTrashedAnnotation(record)
                                        }
                                        onRestoreGuide={(record) => void restoreGuide(record)}
                                        onRestoreEvidence={(record) => void restoreEvidence(record)}
                                        onRestoreEvidenceEdge={(record) =>
                                            void restoreTrashedEvidenceEdge(record)
                                        }
                                        onRestoreNoteBlock={(block) =>
                                            void restoreTrashedNoteBlock(block)
                                        }
                                        onRestoreSession={(record) =>
                                            void restoreSessionGroup(record)
                                        }
                                        pendingPurge={pendingTrashPurge()}
                                        onBeginPurge={() => void beginTrashPurge()}
                                        onCancelPurge={() => setPendingTrashPurge(null)}
                                        onConfirmPurge={() => void confirmTrashPurge()}
                                        disabled={
                                            state().snapshot.locked ||
                                            !state().snapshot.canMutate ||
                                            busy()
                                        }
                                    />
                                </Show>
                                <Show when={view() === "archive"}>
                                    <ArchivePage
                                        state={state()}
                                        busy={busy()}
                                        onApplyMaintenance={applyArchiveMaintenance}
                                        onSave={() => void saveCurrentArchiveFromAction()}
                                        onOpen={() => void openArchive()}
                                        onLock={() => void lockCurrentArchive()}
                                    />
                                </Show>
                                <Show when={view() === "settings"}>
                                    <SettingsPage
                                        theme={theme()}
                                        themeMode={themeMode()}
                                        onThemeMode={chooseThemeMode}
                                        state={state()}
                                        busy={busy()}
                                        onChangePassphrase={() => openDialog("passphrase")}
                                        onEnableEncryption={enableCurrentEncryption}
                                        onSaveArchive={() => void saveCurrentArchiveFromAction()}
                                        onSaveMarkerKeys={saveMarkerKeys}
                                        onSaveSettings={(records, message) =>
                                            addRecords(records, message)
                                        }
                                        onRenameArchive={renameArchiveDisplayName}
                                    />
                                </Show>
                            </>
                        )}
                    </Show>
                </main>
            </div>

            <Show when={notice()}>
                {(item) => (
                    <div
                        class={cn(
                            `toast toast-${item().tone}`,
                            "items-center animate-[toast-in_0.2s_ease-out] bg-surface rounded-[5px] border border-line bottom-5 shadow-none text-ink-soft flex text-xs gap-2.5 max-w-[min(460px,_calc(100vw_-_36px))] min-h-11.5 py-2 px-2.5 fixed right-5.5 z-40",
                        )}
                        role="status"
                        aria-live="polite"
                    >
                        <span
                            class={cn(
                                "toast-mark [&:nth-child(2)]:leading-[1.55] bg-accent-soft rounded-[5px] text-accent grid flex-none h-6.5 place-items-center w-6.5",
                                item().tone === "error" && "bg-[var(--danger-soft)] text-danger",
                            )}
                        >
                            <Icon
                                name={
                                    item().tone === "success"
                                        ? "check"
                                        : item().tone === "error"
                                          ? "close"
                                          : "spark"
                                }
                            />
                        </span>
                        <span class="[&:nth-child(2)]:leading-[1.55]">{item().message}</span>
                        <button
                            type="button"
                            onClick={() => setNotice(null)}
                            aria-label="Dismiss notification"
                            class="text-faint font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 hover:bg-surface-inset hover:text-ink bg-transparent rounded-[5px] border-0 cursor-pointer grid h-6 ml-1.5 place-items-center w-6"
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                )}
            </Show>

            <Show when={observationPlayback()}>
                {(playback) => (
                    <section
                        class="transcript-audio-panel items-center grid gap-y-3.5 gap-x-4.5 grid-cols-2 mt-0 mx-0 mb-3.5 min-w-0 max-sm:gap-2.5 max-sm:grid-cols-[minmax(0,_1fr)] min-[651px]:max-[900px]:grid-cols-[minmax(0,_1fr)_minmax(160px,_0.8fr)]"
                        aria-label="Observation audio playback"
                        style={{
                            position: "fixed",
                            right: "1rem",
                            bottom: "5.5rem",
                            "z-index": 60,
                            "max-width": "min(26rem, calc(100vw - 2rem))",
                            "box-shadow": "0 18px 48px rgba(0, 0, 0, .22)",
                        }}
                    >
                        <div class="transcript-audio-copy grid gap-1 min-w-0">
                            <strong class="text-ink text-xs font-[650] overflow-hidden text-ellipsis whitespace-nowrap">
                                {playback().title}
                            </strong>
                            <span class="last:text-muted last:text-xs">
                                Playing from {playback().start}
                            </span>
                        </div>
                        <MediaPlayer
                            kind="audio"
                            src={playback().url}
                            label="Observation audio"
                            autoPlay
                        />
                        <button
                            class={cn(
                                buttonQuiet,
                                "button button-quiet record-action text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 text-xs min-h-7.5 py-0 px-2.5",
                            )}
                            type="button"
                            onClick={() => {
                                URL.revokeObjectURL(playback().url);
                                setObservationPlayback(null);
                            }}
                        >
                            Close
                        </button>
                    </section>
                )}
            </Show>

            <Show when={dialog()} keyed>
                {(kind) => (
                    <FormDialog
                        kind={kind}
                        state={workspace()}
                        record={dialogRecord()}
                        notesDocument={
                            workspace()?.notesDocuments.find(
                                (record) =>
                                    record.id === dialogRecord()?.fields.get("notes_document_id"),
                            ) ?? null
                        }
                        busy={busy()}
                        onClose={closeDialog}
                        onCreateArchive={(name, description, passphrase) =>
                            createArchive(name, description, passphrase)
                        }
                        onChangePassphrase={(currentPassphrase, newPassphrase) =>
                            changeCurrentPassphrase(currentPassphrase, newPassphrase)
                        }
                        onSaveStudent={(input, record) =>
                            void updateStudent(input, record).catch((error: unknown) =>
                                announce(errorMessage(error), "error"),
                            )
                        }
                        onAutosaveNotes={autosaveNotes}
                        onEnableNotesAutosave={enableNotesAutosave}
                        onSaveSession={(input, record, notesDocument, updateNotes) => {
                            const state = workspace();
                            const latest = record
                                ? [
                                      ...(state?.sessions ?? []),
                                      ...(state?.archivedSessions ?? []),
                                  ].find((item) => item.id === record.id)
                                : null;
                            if (record && !latest) {
                                announce("This session is no longer available.", "error");
                                return;
                            }
                            const latestNotes = latest
                                ? (state?.notesDocuments.find(
                                      (item) => item.id === field(latest, "notes_document_id"),
                                  ) ?? null)
                                : notesDocument;
                            const changes = latest
                                ? updateSessionRecords(latest, input, latestNotes, updateNotes)
                                : makeSessionRecords(input, {
                                      ensureJournalRoot: !(workspace()?.journals.length ?? 0),
                                  } satisfies SessionCreateOptions);
                            const createdSession = latest
                                ? undefined
                                : changes.find((item) => item.type === RecordType.session);
                            void addRecords(
                                changes,
                                record ? "Session details updated." : undefined,
                            )
                                .then((saved) => {
                                    if (saved && createdSession && view() === "transcripts") {
                                        setSelectedTranscriptSessionId(createdSession.id);
                                    }
                                })
                                .catch((error: unknown) => announce(errorMessage(error), "error"));
                        }}
                        onSaveJournal={(input, record, notesDocument, updateNotes) => {
                            const state = workspace();
                            const latest = record
                                ? state?.entries.find((item) => item.id === record.id)
                                : null;
                            if (record && !latest) {
                                announce("This journal entry is no longer available.", "error");
                                return;
                            }
                            const latestNotes = latest
                                ? (state?.notesDocuments.find(
                                      (item) => item.id === field(latest, "notes_document_id"),
                                  ) ?? null)
                                : notesDocument;
                            void addRecords(
                                latest
                                    ? updateJournalRecords(latest, input, latestNotes, updateNotes)
                                    : makeJournalRecords(input, {
                                          ensureJournalRoot: !(workspace()?.journals.length ?? 0),
                                      }),
                                record ? "Journal entry updated." : undefined,
                            ).catch((error: unknown) => announce(errorMessage(error), "error"));
                        }}
                    />
                )}
            </Show>

            <Show when={pendingDelete()}>
                {(record) => (
                    <ConfirmDeleteDialog
                        kind={record().type === RecordType.annotation ? "observation" : "student"}
                        name={
                            record().type === RecordType.annotation
                                ? field(
                                      record(),
                                      "title",
                                      annotationTypeLabel(field(record(), "type", "observation")),
                                  )
                                : field(record(), "display_name", "this student")
                        }
                        busy={busy()}
                        onCancel={() => setPendingDelete(null)}
                        onConfirm={() => {
                            if (record().type === RecordType.annotation)
                                void trashAnnotation(record());
                            else void trashStudent(record());
                        }}
                    />
                )}
            </Show>

            <Show when={pendingSessionTrash()}>
                {(review) => (
                    <ConfirmSessionTrashDialog
                        session={review().session}
                        counts={review().plan.counts}
                        busy={busy()}
                        onCancel={() => setPendingSessionTrash(null)}
                        onConfirm={() => void confirmSessionTrash()}
                    />
                )}
            </Show>

            <Show when={paletteOpen()}>
                <div
                    class="palette-backdrop animate-[fade-in_0.14s_ease-out] backdrop-blur-none bg-black/45 grid inset-0 p-5.5 place-items-center fixed z-20"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) closePalette();
                    }}
                >
                    <ManagedDialog
                        class="command-palette self-start animate-[modal-in_0.14s_ease-out] bg-surface rounded-[5px] border border-line shadow-none mt-[min(16vh,_135px)] overflow-hidden w-full max-w-[520px]"
                        role="dialog"
                        labelledBy="palette-title"
                        onKeyDown={handlePaletteKeys}
                        onEscape={() => closePalette()}
                        restoreFocus={() => false}
                    >
                        <div class="palette-search items-center border-b border-b-line-soft text-muted flex gap-2.5 h-13.5 py-0 px-4">
                            <Icon name="search" />
                            <input
                                placeholder="What would you like to do?"
                                aria-label="Find a quick action"
                                data-dialog-initial-focus
                                value={paletteQuery()}
                                onInput={(event) => {
                                    setPaletteQuery(event.currentTarget.value);
                                    setPaletteIndex(0);
                                }}
                                class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 placeholder:text-faint bg-transparent border-0 text-ink flex-1 text-xs min-w-0"
                            />
                            <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                esc
                            </kbd>
                        </div>
                        <h2 id="palette-title" class="">
                            Quick actions
                        </h2>
                        <div class="palette-actions grid pt-0 px-1.5 pb-2">
                            <For each={matchingActions()}>
                                {(action, index) => (
                                    <button
                                        type="button"
                                        class={cn(
                                            "palette-action",
                                            "text-inherit font-sans focus-visible:outline-offset-[-2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent items-center bg-transparent rounded-[5px] border-0 cursor-pointer flex gap-2.5 min-h-12.5 py-1.5 px-2.5 text-left hover:bg-surface-inset data-[active=true]:bg-accent-soft data-[active=true]:text-accent",
                                        )}
                                        data-active={paletteIndex() === index()}
                                        onMouseEnter={() => setPaletteIndex(index())}
                                        onFocus={() => setPaletteIndex(index())}
                                        onClick={() => action.run()}
                                    >
                                        <span class="palette-action-icon [&:nth-child(2)]:grid [&:nth-child(2)]:flex-1 [&:nth-child(2)]:gap-1 [&:nth-child(2)]:min-w-0 bg-surface rounded-[5px] border border-line-soft text-accent grid h-7.5 place-items-center w-7.5">
                                            <Icon name={action.icon} />
                                        </span>
                                        <span class="[&:nth-child(2)]:grid [&:nth-child(2)]:flex-1 [&:nth-child(2)]:gap-1 [&:nth-child(2)]:min-w-0">
                                            <strong class="text-ink-soft text-xs font-semibold">
                                                {action.label}
                                            </strong>
                                            <small class="text-faint text-xs">
                                                {action.detail}
                                            </small>
                                        </span>
                                        <Icon name="arrow" />
                                    </button>
                                )}
                            </For>
                        </div>
                        <Show when={matchingActions().length === 0}>
                            <p class="palette-empty text-muted py-3 px-5">
                                No actions match your search.
                            </p>
                        </Show>
                        <div class="palette-footer border-t border-t-line-soft text-faint flex text-xs justify-between py-2.5 px-4 max-sm:text-xs">
                            <span class="last:items-center last:flex last:gap-1.5">
                                <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                    ↑
                                </kbd>{" "}
                                <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                    ↓
                                </kbd>{" "}
                                move{" "}
                                <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                    Tab
                                </kbd>{" "}
                                cycle focus
                            </span>
                            <span class="last:items-center last:flex last:gap-1.5">
                                <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                    ↵
                                </kbd>{" "}
                                select{" "}
                                <kbd class="bg-surface rounded-[5px] border border-line text-faint py-0.5 px-1.5">
                                    Esc
                                </kbd>{" "}
                                close
                            </span>
                        </div>
                    </ManagedDialog>
                </div>
            </Show>
            <Show when={commandConsoleOpen()}>
                <CommandConsole
                    archive={
                        workspace()
                            ? {
                                  source: workspace()!.snapshot.source,
                                  name: workspace()!.name,
                                  location: workspace()!.location,
                                  dirty: workspace()!.dirty,
                                  locked: workspace()!.snapshot.locked,
                              }
                            : null
                    }
                    onArchiveChanged={refreshArchiveAfterCommand}
                    onClose={() => setCommandConsoleOpen(false)}
                />
            </Show>
            <Show when={guidePrintContent()} keyed>
                {(content) => (
                    <div
                        class="guide-print-preview hidden print:block print:bg-white print:text-[#18211b] print:[&_.brand]:text-[#315b4a] print:[&_.brand]:text-xs print:[&_.brand]:font-bold print:[&_.brand]:tracking-[0.08em] print:[&_.brand]:mt-0 print:[&_.brand]:mx-0 print:[&_.brand]:mb-4 print:[&_.brand]:normal-case print:[&_.document-footer]:border-t print:[&_.document-footer]:border-t-[#dfe6df] print:[&_.document-footer]:text-[#637267] print:[&_.document-footer]:text-[8pt] print:[&_.document-footer]:mt-7.5 print:[&_.document-footer]:pt-3 print:[&_.document-header]:border-b print:[&_.document-header]:border-b-[#dfe6df] print:[&_.document-header]:pb-5.5 print:[&_.document-meta]:text-[#637267] print:[&_.document-meta]:text-xs print:[&_.document-meta]:mt-2.5 print:[&_.document-meta]:mx-0 print:[&_.document-meta]:mb-0 print:[&_.guide-block-kind]:text-[#637267] print:[&_.guide-block-kind]:text-xs print:[&_.guide-block-kind]:font-bold print:[&_.guide-block-kind]:tracking-[0.07em] print:[&_.guide-block-kind]:mt-0 print:[&_.guide-block-kind]:mx-0 print:[&_.guide-block-kind]:mb-1.5 print:[&_.guide-block-kind]:normal-case print:[&_.guide-block]:break-inside-avoid print:[&_.guide-block]:mt-0 print:[&_.guide-block]:mx-0 print:[&_.guide-block]:mb-4 print:[&_.guide-figure]:break-inside-avoid print:[&_.guide-figure]:my-3.5 print:[&_.guide-figure]:mx-0 print:[&_.guide-figure]:text-center print:[&_.guide-figure_figcaption]:text-[#637267] print:[&_.guide-figure_figcaption]:text-[9pt] print:[&_.guide-figure_figcaption]:mt-1.5 print:[&_.guide-section]:mt-6 print:[&_.guide-sources]:text-[#637267] print:[&_.guide-sources]:text-[8.5pt] print:[&_.guide-sources]:mt-2 print:[&_.guide-sources]:mx-0 print:[&_.guide-sources]:mb-0 print:[&_.guide-sources]:break-words print:[&_.guide-stale]:bg-[#fbf4e9] print:[&_.guide-stale]:border-l-[3px] print:[&_.guide-stale]:border-l-[#9b6e2f] print:[&_.guide-stale]:text-[#704d20] print:[&_.guide-stale]:text-[9pt] print:[&_.guide-stale]:mt-0 print:[&_.guide-stale]:mx-0 print:[&_.guide-stale]:mb-2 print:[&_.guide-stale]:py-2 print:[&_.guide-stale]:px-2.5 print:[&_.guide-table]:text-[10pt] print:[&_.guide-table]:my-2.5 print:[&_.guide-table]:mx-0 print:[&_.guide-table]:w-full print:[&_.guide-table_td]:border print:[&_.guide-table_td]:border-[#d9e0d8] print:[&_.guide-table_td]:py-2 print:[&_.guide-table_td]:px-2.5 print:[&_.guide-table_td]:text-left print:[&_.guide-table_td]:align-top print:[&_.guide-table_th]:bg-[#edf1eb] print:[&_.guide-table_th]:border print:[&_.guide-table_th]:border-[#d9e0d8] print:[&_.guide-table_th]:text-[#28463c] print:[&_.guide-table_th]:py-2 print:[&_.guide-table_th]:px-2.5 print:[&_.guide-table_th]:text-left print:[&_.guide-table_th]:align-top print:[&_.guide-text]:text-[#35443a] print:[&_.guide-text]:text-[11pt] print:[&_.guide-text]:leading-[1.65] print:[&_.guide-text]:break-words print:[&_.guide-text]:whitespace-pre-wrap print:[&_blockquote]:border-l-[3px] print:[&_blockquote]:border-l-[#9bc8aa] print:[&_blockquote]:text-[#35443a] print:[&_blockquote]:text-[11pt] print:[&_blockquote]:leading-[1.65] print:[&_blockquote]:break-words print:[&_blockquote]:pl-3.5 print:[&_blockquote]:whitespace-pre-wrap print:[html.guide-printing_&]:bg-white! print:[html.guide-printing_&]:text-[#18211b]! print:[html.guide-printing_&]:block! print:[html.guide-printing_&]:font-sans"
                        aria-hidden="true"
                        ref={(element) => element.replaceChildren(content)}
                    />
                )}
            </Show>
        </div>
    );
}

function Welcome(props: {
    loading: boolean;
    onCreate: () => void;
    onOpen: () => void;
}): JSX.Element {
    return (
        <div class="welcome-page items-center grid min-h-[calc(100vh_-_120px)] py-10 px-[clamp(28px,_5vw,_72px)] pt-10.5 pb-5 max-[1120px]:pl-7 max-[1120px]:pr-7 max-sm:py-7 max-sm:px-4.5 max-sm:min-h-auto min-[641px]:max-[650px]:pt-4.5 min-[641px]:max-[650px]:px-3 min-[641px]:max-[650px]:pb-3.5">
            <section
                class="welcome-invitation my-0 mx-auto pb-[6vh] w-full max-w-[570px] max-sm:pb-0"
                aria-labelledby="welcome-title"
            >
                <span class={cn(eyebrow, "eyebrow")}>Archive</span>
                <h1
                    id="welcome-title"
                    class="text-ink text-[30px] font-semibold tracking-[-0.025em] leading-tight mt-1 mx-0 mb-2 text-balance max-sm:text-[25px]"
                >
                    Open or create an archive
                </h1>
                <p class="text-muted text-[15px] leading-relaxed m-0 max-w-[66ch]">
                    {props.loading
                        ? "Loading your teaching workspace…"
                        : "Open an existing archive or create a new one for your teaching work."}
                </p>
                <div class="mt-4 flex flex-wrap gap-2">
                    <button
                        class={buttonPrimary}
                        type="button"
                        disabled={props.loading}
                        onClick={() => props.onCreate()}
                    >
                        <Icon name="plus" />
                        Create archive
                    </button>
                    <button
                        class={buttonOutline}
                        type="button"
                        disabled={props.loading}
                        onClick={() => props.onOpen()}
                    >
                        <Icon name="folder" />
                        Open archive
                    </button>
                </div>
            </section>
        </div>
    );
}

function Overview(props: {
    state: Workspace;
    onNavigate: (view: View) => void;
    onCreate: (kind: Exclude<DialogKind, null>) => void;
    onOpen: () => void;
}): JSX.Element {
    const [filter, setFilter] = createSignal<"week" | "month">("week");
    const now = new Date();
    const greeting =
        now.getHours() < 12
            ? "Good morning"
            : now.getHours() < 18
              ? "Good afternoon"
              : "Good evening";
    const recentSessions = createMemo(() =>
        [...props.state.sessions]
            .sort((a, b) => Number(field(b, "started_at_us")) - Number(field(a, "started_at_us")))
            .slice(0, 4),
    );
    const recentEntries = createMemo(() =>
        [...props.state.entries]
            .sort((a, b) => field(b, "entry_date").localeCompare(field(a, "entry_date")))
            .slice(0, 3),
    );
    const activity = createMemo(() => activityValues(props.state.sessions, filter()));

    return (
        <div class={cn(pageBody, "page-body overview-page")}>
            <section class="overview-heading items-end flex gap-5 justify-between mb-5.5 mt-1 mx-0 max-sm:items-start max-sm:flex-col max-sm:gap-3 max-sm:mb-4">
                <div class="">
                    <span class={cn(eyebrow, "eyebrow")}>{formatFullDate(now)}</span>
                    <h1 class="text-ink text-[28px] font-semibold tracking-[-0.055em] leading-tight mt-1.5 mx-0 mb-1.5 text-balance max-sm:text-[25px] min-[641px]:max-[650px]:text-[23px]">
                        {greeting}, teacher.
                    </h1>
                    <p class="text-muted text-sm leading-loose m-0 max-w-[66ch]">
                        Here’s a clear view of the work you’re doing with your learners.
                    </p>
                </div>
                <div class="heading-action-group flex gap-2 pb-0.5 max-sm:w-full">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        onClick={() => props.onOpen()}
                    >
                        <Icon name="folder" />
                        Switch archive
                    </button>
                    <button
                        class={cn(
                            buttonPrimary,
                            "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        onClick={() => props.onCreate("session")}
                        disabled={!props.state.snapshot.canMutate}
                    >
                        <Icon name="plus" />
                        New session
                    </button>
                </div>
            </section>

            <section
                class="overview-stat-grid grid gap-3 grid-cols-4 mb-3.5 min-[651px]:max-[1120px]:gap-2 max-sm:gap-2 max-[900px]:grid-cols-2"
                aria-label="Workspace summary"
            >
                <StatCard
                    label="Students"
                    value={props.state.students.length}
                    detail={
                        props.state.students.length === 1
                            ? "learner in your care"
                            : "learners in your care"
                    }
                    icon="students"
                    onClick={() => props.onNavigate("students")}
                />
                <StatCard
                    label="Sessions"
                    value={props.state.sessions.length}
                    detail="captured in this archive"
                    icon="sessions"
                    onClick={() => props.onNavigate("sessions")}
                />
                <StatCard
                    label="Journal entries"
                    value={props.state.entries.length}
                    detail="reflections and notes"
                    icon="journal"
                    onClick={() => props.onNavigate("journal")}
                />
                <StatCard
                    label="Study guides"
                    value={props.state.guides.length}
                    detail="ready to support learning"
                    icon="guides"
                    onClick={() => props.onNavigate("guides")}
                />
            </section>

            <div class="overview-content-grid grid gap-3.5 grid-cols-[minmax(0,_1.17fr)_minmax(290px,_0.83fr)] max-sm:grid-cols-[minmax(0,_1fr)]">
                <section
                    class={cn(
                        card,
                        "surface-card activity-card min-h-67.5 pt-4.5 px-5 pb-3.5 max-sm:min-h-0 max-sm:p-3.5",
                    )}
                    aria-labelledby="activity-title"
                >
                    <div class={cn(cardHeading, "card-heading")}>
                        <div class="">
                            <span class={cn(eyebrow, "eyebrow")}>Teaching rhythm</span>
                            <h2
                                id="activity-title"
                                class="text-ink-soft text-sm font-semibold tracking-[-0.025em] mt-1 mx-0 mb-0"
                            >
                                Your sessions
                            </h2>
                        </div>
                        <div
                            class="segmented-control bg-surface-subtle rounded-[5px] border border-line-soft flex gap-0.5 p-1"
                            aria-label="Activity time range"
                        >
                            <button
                                class={cn(
                                    filter() === "week" ? "selected" : "",
                                    "text-faint font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 bg-transparent rounded-[5px] border-0 cursor-pointer text-xs font-semibold min-h-6 py-0 px-2",
                                )}
                                onClick={() => setFilter("week")}
                            >
                                7 days
                            </button>
                            <button
                                class={cn(
                                    filter() === "month" ? "selected" : "",
                                    "text-faint font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 bg-transparent rounded-[5px] border-0 cursor-pointer text-xs font-semibold min-h-6 py-0 px-2",
                                )}
                                onClick={() => setFilter("month")}
                            >
                                4 weeks
                            </button>
                        </div>
                    </div>
                    <div class="activity-summary items-baseline flex gap-2 mt-4">
                        <strong class="text-ink text-[22px] font-medium tracking-tight">
                            {activity().reduce((sum, value) => sum + value.count, 0)}
                        </strong>
                        <span class="text-muted text-xs">sessions recorded in this period</span>
                    </div>
                    <div
                        class={cn(
                            `activity-chart ${filter() === "month" ? "is-month" : ""}`,
                            "grid gap-3 grid-cols-7 h-30 pt-2 relative max-sm:gap-1.5",
                        )}
                        role="img"
                        aria-label={`${activity().reduce((sum, value) => sum + value.count, 0)} sessions over the last ${filter() === "week" ? "seven days" : "four weeks"}`}
                    >
                        <div class="chart-grid flex flex-col inset-[4px_0_19px] justify-between pointer-events-none absolute">
                            <span class="border-t border-dashed border-t-line-soft w-full" />
                            <span class="border-t border-dashed border-t-line-soft w-full" />
                            <span class="border-t border-dashed border-t-line-soft w-full" />
                            <span class="border-t border-dashed border-t-line-soft w-full" />
                        </div>
                        <For each={activity()}>
                            {(item) => (
                                <div class="chart-column items-center flex flex-col gap-2 justify-end min-w-0 relative z-1">
                                    <div class="chart-bar-wrap items-end flex h-22 justify-center w-full">
                                        <div
                                            class="chart-bar items-start bg-accent-soft border-b-0 rounded-[5px] border border-accent/15 text-accent flex justify-center max-h-21.5 min-w-4 transition-[height] duration-200 w-[min(46px,_74%)]"
                                            style={{ height: `${Math.max(4, item.count * 26)}px` }}
                                            title={`${item.count} sessions`}
                                        >
                                            <span class="text-xs font-bold mt-1">
                                                {item.count > 0 ? item.count : ""}
                                            </span>
                                        </div>
                                    </div>
                                    <span class="chart-label text-faint text-xs">{item.label}</span>
                                </div>
                            )}
                        </For>
                    </div>
                    <div class="chart-legend items-center border-t border-t-line-soft text-muted flex text-xs gap-1.5 mt-1 pt-3">
                        <span class="legend-dot bg-accent rounded-[5px] h-2 w-2" />
                        Sessions completed{" "}
                        <span class="chart-note text-faint ml-auto">
                            Your archive stays on this device
                        </span>
                    </div>
                </section>

                <section
                    class={cn(
                        card,
                        "surface-card focus-card min-h-67.5 pt-4.5 px-4.5 pb-3.5 max-sm:min-h-0",
                    )}
                    aria-labelledby="focus-title"
                >
                    <div class={cn(cardHeading, "card-heading")}>
                        <div class="">
                            <span class={cn(eyebrow, "eyebrow")}>Your learners</span>
                            <h2
                                id="focus-title"
                                class="text-ink-soft text-sm font-semibold tracking-[-0.025em] mt-1 mx-0 mb-0"
                            >
                                Students to keep close
                            </h2>
                        </div>
                        <button
                            class="text-action text-accent font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-0 cursor-pointer inline-flex text-xs font-semibold gap-1.5 py-0.5 px-0 hover:text-accent-hover"
                            type="button"
                            onClick={() => props.onNavigate("students")}
                        >
                            View all <Icon name="arrow" />
                        </button>
                    </div>
                    <Show
                        when={props.state.students.length > 0}
                        fallback={
                            <EmptyMini
                                title="Your student list is ready"
                                text="Add a learner to keep their goals and progress together."
                                action="Add a student"
                                onAction={() => props.onCreate("student")}
                            />
                        }
                    >
                        <div class="student-peek-list grid mt-3.5">
                            <For each={props.state.students.slice(0, 4)}>
                                {(student, index) => (
                                    <button
                                        class="student-peek text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-b border-b-line-soft border-0 cursor-pointer flex gap-2.5 min-w-0 py-2.5 px-0.5 text-left"
                                        type="button"
                                        onClick={() => props.onNavigate("students")}
                                    >
                                        <span
                                            class={cn(
                                                `student-avatar avatar-${index() % 5}`,
                                                "bg-[#f0dfd5] rounded-full text-[#765449] grid flex-none text-xs font-bold h-8.5 place-items-center w-8.5 [html[data-theme=dark]_&]:bg-[#49342f] [html[data-theme=dark]_&]:text-[#e7beb0]",
                                                [
                                                    "",
                                                    "bg-[#dce9e8] text-[#435e65] [html[data-theme=dark]_&]:bg-[#294148] [html[data-theme=dark]_&]:text-[#b6d3d6]",
                                                    "bg-[#e9dfeb] text-[#745c76] [html[data-theme=dark]_&]:bg-[#41334a] [html[data-theme=dark]_&]:text-[#d0b8d6]",
                                                    "bg-[#f0e7ce] text-[#80663c] [html[data-theme=dark]_&]:bg-[#443a28] [html[data-theme=dark]_&]:text-[#e1c891]",
                                                    "bg-[#e0e9d8] text-[#596c4f] [html[data-theme=dark]_&]:bg-[#33422e] [html[data-theme=dark]_&]:text-[#c2d4b1]",
                                                ][index() % 5],
                                            )}
                                        >
                                            {initials(field(student, "display_name", "S"))}
                                        </span>
                                        <span class="student-peek-copy grid flex-1 gap-1 min-w-0">
                                            <strong class="text-ink-soft text-xs font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
                                                {field(student, "display_name", "Student")}
                                            </strong>
                                            <small class="text-faint text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                                                {[
                                                    field(student, "grade"),
                                                    field(student, "subjects"),
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ") || "Student profile"}
                                            </small>
                                        </span>
                                        <Icon name="chevron" />
                                    </button>
                                )}
                            </For>
                        </div>
                    </Show>
                </section>

                <section
                    class={cn(
                        card,
                        "surface-card recent-card min-h-67.5 pt-4.5 px-4.5 pb-3.5 max-sm:min-h-0",
                    )}
                    aria-labelledby="recent-title"
                >
                    <div class={cn(cardHeading, "card-heading")}>
                        <div class="">
                            <span class={cn(eyebrow, "eyebrow")}>Keep the thread</span>
                            <h2
                                id="recent-title"
                                class="text-ink-soft text-sm font-semibold tracking-[-0.025em] mt-1 mx-0 mb-0"
                            >
                                Recent sessions
                            </h2>
                        </div>
                        <button
                            class="text-action text-accent font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-0 cursor-pointer inline-flex text-xs font-semibold gap-1.5 py-0.5 px-0 hover:text-accent-hover"
                            type="button"
                            onClick={() => props.onNavigate("sessions")}
                        >
                            All sessions <Icon name="arrow" />
                        </button>
                    </div>
                    <Show
                        when={recentSessions().length > 0}
                        fallback={
                            <EmptyMini
                                title="No sessions yet"
                                text="Capture a conversation, a breakthrough, or a plan for next time."
                                action="Create a session"
                                onAction={() => props.onCreate("session")}
                            />
                        }
                    >
                        <div class="recent-session-list grid mt-3.5">
                            <For each={recentSessions()}>
                                {(session) => (
                                    <SessionRow session={session} students={props.state.students} />
                                )}
                            </For>
                        </div>
                    </Show>
                </section>

                <section
                    class={cn(
                        card,
                        "surface-card journal-peek-card min-h-67.5 pt-4.5 px-4.5 pb-3.5 max-sm:min-h-0",
                    )}
                    aria-labelledby="journal-peek-title"
                >
                    <div class={cn(cardHeading, "card-heading")}>
                        <div class="">
                            <span class={cn(eyebrow, "eyebrow")}>
                                Small observations, big picture
                            </span>
                            <h2
                                id="journal-peek-title"
                                class="text-ink-soft text-sm font-semibold tracking-[-0.025em] mt-1 mx-0 mb-0"
                            >
                                Journal
                            </h2>
                        </div>
                        <button
                            class="text-action text-accent font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-0 cursor-pointer inline-flex text-xs font-semibold gap-1.5 py-0.5 px-0 hover:text-accent-hover"
                            type="button"
                            onClick={() => props.onNavigate("journal")}
                        >
                            Open journal <Icon name="arrow" />
                        </button>
                    </div>
                    <Show
                        when={recentEntries().length > 0}
                        fallback={
                            <EmptyMini
                                title="Make space for a reflection"
                                text="A few lines after a lesson can reveal what’s working."
                                action="Write an entry"
                                onAction={() => props.onCreate("journal")}
                            />
                        }
                    >
                        <div class="journal-peek-list grid mt-3.5">
                            <For each={recentEntries()}>
                                {(entry) => (
                                    <button
                                        class="journal-peek text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-b border-b-line-soft border-0 cursor-pointer flex gap-2.5 min-w-0 py-2.5 px-0.5 text-left"
                                        type="button"
                                        onClick={() => props.onNavigate("journal")}
                                    >
                                        <span class="journal-date [&:nth-child(2)]:grid [&:nth-child(2)]:flex-1 [&:nth-child(2)]:gap-1 [&:nth-child(2)]:min-w-0 content-center bg-surface-subtle rounded-[5px] border border-line-soft text-accent grid flex-none gap-0.5 h-9.5 place-items-center w-8">
                                            <strong class="text-xs font-semibold leading-none text-ink-soft overflow-hidden text-ellipsis whitespace-nowrap">
                                                {dateParts(field(entry, "entry_date")).day}
                                            </strong>
                                            <small class="text-faint text-xs font-bold tracking-[0.08em] overflow-hidden text-ellipsis whitespace-nowrap">
                                                {dateParts(field(entry, "entry_date")).month}
                                            </small>
                                        </span>
                                        <span class="[&:nth-child(2)]:grid [&:nth-child(2)]:flex-1 [&:nth-child(2)]:gap-1 [&:nth-child(2)]:min-w-0">
                                            <strong class="text-ink-soft text-xs font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
                                                {field(entry, "title", "Untitled entry")}
                                            </strong>
                                            <small class="text-faint text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                                                {field(entry, "entry_date")}
                                            </small>
                                        </span>
                                        <Icon name="chevron" />
                                    </button>
                                )}
                            </For>
                        </div>
                    </Show>
                </section>
            </div>
            <div class="overview-footnote items-center text-faint flex text-xs justify-between mt-3.5">
                <span class="items-center inline-flex gap-1.5">
                    <Icon name="shield" />
                    Your archive is stored locally
                </span>
                <button
                    type="button"
                    onClick={() => props.onNavigate("archive")}
                    class="text-muted font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 hover:text-accent items-center bg-transparent border-0 cursor-pointer inline-flex text-xs gap-1.5 p-0"
                >
                    Archive details <Icon name="arrow" />
                </button>
            </div>
        </div>
    );
}

function UnlockArchivePanel(props: {
    onUnlock: (passphrase: string) => Promise<void>;
    busy: boolean;
}): JSX.Element {
    const [passphrase, setPassphrase] = createSignal("");
    const [error, setError] = createSignal("");
    const submit = async (event: SubmitEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        try {
            await props.onUnlock(passphrase());
            setPassphrase("");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };

    return (
        <form
            class="locked-unlock-form items-end grid flex-[1_1_340px] gap-2 grid-cols-[minmax(190px,_1fr)_auto] max-w-125 max-sm:grid-cols-[1fr]"
            onSubmit={submit}
        >
            <label class={cn(labelBase, "form-field")} for="archive-passphrase">
                Archive passphrase
                <input
                    id="archive-passphrase"
                    type="password"
                    value={passphrase()}
                    onInput={(event) => setPassphrase(event.currentTarget.value)}
                    autocomplete="current-password"
                    autocapitalize="none"
                    spellcheck={false}
                    aria-invalid={Boolean(error())}
                    aria-describedby="archive-unlock-error"
                    required
                    class={inputBase}
                />
            </label>
            <button
                class={cn(
                    buttonPrimary,
                    "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                )}
                type="submit"
                disabled={props.busy || !passphrase()}
            >
                {props.busy ? "Unlocking…" : "Unlock archive"}
            </button>
            <Show when={error()}>
                <p
                    id="archive-unlock-error"
                    class="locked-unlock-error text-danger col-span-full m-0"
                    role="alert"
                >
                    {error()}
                </p>
            </Show>
        </form>
    );
}

function ArchivePage(props: {
    state: Workspace;
    busy: boolean;
    onApplyMaintenance: (
        original: ArchiveSnapshot,
        replacement: ArchiveSnapshot,
    ) => Promise<boolean>;
    onSave: () => void;
    onOpen: () => void;
    onLock: () => void;
}): JSX.Element {
    const [verification, setVerification] = createSignal<ArchiveVerificationResult | null>(null);
    const [verificationError, setVerificationError] = createSignal("");
    const [historyVerification, setHistoryVerification] = createSignal<{
        historicalRevisions: number;
        verifiedCommits: number;
        verifiedGenerationRecords: number;
    } | null>(null);
    const [verifying, setVerifying] = createSignal(false);
    const [trackedGeneration, setTrackedGeneration] = createSignal("");
    createEffect(() => {
        const generation = props.state.snapshot.commit.generation.toString();
        if (trackedGeneration() === generation) return;
        setTrackedGeneration(generation);
        setVerification(null);
        setHistoryVerification(null);
        setVerificationError("");
    });
    const verify = async (history = false): Promise<void> => {
        const snapshot = props.state.snapshot;
        setVerifying(true);
        setVerificationError("");
        try {
            if (history) {
                const result = await verifyArchiveHistory(snapshot);
                setHistoryVerification(result);
                setVerification(result);
            } else {
                setVerification(await verifyArchiveSnapshot(snapshot));
                setHistoryVerification(null);
            }
        } catch (error) {
            setVerificationError(
                error instanceof Error ? error.message : "Archive verification failed.",
            );
        } finally {
            setVerifying(false);
        }
    };
    return (
        <div class={cn(pageBody, "page-body archive-page max-w-275")}>
            <section class="record-heading items-end flex gap-5 justify-between mb-5.5 mt-1.5 mx-0 max-sm:items-start max-sm:flex-col max-sm:gap-3 max-sm:mb-4 rounded-[10px]">
                <div class="">
                    <span class={cn(eyebrow, "eyebrow")}>Your data, in your hands</span>
                    <h1 class="text-ink text-[28px] font-semibold tracking-[-0.055em] leading-tight mt-1.5 mx-0 mb-1.5 text-balance max-sm:text-[25px] min-[641px]:max-[650px]:text-[23px]">
                        Archive health
                    </h1>
                    <p class="text-muted text-xs leading-loose m-0 max-w-155">
                        Review the portable file that holds your tutoring workspace.
                    </p>
                </div>
                <button
                    class={cn(
                        buttonPrimary,
                        "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                    )}
                    type="button"
                    onClick={() => props.onSave()}
                >
                    <Icon name="check" />
                    {props.state.dirty ? "Save changes" : "Save a copy"}
                </button>
            </section>
            <section class="archive-summary-card items-center bg-surface border-b border-b-line rounded-[5px] border border-line flex gap-5.5 min-h-41 overflow-hidden pt-0 px-0 pb-5 p-5.5 relative max-sm:items-start max-sm:flex-wrap max-sm:gap-3 max-sm:min-h-0 max-sm:p-3.5">
                <div class="archive-card-art bg-accent-soft rounded-[5px] border border-accent/15 hidden flex-none h-28 place-items-center relative w-25 max-sm:h-16.5 max-sm:w-15">
                    <img
                        src={brandLogo}
                        alt=""
                        class="rounded-[5px] shadow-none h-13 relative w-13 z-1 max-sm:h-9.5 max-sm:w-9.5"
                    />
                    <span class="archive-card-glow bg-accent/20 rounded-full blur-[17px] h-19 absolute w-19" />
                </div>
                <div class="archive-summary-copy flex-1 min-w-0">
                    <span class={cn(eyebrow, "eyebrow")}>Tutorux portable archive</span>
                    <h2 class="text-ink text-[19px] font-medium tracking-[-0.04em] my-1.5 mx-0 overflow-hidden text-ellipsis whitespace-nowrap max-sm:text-sm">
                        {props.state.manifest.displayName}
                    </h2>
                    <p class="text-muted text-xs m-0 max-sm:text-xs max-sm:leading-normal">
                        {props.state.manifest.description ||
                            "A private workspace for your tutoring practice."}
                    </p>
                    <div class="archive-chip-row flex flex-wrap gap-1.5 mt-3.5 max-sm:gap-1">
                        <span class="items-center bg-surface rounded-[5px] border border-line-soft text-muted inline-flex text-xs gap-1.5 py-1 px-2 max-sm:text-xs">
                            <i class="dot-green bg-[#549368] rounded-full h-1.5 w-1.5" />
                            {props.state.snapshot.locked
                                ? "Encrypted · locked"
                                : props.state.snapshot.encrypted
                                  ? "Encrypted · unlocked"
                                  : "Ready to use"}
                        </span>
                        <span class="items-center bg-surface rounded-[5px] border border-line-soft text-muted inline-flex text-xs gap-1.5 py-1 px-2 max-sm:text-xs">
                            <Icon name="archive" />
                            Format v{props.state.snapshot.header.majorVersion}.
                            {props.state.snapshot.header.minorVersion}
                        </span>
                        <span class="items-center bg-surface rounded-[5px] border border-line-soft text-muted inline-flex text-xs gap-1.5 py-1 px-2 max-sm:text-xs">
                            <Icon name="clock" />
                            Generation {props.state.snapshot.commit.generation.toString()}
                        </span>
                    </div>
                </div>
                <div class="archive-size border-l border-l-line grid flex-none gap-1 pl-5 w-40 max-sm:items-center max-sm:border-l-0 max-sm:border-t max-sm:border-t-line-soft max-sm:flex max-sm:basis-full max-sm:gap-2 max-sm:ml-18 max-sm:pt-2 max-sm:px-0 max-sm:pb-0 max-sm:w-auto">
                    <span class="text-faint text-xs font-bold tracking-[0.1em] max-sm:hidden">
                        File size
                    </span>
                    <strong class="text-ink-soft text-[15px] font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                        {formatBytes(props.state.snapshot.source.size)}
                    </strong>
                    <small class="text-faint text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                        {props.state.location ?? "Browser copy"}
                    </small>
                </div>
            </section>
            <Show when={props.state.snapshot.encrypted && !props.state.snapshot.locked}>
                <div class="archive-lock-action items-center bg-surface-subtle rounded-[5px] border border-line text-muted flex text-xs gap-3 justify-between mt-2.5 mx-7.5 mb-0 py-2.5 px-3 max-sm:items-start max-sm:flex-col max-sm:ml-3 max-sm:mr-3">
                    <span class="">Archive contents are unlocked for this session.</span>
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        onClick={() => props.onLock()}
                    >
                        <Icon name="shield" />
                        Lock archive
                    </button>
                </div>
            </Show>
            <div class="archive-info-grid border-t border-t-line-soft grid gap-2.5 grid-cols-4 my-3.5 mx-0 max-sm:grid-cols-2">
                <InfoCard
                    label="Created"
                    value={formatMicroseconds(props.state.snapshot.header.createdAtUs)}
                    icon="clock"
                />
                <InfoCard
                    label="Last committed"
                    value={`Generation ${props.state.snapshot.commit.generation.toString()}`}
                    icon="check"
                />
                <InfoCard
                    label="Records indexed"
                    value={props.state.snapshot.indexEntryCount().toLocaleString("en-US")}
                    icon="archive"
                />
                <InfoCard
                    label="Archive ID"
                    value={props.state.snapshot.header.id}
                    icon="shield"
                    mono
                />
            </div>
            <section
                class={cn(
                    card,
                    "surface-card archive-integrity items-center rounded-[5px] shadow-none flex gap-3 py-3.5 px-4 max-sm:items-start max-sm:flex-wrap",
                )}
            >
                <div class="integrity-icon [&:nth-child(2)]:flex-1 [&:nth-child(2)]:min-w-0 bg-accent-soft rounded-[5px] text-accent grid flex-none h-8 place-items-center w-8">
                    <Icon name="shield" />
                </div>
                <div class="archive-integrity-copy [&:nth-child(2)]:flex-1 [&:nth-child(2)]:min-w-0">
                    <h2 class="text-ink-soft text-xs font-semibold m-0">
                        {verification()
                            ? "Every current record passed verification"
                            : props.state.snapshot.locked
                              ? "Unlock to verify archive records"
                              : "Verify every current record"}
                    </h2>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        {verification()
                            ? `${verification()!.currentRecords.toLocaleString("en-US")} records checked, including ${verification()!.deletedRecords.toLocaleString("en-US")} in Trash.`
                            : "Read every indexed record and check its index reference, including records in Trash."}
                    </p>
                    <Show when={verificationError()}>
                        <p
                            class="archive-integrity-error text-danger text-xs mt-1 mx-0 mb-0"
                            role="alert"
                        >
                            {verificationError()}
                        </p>
                    </Show>
                    <Show when={historyVerification()}>
                        {(result) => (
                            <p class="text-muted text-xs mt-1 mx-0 mb-0">
                                {result().historicalRevisions.toLocaleString("en-US")} historical
                                revisions and{" "}
                                {result().verifiedGenerationRecords.toLocaleString("en-US")} indexed
                                records across {result().verifiedCommits.toLocaleString("en-US")}{" "}
                                committed generations checked. Records present in multiple
                                generations are counted once per generation.
                            </p>
                        )}
                    </Show>
                </div>
                <div class="archive-integrity-actions [&:nth-child(2)]:flex-1 [&:nth-child(2)]:min-w-0 items-center flex gap-3 ml-auto max-sm:flex-wrap max-sm:justify-between max-sm:ml-11 max-sm:w-[calc(100%_-_43px)]">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.state.snapshot.locked || verifying()}
                        onClick={() => void verify()}
                    >
                        {verifying() ? "Checking records…" : "Verify archive"}
                    </button>
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.state.snapshot.locked || verifying()}
                        onClick={() => void verify(true)}
                    >
                        Verify history
                    </button>
                    <span
                        class="integrity-status items-center text-accent inline-flex text-xs font-semibold gap-1.5 whitespace-nowrap max-sm:ml-0"
                        role="status"
                    >
                        <i class="bg-current rounded-full h-1.5 w-1.5" />
                        {verification()
                            ? `Generation ${verification()!.generation} verified`
                            : "Header and index checked on open"}
                    </span>
                </div>
            </section>
            <ArchiveMaintenance
                snapshot={props.state.snapshot}
                disabled={props.busy}
                onApply={props.onApplyMaintenance}
            />
            <SanitizedCopy snapshot={props.state.snapshot} disabled={props.busy} />
            <section class="archive-actions-card items-center bg-surface rounded-[5px] border border-line shadow-none flex gap-5 justify-between mt-3.5 py-4 px-4 max-sm:items-start max-sm:flex-col">
                <div class="last:flex last:gap-2 max-sm:last:w-full">
                    <span class={cn(eyebrow, "eyebrow")}>Portable by design</span>
                    <h2 class="text-ink-soft text-xs font-semibold my-1 mx-0">Keep a safe copy</h2>
                    <p class="text-muted text-xs leading-loose m-0 max-w-120">
                        Your archive is a single file. Save a copy somewhere you trust, then open it
                        on another supported device when you need it.
                    </p>
                </div>
                <div class="last:flex last:gap-2 max-sm:last:w-full">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        onClick={() => props.onOpen()}
                    >
                        <Icon name="folder" />
                        Open another archive
                    </button>
                    <button
                        class={cn(
                            buttonPrimary,
                            "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        onClick={() => props.onSave()}
                    >
                        <Icon name="arrow" />
                        {props.state.location ? "Save archive" : "Download .tux file"}
                    </button>
                </div>
            </section>
        </div>
    );
}

function SettingsPage(props: {
    theme: "light" | "dark";
    themeMode: ThemeMode;
    onThemeMode: (mode: ThemeMode) => void;
    state: Workspace;
    busy: boolean;
    onChangePassphrase: () => void;
    onEnableEncryption: (passphrase: string) => Promise<void>;
    onSaveArchive: () => void;
    onSaveMarkerKeys: (keys: string[]) => Promise<boolean>;
    onSaveSettings: (records: ArchiveRecord[], message: string) => Promise<boolean>;
    onRenameArchive: (displayName: string) => Promise<boolean>;
}): JSX.Element {
    const [keys, setKeys] = createSignal(untrack(() => markerKeys(props.state)));
    const [keysDirty, setKeysDirty] = createSignal(false);
    createEffect(() => {
        const next = markerKeys(props.state);
        if (!keysDirty()) setKeys(next);
    });
    return (
        <div class={cn(pageBody, "page-body settings-page max-w-275")}>
            <section class="record-heading items-end flex gap-5 justify-between mb-5.5 mt-1.5 mx-0 max-sm:items-start max-sm:flex-col max-sm:gap-3 max-sm:mb-4 rounded-[10px]">
                <div class="">
                    <span class={cn(eyebrow, "eyebrow")}>Make the space yours</span>
                    <h1 class="text-ink text-[28px] font-semibold tracking-[-0.055em] leading-tight mt-1.5 mx-0 mb-1.5 text-balance max-sm:text-[25px] min-[641px]:max-[650px]:text-[23px]">
                        Preferences
                    </h1>
                    <p class="text-muted text-xs leading-loose m-0 max-w-155">
                        A few small choices for a workspace that feels right to use.
                    </p>
                </div>
            </section>
            <section
                class="settings-section bg-surface rounded-[5px] border border-line shadow-none my-3 mx-0 overflow-hidden"
                aria-labelledby="keyboard-shortcuts-title"
            >
                <div class="settings-section-heading border-b border-b-line-soft pt-3.5 px-4 pb-2.5">
                    <h2
                        id="keyboard-shortcuts-title"
                        class="text-ink-soft text-xs font-semibold m-0"
                    >
                        Keyboard shortcuts
                    </h2>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        Core commands work throughout Tutorux; observation and note-editing
                        shortcuts are available in their matching workspace pages.
                    </p>
                </div>
                <dl class="shortcut-matrix m-0">
                    <For
                        each={keyboardShortcutRows(
                            navigator.platform.includes("Mac"),
                            platform.kind === "desktop",
                            keys(),
                        )}
                    >
                        {(shortcut) => (
                            <div class="shortcut-matrix-row items-center border-b-line-soft border-b flex gap-3.5 justify-between min-h-9.5 py-2 px-4">
                                <dt class="text-ink-soft text-sm min-w-0">{shortcut.action}</dt>
                                <dd class="text-muted text-[13px] tabular-nums m-0 max-w-[62%] break-words text-right">
                                    {shortcut.keys}
                                </dd>
                            </div>
                        )}
                    </For>
                </dl>
            </section>
            <section class="settings-section bg-surface rounded-[5px] border border-line shadow-none my-3 mx-0 overflow-hidden">
                <div class="settings-section-heading border-b border-b-line-soft pt-3.5 px-4 pb-2.5">
                    <h2 class="text-ink-soft text-xs font-semibold m-0">Appearance</h2>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        Choose the colors you’d like Tutorux to use.
                    </p>
                </div>
                <div class="preference-row items-center border-b-line-soft border-b flex gap-2.5 min-h-15.5 py-2.5 px-4">
                    <div class="preference-icon bg-[#f4f0e7] rounded-[5px] text-[#a27e3f] grid flex-none h-7 place-items-center w-7">
                        <Icon name={props.theme === "light" ? "sun" : "moon"} />
                    </div>
                    <div class="preference-copy grid flex-1 gap-1 min-w-0">
                        <strong class="text-ink-soft text-sm font-semibold">Color theme</strong>
                        <span class="text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {props.themeMode === "system"
                                ? `System appearance · ${props.theme}`
                                : `${props.themeMode} appearance`}
                        </span>
                    </div>
                    <label class="theme-mode-control">
                        <span class="visually-hidden sr-only h-0.5 overflow-hidden absolute whitespace-nowrap w-0.5">
                            Color theme
                        </span>
                        <select
                            aria-label="Color theme"
                            value={props.themeMode}
                            onChange={(event) =>
                                props.onThemeMode(event.currentTarget.value as ThemeMode)
                            }
                            class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 bg-surface rounded-[5px] border border-line text-ink-soft cursor-pointer text-xs h-8 min-w-24 py-0 px-2.5"
                        >
                            <option value="system">System</option>
                            <option value="light">Light</option>
                            <option value="dark">Dark</option>
                        </select>
                    </label>
                </div>
            </section>
            <section class="settings-section bg-surface rounded-[5px] border border-line shadow-none my-3 mx-0 overflow-hidden">
                <div class="settings-section-heading border-b border-b-line-soft pt-3.5 px-4 pb-2.5">
                    <h2 class="text-ink-soft text-xs font-semibold m-0">Observation shortcuts</h2>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        On the Observations page, use Ctrl on Windows and Linux or Command on macOS
                        with a key to start an observation. These keys travel with your archive. K,
                        O, S, and N are reserved for workspace actions.
                    </p>
                </div>
                <div class="marker-shortcuts grid gap-3.5 grid-cols-[repeat(auto-fit,_minmax(130px,_1fr))] py-5 px-0">
                    <For each={markerTypes}>
                        {(type, index) => (
                            <label class={cn(labelBase, "form-field")}>
                                {annotationTypeLabel(type)}
                                <input
                                    value={keys()[index()] ?? ""}
                                    maxlength="1"
                                    disabled={
                                        props.busy ||
                                        props.state.snapshot.locked ||
                                        !props.state.snapshot.canMutate
                                    }
                                    onInput={(event) => {
                                        setKeysDirty(true);
                                        setKeys((current) =>
                                            current.map((key, i) =>
                                                i === index() ? event.currentTarget.value : key,
                                            ),
                                        );
                                    }}
                                    class={inputBase}
                                />
                            </label>
                        )}
                    </For>
                </div>
                <div class="marker-shortcut-actions flex flex-wrap gap-2.5 justify-end">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={
                            props.busy ||
                            props.state.snapshot.locked ||
                            !props.state.snapshot.canMutate
                        }
                        onClick={() => {
                            setKeysDirty(true);
                            setKeys([...defaultMarkerKeys]);
                        }}
                    >
                        Restore defaults
                    </button>
                    <button
                        class={cn(
                            buttonPrimary,
                            "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={
                            props.busy ||
                            props.state.snapshot.locked ||
                            !props.state.snapshot.canMutate
                        }
                        onClick={() =>
                            void props.onSaveMarkerKeys(keys()).then((saved) => {
                                if (saved) setKeysDirty(false);
                            })
                        }
                    >
                        Save shortcuts
                    </button>
                </div>
            </section>
            <section class="settings-section bg-surface rounded-[5px] border border-line shadow-none my-3 mx-0 overflow-hidden">
                <div class="settings-section-heading border-b border-b-line-soft pt-3.5 px-4 pb-2.5">
                    <h2 class="text-ink-soft text-xs font-semibold m-0">Privacy & storage</h2>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        Tutorux keeps your work inside a portable archive you control.
                    </p>
                </div>
                <div class="preference-row items-center border-b-line-soft border-b flex gap-2.5 min-h-15.5 py-2.5 px-4">
                    <div class="preference-icon secure bg-accent-soft rounded-[5px] text-accent grid flex-none h-7 place-items-center w-7">
                        <Icon name="shield" />
                    </div>
                    <div class="preference-copy grid flex-1 gap-1 min-w-0">
                        <strong class="text-ink-soft text-sm font-semibold">
                            Local-first workspace
                        </strong>
                        <span class="text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {platform.kind === "desktop"
                                ? "Files are read and written directly on this device."
                                : "The application does not upload archive files."}
                        </span>
                    </div>
                    <span class="preference-value text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                        On this device
                    </span>
                </div>
                <Show when={props.state.snapshot.encrypted}>
                    <div class="preference-row items-center border-b-line-soft border-b flex gap-2.5 min-h-15.5 py-2.5 px-4">
                        <div class="preference-icon secure bg-accent-soft rounded-[5px] text-accent grid flex-none h-7 place-items-center w-7">
                            <Icon name="shield" />
                        </div>
                        <div class="preference-copy grid flex-1 gap-1 min-w-0">
                            <strong class="text-ink-soft text-sm font-semibold">
                                Passphrase protection
                            </strong>
                            <span class="text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                                {props.state.snapshot.locked
                                    ? "Unlock this archive to change its passphrase."
                                    : "Your records are encrypted in this archive."}
                            </span>
                        </div>
                        <button
                            class={cn(
                                buttonOutline,
                                "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                            )}
                            type="button"
                            onClick={() => props.onChangePassphrase()}
                            disabled={props.busy || props.state.snapshot.locked}
                        >
                            Change passphrase
                        </button>
                    </div>
                </Show>
                <div class="preference-row items-center border-b-line-soft border-b flex gap-2.5 min-h-15.5 py-2.5 px-4">
                    <div class="preference-icon bg-[#f4f0e7] rounded-[5px] text-[#a27e3f] grid flex-none h-7 place-items-center w-7">
                        <Icon name="archive" />
                    </div>
                    <div class="preference-copy grid flex-1 gap-1 min-w-0">
                        <strong class="text-ink-soft text-sm font-semibold">Current archive</strong>
                        <span class="text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                            {props.state.name}
                        </span>
                    </div>
                    <span class="preference-value text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {formatBytes(props.state.snapshot.source.size)}
                    </span>
                </div>
                <Show when={props.state.dirty}>
                    <div class="preference-row items-center border-b-line-soft border-b flex gap-2.5 min-h-15.5 py-2.5 px-4">
                        <div class="preference-icon bg-[#f4f0e7] rounded-[5px] text-[#a27e3f] grid flex-none h-7 place-items-center w-7">
                            <Icon name="archive" />
                        </div>
                        <div class="preference-copy grid flex-1 gap-1 min-w-0">
                            <strong class="text-ink-soft text-sm font-semibold">
                                Changes waiting to be saved
                            </strong>
                            <span class="text-muted text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">
                                The passphrase on disk updates when you save this workspace.
                            </span>
                        </div>
                        <button
                            class={cn(
                                buttonOutline,
                                "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                            )}
                            type="button"
                            onClick={() => props.onSaveArchive()}
                            disabled={props.busy}
                        >
                            Save workspace
                        </button>
                    </div>
                </Show>
            </section>
            <ArchiveSettings
                displayName={props.state.manifest.displayName}
                encrypted={props.state.snapshot.encrypted}
                records={props.state.settings}
                disabled={
                    props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate
                }
                onSave={props.onSaveSettings}
                onRename={props.onRenameArchive}
                onEnableEncryption={props.onEnableEncryption}
            />
            <ArchiveSettingsCopy
                archiveId={props.state.snapshot.header.id}
                archiveGeneration={props.state.snapshot.commit.generation.toString()}
                settings={props.state.settings}
                disabled={
                    props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate
                }
                onSave={props.onSaveSettings}
            />
            <DiagnosticsReport snapshot={props.state.snapshot} disabled={props.busy} />
            <section class="settings-note items-start bg-accent-soft rounded-[5px] border border-accent/15 flex gap-2.5 mt-3.5 py-3.5 px-4">
                <Icon name="book" />
                <div class="">
                    <strong class="text-ink-soft text-xs font-semibold">
                        Built for people who teach
                    </strong>
                    <p class="text-muted text-xs mt-1 mx-0 mb-0">
                        Tutorux helps you notice the details and make room for the work that
                        matters.
                    </p>
                </div>
            </section>
        </div>
    );
}

function ConfirmSessionTrashDialog(props: {
    session: ArchiveRecord;
    counts: SessionTrashCounts;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): JSX.Element {
    const details = () => [
        { label: "Session record", value: 1 },
        { label: "Recording chunks", value: props.counts.audioChunks },
        { label: "Waveform indexes", value: props.counts.waveformIndices },
        { label: "Transcript cues", value: props.counts.transcriptSegments },
        { label: "Observations", value: props.counts.annotations },
        { label: "Materials", value: props.counts.assets },
        { label: "Study guides", value: props.counts.guides },
        { label: "Evidence records", value: props.counts.evidenceNodes },
        { label: "Evidence links", value: props.counts.evidenceEdges },
        { label: "Session notes", value: props.counts.sessionNotes },
        { label: "Journal entries detached", value: props.counts.entriesUpdated },
    ];
    return (
        <div
            class={cn(dialogBackdrop, "dialog-backdrop")}
            onClick={(event) => {
                if (event.target === event.currentTarget && !props.busy) props.onCancel();
            }}
        >
            <ManagedDialog
                class={cn(
                    dialogPanel,
                    "form-dialog confirm-dialog session-trash-dialog w-full max-w-[520px] max-h-[calc(100vh_-_32px)] overflow-y-auto",
                )}
                role="alertdialog"
                labelledBy="session-trash-title"
                describedBy="session-trash-description session-trash-side-effects"
                onEscape={() => props.onCancel()}
                canEscape={() => !props.busy}
            >
                <span class="dialog-icon bg-accent-soft rounded-[5px] border border-accent/15 text-accent grid h-9.5 mb-4 place-items-center w-9.5">
                    <Icon name="trash" />
                </span>
                <span class={cn(eyebrow, "eyebrow")}>Review session group</span>
                <h2 id="session-trash-title" class="">
                    Move this session to Trash?
                </h2>
                <p
                    id="session-trash-description"
                    class={cn(dialogDescription, "dialog-description")}
                >
                    <strong class="">{field(props.session, "title", "Untitled session")}</strong>{" "}
                    and its linked transcripts, observations, recordings, materials, guides, and
                    evidence will move together. Journal entries stay in place and reconnect when
                    you restore the group.
                </p>
                <div class="session-trash-total items-baseline bg-[var(--danger-soft)] rounded-[5px] border border-danger text-danger flex gap-2 mt-4 py-3 px-3.5">
                    <strong class="text-[22px] font-[650] leading-none">
                        {props.counts.totalRecords}
                    </strong>
                    <span class="text-ink-soft text-xs">records affected</span>
                </div>
                <dl class="session-trash-scope bg-line-soft rounded-[5px] border border-line-soft grid gap-0.5 grid-cols-2 mt-2.5 mx-0 mb-0 overflow-hidden">
                    <For each={details()}>
                        {(detail) => (
                            <div class="bg-surface flex gap-2 justify-between py-2.5 px-3">
                                <dt class="text-muted text-xs">{detail.label}</dt>
                                <dd class="text-ink-soft text-xs tabular-nums font-[650] m-0">
                                    {detail.value}
                                </dd>
                            </div>
                        )}
                    </For>
                </dl>
                <p
                    id="session-trash-side-effects"
                    class="session-trash-note text-muted text-xs leading-relaxed mt-3 mx-0 mb-0"
                >
                    Journal entries will be detached from this session and reconnected when the
                    group is restored. Existing cross-session source links must be resolved first.
                </p>
                <div class="dialog-actions border-t border-t-line-soft flex gap-2 justify-end mt-1.5 pt-3">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onCancel()}
                    >
                        Keep session
                    </button>
                    <button
                        class={cn(
                            buttonDanger,
                            "button button-danger text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onConfirm()}
                    >
                        {props.busy ? "Moving…" : "Move session group to Trash"}
                    </button>
                </div>
            </ManagedDialog>
        </div>
    );
}

function ConfirmDeleteDialog(props: {
    kind: "student" | "observation";
    name: string;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): JSX.Element {
    return (
        <div
            class={cn(dialogBackdrop, "dialog-backdrop")}
            onClick={(event) => {
                if (event.target === event.currentTarget && !props.busy) props.onCancel();
            }}
        >
            <ManagedDialog
                class={cn(dialogPanel, "form-dialog confirm-dialog w-full max-w-[430px]")}
                role="alertdialog"
                labelledBy="trash-dialog-title"
                describedBy="trash-dialog-description"
                onEscape={() => props.onCancel()}
                canEscape={() => !props.busy}
            >
                <span class="dialog-icon bg-accent-soft rounded-[5px] border border-accent/15 text-accent grid h-9.5 mb-4 place-items-center w-9.5">
                    <Icon name="trash" />
                </span>
                <span class={cn(eyebrow, "eyebrow")}>Recoverable action</span>
                <h2 id="trash-dialog-title" class="">
                    Move {props.kind === "student" ? "student" : "observation"} to Trash?
                </h2>
                <p
                    id="trash-dialog-description"
                    class={cn(dialogDescription, "dialog-description")}
                >
                    <strong class="">{props.name}</strong> will leave the active workspace. You can
                    restore this
                    {props.kind === "student" ? " profile" : " observation"} from Trash later.
                </p>
                <div class="dialog-actions border-t border-t-line-soft flex gap-2 justify-end mt-1.5 pt-3">
                    <button
                        class={cn(
                            buttonOutline,
                            "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onCancel()}
                    >
                        Keep {props.kind === "student" ? "student" : "observation"}
                    </button>
                    <button
                        class={cn(
                            buttonDanger,
                            "button button-danger text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                        )}
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onConfirm()}
                    >
                        {props.busy ? "Moving…" : "Move to Trash"}
                    </button>
                </div>
            </ManagedDialog>
        </div>
    );
}

function FormDialog(props: {
    kind: Exclude<DialogKind, null>;
    state: Workspace | null;
    record: ArchiveRecord | null;
    notesDocument: ArchiveRecord | null;
    busy: boolean;
    onClose: () => void;
    onCreateArchive: (name: string, description: string, passphrase: string) => Promise<void>;
    onChangePassphrase: (currentPassphrase: string, newPassphrase: string) => Promise<void>;
    onEnableNotesAutosave: () => Promise<boolean>;
    onAutosaveNotes: (
        owner: ArchiveRecord,
        version: NotesAutosaveVersion,
        blocks: readonly JournalNoteBlock[],
    ) => Promise<NotesAutosaveResult>;
    onSaveStudent: (input: StudentInput, current: ArchiveRecord | null) => void;
    onSaveSession: (
        input: SessionInput,
        current: ArchiveRecord | null,
        notesDocument: ArchiveRecord | null,
        updateNotes: boolean,
    ) => void;
    onSaveJournal: (
        input: JournalInput,
        current: ArchiveRecord | null,
        notesDocument: ArchiveRecord | null,
        updateNotes: boolean,
    ) => void;
}): JSX.Element {
    let nameInput: HTMLInputElement | undefined;
    let currentPassphraseInput: HTMLInputElement | undefined;
    let passphraseInput: HTMLInputElement | undefined;
    const titles: Record<
        Exclude<DialogKind, null>,
        { eyebrow: string; title: string; description: string; submit: string; icon: IconName }
    > = {
        archive: {
            eyebrow: "A home for your work",
            title: "Create a workspace",
            description:
                "Your workspace lives in one portable .tux file. You can move it or make a backup whenever you like.",
            submit: "Create workspace",
            icon: "archive",
        },
        passphrase: {
            eyebrow: "Keep your work protected",
            title: "Change passphrase",
            description:
                "Tutorux checks your current passphrase and every retained revision, then re-encrypts the archive with a fresh data key.",
            submit: "Change passphrase",
            icon: "shield",
        },
        student: {
            eyebrow: "The person first",
            title: "Add a student",
            description: "Start with the details that help you see and support this learner.",
            submit: "Add student",
            icon: "students",
        },
        session: {
            eyebrow: "Make the moment count",
            title: "New session",
            description: "Capture what you worked on and what you want to carry into next time.",
            submit: "Save session",
            icon: "sessions",
        },
        journal: {
            eyebrow: "Notice, reflect, return",
            title: "New journal entry",
            description: "A short reflection can help you notice how a learner is growing.",
            submit: "Save entry",
            icon: "journal",
        },
    };
    const content = createMemo(() =>
        props.record
            ? {
                  ...titles[props.kind],
                  eyebrow:
                      props.kind === "student"
                          ? "KEEP THE PROFILE CURRENT"
                          : props.kind === "session"
                            ? "REFINE THE SESSION RECORD"
                            : "RETURN TO THIS REFLECTION",
                  title:
                      props.kind === "student"
                          ? "Edit student"
                          : props.kind === "session"
                            ? "Edit session"
                            : "Edit journal entry",
                  submit: "Save changes",
              }
            : titles[props.kind],
    );
    const noteState = untrack(() => {
        const expectedNotesOwner = props.record
            ? props.kind === "session"
                ? {
                      entryId: props.record.fields.get("entry_id") ?? "",
                      sessionId: props.record.id,
                  }
                : props.kind === "journal"
                  ? { entryId: props.record.id, sessionId: "" }
                  : undefined
            : undefined;
        return notesEditState(props.notesDocument, expectedNotesOwner);
    });
    const [noteBlocks, setNoteBlocks] = createSignal<JournalNoteBlock[]>(
        noteState.editable
            ? noteState.blocks.length > 0
                ? noteState.blocks
                : [{ id: crypto.randomUUID(), kind: "paragraph", text: "" }]
            : [],
    );
    const initialOwner = untrack(() => props.record);
    const initialArchiveId = untrack(() => props.state?.snapshot.header.id ?? "");
    const initialDocument = untrack(() => props.notesDocument);
    let autosaveVersion: NotesAutosaveVersion = {
        archiveId: initialArchiveId,
        documentId: initialOwner ? field(initialOwner, "notes_document_id") : "",
        revision: initialDocument?.revision ?? null,
    };
    const [autosaveEnabled, setAutosaveEnabled] = createSignal(false);
    const [autosavePermissionPending, setAutosavePermissionPending] = createSignal(false);
    const [autosaveStatus, setAutosaveStatus] = createSignal("");
    let autosaveTimer: number | undefined;
    let editSequence = 0;
    let savedSequence = -1;
    let autosaveInFlight = false;
    let editorDisposed = false;

    function scheduleNotesAutosave(): void {
        window.clearTimeout(autosaveTimer);
        if (!autosaveEnabled() || !initialOwner || editorDisposed) return;
        setAutosaveStatus("Waiting to save notes…");
        autosaveTimer = window.setTimeout(() => void flushNotesAutosave(), 1800);
    }

    async function flushNotesAutosave(): Promise<boolean> {
        window.clearTimeout(autosaveTimer);
        if (!autosaveEnabled() || !initialOwner || editorDisposed) return true;
        if (autosaveInFlight || props.busy) {
            scheduleNotesAutosave();
            return false;
        }
        const sequence = editSequence;
        const blocks = noteBlocks().map((block) => ({ ...block }));
        autosaveInFlight = true;
        setAutosaveStatus("Saving notes…");
        try {
            const result = await props.onAutosaveNotes(initialOwner, autosaveVersion, blocks);
            autosaveVersion = {
                ...autosaveVersion,
                documentId: result.documentId,
                revision: result.revision,
            };
            savedSequence = sequence;
            if (editorDisposed) return true;
            setAutosaveStatus(
                result.persisted
                    ? "Notes and current workspace changes saved to the archive file."
                    : result.diskError
                      ? `Notes saved in the workspace; save the archive to write them to disk. ${result.diskError}`
                      : "Notes saved in the workspace. Save the archive to write them to disk.",
            );
            return true;
        } catch (error) {
            if (!editorDisposed) {
                setAutosaveEnabled(false);
                setAutosaveStatus(`Autosave paused: ${errorMessage(error)}`);
            }
            return false;
        } finally {
            autosaveInFlight = false;
            if (!editorDisposed && autosaveEnabled() && editSequence !== savedSequence) {
                scheduleNotesAutosave();
            }
        }
    }

    function changeNoteBlocks(blocks: JournalNoteBlock[]): void {
        setNoteBlocks(blocks);
        editSequence += 1;
        scheduleNotesAutosave();
    }

    async function closeForm(): Promise<void> {
        while (autosaveEnabled() && editSequence !== savedSequence) {
            if (!(await flushNotesAutosave())) return;
        }
        props.onClose();
    }

    onCleanup(() => {
        editorDisposed = true;
        window.clearTimeout(autosaveTimer);
    });
    const journalIds = (key: "collection_ids" | "tag_ids"): string[] =>
        props.record ? field(props.record, key).split(",").filter(Boolean) : [];
    const todayDate = new Date();
    const today = [
        todayDate.getFullYear().toString().padStart(4, "0"),
        (todayDate.getMonth() + 1).toString().padStart(2, "0"),
        todayDate.getDate().toString().padStart(2, "0"),
    ].join("-");
    const [journalDate, setJournalDate] = createSignal(
        untrack(() =>
            props.kind === "journal"
                ? props.record
                    ? field(props.record, "entry_date")
                    : today
                : "",
        ),
    );
    const [validationError, setValidationError] = createSignal("");
    const [encryptOnCreate, setEncryptOnCreate] = createSignal(false);

    onMount(() =>
        queueMicrotask(() => (currentPassphraseInput ?? passphraseInput ?? nameInput)?.focus()),
    );

    async function submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setValidationError("");
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const value = (key: string): string => String(data.get(key) ?? "");
        try {
            if (props.kind === "archive") {
                const passphrase = encryptOnCreate() ? value("passphrase") : "";
                if (encryptOnCreate() && !passphrase) {
                    throw new Error("Enter a passphrase to protect this workspace.");
                }
                if (passphrase) {
                    const passphraseBytes = new TextEncoder().encode(passphrase);
                    const byteLength = passphraseBytes.byteLength;
                    passphraseBytes.fill(0);
                    if (byteLength < 12 || byteLength > 4096) {
                        throw new Error("Use a passphrase between 12 and 4096 UTF-8 bytes long.");
                    }
                }
                if (passphrase !== value("confirmPassphrase")) {
                    throw new Error("The passphrases do not match.");
                }
                const passphraseInput = form.querySelector<HTMLInputElement>(
                    'input[name="passphrase"]',
                );
                const confirmationInput = form.querySelector<HTMLInputElement>(
                    'input[name="confirmPassphrase"]',
                );
                await props.onCreateArchive(value("name"), value("description"), passphrase);
                if (passphraseInput) passphraseInput.value = "";
                if (confirmationInput) confirmationInput.value = "";
            } else if (props.kind === "passphrase") {
                const currentPassphrase = value("currentPassphrase");
                const passphrase = value("passphrase");
                const passphraseBytes = new TextEncoder().encode(passphrase);
                const byteLength = passphraseBytes.byteLength;
                const validUnicode = new TextDecoder().decode(passphraseBytes) === passphrase;
                passphraseBytes.fill(0);
                if (!validUnicode) throw new Error("Enter a passphrase using valid Unicode text.");
                if (byteLength < 12 || byteLength > 4096) {
                    throw new Error("Use a passphrase between 12 and 4096 UTF-8 bytes long.");
                }
                if (passphrase !== value("confirmPassphrase")) {
                    throw new Error("The passphrases do not match.");
                }
                if (currentPassphrase === passphrase) {
                    throw new Error("Choose a different new passphrase from the current one.");
                }
                const currentPassphraseInputElement = form.querySelector<HTMLInputElement>(
                    'input[name="currentPassphrase"]',
                );
                const confirmationInput = form.querySelector<HTMLInputElement>(
                    'input[name="confirmPassphrase"]',
                );
                await props.onChangePassphrase(currentPassphrase, passphrase);
                if (currentPassphraseInputElement) currentPassphraseInputElement.value = "";
                if (passphraseInput) passphraseInput.value = "";
                if (confirmationInput) confirmationInput.value = "";
            } else if (props.kind === "student")
                props.onSaveStudent(
                    {
                        name: value("name"),
                        grade: value("grade"),
                        subjects: value("subjects"),
                        objectives: value("objectives"),
                        tutorNotes: value("notes"),
                        difficulties: value("difficulties"),
                        demonstratedImprovements: value("demonstratedImprovements"),
                        preferredGuideTemplate: value("preferredGuideTemplate"),
                    },
                    props.record,
                );
            else if (props.kind === "session")
                props.onSaveSession(
                    {
                        studentId: value("student"),
                        subject: value("subject"),
                        title: value("title"),
                        objectives: value("objectives"),
                        noteBlocks: noteBlocks(),
                    },
                    props.record,
                    props.notesDocument,
                    noteState.editable,
                );
            else
                props.onSaveJournal(
                    {
                        title: value("title"),
                        date: journalDate(),
                        noteBlocks: noteBlocks(),
                        collectionIds: data.getAll("collectionIds").map(String),
                        tagIds: data.getAll("tagIds").map(String),
                    },
                    props.record,
                    props.notesDocument,
                    noteState.editable,
                );
        } catch (error) {
            setValidationError(errorMessage(error));
        }
    }

    function notesAutosaveControl(): JSX.Element {
        return (
            <Show when={initialOwner && noteState.editable}>
                <div class="notes-autosave text-muted grid text-xs gap-1.5 mt-2">
                    <label class="items-center text-ink-soft flex font-semibold gap-2">
                        <input
                            type="checkbox"
                            checked={autosaveEnabled()}
                            disabled={
                                props.busy ||
                                autosavePermissionPending() ||
                                !props.state?.snapshot.canMutate
                            }
                            onChange={(event) => {
                                if (!event.currentTarget.checked) {
                                    setAutosaveEnabled(false);
                                    window.clearTimeout(autosaveTimer);
                                    setAutosaveStatus("Autosave is off.");
                                    return;
                                }
                                // Keep the control unchecked until permission has actually been granted.
                                event.currentTarget.checked = false;
                                setAutosavePermissionPending(true);
                                // Invoke immediately in the user gesture so the browser may prompt.
                                void props
                                    .onEnableNotesAutosave()
                                    .then((allowed) => {
                                        if (editorDisposed) return;
                                        setAutosaveEnabled(allowed);
                                        if (allowed) scheduleNotesAutosave();
                                        else
                                            setAutosaveStatus(
                                                "Autosave could not get permission for this archive.",
                                            );
                                    })
                                    .catch((error: unknown) => {
                                        if (!editorDisposed)
                                            setAutosaveStatus(
                                                `Autosave could not start: ${errorMessage(error)}`,
                                            );
                                    })
                                    .finally(() => {
                                        if (!editorDisposed) setAutosavePermissionPending(false);
                                    });
                            }}
                            class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 accent-accent"
                        />
                        Autosave notes
                    </label>
                    <small class="leading-normal">
                        {platform.kind === "desktop" && props.state?.location
                            ? "Autosave writes all current workspace changes to the open archive file."
                            : "When available, grant file access to save workspace changes to the open archive. Otherwise save the archive manually."}
                    </small>
                    <Show when={autosaveStatus()}>
                        <small role="status" aria-live="polite" class="leading-normal">
                            {autosaveStatus()}
                        </small>
                    </Show>
                </div>
            </Show>
        );
    }

    return (
        <div
            class={cn(dialogBackdrop, "dialog-backdrop")}
            onClick={(event) => {
                if (event.target === event.currentTarget && !props.busy) void closeForm();
            }}
        >
            <ManagedDialog
                class={cn(dialogPanel, "form-dialog")}
                role="dialog"
                labelledBy="form-dialog-title"
                onEscape={() => void closeForm()}
                canEscape={() => !props.busy}
            >
                <button
                    class={cn(
                        iconButton,
                        "icon-button dialog-close text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 absolute right-3.5 top-3.5",
                    )}
                    type="button"
                    onClick={() => void closeForm()}
                    disabled={props.busy}
                    aria-label="Close"
                >
                    <Icon name="close" />
                </button>
                <span class="dialog-icon bg-accent-soft rounded-[5px] border border-accent/15 text-accent grid h-9.5 mb-4 place-items-center w-9.5">
                    <Icon name={content().icon} />
                </span>
                <span class={cn(eyebrow, "eyebrow")}>{content().eyebrow}</span>
                <h2 id="form-dialog-title" class="">
                    {content().title}
                </h2>
                <p class={cn(dialogDescription, "dialog-description")}>{content().description}</p>
                <form onSubmit={submit} class="">
                    <Show when={props.kind === "archive"}>
                        <label class={cn(labelBase, "form-field")}>
                            Workspace name
                            <input
                                ref={(element) => {
                                    nameInput = element;
                                }}
                                name="name"
                                placeholder="e.g. Maya’s tutoring"
                                maxlength="200"
                                required
                                class={inputBase}
                            />
                        </label>
                        <label class={cn(labelBase, "form-field")}>
                            A short description{" "}
                            <span class="optional text-faint text-xs font-normal">Optional</span>
                            <textarea
                                name="description"
                                rows="3"
                                placeholder="What will this workspace hold?"
                                maxlength="1000"
                                class={textareaBase}
                            />
                        </label>
                        <label class="archive-encryption-toggle items-start bg-surface-subtle rounded-[5px] border border-line text-ink cursor-pointer flex gap-2.5 py-3 px-3">
                            <input
                                type="checkbox"
                                checked={encryptOnCreate()}
                                onChange={(event) =>
                                    setEncryptOnCreate(event.currentTarget.checked)
                                }
                                class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 accent-accent h-3.5 mt-0.5 mx-0 mb-0 w-3.5"
                            />
                            <span class="grid gap-1">
                                <strong class="text-xs font-[650]">
                                    Protect this workspace with a passphrase
                                </strong>
                                <small class="text-ink-soft text-xs leading-normal">
                                    Encrypt learner records and private notes on disk.
                                </small>
                            </span>
                        </label>
                        <Show when={encryptOnCreate()}>
                            <label class={cn(labelBase, "form-field")}>
                                Archive passphrase
                                <input
                                    type="password"
                                    name="passphrase"
                                    autocomplete="new-password"
                                    maxlength="4096"
                                    required
                                    class={inputBase}
                                />
                            </label>
                            <label class={cn(labelBase, "form-field")}>
                                Confirm passphrase
                                <input
                                    type="password"
                                    name="confirmPassphrase"
                                    autocomplete="new-password"
                                    maxlength="4096"
                                    required
                                    class={inputBase}
                                />
                            </label>
                            <p class="archive-encryption-help text-ink-soft text-xs leading-normal -mt-1 mx-0 mb-0">
                                Keep this passphrase safe. Tutorux cannot recover it if it is lost.
                            </p>
                        </Show>
                    </Show>
                    <Show when={props.kind === "passphrase"}>
                        <label class={cn(labelBase, "form-field")}>
                            Current passphrase
                            <input
                                ref={(element) => {
                                    currentPassphraseInput = element;
                                }}
                                type="password"
                                name="currentPassphrase"
                                autocomplete="current-password"
                                maxlength="4096"
                                required
                                class={inputBase}
                            />
                        </label>
                        <label class={cn(labelBase, "form-field")}>
                            New passphrase
                            <input
                                ref={(element) => {
                                    passphraseInput = element;
                                }}
                                type="password"
                                name="passphrase"
                                autocomplete="new-password"
                                maxlength="4096"
                                required
                                class={inputBase}
                            />
                        </label>
                        <label class={cn(labelBase, "form-field")}>
                            Confirm new passphrase
                            <input
                                type="password"
                                name="confirmPassphrase"
                                autocomplete="new-password"
                                maxlength="4096"
                                required
                                class={inputBase}
                            />
                        </label>
                        <p class="archive-encryption-help text-ink-soft text-xs leading-normal -mt-1 mx-0 mb-0">
                            Use 12–4096 UTF-8 bytes. Save the workspace after changing it; the
                            previous passphrase remains active on disk until then. Older backup
                            files keep their original passphrase.
                        </p>
                    </Show>
                    <Show when={props.kind === "student"}>
                        <label class={cn(labelBase, "form-field")}>
                            Student name
                            <input
                                ref={(element) => {
                                    nameInput = element;
                                }}
                                name="name"
                                placeholder="e.g. Maya Chen"
                                maxlength="256"
                                value={props.record ? field(props.record, "display_name") : ""}
                                required
                                class={inputBase}
                            />
                        </label>
                        <div class={cn(fieldGrid, "form-field-grid")}>
                            <label class={cn(labelBase, "form-field")}>
                                Grade or level
                                <input
                                    name="grade"
                                    placeholder="e.g. Year 8"
                                    maxlength="128"
                                    value={props.record ? field(props.record, "grade") : ""}
                                    class={inputBase}
                                />
                            </label>
                            <label class={cn(labelBase, "form-field")}>
                                Subjects
                                <input
                                    name="subjects"
                                    placeholder="e.g. Algebra, Science"
                                    maxlength="2048"
                                    value={props.record ? field(props.record, "subjects") : ""}
                                    class={inputBase}
                                />
                            </label>
                        </div>
                        <label class={cn(labelBase, "form-field")}>
                            Learning goals
                            <textarea
                                name="objectives"
                                rows="3"
                                placeholder="What are they working towards?"
                                maxlength="4096"
                                value={
                                    props.record ? field(props.record, "learning_objectives") : ""
                                }
                                class={textareaBase}
                            />
                        </label>
                        <div class={cn(fieldGrid, "form-field-grid")}>
                            <label class={cn(labelBase, "form-field")}>
                                Areas to revisit
                                <textarea
                                    name="difficulties"
                                    rows="3"
                                    placeholder="Concepts or approaches that still need practice"
                                    maxlength="4096"
                                    value={
                                        props.record
                                            ? field(props.record, "known_difficulties")
                                            : ""
                                    }
                                    class={textareaBase}
                                />
                            </label>
                            <label class={cn(labelBase, "form-field")}>
                                Demonstrated improvements
                                <textarea
                                    name="demonstratedImprovements"
                                    rows="3"
                                    placeholder="Skills the learner is showing more independently"
                                    maxlength="4096"
                                    value={
                                        props.record
                                            ? field(props.record, "demonstrated_improvements")
                                            : ""
                                    }
                                    class={textareaBase}
                                />
                            </label>
                        </div>
                        <label class={cn(labelBase, "form-field")}>
                            Preferred study-guide structure{" "}
                            <span class="optional text-faint text-xs font-normal">Optional</span>
                            <select
                                name="preferredGuideTemplate"
                                value={
                                    props.record
                                        ? field(props.record, "preferred_guide_template")
                                        : ""
                                }
                                class={selectBase}
                            >
                                <option value="">Choose when creating a guide</option>
                                <Show
                                    when={
                                        props.record &&
                                        field(props.record, "preferred_guide_template") &&
                                        !GUIDE_TEMPLATES.some(
                                            (template) =>
                                                template.id ===
                                                field(props.record!, "preferred_guide_template"),
                                        ) &&
                                        !props.state?.guideTemplates.some(
                                            (template) =>
                                                template.id ===
                                                field(props.record!, "preferred_guide_template"),
                                        )
                                    }
                                >
                                    <option
                                        value={field(props.record!, "preferred_guide_template")}
                                    >
                                        {field(props.record!, "preferred_guide_template")} · saved
                                        in this archive
                                    </option>
                                </Show>
                                <For each={GUIDE_TEMPLATES}>
                                    {(template) => (
                                        <option value={template.id}>{template.name}</option>
                                    )}
                                </For>
                                <For each={props.state?.guideTemplates ?? []}>
                                    {(template) => (
                                        <option value={template.id}>
                                            {template.fields.get("name") ?? "Custom template"}
                                        </option>
                                    )}
                                </For>
                            </select>
                        </label>
                        <details
                            class="optional-fields text-ink-soft text-xs"
                            open={Boolean(props.record && field(props.record, "tutor_notes"))}
                        >
                            <summary class="focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 text-muted cursor-pointer w-[fit-content]">
                                Private tutor notes{" "}
                                <span class="text-faint text-xs ml-1.5">Only in this archive</span>
                            </summary>
                            <textarea
                                name="notes"
                                rows="3"
                                placeholder="Anything useful to keep in mind?"
                                maxlength="16384"
                                value={props.record ? field(props.record, "tutor_notes") : ""}
                                class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 placeholder:text-faint focus-visible:border-accent focus-visible:shadow-none bg-surface-subtle rounded-[5px] border border-line text-ink block text-xs font-normal leading-relaxed mt-2 min-h-18 min-w-0 py-2.5 px-2.5 resize-y transition-colors duration-150 w-full"
                            />
                        </details>
                    </Show>
                    <Show when={props.kind === "session"}>
                        <label class={cn(labelBase, "form-field")}>
                            Session title
                            <input
                                ref={(element) => {
                                    nameInput = element;
                                }}
                                name="title"
                                placeholder="e.g. Linear equations and confidence"
                                maxlength="240"
                                value={props.record ? field(props.record, "title") : ""}
                                required
                                class={inputBase}
                            />
                        </label>
                        <div class={cn(fieldGrid, "form-field-grid")}>
                            <label class={cn(labelBase, "form-field")}>
                                Student
                                <select
                                    name="student"
                                    value={props.record ? field(props.record, "student_id") : ""}
                                    class={selectBase}
                                >
                                    <option value="">Independent session</option>
                                    <For each={props.state?.students ?? []}>
                                        {(student) => (
                                            <option value={student.id}>
                                                {field(student, "display_name")}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <label class={cn(labelBase, "form-field")}>
                                Subject
                                <input
                                    name="subject"
                                    placeholder="e.g. Algebra"
                                    maxlength="200"
                                    value={props.record ? field(props.record, "subject") : ""}
                                    class={inputBase}
                                />
                            </label>
                        </div>
                        <label class={cn(labelBase, "form-field")}>
                            Learning objective
                            <input
                                name="objectives"
                                placeholder="What did you want to work on?"
                                maxlength="4000"
                                value={
                                    props.record ? field(props.record, "learning_objectives") : ""
                                }
                                class={inputBase}
                            />
                        </label>
                        <div class={cn(labelBase, "form-field document-form-field")}>
                            <span class="">Session notes</span>
                            <Show
                                when={noteState.editable}
                                fallback={
                                    <span class={cn(helperText, "form-help")}>
                                        These notes contain content this editor cannot safely
                                        change. They remain preserved while you edit the other
                                        session details.
                                    </span>
                                }
                            >
                                <DocumentEditor
                                    label="Session notes"
                                    blocks={noteBlocks()}
                                    onChange={changeNoteBlocks}
                                />
                                {notesAutosaveControl()}
                            </Show>
                        </div>
                    </Show>
                    <Show when={props.kind === "journal"}>
                        <label class={cn(labelBase, "form-field")}>
                            Entry title
                            <input
                                ref={(element) => {
                                    nameInput = element;
                                }}
                                name="title"
                                placeholder="e.g. A new way into fractions"
                                maxlength="240"
                                value={props.record ? field(props.record, "title") : ""}
                                required
                                class={inputBase}
                            />
                        </label>
                        <div class={cn(labelBase, "form-field")}>
                            <span class="">Date</span>
                            <div class="journal-date-field-controls">
                                <DatePicker
                                    id="journal-entry-date"
                                    value={journalDate()}
                                    aria-label="Journal entry date"
                                    onChange={setJournalDate}
                                />
                                <button
                                    class={cn(
                                        buttonQuiet,
                                        "button button-quiet record-action text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 text-xs min-h-7.5 py-0 px-2.5",
                                    )}
                                    type="button"
                                    disabled={!journalDate()}
                                    onClick={() => setJournalDate("")}
                                >
                                    Clear date
                                </button>
                            </div>
                            <span class={cn(helperText, "form-help")}>
                                Leave the date empty for an undated reflection.
                            </span>
                        </div>
                        <div class={cn(labelBase, "form-field document-form-field")}>
                            <span class="">Reflection</span>
                            <Show
                                when={noteState.editable}
                                fallback={
                                    <span class={cn(helperText, "form-help")}>
                                        These notes contain content this editor cannot safely
                                        change. They remain preserved while you edit the other entry
                                        details.
                                    </span>
                                }
                            >
                                <DocumentEditor
                                    label="Reflection"
                                    blocks={noteBlocks()}
                                    onChange={changeNoteBlocks}
                                />
                                {notesAutosaveControl()}
                            </Show>
                        </div>
                        <div class="journal-link-fields grid gap-2.5 grid-cols-2 max-[560px]:grid-cols-[minmax(0,_1fr)]">
                            <fieldset class="journal-link-group rounded-[5px] border border-line-soft flex flex-wrap gap-y-2 gap-x-3 m-0 min-w-0 pt-2.5 px-2.5 pb-2.5">
                                <legend class="text-ink-soft text-xs font-semibold py-0 px-1">
                                    Collections
                                </legend>
                                <Show
                                    when={(props.state?.collections.length ?? 0) > 0}
                                    fallback={
                                        <p class={cn(helperText, "form-help")}>
                                            Create a collection in the journal to group related
                                            reflections.
                                        </p>
                                    }
                                >
                                    <For each={props.state?.collections ?? []}>
                                        {(item) => (
                                            <label class="journal-check-label items-center text-ink-soft cursor-pointer inline-flex text-xs gap-1.5 min-w-0">
                                                <input
                                                    type="checkbox"
                                                    name="collectionIds"
                                                    value={item.id}
                                                    checked={journalIds("collection_ids").includes(
                                                        item.id,
                                                    )}
                                                    class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 accent-accent"
                                                />
                                                <span
                                                    class="journal-label-dot bg-[var(--label-color,var(--accent))] rounded-full flex-none h-2 w-2"
                                                    style={{
                                                        "--label-color": safeJournalColor(item),
                                                    }}
                                                />
                                                {field(item, "name", "Untitled collection")}
                                            </label>
                                        )}
                                    </For>
                                </Show>
                                <For
                                    each={journalIds("collection_ids").filter(
                                        (id) =>
                                            !props.state?.collections.some(
                                                (item) => item.id === id,
                                            ),
                                    )}
                                >
                                    {(id) => (
                                        <input
                                            type="hidden"
                                            name="collectionIds"
                                            value={id}
                                            class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40"
                                        />
                                    )}
                                </For>
                            </fieldset>
                            <fieldset class="journal-link-group rounded-[5px] border border-line-soft flex flex-wrap gap-y-2 gap-x-3 m-0 min-w-0 pt-2.5 px-2.5 pb-2.5">
                                <legend class="text-ink-soft text-xs font-semibold py-0 px-1">
                                    Tags
                                </legend>
                                <Show
                                    when={(props.state?.tags.length ?? 0) > 0}
                                    fallback={
                                        <p class={cn(helperText, "form-help")}>
                                            Create a tag in the journal to mark a useful detail.
                                        </p>
                                    }
                                >
                                    <For each={props.state?.tags ?? []}>
                                        {(item) => (
                                            <label class="journal-check-label items-center text-ink-soft cursor-pointer inline-flex text-xs gap-1.5 min-w-0">
                                                <input
                                                    type="checkbox"
                                                    name="tagIds"
                                                    value={item.id}
                                                    checked={journalIds("tag_ids").includes(
                                                        item.id,
                                                    )}
                                                    class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 accent-accent"
                                                />
                                                <span
                                                    class="journal-label-dot bg-[var(--label-color,var(--accent))] rounded-full flex-none h-2 w-2"
                                                    style={{
                                                        "--label-color": safeJournalColor(item),
                                                    }}
                                                />
                                                {field(item, "name", "Untitled tag")}
                                            </label>
                                        )}
                                    </For>
                                </Show>
                                <For
                                    each={journalIds("tag_ids").filter(
                                        (id) => !props.state?.tags.some((item) => item.id === id),
                                    )}
                                >
                                    {(id) => (
                                        <input
                                            type="hidden"
                                            name="tagIds"
                                            value={id}
                                            class="font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40"
                                        />
                                    )}
                                </For>
                            </fieldset>
                        </div>
                        <Show
                            when={
                                journalIds("collection_ids").some(
                                    (id) =>
                                        !props.state?.collections.some((item) => item.id === id),
                                ) ||
                                journalIds("tag_ids").some(
                                    (id) => !props.state?.tags.some((item) => item.id === id),
                                )
                            }
                        >
                            <span class={cn(helperText, "form-help")}>
                                Unavailable legacy labels remain linked when this entry is saved.
                            </span>
                        </Show>
                        <Show when={props.record && !noteState.editable}>
                            <span class={cn(helperText, "form-help")}>
                                This reflection contains structured blocks. They are preserved while
                                you edit the title or date.
                            </span>
                        </Show>
                    </Show>
                    <Show when={validationError()}>
                        <p class={cn(errorText, "form-error")} role="alert">
                            {validationError()}
                        </p>
                    </Show>
                    <div class="dialog-actions border-t border-t-line-soft flex gap-2 justify-end mt-1.5 pt-3">
                        <button
                            class={cn(
                                buttonOutline,
                                "button button-outline text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                            )}
                            type="button"
                            onClick={() => void closeForm()}
                            disabled={props.busy}
                        >
                            Cancel
                        </button>
                        <button
                            class={cn(
                                buttonPrimary,
                                "button button-primary text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
                            )}
                            type="submit"
                            disabled={
                                props.busy ||
                                (props.kind !== "archive" &&
                                    (!props.state || !props.state.snapshot.canMutate))
                            }
                        >
                            {props.busy ? "Saving…" : content().submit}
                            <Icon name="arrow" />
                        </button>
                    </div>
                </form>
                <span class="dialog-privacy items-center text-faint flex text-xs gap-1.5 justify-center mt-3">
                    <Icon name="shield" />
                    Stored locally in your archive
                </span>
            </ManagedDialog>
        </div>
    );
}

function StatCard(props: {
    label: string;
    value: number;
    detail: string;
    icon: IconName;
    onClick: () => void;
}): JSX.Element {
    return (
        <button
            class={cn(
                statisticCard,
                "stat-card text-inherit font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40",
            )}
            type="button"
            onClick={() => props.onClick()}
        >
            <span
                class={cn(
                    `stat-icon stat-${props.icon}`,
                    "bg-accent-soft rounded-[5px] text-accent grid flex-none h-7.5 place-items-center w-7.5 min-[651px]:max-[1120px]:h-6.5 min-[651px]:max-[1120px]:w-6.5 max-sm:h-6 max-sm:w-6",
                    props.icon === "journal"
                        ? "bg-[#f4f0e7] text-[#8b7654] [html[data-theme=dark]_&]:bg-[#302a20] [html[data-theme=dark]_&]:text-[#d0b88c]"
                        : props.icon === "guides"
                          ? "bg-[#f1eef6] text-[#81709c] [html[data-theme=dark]_&]:bg-[#2a2434] [html[data-theme=dark]_&]:text-[#c1aedc]"
                          : "bg-[#edf3f5] text-[#59798b] [html[data-theme=dark]_&]:bg-[#1d2c32] [html[data-theme=dark]_&]:text-[#a0c1d0]",
                )}
            >
                <Icon name={props.icon} />
            </span>
            <span class="stat-copy grid flex-1 gap-0.5 min-w-0">
                <span class="text-muted text-xs font-medium max-sm:text-xs">{props.label}</span>
                <strong class="text-ink text-[23px] font-medium tracking-[-0.055em] leading-tight min-[651px]:max-[1120px]:text-[21px] max-sm:text-[19px]">
                    {props.value.toLocaleString("en-US")}
                </strong>
                <small class="text-faint text-xs overflow-hidden text-ellipsis whitespace-nowrap max-sm:text-xs">
                    {props.detail}
                </small>
            </span>
            <Icon name="arrow" />
        </button>
    );
}

function EmptyMini(props: {
    title: string;
    text: string;
    action: string;
    onAction: () => void;
}): JSX.Element {
    return (
        <div class="empty-mini items-center flex gap-2.5 min-h-40 pt-5.5 px-2 pb-2">
            <span class="empty-mini-mark bg-accent-soft rounded-full text-accent grid flex-none h-8 place-items-center w-8">
                <Icon name="spark" />
            </span>
            <div class="min-w-0">
                <strong class="text-ink-soft text-xs font-semibold">{props.title}</strong>
                <p class="text-muted text-xs leading-relaxed mt-1 mx-0 mb-2">{props.text}</p>
                <button
                    class="text-action text-accent font-sans focus-visible:outline-offset-[2px] focus-visible:outline focus-visible:outline-3 focus-visible:outline-accent/40 items-center bg-transparent border-0 cursor-pointer inline-flex text-xs font-semibold gap-1.5 py-0.5 px-0 hover:text-accent-hover"
                    type="button"
                    onClick={() => props.onAction()}
                >
                    {props.action}
                    <Icon name="arrow" />
                </button>
            </div>
        </div>
    );
}

function InfoCard(props: {
    label: string;
    value: string;
    icon: IconName;
    mono?: boolean;
}): JSX.Element {
    return (
        <article class="archive-info-card content-start items-center bg-surface border-b border-b-line-soft rounded-[5px] border border-line grid gap-1.5 grid-cols-[minmax(130px,_0.7fr)_minmax(0,_2fr)] min-h-22.5 min-w-0 p-3 py-2 px-0.5">
            <span class="info-card-icon bg-accent-soft rounded-[5px] text-accent hidden h-5.5 mb-0.5 place-items-center w-5.5">
                <Icon name={props.icon} />
            </span>
            <span class={cn(eyebrow, "eyebrow")}>{props.label}</span>
            <strong
                class={cn(
                    props.mono ? "mono" : "",
                    "text-ink-soft text-xs font-semibold col-[2] row-[1] break-words overflow-hidden text-ellipsis whitespace-nowrap",
                )}
                title={props.value}
            >
                {props.value}
            </strong>
        </article>
    );
}

function alive(records: ArchiveRecord[]): ArchiveRecord[] {
    return records.filter((record) => record.fields.get("_deleted") !== "true");
}

function formatFullDate(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
    }).format(date);
}

function formatMicroseconds(value: bigint): string {
    return formatTimestamp(value.toString());
}

function activityValues(
    sessions: ArchiveRecord[],
    range: "week" | "month",
): { label: string; count: number }[] {
    const now = new Date();
    if (range === "week") {
        return Array.from({ length: 7 }, (_, index) => {
            const date = new Date(now);
            date.setDate(now.getDate() - (6 - index));
            return {
                label: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date),
                count: sessions.filter((session) =>
                    sameLocalDate(
                        new Date(Number(BigInt(field(session, "started_at_us", "0")) / 1000n)),
                        date,
                    ),
                ).length,
            };
        });
    }
    return Array.from({ length: 4 }, (_, index) => {
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - (3 - index) * 7 - 6);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 7);
        return {
            label: `W${index + 1}`,
            count: sessions.filter((session) => {
                const date = new Date(Number(BigInt(field(session, "started_at_us", "0")) / 1000n));
                return date >= weekStart && date < weekEnd;
            }).length,
        };
    });
}

function sameLocalDate(left: Date, right: Date): boolean {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
}

function isCancelled(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function isArchiveSaveConflictMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes("archive changed outside tutorux") ||
        normalized.includes("archive destination now points to a different file") ||
        normalized.includes("selected archive location changed")
    );
}

function recoveredArchiveName(name: string): string {
    const stem = name.toLowerCase().endsWith(".tux") ? name.slice(0, -4) : name;
    return `${safeFileName(`${stem} - recovered`)}.tux`;
}

applyDocumentTailwindUtilities();
render(() => <App />, document.getElementById("root")!);
