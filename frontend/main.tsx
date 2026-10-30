import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
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
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "./archive/format";
import { DocumentEditor } from "./DocumentEditor";
import { DiagnosticsReport } from "./DiagnosticsReport";
import { AnnotationPage } from "./AnnotationPage";
import { AudioWaveform } from "./AudioWaveform";
import { ArchiveSettings } from "./ArchiveSettings";
import { ArchiveSettingsCopy } from "./ArchiveSettingsCopy";
import { JournalHistory } from "./JournalHistory";
import { JournalRelations } from "./JournalRelations";
import { StudentVersionHistory } from "./StudentVersionHistory";
import { ArchiveMaintenance } from "./ArchiveMaintenance";
import { SanitizedCopy } from "./SanitizedCopy";
import { MaterialDetails, MaterialImportControls, MaterialTrash } from "./MaterialDetails";
import { MaterialAudioPreview } from "./MaterialAudioPreview";
import { EvidenceSources } from "./EvidenceSources";
import { AudioMixer } from "./AudioMixer";
import { WhisperTranscription } from "./WhisperTranscription";
import { SessionVersionHistory, restoreSessionDetails } from "./SessionVersionHistory";
import { MicrophoneTrackRecorder } from "./MicrophoneTrackRecorder";
import { SynchronizedRecorder } from "./SynchronizedRecorder";
import { FullTrackWaveform } from "./FullTrackWaveform";
import { sourceStream, type ArchiveByteSource } from "./archive/source";
import { AiPage } from "./AiPage";
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
import {
  filterAssetsBySession,
  MAX_ASSET_BYTES,
  readAssetBytes,
  streamAssetBytes,
} from "./domain/assets";
import {
  browserAssetReadSource,
  prepareStreamingAssetBatchImport,
  prepareStreamingAssetImport,
  type AssetBatchProgress,
} from "./domain/assets-stream";
import {
  buildPcmWavAssetWaveform,
  MAX_MATERIAL_AUDIO_PREVIEW_BYTES,
  type PcmWavAssetWaveform,
} from "./domain/asset-waveform";
import { createArchiveStaging } from "./archive/staging";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { configurePdfWorkerSource } from "./domain/document-text";
import {
  buildAudioTrackWavExport,
  buildAudioPreview,
  listSessionAudioTracks,
  type AudioPreview,
  type AudioTrackDescriptor,
} from "./domain/audio";
import { makeWaveImportRecords } from "./domain/wav";
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
  EVIDENCE_RELATIONSHIPS,
  classifyTranscriptEvidence,
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
import { createEvidenceGraphLayout, type EvidenceGraphLayout } from "./domain/evidence-graph";
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
import type { AiCredentialStorage, BrowserArchiveAutosave } from "./platform/types";
import { CommandConsole } from "./CommandConsole";
import { keyboardShortcutRows, resolveKeyboardShortcut } from "./domain/keyboard-shortcuts";
import { GuidesPage } from "./GuidesPage";
import { StudentProgressPanel } from "./StudentProgressPanel";
import { JournalOrganizer } from "./JournalOrganizer";
import brandLogo from "./assets/tutorux.svg";
import "./styles.css";
import "./transcript.css";
import "./annotation.css";
import "./assets.css";
import "./evidence.css";
import "./journal.css";

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

interface Workspace {
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

interface TrashPurgeReview {
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

type IconName =
  | "home"
  | "journal"
  | "students"
  | "sessions"
  | "annotations"
  | "transcripts"
  | "guides"
  | "evidence"
  | "assets"
  | "trash"
  | "archive"
  | "settings"
  | "plus"
  | "microphone"
  | "search"
  | "sun"
  | "moon"
  | "chevron"
  | "arrow"
  | "book"
  | "clock"
  | "spark"
  | "folder"
  | "shield"
  | "close"
  | "check"
  | "more";

const views: readonly ViewDefinition[] = [
  { id: "home", label: "Overview", icon: "home", group: "workspace" },
  { id: "journal", label: "Journal", icon: "journal", group: "workspace" },
  { id: "students", label: "Students", icon: "students", group: "workspace" },
  { id: "sessions", label: "Sessions", icon: "sessions", group: "workspace" },
  { id: "annotations", label: "Observations", icon: "annotations", group: "workspace" },
  { id: "transcripts", label: "Transcripts", icon: "transcripts", group: "workspace" },
  { id: "ai", label: "AI workspace", icon: "spark", group: "workspace" },
  { id: "guides", label: "Study guides", icon: "guides", group: "library" },
  { id: "evidence", label: "Evidence", icon: "evidence", group: "library" },
  { id: "assets", label: "Materials", icon: "assets", group: "library" },
  { id: "trash", label: "Trash", icon: "trash", group: "library" },
  { id: "archive", label: "Archive health", icon: "archive", group: "system" },
  { id: "settings", label: "Preferences", icon: "settings", group: "system" },
];

const [workspace, setWorkspace] = createSignal<Workspace | null>(null);
const [view, setView] = createSignal<View>("home");
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
const [busy, setBusy] = createSignal(false);
const [selectedTranscriptSessionId, setSelectedTranscriptSessionId] = createSignal("");
const [selectedAnnotationSessionId, setSelectedAnnotationSessionId] = createSignal("");
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

interface ManagedDialogProps {
  children: JSX.Element;
  class: string;
  role: "dialog" | "alertdialog";
  labelledBy?: string;
  describedBy?: string;
  label?: string;
  onEscape?: () => void;
  canEscape?: () => boolean;
  onKeyDown?: (event: KeyboardEvent) => void;
  restoreFocus?: () => boolean;
}

function ManagedDialog(props: ManagedDialogProps): JSX.Element {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let dialogElement!: HTMLElement;

  const focusableElements = (): HTMLElement[] =>
    [
      ...dialogElement.querySelectorAll<HTMLElement>(
        'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, audio[controls], video[controls], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.getClientRects().length > 0,
    );

  onMount(() => {
    const initialFocus =
      dialogElement.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      (props.role === "dialog"
        ? dialogElement.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]',
          )
        : null) ??
      focusableElements()[0] ??
      dialogElement;
    initialFocus.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !dialogElement.isConnected ||
        [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1) !== dialogElement
      ) {
        return;
      }

      if (event.key === "Escape" && props.onEscape) {
        event.preventDefault();
        event.stopPropagation();
        if (props.canEscape?.() ?? true) props.onEscape();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || active === dialogElement || !dialogElement.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || active === dialogElement || !dialogElement.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (props.restoreFocus?.() === false) return;
      queueMicrotask(() => {
        const activeDialog = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(
          -1,
        );
        const returnTarget =
          returnFocus?.isConnected && !returnFocus.matches(":disabled, [aria-disabled='true']")
            ? returnFocus
            : null;
        const target = activeDialog
          ? returnTarget && activeDialog.contains(returnTarget)
            ? returnTarget
            : (activeDialog.querySelector<HTMLElement>(
                'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ) ?? activeDialog)
          : (returnTarget ?? document.querySelector<HTMLElement>("#main-content"));
        target?.focus({ preventScroll: true });
      });
    });
  });

  return (
    <section
      ref={(element) => {
        dialogElement = element;
      }}
      class={`${props.class} modal-focus-scope`}
      role={props.role}
      aria-modal="true"
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      aria-label={props.label}
      tabindex="-1"
      onKeyDown={(event) => props.onKeyDown?.(event)}
    >
      {props.children}
    </section>
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

const activeView = createMemo(() => views.find((item) => item.id === view()) ?? views[0]!);
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
  const needle = query().trim().toLocaleLowerCase();
  const records = currentRecords();
  if (!needle) return records;
  const matches = (record: ArchiveRecord) =>
    [...record.fields.values()].some((value) => value.toLocaleLowerCase().includes(needle));
  const state = workspace();
  if (view() !== "journal" || !state) return records.filter(matches);
  const matchingEntries = new Set<string>();
  const sessionEntries = new Map(
    [...state.sessions, ...state.archivedSessions].map((session) => [
      session.id.toLowerCase(),
      field(session, "entry_id").toLowerCase(),
    ]),
  );
  for (const record of [...state.notesDocuments, ...state.guides, ...state.transcripts]) {
    if (!matches(record)) continue;
    const entry =
      field(record, "entry_id").toLowerCase() ||
      sessionEntries.get(field(record, "session_id").toLowerCase());
    if (entry) matchingEntries.add(entry);
  }
  return records.filter(
    (record) => matches(record) || matchingEntries.has(record.id.toLowerCase()),
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
  let noticeTimer = 0;
  let removeNativeCommandListener: (() => void) | undefined;
  let nativeCommandListenerDisposed = false;
  let launchArchiveQueue: Promise<void> = Promise.resolve();
  let pageSearchInput: HTMLInputElement | undefined;
  let mainContentElement: HTMLElement | undefined;
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
        modalOpen: Boolean(dialog() || pendingDelete() || pendingSessionTrash()),
        paletteOpen: paletteOpen(),
        markerKeys: markerKeys(active),
        markerEnabled: Boolean(active?.sessions.length && active.snapshot.canMutate && !busy()),
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
          void saveCurrentArchive();
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
      const session =
        current.sessions.find((item) => item.id === selectedAnnotationSessionId()) ??
        current.sessions[0];
      if (!session) {
        announce("Create a session before using quick markers.", "info");
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
        .onNativeCommand((command) => {
          switch (command) {
            case "open":
              void openArchive();
              break;
            case "save":
              void saveCurrentArchive();
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
        })
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
    window.addEventListener("tutorux:notice", receiveNotice);
    window.addEventListener("tutorux:quick-marker", handleQuickMarker);
    window.addEventListener("keydown", handleKeys);
    onCleanup(() => {
      window.removeEventListener("tutorux:notice", receiveNotice);
      window.removeEventListener("tutorux:quick-marker", handleQuickMarker);
      window.removeEventListener("keydown", handleKeys);
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
      trashedStudents: allStudents.filter((record) => record.fields.get("_deleted") === "true"),
      trashedAnnotations: allAnnotations.filter(
        (record) =>
          record.fields.get("_deleted") === "true" && !record.fields.get("_trash_group_id"),
      ),
      trashedGuides: guides.filter(
        (record) =>
          record.fields.get("_deleted") === "true" && !record.fields.get("_trash_group_id"),
      ),
      trashedEvidence: evidence.filter(
        (record) =>
          record.fields.get("_deleted") === "true" &&
          !trashedSessionIds.has(field(record, "_trash_group_id").toLowerCase()),
      ),
      sessions: liveSessions.filter((record) => record.fields.get("archived") !== "true"),
      archivedSessions: liveSessions.filter((record) => record.fields.get("archived") === "true"),
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
      journals: alive(settings).filter((record) => record.fields.get("record_role") === "journal"),
      collections: alive(settings).filter(
        (record) => record.fields.get("record_role") === "journal-collection",
      ),
      tags: alive(settings).filter((record) => record.fields.get("record_role") === "journal-tag"),
      trashedJournalOrganizers: settings.filter(
        (record) =>
          record.fields.get("_deleted") === "true" &&
          ["journal-collection", "journal-tag"].includes(record.fields.get("record_role") ?? ""),
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
      settings: alive(settings).filter((record) => field(record, "record_role") === "setting"),
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
      setView("home");
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
      applyWorkspaceTheme(next);
      setView("home");
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
    setView("home");
    announce("Archive locked.", "success");
  }

  async function openArchive(): Promise<void> {
    try {
      const selected = await platform.openArchive();
      if (!selected) return;
      await acceptArchive(selected.source, selected.name, selected.location, selected.autosave);
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
      applyWorkspaceTheme(next);
      browserAutosaveBinding = undefined;
      current.snapshot.lock();
      setPendingSessionTrash(null);
      setPendingTrashPurge(null);
      setDialog(null);
      setDialogRecord(null);
      setPendingDelete(null);
      setView("home");
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
      setView("home");
      await current.snapshot.source.close?.().catch(() => undefined);
      announce(
        `The command changed this archive, but Tutorux could not reopen it. Reopen the archive before continuing. ${errorMessage(error)}`,
        "error",
      );
    }
  }

  async function createArchive(name: string, description: string, passphrase = ""): Promise<void> {
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
      const savedLocation = await platform.saveArchive(snapshot.source, suggestedName, location);
      const next = await readWorkspace(snapshot, suggestedName, savedLocation);
      const previous = workspace();
      setWorkspace(next);
      applyWorkspaceTheme(next);
      browserAutosaveBinding = undefined;
      accepted = true;
      if (previous && previous.snapshot !== snapshot) previous.snapshot.lock();
      if (previous && previous.snapshot.source !== snapshot.source) {
        await previous.snapshot.source.close?.().catch(() => undefined);
      }
      setPendingSessionTrash(null);
      setView("home");
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
    const state = workspace();
    if (!state || busy()) return;
    setBusy(true);
    try {
      const path = await platform.saveArchive(state.snapshot.source, state.name, state.location);
      if (!path) return;
      if (platform.kind === "browser") browserAutosaveBinding = undefined;
      setWorkspace({ ...state, location: platform.kind === "desktop" ? path : null, dirty: false });
      announce("Your archive is saved.", "success");
    } catch (error) {
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
      announce("Archive changes are ready. Save the workspace to write them to disk.", "success");
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
      throw new Error("The active archive changed. Reopen this record to continue autosaving.");
    const owners =
      owner.type === RecordType.session
        ? [...current.sessions, ...current.archivedSessions]
        : current.entries;
    const latestOwner = owners.find((item) => item.id.toLowerCase() === owner.id.toLowerCase());
    if (!latestOwner) throw new Error("This record is no longer available in the archive.");
    const documentId = field(latestOwner, "notes_document_id");
    const document =
      current.notesDocuments.find((item) => item.id.toLowerCase() === documentId.toLowerCase()) ??
      null;
    if (
      documentId.toLowerCase() !== version.documentId.toLowerCase() ||
      (document?.revision ?? null) !== version.revision
    ) {
      throw new Error("These notes changed elsewhere. Reopen the record before autosaving.");
    }
    const changes = updateOwnerNotes(latestOwner, document, blocks);
    const changedDocument = changes.find(
      (item) => item.type === RecordType.settings && field(item, "record_role") === "journal-notes",
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
      const savedDocument = updated.notesDocuments.find((item) => item.id === changedDocument.id);
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
          }
        } catch (error) {
          diskError = errorMessage(error);
          announce(
            "Notes are saved in the workspace, but the archive file could not be updated.",
            "error",
          );
        }
      } else if (platform.kind === "browser") {
        const binding = browserAutosaveBinding;
        if (binding?.authorized && binding.archiveId === current.snapshot.header.id.toLowerCase()) {
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
              throw new Error("The active archive changed while the saved file was reopening.");
            }
            setWorkspace({ ...updated, snapshot: rebased, dirty: false });
            nextSnapshot.lock();
            persisted = true;
          } catch (error) {
            rebased?.lock();
            binding.authorized = false;
            diskError = errorMessage(error);
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
    if (!providerConfiguration) throw new Error("The saved provider settings could not be loaded.");
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
    if (!providerMetadata) throw new Error("Save Replicate settings before inspecting a model.");
    const providerConfiguration = await current.snapshot.getRecord(
      RecordType.settings,
      providerMetadata.id,
    );
    if (!providerConfiguration || providerConfiguration.fields.get("selected_model") !== model) {
      throw new Error("The saved Replicate model changed. Save it again before previewing.");
    }

    let credential = "";
    if (credentialStorage === "system-keychain") {
      if (
        platform.kind !== "desktop" ||
        !systemCredentialStoreAvailable() ||
        !(await platform.hasAiCredential(providerId))
      ) {
        throw new Error("Save the Replicate API token in the system credential store first.");
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
      if (!metadata) throw new Error("Save the Replicate API token before inspecting the model.");
      const savedCredential = await current.snapshot.getRecord(RecordType.settings, metadata.id);
      if (
        !savedCredential ||
        savedCredential.fields.get("record_role") !== "credential" ||
        savedCredential.fields.get("_deleted") === "true" ||
        savedCredential.fields.get("provider_id") !== providerId
      ) {
        throw new Error("The saved Replicate API token could not be verified in this archive.");
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
    const session = state?.sessions.find(
      (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
    );
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
      !(await addRecords(imported.records, `Imported external AI response as ${imported.status}.`))
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
    if (confirmedBodyHash !== preview.requestBodyHash || confirmedEndpoint !== preview.endpoint) {
      throw new Error("Confirm the exact provider endpoint and request body before sending.");
    }
    if (packageDraft.type !== RecordType.aiJob || packageDraft.fields.get("mode") !== "manual") {
      throw new Error("The reviewed package is no longer available.");
    }

    const existingPackage = await current.snapshot.getRecord(RecordType.aiJob, packageDraft.id);
    if (existingPackage) {
      if (existingPackage.fields.get("content_hash") !== packageDraft.fields.get("content_hash")) {
        throw new Error("The package changed after review. Prepare and review it again.");
      }
    } else if (!(await addRecords([packageDraft], "Reviewed AI package saved in this archive."))) {
      throw new Error("The reviewed package could not be saved to the active archive.");
    }

    current = workspace();
    if (!current || current.snapshot.locked || !current.snapshot.canMutate) {
      throw new Error("The active archive changed before the provider request could be sent.");
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
    if (!providerConfiguration) throw new Error("The saved provider settings could not be loaded.");
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
          throw new Error("Save a provider key inside an encrypted archive before sending.");
        }
        const metadata = current.credentials.find(
          (record) =>
            record.fields.get("provider_id") === freshPreview.providerId ||
            record.fields.get("key") === providerById(freshPreview.providerId)?.credentialKey,
        );
        if (!metadata) throw new Error("Save an API key in this encrypted archive before sending.");
        const savedCredential = await current.snapshot.getRecord(RecordType.settings, metadata.id);
        if (
          !savedCredential ||
          savedCredential.fields.get("record_role") !== "credential" ||
          savedCredential.fields.get("_deleted") === "true" ||
          savedCredential.fields.get("provider_id") !== freshPreview.providerId
        ) {
          throw new Error("The saved API key could not be verified in this encrypted archive.");
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
      const responseRecords = execution.guide ? [execution.job, execution.guide] : [execution.job];
      const savedMessage = execution.guide
        ? "AI response saved as an unapproved guide draft."
        : "The raw provider response was saved in this archive for export.";
      if (!(await addRecords(responseRecords, savedMessage))) {
        throw new Error("The provider response could not be saved in the active archive.");
      }
      setLastAiExecution({ archiveId: current.snapshot.header.id, summary: execution.summary });
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
      nextSnapshot = await current.snapshot.changePassphrase(currentPassphrase, newPassphrase);
      const updated = await readWorkspace(nextSnapshot, current.name, current.location, true);
      if (workspace()?.snapshot !== current.snapshot) {
        throw new Error("The active archive changed while its passphrase was being updated.");
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
      announce("Encryption enabled. Save the workspace to replace the archive file.", "success");
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
        throw new Error("The active archive changed while the session package was being read.");
      }
      const importedSession = imported.records.find(
        (record) => record.type === RecordType.session && record.id === imported.sessionId,
      );
      if (!importedSession) throw new Error("The imported session package has no session record.");
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
        archived ? "Session moved to the archive." : "Session returned to current sessions.",
      );
    } catch (error) {
      announce(errorMessage(error), "error");
    }
  }

  async function updateStudent(input: StudentInput, current: ArchiveRecord | null): Promise<void> {
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
      announce("The active archive changed. Review the session deletion scope again.", "error");
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
      announce("The active archive changed. Review the session deletion scope again.", "error");
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
      announce("The active archive changed. Review the session deletion scope again.", "error");
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
        announce("The active archive changed. Reopen Trash and review the purge again.", "error");
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
        ? [...state.sessions, ...state.archivedSessions].find((item) => item.id === draft.sessionId)
        : undefined;
      const entry = !draft.sessionId
        ? state.entries.find((item) => item.id === draft.entryId)
        : undefined;
      if (!session && !entry)
        throw new Error("Restore the source journal entry or session before saving this guide.");
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
        ? [...state.sessions, ...state.archivedSessions].find((item) => item.id === draft.sessionId)
        : undefined;
      const entry = !draft.sessionId
        ? state.entries.find((item) => item.id === draft.entryId)
        : undefined;
      if (!session && !entry) {
        throw new Error("Restore the source journal entry or session before approving this guide.");
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
      current ? "Study guide template updated." : "Study guide template added to the archive.",
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
        if (!printable) throw new Error("The study guide could not be prepared for printing.");
        finishPrint = (): void => {
          document.documentElement.classList.remove("guide-printing");
          setGuidePrintContent(null);
        };
        setGuidePrintContent(printable.cloneNode(true) as HTMLElement);
        document.documentElement.classList.add("guide-printing");
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
      if (path) announce(`Study guide exported as ${isHtml ? "HTML" : "Markdown"}.`, "success");
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
      if (!["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(mimeType))
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
      const preview = await buildAudioPreview(state.snapshot, session.id, track.id, startTimeUs);
      const previous = observationPlayback();
      if (previous) URL.revokeObjectURL(previous.url);
      const url = URL.createObjectURL(
        new Blob([preview.wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }),
      );
      setObservationPlayback({
        url,
        title: field(record, "title", annotationTypeLabel(field(record, "type", "observation"))),
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
    const session = state?.sessions.find((record) => record.id === sessionId);
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
            throw new Error("The archive changed while transcript cues were being imported.");
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
        throw new Error("The active archive changed while the transcript was being imported.");
      }
      const updated = await readWorkspace(snapshot, state.name, state.location, true);
      setWorkspace(updated);
      applyWorkspaceTheme(updated);
      state.snapshot.lock();
      pendingSnapshot = undefined;
      setView(view());
      announce(`Imported ${result.imported} provisional transcript cues.`, "success");
    } catch (error) {
      if (pendingSnapshot && pendingSnapshot !== workspace()?.snapshot) pendingSnapshot.lock();
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
    const session = state?.sessions.find((record) => record.id === sessionId);
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
        `Imported ${selected.split(/[\\/]/u).pop() ?? "audio"} as a ${imported.sampleRateHz.toLocaleString()} Hz audio track.`,
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
    const session = state?.sessions.find((record) => record.id === sessionId);
    if (!state || !session) {
      announce("Choose a session before importing audio.", "error");
      return;
    }
    if (state.snapshot.locked) {
      announce("Unlock this archive before importing audio.", "error");
      return;
    }
    setBusy(true);
    try {
      const tracks = state.audioTracks.filter(
        (track) => track.sessionId === session.id.toLowerCase(),
      );
      const imported = await makeWaveImportRecords(
        session,
        file,
        allowAdditionalTrack,
        tracks.map((track) => track.id),
      );
      await addRecords(
        imported.records,
        `Imported ${file.name} as a ${imported.sampleRateHz.toLocaleString()} Hz audio track.`,
      );
    } catch (error) {
      announce(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function recoverWavImport(sessionId: string): Promise<void> {
    const state = workspace();
    const session = state?.sessions.find(
      (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
    );
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
    const session = state?.sessions.find(
      (record) => record.id.toLowerCase() === sessionId.toLowerCase(),
    );
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
          const audioExport = await buildAudioTrackWavExport(state.snapshot, sessionId, trackId, {
            fillGapsWithSilence,
          });
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

  async function saveRecordingTrackName(track: AudioTrackDescriptor, label: string): Promise<void> {
    const state = workspace();
    if (!state) return;
    try {
      const updated = await renameRecordingTrack(state.snapshot, track.id, label);
      await addRecords([updated], "Recording track renamed.");
    } catch (error) {
      announce(errorMessage(error), "error");
    }
  }

  async function changeRecordingTrackTrash(track: { id: string }, deleted: boolean): Promise<void> {
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
      announce("The selected session is no longer available. Choose another session.", "error");
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
        `Added ${imported.items.length.toLocaleString()} ${imported.items.length === 1 ? "material" : "materials"} to the archive.${imported.deduplicatedCount ? ` ${imported.deduplicatedCount.toLocaleString()} ${imported.deduplicatedCount === 1 ? "material reuses" : "materials reuse"} verified content already stored here.` : ""} Save to write the changes to disk.`,
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
    if (!state.sessions.some((session) => session.id.toLowerCase() === sessionId.toLowerCase())) {
      announce("The selected session is no longer available. Choose another session.", "error");
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
    const session = state?.sessions.find((record) => record.id === sessionId);
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
      const session = state.sessions.find((record) => record.id === sessionId);
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
      announce("Choose seven unique printable keys, excluding comma and K, O, S, or N.", "error");
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
      const latest = existing ?? (await current.snapshot.getRecord(RecordType.settings, stableId));
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
    setView(nextView);
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
        void saveCurrentArchive();
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
    const needle = paletteQuery().trim().toLocaleLowerCase();
    return [...actions, ...navigationActions].filter((action) =>
      `${action.label} ${action.detail}`.toLocaleLowerCase().includes(needle),
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
    <div class="app-frame">
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header class="topbar">
        <div class="brand-lockup">
          <img src={brandLogo} class="brand-mark" alt="" />
          <span class="brand-name">Tutorux</span>
          <span class="brand-divider" aria-hidden="true" />
          <span class="brand-context">Teaching workspace</span>
        </div>

        <div class="topbar-center" aria-live="polite">
          <span class={`archive-status ${workspace() ? "is-open" : ""}`}>
            <span class="status-dot" aria-hidden="true" />
            <span>{workspace() ? workspace()!.manifest.displayName : "No archive open"}</span>
          </span>
          <Show when={workspace()?.dirty}>
            <span class="dirty-label">
              <span />
              Unsaved changes
            </span>
          </Show>
        </div>

        <div class="topbar-actions">
          <button
            class="topbar-search"
            type="button"
            onClick={openPalette}
            aria-label="Open quick actions"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Icon name="search" /> <span>Search Tutorux</span>
            <kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <button
            class="icon-button theme-button"
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme() === "light" ? "dark" : "light"} appearance`}
            title="Appearance"
            aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
          >
            <Icon name={theme() === "light" ? "moon" : "sun"} />
          </button>
          <button
            class="button button-outline topbar-open"
            type="button"
            onClick={() => void openArchive()}
            aria-keyshortcuts="Control+O Meta+O"
          >
            <Icon name="folder" />
            Open
          </button>
          <button
            class="button button-primary topbar-save"
            type="button"
            disabled={!workspace() || busy()}
            onClick={() => void saveCurrentArchive()}
            aria-keyshortcuts="Control+S Meta+S"
          >
            <Icon name="check" />
            {busy() ? "Saving…" : workspace()?.dirty ? "Save archive" : "Save"}
          </button>
        </div>
      </header>

      <div class="workspace-frame">
        <aside class="sidebar" aria-label="Workspace navigation">
          <div class="sidebar-workspace">
            <div class="workspace-monogram">
              {workspace() ? initials(workspace()!.manifest.displayName) : <Icon name="book" />}
            </div>
            <div class="workspace-switcher-copy">
              <span class="eyebrow">CURRENT WORKSPACE</span>
              <strong>{workspace()?.manifest.displayName ?? "Local workspace"}</strong>
            </div>
            <button
              class="icon-button workspace-more"
              type="button"
              title="Workspace actions"
              aria-label="Workspace actions"
              onClick={() => navigateToView("archive")}
            >
              <Icon name="more" />
            </button>
          </div>

          <nav class="nav-groups">
            <NavGroup
              title="Workspace"
              items={views.filter((item) => item.group === "workspace")}
            />
            <NavGroup title="Library" items={views.filter((item) => item.group === "library")} />
            <NavGroup title="Manage" items={views.filter((item) => item.group === "system")} />
          </nav>

          <div class="sidebar-bottom">
            <div class="privacy-card">
              <span class="privacy-icon">
                <Icon name="shield" />
              </span>
              <div>
                <strong>Private by design</strong>
                <span>Your records stay with you.</span>
              </div>
            </div>
            <div class="sidebar-account">
              <div class="account-avatar">T</div>
              <div class="account-copy">
                <strong>Teaching practice</strong>
                <span>{platform.kind === "desktop" ? "Desktop app" : "Browser workspace"}</span>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Preferences"
                onClick={() => navigateToView("settings")}
              >
                <Icon name="more" />
              </button>
            </div>
          </div>
        </aside>

        <main
          class="main-content"
          id="main-content"
          tabindex="-1"
          ref={(element) => (mainContentElement = element)}
        >
          <div class="page-toolbar">
            <div class="breadcrumbs">
              <span>Workspace</span>
              <Icon name="chevron" />
              <strong>{activeView().label}</strong>
            </div>
            <div class="toolbar-actions">
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
                <label class="inline-search">
                  <Icon name="search" />
                  <input
                    ref={(element) => (pageSearchInput = element)}
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder={`Search ${activeView().label.toLocaleLowerCase()}…`}
                    aria-label={`Search ${activeView().label}`}
                    aria-keyshortcuts="Control+F Meta+F"
                  />
                  <kbd class="inline-search-shortcut">
                    {navigator.platform.includes("Mac") ? "⌘F" : "Ctrl F"}
                  </kbd>
                </label>
              </Show>
              <button
                class="icon-button toolbar-more"
                type="button"
                title="Quick actions"
                aria-label="Quick actions"
                onClick={openPalette}
              >
                <Icon name="more" />
              </button>
            </div>
          </div>

          <Show when={!workspace()}>
            <Welcome
              onOpen={() => void openArchive()}
              onCreate={() => openDialog("archive")}
              loading={loading()}
            />
          </Show>
          <Show when={workspace()} keyed>
            {(state) => (
              <>
                <Show when={state.snapshot.locked}>
                  <section class="locked-banner locked-panel">
                    <Icon name="shield" />
                    <div class="locked-copy">
                      <strong>This archive is encrypted</strong>
                      <p>
                        Enter its passphrase to authenticate the archive and unlock its records.
                      </p>
                    </div>
                    <UnlockArchivePanel onUnlock={unlockCurrentArchive} busy={busy()} />
                  </section>
                </Show>
                <Show when={view() === "home"}>
                  <Overview
                    state={state}
                    onNavigate={navigateToView}
                    onCreate={openDialog}
                    onOpen={() => void openArchive()}
                  />
                </Show>
                <Show when={view() === "students"}>
                  <RecordPage
                    kind="students"
                    records={filteredRecords()}
                    state={state}
                    onWriteRecords={(records, message) => addRecords(records, message)}
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
                    state={state}
                    onRestoreSessionVersion={restoreSessionVersion}
                    onAdd={() => openDialog("session")}
                    onEdit={(record) => editRecord("session", record)}
                    onTrash={(record) => void reviewSessionTrash(record)}
                    onTransition={(record, action) => void transitionSession(record, action)}
                    onClone={(record) => void duplicateSession(record)}
                    onExportSessionPackage={(record) => void exportSessionPackageFile(record)}
                    onImportSessionPackage={(studentId) => void importSessionPackageFile(studentId)}
                    onArchive={(record, archived) =>
                      void updateSessionArchiveState(record, archived)
                    }
                  />
                </Show>
                <Show when={view() === "transcripts"}>
                  <TranscriptPage
                    snapshot={state.snapshot}
                    sessions={state.sessions}
                    records={filteredRecords()}
                    assets={state.assets}
                    tracks={state.audioTracks}
                    recordingTakes={state.assets.filter(
                      (record) => record.fields.get("record_role") === "recording-take",
                    )}
                    trashedRecordingTakes={state.trashedRecordingTakes}
                    trashedRecordingTracks={state.trashedRecordingTracks}
                    selectedSessionId={selectedTranscriptSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onSelectSession={setSelectedTranscriptSessionId}
                    onNewSession={() => openDialog("session")}
                    onImport={(file, sessionId) => void importTranscript(file, sessionId)}
                    onImportAudio={(file, sessionId, allowAdditionalTrack) =>
                      void importWave(file, sessionId, allowAdditionalTrack)
                    }
                    onImportCompressedAudio={(sessionId, allowAdditionalTrack) =>
                      void importCompressedAudioFile(sessionId, allowAdditionalTrack)
                    }
                    onRecoverAudio={(sessionId) => void recoverWavImport(sessionId)}
                    onRecoverNativeAudio={(sessionId) => void recoverNativeAudio(sessionId)}
                    onRecordAudio={(file, sessionId, consentAtUs) =>
                      importCapturedAudio(file, sessionId, consentAtUs)
                    }
                    onExportAudio={(sessionId, trackId, label, fillGapsWithSilence) =>
                      void exportAudioTrack(sessionId, trackId, label, fillGapsWithSilence)
                    }
                    onRenameRecordingTake={(take, label) => void saveRecordingTakeName(take, label)}
                    onRenameRecordingTrack={(track, label) =>
                      void saveRecordingTrackName(track, label)
                    }
                    onTrashRecordingTrack={(track) => void changeRecordingTrackTrash(track, true)}
                    onRestoreRecordingTrack={(track) =>
                      void changeRecordingTrackTrash(track, false)
                    }
                    onTrashRecordingTake={(take) => void changeRecordingTakeTrash(take, true)}
                    onRestoreRecordingTake={(take) => void changeRecordingTakeTrash(take, false)}
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
                    onExport={(sessionId, format) => void exportTranscript(sessionId, format)}
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
                    archiveId={state.snapshot.header.id}
                    sessions={[...state.sessions, ...state.archivedSessions]}
                    assets={state.assets}
                    customTemplates={state.guideTemplates}
                    jobs={state.aiJobs}
                    providerSettings={state.providerSettings}
                    credentials={state.credentials}
                    systemCredentialStoreAvailable={systemCredentialStoreAvailable()}
                    hasSystemCredential={platform.hasAiCredential}
                    encrypted={state.snapshot.encrypted}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate}
                    busy={busy()}
                    execution={
                      lastAiExecution()?.archiveId === state.snapshot.header.id
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
                    sessions={state.sessions}
                    records={filteredRecords()}
                    assets={state.assets}
                    evidence={state.evidence}
                    onWriteRecords={(records, message) => addRecords(records, message)}
                    selectedSessionId={selectedAnnotationSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onSelectSession={setSelectedAnnotationSessionId}
                    onSave={saveAnnotation}
                    onRemove={(record) => setPendingDelete(record)}
                    onDuplicate={(record) =>
                      addRecords([duplicateAnnotationRecord(record)], "Observation duplicated.")
                    }
                    onNewSession={() => openDialog("session")}
                    onHistory={getAnnotationHistory}
                    onRestore={restoreAnnotationRevision}
                    onPlayFromTimestamp={(record) => void playObservationFromTimestamp(record)}
                  />
                </Show>
                <Show when={view() === "journal"}>
                  <RecordPage
                    kind="journal"
                    records={filteredRecords()}
                    state={state}
                    onWriteRecords={(records, message) => addRecords(records, message)}
                    onAdd={() => openDialog("journal")}
                    onEdit={(record) => editRecord("journal", record)}
                    onSaveOrganizer={(record, message) => addRecords([record], message)}
                    onArchiveOrganizer={(record) =>
                      void addRecords(
                        archiveJournalOrganizerRecord(record, state.entries),
                        "Label archived. Its links can be restored with the label.",
                      )
                    }
                    onRestoreOrganizer={(record) =>
                      void addRecords(
                        restoreJournalOrganizerRecord(record, state.entries),
                        "Label restored with its previous entry links.",
                      )
                    }
                  />
                </Show>
                <Show when={view() === "guides"}>
                  <GuidesPage
                    snapshot={state.snapshot}
                    records={filteredRecords()}
                    sessions={[...state.sessions, ...state.archivedSessions]}
                    entries={state.entries}
                    students={state.students}
                    sourceRecords={guideSourceRecords(state)}
                    customTemplates={state.guideTemplates}
                    trashedTemplates={state.trashedGuideTemplates}
                    templateManagerOpen={guideTemplateManagerOpen()}
                    onToggleTemplateManager={() => setGuideTemplateManagerOpen((open) => !open)}
                    disabled={!state.snapshot.canMutate}
                    busy={busy()}
                    onOpenSessions={() => navigateToView("sessions")}
                    onSave={saveGuide}
                    onRestoreVersion={restoreGuideVersion}
                    onApprove={(record) => void approveGuide(record)}
                    onTrash={(record) => void trashGuide(record)}
                    onExport={(record, format) => void exportGuide(record, format)}
                    onSaveTemplate={saveGuideTemplate}
                    onTrashTemplate={(record) => void trashGuideTemplate(record)}
                    onRestoreTemplate={(record) => void restoreGuideTemplate(record)}
                    onExportTemplate={(template) => void exportGuideTemplate(template)}
                  />
                </Show>
                <Show when={view() === "evidence"}>
                  <EvidencePage
                    snapshot={state.snapshot}
                    sessions={state.sessions}
                    records={filteredRecords()}
                    edges={state.evidenceEdges}
                    transcripts={state.transcripts}
                    assets={state.assets}
                    selectedSessionId={selectedEvidenceSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
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
                    sessions={state.sessions}
                    snapshot={state.snapshot}
                    onWriteRecords={(records, message) => addRecords(records, message)}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onImport={importAssets}
                    onPreview={loadAssetPreview}
                    onExport={(record) => void exportAsset(record)}
                  />
                </Show>
                <Show when={view() === "trash"}>
                  <TrashPage
                    records={state.trashedStudents}
                    journalEntries={state.trashedJournalEntries}
                    annotations={state.trashedAnnotations}
                    guides={state.trashedGuides}
                    evidence={state.trashedEvidence}
                    evidenceEdges={state.trashedEvidenceEdges}
                    noteBlocks={state.notesDocuments.flatMap(
                      (document) => readRemovedNoteBlocks(document) ?? [],
                    )}
                    sessions={state.trashedSessions}
                    onRestore={(record) => void restoreStudent(record)}
                    onRestoreJournalEntry={(record) => void restoreJournalEntry(record)}
                    onRestoreAnnotation={(record) => void restoreTrashedAnnotation(record)}
                    onRestoreGuide={(record) => void restoreGuide(record)}
                    onRestoreEvidence={(record) => void restoreEvidence(record)}
                    onRestoreEvidenceEdge={(record) => void restoreTrashedEvidenceEdge(record)}
                    onRestoreNoteBlock={(block) => void restoreTrashedNoteBlock(block)}
                    onRestoreSession={(record) => void restoreSessionGroup(record)}
                    pendingPurge={pendingTrashPurge()}
                    onBeginPurge={() => void beginTrashPurge()}
                    onCancelPurge={() => setPendingTrashPurge(null)}
                    onConfirmPurge={() => void confirmTrashPurge()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                  />
                </Show>
                <Show when={view() === "archive"}>
                  <ArchivePage
                    state={state}
                    busy={busy()}
                    onApplyMaintenance={applyArchiveMaintenance}
                    onSave={() => void saveCurrentArchive()}
                    onOpen={() => void openArchive()}
                    onLock={() => void lockCurrentArchive()}
                  />
                </Show>
                <Show when={view() === "settings"}>
                  <SettingsPage
                    theme={theme()}
                    themeMode={themeMode()}
                    onThemeMode={chooseThemeMode}
                    state={state}
                    busy={busy()}
                    onChangePassphrase={() => openDialog("passphrase")}
                    onEnableEncryption={enableCurrentEncryption}
                    onSaveArchive={() => void saveCurrentArchive()}
                    onSaveMarkerKeys={saveMarkerKeys}
                    onSaveSettings={(records, message) => addRecords(records, message)}
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
          <div class={`toast toast-${item().tone}`} role="status" aria-live="polite">
            <span class="toast-mark">
              <Icon
                name={
                  item().tone === "success" ? "check" : item().tone === "error" ? "close" : "spark"
                }
              />
            </span>
            <span>{item().message}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification">
              <Icon name="close" />
            </button>
          </div>
        )}
      </Show>

      <Show when={observationPlayback()}>
        {(playback) => (
          <section
            class="transcript-audio-panel"
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
            <div class="transcript-audio-copy">
              <strong>{playback().title}</strong>
              <span>Playing from {playback().start}</span>
            </div>
            <audio
              controls
              autoplay
              src={playback().url}
              ref={(element) => queueMicrotask(() => void element.play().catch(() => undefined))}
            />
            <button
              class="button button-quiet record-action"
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

      <Show when={dialog()}>
        {(kind) => (
          <FormDialog
            kind={kind()}
            state={workspace()}
            record={dialogRecord()}
            notesDocument={
              workspace()?.notesDocuments.find(
                (record) => record.id === dialogRecord()?.fields.get("notes_document_id"),
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
                ? [...(state?.sessions ?? []), ...(state?.archivedSessions ?? [])].find(
                    (item) => item.id === record.id,
                  )
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
              void addRecords(
                latest
                  ? updateSessionRecords(latest, input, latestNotes, updateNotes)
                  : makeSessionRecords(input, {
                      ensureJournalRoot: !(workspace()?.journals.length ?? 0),
                    } satisfies SessionCreateOptions),
                record ? "Session details updated." : undefined,
              ).catch((error: unknown) => announce(errorMessage(error), "error"));
            }}
            onSaveJournal={(input, record, notesDocument, updateNotes) => {
              const state = workspace();
              const latest = record ? state?.entries.find((item) => item.id === record.id) : null;
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
              if (record().type === RecordType.annotation) void trashAnnotation(record());
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
          class="palette-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) closePalette();
          }}
        >
          <ManagedDialog
            class="command-palette"
            role="dialog"
            labelledBy="palette-title"
            onKeyDown={handlePaletteKeys}
            onEscape={() => closePalette()}
            restoreFocus={() => false}
          >
            <div class="palette-search">
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
              />
              <kbd>esc</kbd>
            </div>
            <h2 id="palette-title">Quick actions</h2>
            <div class="palette-actions">
              <For each={matchingActions()}>
                {(action, index) => (
                  <button
                    type="button"
                    class={`palette-action ${paletteIndex() === index() ? "is-active" : ""}`}
                    data-active={paletteIndex() === index()}
                    onMouseEnter={() => setPaletteIndex(index())}
                    onFocus={() => setPaletteIndex(index())}
                    onClick={() => action.run()}
                  >
                    <span class="palette-action-icon">
                      <Icon name={action.icon} />
                    </span>
                    <span>
                      <strong>{action.label}</strong>
                      <small>{action.detail}</small>
                    </span>
                    <Icon name="arrow" />
                  </button>
                )}
              </For>
            </div>
            <Show when={matchingActions().length === 0}>
              <p class="palette-empty">No actions match your search.</p>
            </Show>
            <div class="palette-footer">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> move <kbd>Tab</kbd> cycle focus
              </span>
              <span>
                <kbd>↵</kbd> select <kbd>Esc</kbd> close
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
            class="guide-print-preview"
            aria-hidden="true"
            ref={(element) => element.replaceChildren(content)}
          />
        )}
      </Show>
    </div>
  );

  function NavGroup(props: { title: string; items: readonly ViewDefinition[] }): JSX.Element {
    return (
      <div class="nav-group">
        <span class="nav-group-title">{props.title}</span>
        <For each={props.items}>
          {(item) => (
            <button
              class={`nav-item ${view() === item.id ? "is-active" : ""}`}
              type="button"
              aria-label={item.label}
              aria-current={view() === item.id ? "page" : undefined}
              onClick={() => {
                navigateToView(item.id);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <Show when={item.id === "sessions" && workspace()?.sessions.length}>
                <span class="nav-count" aria-hidden="true">
                  {workspace()?.sessions.length}
                </span>
              </Show>
              <Show
                when={
                  item.id === "trash" &&
                  (workspace()?.trashedStudents.length ?? 0) +
                    (workspace()?.trashedAnnotations.length ?? 0) +
                    (workspace()?.trashedGuides.length ?? 0) +
                    (workspace()?.trashedEvidence.length ?? 0) +
                    (workspace()?.trashedEvidenceEdges.length ?? 0) +
                    (workspace()?.trashedSessions.length ?? 0)
                }
              >
                <span class="nav-count" aria-hidden="true">
                  {(workspace()?.trashedStudents.length ?? 0) +
                    (workspace()?.trashedAnnotations.length ?? 0) +
                    (workspace()?.trashedGuides.length ?? 0) +
                    (workspace()?.trashedEvidence.length ?? 0) +
                    (workspace()?.trashedEvidenceEdges.length ?? 0) +
                    (workspace()?.trashedSessions.length ?? 0)}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
    );
  }
}

function Welcome(props: {
  onOpen: () => void;
  onCreate: () => void;
  loading: boolean;
}): JSX.Element {
  return (
    <div class="welcome-page">
      <section class="welcome-hero">
        <div class="welcome-copy">
          <span class="eyebrow welcome-eyebrow">
            <span /> A thoughtful space for teaching
          </span>
          <h1>
            Your work with learners,
            <br />
            <em>beautifully gathered.</em>
          </h1>
          <p>
            Keep notes, sessions, and study materials in one private, portable workspace that
            belongs to you.
          </p>
          <div class="welcome-actions">
            <button
              class="button button-primary button-large"
              type="button"
              onClick={() => props.onCreate()}
              disabled={props.loading}
            >
              <Icon name="plus" />
              Create your workspace
              <Icon name="arrow" />
            </button>
            <button
              class="button button-outline button-large"
              type="button"
              onClick={() => props.onOpen()}
              disabled={props.loading}
            >
              <Icon name="folder" />
              Open an archive
            </button>
          </div>
          <div class="welcome-promise">
            <Icon name="shield" />
            <span>Local first · Portable by design · No account required</span>
          </div>
        </div>
        <div class="welcome-art" aria-hidden="true">
          <div class="art-orbit orbit-one" />
          <div class="art-orbit orbit-two" />
          <div class="art-paper">
            <div class="art-paper-head">
              <span class="art-brand-dot" />
              <span>TUTORING NOTES</span>
              <span>•••</span>
            </div>
            <div class="art-paper-title" />
            <div class="art-paper-line line-long" />
            <div class="art-paper-line" />
            <div class="art-paper-line line-mid" />
            <div class="art-paper-note">
              <span />
              <div>
                <i />
                <i />
              </div>
            </div>
            <div class="art-paper-footer">
              <span>STUDENT PROGRESS</span>
              <strong>+ 24%</strong>
            </div>
            <div class="art-paper-chart">
              <span style={{ "--bar": "36%" }} />
              <span style={{ "--bar": "52%" }} />
              <span style={{ "--bar": "44%" }} />
              <span style={{ "--bar": "68%" }} />
              <span style={{ "--bar": "60%" }} />
              <span style={{ "--bar": "82%" }} />
              <span style={{ "--bar": "96%" }} />
            </div>
          </div>
          <div class="art-floating art-note">
            <span class="floating-dot" />
            <div>
              <strong>Lesson reflection</strong>
              <small>Saved just now</small>
            </div>
            <Icon name="check" />
          </div>
          <div class="art-floating art-student">
            <span class="student-face">M</span>
            <div>
              <strong>Maya Chen</strong>
              <small>Algebra · Year 8</small>
            </div>
            <span class="student-progress">+12%</span>
          </div>
          <div class="art-leaf leaf-one" />
          <div class="art-leaf leaf-two" />
        </div>
      </section>
      <section class="welcome-features">
        <div class="feature-intro">
          <span class="eyebrow">MADE FOR THE RHYTHM OF TEACHING</span>
          <h2>
            Everything has a place.
            <br />
            <span>Nothing gets in the way.</span>
          </h2>
        </div>
        <div class="feature-grid">
          <Feature
            icon="journal"
            title="A living journal"
            text="Collect reflections and lesson notes as your practice grows."
          />
          <Feature
            icon="students"
            title="People, not paperwork"
            text="Keep each learner’s goals and progress close at hand."
          />
          <Feature
            icon="sessions"
            title="Sessions that connect"
            text="Bring notes, recordings, and materials together."
          />
          <Feature
            icon="archive"
            title="Yours to keep"
            text="One open archive file, easy to back up and move."
          />
        </div>
      </section>
      <footer class="welcome-footer">
        <span>Designed for focused, human teaching.</span>
        <span>Windows · macOS · Linux · Web</span>
      </footer>
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
    now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
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
    <div class="page-body overview-page">
      <section class="overview-heading">
        <div>
          <span class="eyebrow">{formatFullDate(now)}</span>
          <h1>{greeting}, teacher.</h1>
          <p>Here’s a clear view of the work you’re doing with your learners.</p>
        </div>
        <div class="heading-action-group">
          <button class="button button-outline" type="button" onClick={() => props.onOpen()}>
            <Icon name="folder" />
            Switch archive
          </button>
          <button
            class="button button-primary"
            type="button"
            onClick={() => props.onCreate("session")}
            disabled={!props.state.snapshot.canMutate}
          >
            <Icon name="plus" />
            New session
          </button>
        </div>
      </section>

      <section class="overview-stat-grid" aria-label="Workspace summary">
        <StatCard
          label="Students"
          value={props.state.students.length}
          detail={
            props.state.students.length === 1 ? "learner in your care" : "learners in your care"
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

      <div class="overview-content-grid">
        <section class="surface-card activity-card" aria-labelledby="activity-title">
          <div class="card-heading">
            <div>
              <span class="eyebrow">TEACHING RHYTHM</span>
              <h2 id="activity-title">Your sessions</h2>
            </div>
            <div class="segmented-control" aria-label="Activity time range">
              <button
                class={filter() === "week" ? "selected" : ""}
                onClick={() => setFilter("week")}
              >
                7 days
              </button>
              <button
                class={filter() === "month" ? "selected" : ""}
                onClick={() => setFilter("month")}
              >
                4 weeks
              </button>
            </div>
          </div>
          <div class="activity-summary">
            <strong>{activity().reduce((sum, value) => sum + value.count, 0)}</strong>
            <span>sessions recorded in this period</span>
          </div>
          <div
            class={`activity-chart ${filter() === "month" ? "is-month" : ""}`}
            role="img"
            aria-label={`${activity().reduce((sum, value) => sum + value.count, 0)} sessions over the last ${filter() === "week" ? "seven days" : "four weeks"}`}
          >
            <div class="chart-grid">
              <span />
              <span />
              <span />
              <span />
            </div>
            <For each={activity()}>
              {(item) => (
                <div class="chart-column">
                  <div class="chart-bar-wrap">
                    <div
                      class="chart-bar"
                      style={{ height: `${Math.max(4, item.count * 26)}px` }}
                      title={`${item.count} sessions`}
                    >
                      <span>{item.count > 0 ? item.count : ""}</span>
                    </div>
                  </div>
                  <span class="chart-label">{item.label}</span>
                </div>
              )}
            </For>
          </div>
          <div class="chart-legend">
            <span class="legend-dot" />
            Sessions completed <span class="chart-note">Your archive stays on this device</span>
          </div>
        </section>

        <section class="surface-card focus-card" aria-labelledby="focus-title">
          <div class="card-heading">
            <div>
              <span class="eyebrow">YOUR LEARNERS</span>
              <h2 id="focus-title">Students to keep close</h2>
            </div>
            <button class="text-action" type="button" onClick={() => props.onNavigate("students")}>
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
            <div class="student-peek-list">
              <For each={props.state.students.slice(0, 4)}>
                {(student, index) => (
                  <button
                    class="student-peek"
                    type="button"
                    onClick={() => props.onNavigate("students")}
                  >
                    <span class={`student-avatar avatar-${index() % 5}`}>
                      {initials(field(student, "display_name", "S"))}
                    </span>
                    <span class="student-peek-copy">
                      <strong>{field(student, "display_name", "Student")}</strong>
                      <small>
                        {[field(student, "grade"), field(student, "subjects")]
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

        <section class="surface-card recent-card" aria-labelledby="recent-title">
          <div class="card-heading">
            <div>
              <span class="eyebrow">KEEP THE THREAD</span>
              <h2 id="recent-title">Recent sessions</h2>
            </div>
            <button class="text-action" type="button" onClick={() => props.onNavigate("sessions")}>
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
            <div class="recent-session-list">
              <For each={recentSessions()}>
                {(session) => <SessionRow session={session} students={props.state.students} />}
              </For>
            </div>
          </Show>
        </section>

        <section class="surface-card journal-peek-card" aria-labelledby="journal-peek-title">
          <div class="card-heading">
            <div>
              <span class="eyebrow">SMALL OBSERVATIONS, BIG PICTURE</span>
              <h2 id="journal-peek-title">Journal</h2>
            </div>
            <button class="text-action" type="button" onClick={() => props.onNavigate("journal")}>
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
            <div class="journal-peek-list">
              <For each={recentEntries()}>
                {(entry) => (
                  <button
                    class="journal-peek"
                    type="button"
                    onClick={() => props.onNavigate("journal")}
                  >
                    <span class="journal-date">
                      <strong>{dateParts(field(entry, "entry_date")).day}</strong>
                      <small>{dateParts(field(entry, "entry_date")).month}</small>
                    </span>
                    <span>
                      <strong>{field(entry, "title", "Untitled entry")}</strong>
                      <small>{field(entry, "entry_date")}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
      <div class="overview-footnote">
        <span>
          <Icon name="shield" />
          Your archive is stored locally
        </span>
        <button type="button" onClick={() => props.onNavigate("archive")}>
          Archive details <Icon name="arrow" />
        </button>
      </div>
    </div>
  );
}

function timestampForEvidence(record: ArchiveRecord): bigint {
  try {
    const timestamp = BigInt(field(record, "start_time_us", "0"));
    return timestamp < 0n ? 0n : timestamp;
  } catch {
    return 0n;
  }
}

function evidenceTranscriptLabel(record: ArchiveRecord): string {
  const speaker = field(record, "speaker_label");
  const text = field(record, "text").replace(/\s+/gu, " ").trim();
  const preview = Array.from(text).slice(0, 96).join("");
  return `${formatTranscriptTimestampUs(timestampForEvidence(record))}${speaker ? ` · ${speaker}` : ""} — ${preview || "Empty segment"}`;
}

function EvidencePage(props: {
  snapshot: ArchiveSnapshot;
  sessions: ArchiveRecord[];
  records: ArchiveRecord[];
  edges: ArchiveRecord[];
  transcripts: ArchiveRecord[];
  assets: ArchiveRecord[];
  selectedSessionId: string;
  disabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onExtract: (sessionId: string) => void;
  onCreate: (sessionId: string, segmentId: string, input: EvidenceCreateInput) => Promise<boolean>;
  onReview: (record: ArchiveRecord, outcome: "human-verified" | "rejected") => void;
  onLink: (fromId: string, toId: string, relationship: string) => void;
  onUnlink: (edge: ArchiveRecord) => void;
  onUpdate: (record: ArchiveRecord, input: EvidenceUpdateInput) => Promise<boolean>;
  onTrash: (record: ArchiveRecord) => void;
}): JSX.Element {
  const [fromId, setFromId] = createSignal("");
  const [toId, setToId] = createSignal("");
  const [evidenceFilter, setEvidenceFilter] = createSignal<"all" | "review" | "verified">("all");
  const [sourceSegmentId, setSourceSegmentId] = createSignal("");
  const [createTitle, setCreateTitle] = createSignal("");
  const [createType, setCreateType] = createSignal("tutor-observation");
  const [createPriority, setCreatePriority] = createSignal("normal");
  const [createContent, setCreateContent] = createSignal("");
  const [relationship, setRelationship] =
    createSignal<(typeof EVIDENCE_RELATIONSHIPS)[number]>("supports");
  const selectedSession = createMemo(
    () =>
      props.sessions.find((session) => session.id === props.selectedSessionId) ??
      props.sessions[0] ??
      null,
  );
  const createdAt = (record: ArchiveRecord): bigint => {
    try {
      return BigInt(field(record, "created_at_us", "0"));
    } catch {
      return 0n;
    }
  };
  const sessionRecords = createMemo(() => {
    const session = selectedSession();
    if (!session) return [] as ArchiveRecord[];
    return [...props.records]
      .filter((record) => field(record, "session_id") === session.id)
      .sort((left, right) => {
        const leftAt = createdAt(left);
        const rightAt = createdAt(right);
        return leftAt > rightAt ? -1 : leftAt < rightAt ? 1 : 0;
      });
  });
  const evidenceFilters = [
    { id: "all", label: "All evidence" },
    { id: "review", label: "Review queue" },
    { id: "verified", label: "Verified" },
  ] as const;
  const evidenceFilterCount = (filter: (typeof evidenceFilters)[number]["id"]): number => {
    if (filter === "all") return sessionRecords().length;
    if (filter === "verified")
      return sessionRecords().filter(
        (record) => field(record, "verification_state") === "human-verified",
      ).length;
    return sessionRecords().filter(
      (record) => field(record, "verification_state", "needs-review") !== "human-verified",
    ).length;
  };
  const visibleEvidenceRecords = createMemo(() => {
    const filter = evidenceFilter();
    return sessionRecords().filter((record) => {
      const state = field(record, "verification_state", "needs-review");
      return (
        filter === "all" ||
        (filter === "verified" ? state === "human-verified" : state !== "human-verified")
      );
    });
  });
  const sessionTranscripts = createMemo(() => {
    const session = selectedSession();
    if (!session) return [] as ArchiveRecord[];
    return [...props.transcripts]
      .filter((record) => field(record, "session_id").toLowerCase() === session.id.toLowerCase())
      .sort((left, right) => {
        const leftAt = timestampForEvidence(left);
        const rightAt = timestampForEvidence(right);
        return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : left.id.localeCompare(right.id);
      });
  });
  const selectedSegment = createMemo(
    () => sessionTranscripts().find((record) => record.id === sourceSegmentId()) ?? null,
  );
  const selectedSegmentAssetIds = createMemo(() =>
    (selectedSegment()?.fields.get("linked_asset_ids") ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
  const selectedSegmentAssets = createMemo(() => {
    const ids = new Set(selectedSegmentAssetIds());
    return props.assets.filter((asset) => ids.has(asset.id.toLowerCase()));
  });
  const sessionEdges = createMemo(() => {
    const ids = new Set(sessionRecords().map((record) => record.id.toLowerCase()));
    const sessionId = selectedSession()?.id.toLowerCase() ?? "";
    return props.edges.filter(
      (edge) =>
        field(edge, "session_id").toLowerCase() === sessionId ||
        ids.has(field(edge, "from_id").toLowerCase()) ||
        ids.has(field(edge, "to_id").toLowerCase()),
    );
  });
  const graph = createMemo(() => createEvidenceGraphLayout(sessionRecords(), sessionEdges()));

  function chooseTranscriptSource(segmentId: string): void {
    setSourceSegmentId(segmentId);
    const segment = sessionTranscripts().find((record) => record.id === segmentId);
    if (!segment) {
      setCreateTitle("");
      setCreateType("tutor-observation");
      setCreateContent("");
      return;
    }
    const text = field(segment, "text");
    const candidate = classifyTranscriptEvidence(text)[0];
    setCreateTitle(candidate?.title ?? "Tutor observation");
    setCreateType(candidate?.type ?? "tutor-observation");
    setCreateContent(text);
  }

  function submitEvidence(event: SubmitEvent): void {
    event.preventDefault();
    const session = selectedSession();
    if (!session || !sourceSegmentId()) return;
    void props
      .onCreate(session.id, sourceSegmentId(), {
        title: createTitle(),
        type: createType(),
        priority: createPriority(),
        content: createContent(),
      })
      .then((saved) => {
        if (!saved) return;
        setSourceSegmentId("");
        setCreateTitle("");
        setCreateType("tutor-observation");
        setCreatePriority("normal");
        setCreateContent("");
      });
  }

  return (
    <div class="page-body evidence-page">
      <section class="record-heading evidence-heading">
        <div>
          <span class="eyebrow">A TRACEABLE RECORD OF LEARNING</span>
          <h1>Evidence</h1>
          <p>
            Review what the session supports, check each source revision, then connect related
            ideas.
          </p>
        </div>
        <button
          class="button button-primary"
          type="button"
          disabled={props.disabled || !selectedSession()}
          onClick={() => selectedSession() && props.onExtract(selectedSession()!.id)}
        >
          <Icon name="spark" />
          Extract session evidence
        </button>
      </section>

      <section class="evidence-session-bar surface-card">
        <label class="material-session-picker">
          <span>Session to review</span>
          <select
            value={selectedSession()?.id ?? ""}
            disabled={props.sessions.length === 0}
            onChange={(event) => {
              props.onSelectSession(event.currentTarget.value);
              setFromId("");
              setToId("");
              chooseTranscriptSource("");
            }}
            aria-label="Evidence session"
          >
            <Show when={props.sessions.length === 0}>
              <option value="">No sessions yet</option>
            </Show>
            <For each={props.sessions}>
              {(session) => (
                <option value={session.id}>{field(session, "title", "Untitled session")}</option>
              )}
            </For>
          </select>
        </label>
        <div class="evidence-session-counts">
          <span>
            <strong>
              {
                sessionRecords().filter(
                  (record) => field(record, "verification_state") === "needs-review",
                ).length
              }
            </strong>{" "}
            to review
          </span>
          <span>
            <strong>
              {
                sessionRecords().filter(
                  (record) => field(record, "verification_state") === "human-verified",
                ).length
              }
            </strong>{" "}
            verified
          </span>
          <span>
            <strong>{sessionEdges().length}</strong> links
          </span>
        </div>
      </section>

      <Show when={selectedSession()}>
        <section class="evidence-create surface-card" aria-labelledby="evidence-create-title">
          <div class="evidence-create-heading">
            <span class="eyebrow">TUTOR-AUTHORED SOURCE</span>
            <h2 id="evidence-create-title">Add evidence from a transcript</h2>
            <p>
              Write a reviewed claim and keep its source segment, revision, and linked materials
              attached.
            </p>
          </div>
          <form class="evidence-create-form" onSubmit={submitEvidence}>
            <label>
              <span>Transcript segment</span>
              <select
                aria-label="Transcript source segment"
                required
                value={sourceSegmentId()}
                disabled={props.disabled || sessionTranscripts().length === 0}
                onChange={(event) => chooseTranscriptSource(event.currentTarget.value)}
              >
                <option value="">Choose a transcript segment</option>
                <For each={sessionTranscripts()}>
                  {(segment) => (
                    <option value={segment.id}>{evidenceTranscriptLabel(segment)}</option>
                  )}
                </For>
              </select>
            </label>
            <label>
              <span>Title</span>
              <input
                aria-label="Evidence title"
                required
                maxLength={512}
                value={createTitle()}
                disabled={props.disabled || !sourceSegmentId()}
                onInput={(event) => setCreateTitle(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Type</span>
              <input
                aria-label="Evidence type"
                required
                maxLength={128}
                value={createType()}
                disabled={props.disabled || !sourceSegmentId()}
                onInput={(event) => setCreateType(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Priority</span>
              <select
                aria-label="Evidence priority"
                value={createPriority()}
                disabled={props.disabled || !sourceSegmentId()}
                onChange={(event) => setCreatePriority(event.currentTarget.value)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label class="evidence-create-content">
              <span>Evidence</span>
              <textarea
                aria-label="Evidence content"
                required
                value={createContent()}
                disabled={props.disabled || !sourceSegmentId()}
                onInput={(event) => setCreateContent(event.currentTarget.value)}
              />
            </label>
            <div class="evidence-create-footer">
              <Show
                when={selectedSegmentAssets().length > 0}
                fallback={
                  <small>
                    {selectedSegmentAssetIds().length > 0
                      ? "Linked material metadata is unavailable. Source IDs will still be preserved."
                      : "The source transcript revision will be recorded with this item."}
                  </small>
                }
              >
                <small>
                  Linked materials:{" "}
                  {selectedSegmentAssets()
                    .map((asset) => field(asset, "filename", "Material"))
                    .join(", ")}
                  {selectedSegmentAssetIds().length > selectedSegmentAssets().length
                    ? ` · ${selectedSegmentAssetIds().length - selectedSegmentAssets().length} unavailable`
                    : ""}
                </small>
              </Show>
              <button
                class="button button-primary"
                type="submit"
                disabled={
                  props.disabled ||
                  !selectedSession() ||
                  !sourceSegmentId() ||
                  !createTitle().trim() ||
                  !createType().trim() ||
                  !createContent().trim()
                }
              >
                Create evidence
              </button>
            </div>
          </form>
        </section>
      </Show>

      <Show
        when={selectedSession()}
        fallback={
          <section class="surface-card evidence-empty">
            <span class="material-empty-mark">
              <Icon name="evidence" />
            </span>
            <h2>Start with a tutoring session</h2>
            <p>Evidence is grounded in observations and transcript cues from a specific session.</p>
          </section>
        }
      >
        <Show
          when={sessionRecords().length > 0}
          fallback={
            <section class="surface-card evidence-empty">
              <span class="material-empty-mark">
                <Icon name="evidence" />
              </span>
              <h2>Evidence begins with what happened</h2>
              <p>
                Extract tutor observations and transcript cues from this session. Spoken cues stay
                unverified until you review them.
              </p>
              <button
                class="button button-outline"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onExtract(selectedSession()!.id)}
              >
                Extract evidence
              </button>
            </section>
          }
        >
          <section class="evidence-review-toolbar surface-card">
            <div class="evidence-review-toolbar-copy">
              <strong>Review session evidence</strong>
              <small>Rejected items stay in the review queue so you can reconsider them.</small>
            </div>
            <div
              class="evidence-review-filter-list"
              role="group"
              aria-label="Filter evidence by review status"
            >
              <For each={evidenceFilters}>
                {(filter) => (
                  <button
                    class="button button-quiet evidence-review-filter"
                    type="button"
                    aria-pressed={evidenceFilter() === filter.id}
                    onClick={() => setEvidenceFilter(filter.id)}
                  >
                    <span>{filter.label}</span>
                    <span class="evidence-review-filter-count">
                      {evidenceFilterCount(filter.id)}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </section>
          <section class="evidence-list" aria-label="Session evidence">
            <Show
              when={visibleEvidenceRecords().length > 0}
              fallback={
                <div class="evidence-filter-empty surface-card" role="status">
                  <span>
                    {evidenceFilter() === "review"
                      ? "Everything in this session has been verified."
                      : "There are no verified items in this session yet."}
                  </span>
                  <button
                    class="button button-quiet"
                    type="button"
                    onClick={() => setEvidenceFilter("all")}
                  >
                    Show all evidence
                  </button>
                </div>
              }
            >
              <For each={visibleEvidenceRecords()}>
                {(record) => (
                  <EvidenceCard
                    snapshot={props.snapshot}
                    record={record}
                    assets={props.assets}
                    disabled={props.disabled}
                    onReview={props.onReview}
                    onUpdate={props.onUpdate}
                    onTrash={props.onTrash}
                  />
                )}
              </For>
            </Show>
          </section>

          <section class="evidence-graph surface-card">
            <div class="evidence-graph-heading">
              <div>
                <span class="eyebrow">RELATIONSHIPS</span>
                <h2>Connect the evidence</h2>
              </div>
              <span>
                {graph().nodes.length} items · {graph().edges.length} links
              </span>
            </div>
            <div class="evidence-graph-legend" aria-label="Evidence map legend">
              <span>
                <i class="evidence-legend-dot evidence-legend-review" aria-hidden="true" />
                Needs review
              </span>
              <span>
                <i class="evidence-legend-dot evidence-legend-verified" aria-hidden="true" />
                Verified
              </span>
              <span>
                <i class="evidence-legend-line evidence-legend-contradiction" aria-hidden="true" />
                Contradicts
              </span>
            </div>
            <EvidenceNetwork layout={graph()} />
            <section
              class="evidence-contradictions"
              aria-labelledby="evidence-contradictions-title"
            >
              <div class="evidence-contradictions-heading">
                <div>
                  <span class="eyebrow">SOURCE REVIEW</span>
                  <h3 id="evidence-contradictions-title">Explicit contradiction links</h3>
                </div>
                <span>{graph().contradictions.length}</span>
              </div>
              <p>
                These pairs were explicitly linked as contradictions. Review each item’s source
                status above.
              </p>
              <Show
                when={graph().contradictions.length > 0}
                fallback={
                  <small>No evidence items are explicitly linked as contradicting another.</small>
                }
              >
                <div class="evidence-contradiction-list">
                  <For each={graph().contradictions}>
                    {(pair) => (
                      <div class="evidence-contradiction-row">
                        <span>{field(pair.first, "title", "Evidence item")}</span>
                        <strong>contradicts</strong>
                        <span>{field(pair.second, "title", "Evidence item")}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={graph().invalidEdgeCount > 0}>
                <p class="evidence-graph-warning" role="status">
                  {graph().invalidEdgeCount} relationship{graph().invalidEdgeCount === 1 ? "" : "s"}{" "}
                  could not be drawn because an endpoint or session reference is invalid.
                </p>
              </Show>
            </section>
            <form
              class="evidence-link-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (fromId() && toId()) props.onLink(fromId(), toId(), relationship());
              }}
            >
              <label>
                <span>From</span>
                <select
                  required
                  value={fromId()}
                  disabled={props.disabled}
                  onChange={(event) => setFromId(event.currentTarget.value)}
                >
                  <option value="">Choose evidence</option>
                  <For each={sessionRecords()}>
                    {(record) => (
                      <option value={record.id}>
                        {field(record, "title", field(record, "type", "Evidence"))}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label>
                <span>Relationship</span>
                <select
                  value={relationship()}
                  disabled={props.disabled}
                  onChange={(event) =>
                    setRelationship(
                      event.currentTarget.value as (typeof EVIDENCE_RELATIONSHIPS)[number],
                    )
                  }
                >
                  <For each={EVIDENCE_RELATIONSHIPS}>
                    {(value) => <option value={value}>{value.replaceAll("-", " ")}</option>}
                  </For>
                </select>
              </label>
              <label>
                <span>To</span>
                <select
                  required
                  value={toId()}
                  disabled={props.disabled}
                  onChange={(event) => setToId(event.currentTarget.value)}
                >
                  <option value="">Choose evidence</option>
                  <For each={sessionRecords()}>
                    {(record) => (
                      <option value={record.id}>
                        {field(record, "title", field(record, "type", "Evidence"))}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <button
                class="button button-outline"
                type="submit"
                disabled={props.disabled || sessionRecords().length < 2 || !fromId() || !toId()}
              >
                Add relationship
              </button>
            </form>
            <Show when={sessionEdges().length > 0}>
              <div class="evidence-edge-list">
                <For each={sessionEdges()}>
                  {(edge) => {
                    const from = () =>
                      sessionRecords().find(
                        (record) =>
                          record.id.toLowerCase() === field(edge, "from_id").toLowerCase(),
                      );
                    const to = () =>
                      sessionRecords().find(
                        (record) => record.id.toLowerCase() === field(edge, "to_id").toLowerCase(),
                      );
                    return (
                      <div class="evidence-edge-row">
                        <span>
                          {from()
                            ? field(from()!, "title", field(from()!, "type", "Evidence"))
                            : "Missing evidence item"}
                        </span>
                        <strong>
                          {field(edge, "relationship", "unknown").replaceAll("-", " ")}
                        </strong>
                        <span>
                          {to()
                            ? field(to()!, "title", field(to()!, "type", "Evidence"))
                            : "Missing evidence item"}
                        </span>
                        <button
                          class="button button-quiet"
                          type="button"
                          disabled={props.disabled || edge.fields.get("_deleted") === "true"}
                          aria-label={`Remove relationship: ${field(edge, "relationship", "unknown")}`}
                          onClick={() => props.onUnlink(edge)}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </section>
        </Show>
      </Show>
    </div>
  );
}

function EvidenceNetwork(props: { layout: EvidenceGraphLayout }): JSX.Element {
  const itemLabel = () => (props.layout.nodes.length === 1 ? "evidence item" : "evidence items");
  const relationshipLabel = () =>
    props.layout.edges.length === 1 ? "relationship" : "relationships";
  return (
    <div class="evidence-network-scroll" role="region" aria-label="Evidence relationship map">
      <svg
        class="evidence-network"
        viewBox={`0 0 ${props.layout.width} ${props.layout.height}`}
        role="img"
        aria-label={`${props.layout.nodes.length} ${itemLabel()} connected by ${props.layout.edges.length} ${relationshipLabel()}`}
      >
        <defs>
          <marker
            id="evidence-edge-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" class="evidence-network-arrow" />
          </marker>
        </defs>
        <For each={props.layout.edges}>
          {(edge) => {
            const relationship = field(edge.record, "relationship", "references");
            return (
              <g class={`evidence-network-link evidence-network-link-${relationship}`}>
                <path d={edge.path} marker-end="url(#evidence-edge-arrow)">
                  <title>{relationship.replaceAll("-", " ")}</title>
                </path>
                <text x={edge.labelX} y={edge.labelY - 5} text-anchor="middle">
                  {relationship.replaceAll("-", " ")}
                </text>
              </g>
            );
          }}
        </For>
        <For each={props.layout.nodes}>
          {(node) => {
            const state = field(node.record, "verification_state", "needs-review");
            const title = field(node.record, "title", "Evidence item");
            const titleCharacters = Array.from(title);
            const shortTitle =
              titleCharacters.length > 23 ? `${titleCharacters.slice(0, 22).join("")}…` : title;
            return (
              <g
                class={`evidence-network-node evidence-network-node-${state}`}
                transform={`translate(${node.x} ${node.y})`}
              >
                <title>{`${title} · ${state.replaceAll("-", " ")}`}</title>
                <rect width="176" height="64" rx="8" />
                <circle cx="14" cy="15" r="4" />
                <text class="evidence-network-state" x="24" y="18">
                  {state.replaceAll("-", " ")}
                </text>
                <text class="evidence-network-title" x="12" y="39">
                  {shortTitle}
                </text>
                <text class="evidence-network-type" x="12" y="55">
                  {field(node.record, "type", "learning evidence").replaceAll("-", " ")}
                </text>
              </g>
            );
          }}
        </For>
      </svg>
    </div>
  );
}

function EvidenceCard(props: {
  snapshot: ArchiveSnapshot;
  record: ArchiveRecord;
  assets: ArchiveRecord[];
  disabled: boolean;
  onReview: (record: ArchiveRecord, outcome: "human-verified" | "rejected") => void;
  onUpdate: (record: ArchiveRecord, input: EvidenceUpdateInput) => Promise<boolean>;
  onTrash: (record: ArchiveRecord) => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [type, setType] = createSignal("");
  const [priority, setPriority] = createSignal("");
  const [content, setContent] = createSignal("");
  const state = () => field(props.record, "verification_state", "needs-review");
  const sourceLabel = () => {
    const origin = field(props.record, "origin");
    if (field(props.record, "source_annotation_id")) return "Tutor observation";
    if (field(props.record, "source_segment_ids")) {
      return origin === "tutor-authored"
        ? "Tutor-authored transcript evidence"
        : "Transcript candidate";
    }
    return "Imported evidence";
  };
  const sourceAssetIds = () =>
    field(props.record, "source_asset_ids")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean);
  const sourceAssets = createMemo(() => {
    const ids = new Set(sourceAssetIds());
    return props.assets.filter((asset) => ids.has(asset.id.toLowerCase()));
  });
  const beginEditing = (): void => {
    setTitle(field(props.record, "title", "Evidence from this session"));
    setType(field(props.record, "type", "learning-evidence"));
    setPriority(field(props.record, "priority", "normal"));
    setContent(field(props.record, "content"));
    setEditing(true);
  };
  const save = (event: SubmitEvent): void => {
    event.preventDefault();
    void props
      .onUpdate(props.record, {
        title: title(),
        type: type(),
        priority: priority(),
        content: content(),
      })
      .then((saved) => {
        if (saved) setEditing(false);
      });
  };
  const timestamp = () => field(props.record, "start_time_us");
  const formattedTimestamp = () => {
    try {
      return formatTranscriptTimestampUs(BigInt(timestamp()));
    } catch {
      return "Timestamp unavailable";
    }
  };

  return (
    <article
      class={`evidence-card surface-card evidence-${state()}`}
      data-evidence-id={props.record.id}
    >
      <div class="evidence-card-rail" aria-hidden="true">
        <span />
      </div>
      <div class="evidence-card-content">
        <EvidenceSources record={props.record} snapshot={props.snapshot} />
        <header class="evidence-card-header">
          <div class="evidence-card-labels">
            <span class="eyebrow">{sourceLabel()}</span>
            <span class={`evidence-state evidence-state-${state()}`}>
              {state() === "human-verified"
                ? "Verified"
                : state() === "rejected"
                  ? "Rejected"
                  : "Needs review"}
            </span>
          </div>
          <span class="evidence-type">
            {field(props.record, "type", "learning evidence").replaceAll("-", " ")}
          </span>
        </header>
        <Show
          when={editing()}
          fallback={
            <>
              <h2>{field(props.record, "title", "Evidence from this session")}</h2>
              <p class="evidence-content">{field(props.record, "content")}</p>
            </>
          }
        >
          <form class="evidence-edit-form" onSubmit={save}>
            <label>
              <span>Title</span>
              <input
                value={title()}
                maxLength={512}
                required
                disabled={props.disabled}
                onInput={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
            <div class="evidence-edit-row">
              <label>
                <span>Type</span>
                <input
                  value={type()}
                  maxLength={128}
                  required
                  disabled={props.disabled}
                  onInput={(event) => setType(event.currentTarget.value)}
                />
              </label>
              <label>
                <span>Priority</span>
                <input
                  value={priority()}
                  maxLength={32}
                  required
                  disabled={props.disabled}
                  onInput={(event) => setPriority(event.currentTarget.value)}
                />
              </label>
            </div>
            <label>
              <span>Evidence</span>
              <textarea
                value={content()}
                maxLength={16 * 1024 * 1024}
                rows={5}
                required
                disabled={props.disabled}
                onInput={(event) => setContent(event.currentTarget.value)}
              />
            </label>
            <div class="evidence-review-actions">
              <button class="button button-primary" type="submit" disabled={props.disabled}>
                Save changes
              </button>
              <button
                class="button button-quiet"
                type="button"
                disabled={props.disabled}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Show>
        <div class="evidence-source-meta">
          <Show when={timestamp()}>
            <span>
              <Icon name="clock" /> {formattedTimestamp()}
            </span>
          </Show>
          <Show when={field(props.record, "detection_confidence")}>
            <span>Heuristic confidence {field(props.record, "detection_confidence")}</span>
          </Show>
          <Show when={field(props.record, "source_speaker_label")}>
            <span>Speaker: {field(props.record, "source_speaker_label")}</span>
          </Show>
          <For each={sourceAssets()}>
            {(asset) => (
              <span class="evidence-source-material">
                Material: {field(asset, "filename", "Untitled material")}
              </span>
            )}
          </For>
          <Show when={sourceAssetIds().length > sourceAssets().length}>
            <span>
              {sourceAssetIds().length - sourceAssets().length} linked materials unavailable
            </span>
          </Show>
        </div>
        <Show when={!editing()}>
          <div class="evidence-review-actions evidence-card-actions">
            <button
              class="button button-outline"
              type="button"
              disabled={props.disabled}
              onClick={beginEditing}
            >
              Edit evidence
            </button>
            <button
              class="button button-quiet"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onTrash(props.record)}
            >
              Move to Trash
            </button>
            <Show when={state() !== "human-verified"}>
              <button
                class="button button-primary"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onReview(props.record, "human-verified")}
              >
                Approve source
              </button>
            </Show>
            <button
              class="button button-quiet"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onReview(props.record, "rejected")}
            >
              {state() === "human-verified" ? "Revoke approval" : "Reject candidate"}
            </button>
          </div>
        </Show>
      </div>
    </article>
  );
}

function AssetPage(props: {
  records: ArchiveRecord[];
  sessions: ArchiveRecord[];
  snapshot: ArchiveSnapshot;
  onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
  disabled: boolean;
  onImport: (
    files: readonly File[],
    sessionId: string,
    onProgress: AssetBatchProgress,
  ) => Promise<boolean>;
  onPreview: (record: ArchiveRecord) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  onExport: (record: ArchiveRecord) => void;
}): JSX.Element {
  const [sessionId, setSessionId] = createSignal("");
  const [librarySessionFilter, setLibrarySessionFilter] = createSignal("all");
  const visibleRecords = createMemo(() =>
    filterAssetsBySession(
      props.records,
      librarySessionFilter() === "all" ? null : librarySessionFilter(),
    ),
  );
  const [preview, setPreview] = createSignal<{
    record: ArchiveRecord;
    url: string;
    mimeType: string;
    text: string | null;
    waveform: PcmWavAssetWaveform | null;
  } | null>(null);
  const [fileDropActive, setFileDropActive] = createSignal(false);
  const [dropStatus, setDropStatus] = createSignal("");
  let dragDepth = 0;
  let previewTrigger: HTMLButtonElement | undefined;

  onCleanup(() => {
    const active = preview();
    if (active) URL.revokeObjectURL(active.url);
  });

  async function openPreview(record: ArchiveRecord): Promise<void> {
    const loaded = await props.onPreview(record);
    if (!loaded) return;
    const previous = preview();
    if (previous) URL.revokeObjectURL(previous.url);
    const url = URL.createObjectURL(
      new Blob([loaded.bytes.slice().buffer], { type: loaded.mimeType }),
    );
    const textType = loaded.mimeType.startsWith("text/") || loaded.mimeType === "application/json";
    let text: string | null = null;
    if (textType && loaded.bytes.byteLength <= 2 * 1024 * 1024) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
      } catch {
        text = null;
      }
    }
    const waveform = loaded.mimeType.startsWith("audio/")
      ? buildPcmWavAssetWaveform(loaded.bytes)
      : null;
    setPreview({ record, url, mimeType: loaded.mimeType, text, waveform });
  }

  function closePreview(): void {
    const active = preview();
    if (active) URL.revokeObjectURL(active.url);
    setPreview(null);
    previewTrigger?.focus();
  }

  function containsFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function dragEnter(event: DragEvent): void {
    if (!containsFiles(event)) return;
    event.preventDefault();
    if (props.disabled) return;
    dragDepth += 1;
    setFileDropActive(true);
  }

  function dragLeave(event: DragEvent): void {
    if (!containsFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setFileDropActive(false);
  }

  function dragOver(event: DragEvent): void {
    if (!containsFiles(event)) return;
    event.preventDefault();
    if (!props.disabled && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function dropFiles(event: DragEvent): void {
    if (!containsFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setFileDropActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      setDropStatus("The drop did not contain any readable files.");
      return;
    }
    if (props.disabled) {
      setDropStatus("Finish the current archive operation before importing dropped files.");
      return;
    }

    setDropStatus(`Preparing ${files.length.toLocaleString()} dropped materials…`);
    void props
      .onImport(files, sessionId(), (phase, completed, total) => {
        if (phase === "staging" && completed === total) {
          setDropStatus("Verifying and finalizing the dropped materials…");
        } else {
          setDropStatus(
            `${phase === "checking" ? "Checking" : "Writing"} dropped material ${completed.toLocaleString()} of ${total.toLocaleString()}…`,
          );
        }
      })
      .then((imported) => {
        setDropStatus(
          imported
            ? `${files.length.toLocaleString()} dropped ${files.length === 1 ? "material is" : "materials are"} ready in the archive. Save to write them to disk.`
            : "Dropped file import was not completed. Review the archive message and try again.",
        );
      })
      .catch((error: unknown) => setDropStatus(errorMessage(error)));
  }

  return (
    <div
      class="page-body material-page"
      onDragEnter={dragEnter}
      onDragLeave={dragLeave}
      onDragOver={dragOver}
      onDrop={dropFiles}
    >
      <Show when={fileDropActive()}>
        <div class="material-file-drop-overlay" aria-hidden="true">
          <strong>Drop files to add them to Materials</strong>
          <span>
            {sessionId()
              ? "Files will be linked to the selected session."
              : "Files will be added to the general library."}
          </span>
        </div>
      </Show>
      <Show when={dropStatus()}>
        <p class="material-drop-status" role="status" aria-live="polite">
          {dropStatus()}
        </p>
      </Show>
      <section class="record-heading material-heading">
        <div>
          <span class="eyebrow">MATERIALS FOR THE WORK</span>
          <h1>Materials</h1>
          <p>
            Keep lesson files beside the sessions and observations they support. Imports are limited
            to 256 MiB per file.
          </p>
        </div>
        <MaterialImportControls
          disabled={props.disabled}
          onImport={(files, onProgress) => props.onImport(files, sessionId(), onProgress)}
        />
      </section>

      <section class="material-library surface-card">
        <div class="material-library-toolbar">
          <div>
            <span class="eyebrow">FILE LIBRARY</span>
            <strong>
              {visibleRecords().length} {visibleRecords().length === 1 ? "item" : "items"}
            </strong>
          </div>
          <label class="material-session-picker">
            <span>Show materials for</span>
            <select
              value={librarySessionFilter()}
              onChange={(event) => setLibrarySessionFilter(event.currentTarget.value)}
              aria-label="Show materials for"
            >
              <option value="all">All materials</option>
              <option value="">General library</option>
              <For each={props.sessions}>
                {(session) => (
                  <option value={session.id}>{field(session, "title", "Untitled session")}</option>
                )}
              </For>
            </select>
          </label>
          <label class="material-session-picker">
            <span>Link new material to</span>
            <select
              value={sessionId()}
              disabled={props.disabled}
              onChange={(event) => setSessionId(event.currentTarget.value)}
              aria-label="Session for imported material"
            >
              <option value="">General library</option>
              <For each={props.sessions}>
                {(session) => (
                  <option value={session.id}>{field(session, "title", "Untitled session")}</option>
                )}
              </For>
            </select>
          </label>
        </div>
        <Show
          when={visibleRecords().length > 0}
          fallback={
            <div class="material-empty">
              <span class="material-empty-mark">
                <Icon name="assets" />
              </span>
              <div>
                <h2>
                  {props.records.length === 0
                    ? "A thoughtful library starts with one file"
                    : "No materials in this view"}
                </h2>
                <p>
                  {props.records.length === 0
                    ? "Import a worksheet, reference image, recording, or document. Tutorux keeps its content inside this archive."
                    : "Choose another session or switch to All materials to see files from the rest of your library."}
                </p>
                <Show when={props.records.length > 0}>
                  <button
                    class="button button-outline"
                    type="button"
                    onClick={() => setLibrarySessionFilter("all")}
                  >
                    Show all materials
                  </button>
                </Show>
              </div>
            </div>
          }
        >
          <div class="material-grid">
            <For each={visibleRecords()}>
              {(record) => {
                const session = () =>
                  props.sessions.find((item) => item.id === field(record, "session_id"));
                const contentType = () => field(record, "mime_type", "application/octet-stream");
                const label = () => contentType().split("/")[0]?.toLocaleUpperCase() || "FILE";
                return (
                  <article class="material-card">
                    <div class="material-card-top">
                      <span class="material-file-glyph">
                        <Icon name="assets" />
                      </span>
                      <span class="material-type-badge">{label()}</span>
                    </div>
                    <div class="material-card-copy">
                      <h2 title={field(record, "filename", "Untitled material")}>
                        {field(record, "filename", "Untitled material")}
                      </h2>
                      <p>{contentType()}</p>
                    </div>
                    <div class="material-card-meta">
                      <span>{formatBytes(BigInt(field(record, "byte_size", "0")))}</span>
                      <span>{formatTimestamp(field(record, "created_at_us"))}</span>
                    </div>
                    <div class="material-card-footer">
                      <span class="material-link-context">
                        {session()
                          ? `Linked · ${field(session()!, "title", "Session")}`
                          : "General library"}
                      </span>
                      <div class="material-card-actions">
                        <button
                          class="button button-quiet record-action"
                          type="button"
                          disabled={props.disabled}
                          onClick={(event) => {
                            previewTrigger = event.currentTarget;
                            void openPreview(record);
                          }}
                        >
                          Preview
                        </button>
                        <button
                          class="button button-outline record-action"
                          type="button"
                          disabled={props.disabled}
                          onClick={() => props.onExport(record)}
                        >
                          Export
                        </button>
                      </div>
                    </div>
                    <Show when={field(record, "text_extraction_status")}>
                      <small class="material-extraction-note">
                        Text extraction: {field(record, "text_extraction_status")}
                      </small>
                    </Show>
                    <MaterialDetails
                      record={record}
                      snapshot={props.snapshot}
                      disabled={props.disabled}
                      onWriteRecords={props.onWriteRecords}
                    />
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
        <MaterialTrash
          snapshot={props.snapshot}
          disabled={props.disabled}
          onWriteRecords={props.onWriteRecords}
        />
      </section>
      <Show when={preview()}>
        {(active) => (
          <div
            class="material-preview-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) closePreview();
            }}
          >
            <ManagedDialog
              class="material-preview-dialog"
              role="dialog"
              label={`Preview ${field(active().record, "filename", "material")}`}
              onEscape={closePreview}
              restoreFocus={() => false}
            >
              <header class="material-preview-header">
                <div>
                  <span class="eyebrow">MATERIAL PREVIEW</span>
                  <h2>{field(active().record, "filename", "Untitled material")}</h2>
                </div>
                <button
                  class="icon-button"
                  type="button"
                  aria-label="Close preview"
                  onClick={closePreview}
                >
                  <Icon name="close" />
                </button>
              </header>
              <div class="material-preview-content">
                <Show
                  when={active().text !== null}
                  fallback={
                    active().mimeType.startsWith("image/") ? (
                      <img
                        src={active().url}
                        alt={field(active().record, "filename", "Material preview")}
                      />
                    ) : active().mimeType.startsWith("audio/") ? (
                      active().waveform ? (
                        <MaterialAudioPreview waveform={active().waveform!} url={active().url} />
                      ) : (
                        <audio controls src={active().url} />
                      )
                    ) : active().mimeType.startsWith("video/") ? (
                      <video controls src={active().url} />
                    ) : active().mimeType.startsWith("text/") ||
                      active().mimeType === "application/json" ? (
                      <div class="material-preview-unavailable">
                        Text previews are limited to 2 MiB. Export the verified original file to
                        read the full document.
                      </div>
                    ) : (
                      <div class="material-preview-unavailable">
                        Preview is unavailable for this file type. Export the verified original file
                        to open it in another app.
                      </div>
                    )
                  }
                >
                  <pre>{active().text}</pre>
                </Show>
              </div>
              <footer class="material-preview-footer">
                <span>
                  {active().mimeType} ·{" "}
                  {formatBytes(BigInt(field(active().record, "byte_size", "0")))}
                </span>
                <button
                  class="button button-outline"
                  type="button"
                  onClick={() => props.onExport(active().record)}
                >
                  Export original
                </button>
              </footer>
            </ManagedDialog>
          </div>
        )}
      </Show>
    </div>
  );
}

function RecordPage(props: {
  kind: "students" | "sessions" | "journal" | "guides" | "evidence" | "assets";
  records: ArchiveRecord[];
  state: Workspace;
  onAdd?: () => void;
  onEdit?: (record: ArchiveRecord) => void;
  onTrash?: (record: ArchiveRecord) => void;
  onTransition?: (record: ArchiveRecord, action: SessionTransitionAction) => void;
  onClone?: (record: ArchiveRecord) => void;
  onExportSessionPackage?: (record: ArchiveRecord) => void;
  onImportSessionPackage?: (studentId?: string) => void;
  onArchive?: (record: ArchiveRecord, archived: boolean) => void;
  onProgressReview?: (input: {
    student: ArchiveRecord;
    skill: string;
    classification: StudentProgressClassification;
    evidenceSourceIds: string[];
    reviewedBy: string;
    note: string;
  }) => Promise<boolean>;
  onSaveOrganizer?: (record: ArchiveRecord, message: string) => Promise<boolean>;
  onArchiveOrganizer?: (record: ArchiveRecord) => void;
  onRestoreOrganizer?: (record: ArchiveRecord) => void;
  onRestoreSessionVersion?: (current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>;
  onWriteRecords?: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
  const [collectionFilter, setCollectionFilter] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");
  const [journalSort, setJournalSort] = createSignal<"newest" | "oldest" | "title">("newest");
  const [journalFrom, setJournalFrom] = createSignal("");
  const [journalTo, setJournalTo] = createSignal("");
  const [hasSessions, setHasSessions] = createSignal<"all" | "yes" | "no">("all");
  const [sessionPackageStudentId, setSessionPackageStudentId] = createSignal("");
  const [sessionArchiveView, setSessionArchiveView] = createSignal<"current" | "archived">(
    "current",
  );
  const visibleRecords = createMemo(() => {
    if (props.kind === "sessions") {
      const showArchived = sessionArchiveView() === "archived";
      return props.records.filter(
        (record) => (field(record, "archived") === "true") === showArchived,
      );
    }
    if (props.kind !== "journal") return props.records;
    return props.records.filter((record) => {
      const collections = field(record, "collection_ids").split(",").filter(Boolean);
      const tags = field(record, "tag_ids").split(",").filter(Boolean);
      const date = field(record, "entry_date");
      const linkedSessionIds = field(record, "session_ids").split(",").filter(Boolean);
      const entryId = record.id.toLowerCase();
      const linkedSessionRecord =
        props.state.sessions.some(
          (session) => field(session, "entry_id").toLowerCase() === entryId,
        ) ||
        props.state.archivedSessions.some(
          (session) => field(session, "entry_id").toLowerCase() === entryId,
        );
      const hasLinkedSessions = linkedSessionIds.length > 0 || linkedSessionRecord;
      return (
        (!collectionFilter() || collections.includes(collectionFilter())) &&
        (!tagFilter() || tags.includes(tagFilter())) &&
        (!journalFrom() || (Boolean(date) && date >= journalFrom())) &&
        (!journalTo() || (Boolean(date) && date <= journalTo())) &&
        (hasSessions() === "all" || (hasSessions() === "yes") === hasLinkedSessions)
      );
    });
  });
  const displayedRecords = createMemo(() => {
    const records = [...visibleRecords()];
    if (props.kind !== "journal") {
      return records.sort((a, b) =>
        recordSort(props.kind, b).localeCompare(recordSort(props.kind, a)),
      );
    }
    return records.sort((left, right) => {
      const titleOrder = field(left, "title").localeCompare(field(right, "title"));
      if (journalSort() === "title") return titleOrder || left.id.localeCompare(right.id);
      const leftDate = field(left, "entry_date");
      const rightDate = field(right, "entry_date");
      if (!leftDate || !rightDate) {
        if (leftDate) return -1;
        if (rightDate) return 1;
        return titleOrder || left.id.localeCompare(right.id);
      }
      const dateOrder = leftDate.localeCompare(rightDate);
      if (journalSort() === "oldest") return dateOrder || titleOrder;
      return -dateOrder || titleOrder;
    });
  });
  const meta: Record<
    typeof props.kind,
    {
      eyebrow: string;
      title: string;
      description: string;
      emptyTitle: string;
      emptyText: string;
      action: string;
      icon: IconName;
    }
  > = {
    students: {
      eyebrow: "THE PEOPLE AT THE HEART OF IT",
      title: "Students",
      description:
        "Know each learner as a whole person. Keep their goals and progress close to your teaching.",
      emptyTitle: "Start with a learner",
      emptyText:
        "Student profiles help you connect session notes with the person you’re supporting.",
      action: "Add your first student",
      icon: "students",
    },
    sessions: {
      eyebrow: "EVERY CONVERSATION COUNTS",
      title: "Sessions",
      description:
        "A connected record of your tutoring work: notes, materials, and ideas for next time.",
      emptyTitle: "Make room for a first session",
      emptyText: "Record the shape of a lesson and the small moments that move learning forward.",
      action: "Create a session",
      icon: "sessions",
    },
    journal: {
      eyebrow: "NOTICE WHAT’S CHANGING",
      title: "Teaching journal",
      description:
        "A calm, chronological place for reflections, plans, and the details you want to remember.",
      emptyTitle: "Your first note can be small",
      emptyText:
        "Capture one thing you noticed, one question to return to, or one win worth remembering.",
      action: "Write a journal entry",
      icon: "journal",
    },
    guides: {
      eyebrow: "STRUCTURE THAT LEAVES ROOM",
      title: "Study guides",
      description:
        "Reusable guides and lesson structures, ready to adapt to the learner in front of you.",
      emptyTitle: "No study guides yet",
      emptyText: "Guides from this archive will be gathered here when they’re available.",
      action: "Create a guide",
      icon: "guides",
    },
    evidence: {
      eyebrow: "GROWTH YOU CAN POINT TO",
      title: "Learning evidence",
      description:
        "Observations and source material that make a learner’s progress easier to see and revisit.",
      emptyTitle: "Evidence builds over time",
      emptyText: "Verified observations and learning sources from this archive will appear here.",
      action: "Explore sessions",
      icon: "evidence",
    },
    assets: {
      eyebrow: "MATERIALS FOR THE WORK",
      title: "Materials",
      description: "Files and resources connected to the tutoring work in this archive.",
      emptyTitle: "Your library is quiet for now",
      emptyText: "Audio, images, and documents attached to this archive will live here.",
      action: "Browse sessions",
      icon: "assets",
    },
  };
  const heading = meta[props.kind];
  const canAdd = props.kind === "students" || props.kind === "sessions" || props.kind === "journal";
  return (
    <div class="page-body record-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">{heading.eyebrow}</span>
          <h1>{heading.title}</h1>
          <p>{heading.description}</p>
        </div>
        <div class="record-heading-actions">
          <Show when={props.kind === "sessions" && props.onImportSessionPackage}>
            <label class="session-package-student-picker">
              <span>Link imported session to</span>
              <select
                value={sessionPackageStudentId()}
                disabled={!props.state.snapshot.canMutate || busy()}
                onChange={(event) => setSessionPackageStudentId(event.currentTarget.value)}
                aria-label="Student for imported session"
              >
                <option value="">Automatically match or leave independent</option>
                <For each={props.state.students}>
                  {(student) => (
                    <option value={student.id}>{field(student, "display_name", "Learner")}</option>
                  )}
                </For>
              </select>
            </label>
            <button
              class="button button-outline"
              type="button"
              disabled={!props.state.snapshot.canMutate || busy()}
              onClick={() => props.onImportSessionPackage?.(sessionPackageStudentId() || undefined)}
            >
              Import session package
            </button>
          </Show>
          <Show when={canAdd}>
            <button
              class="button button-primary"
              type="button"
              disabled={!props.state.snapshot.canMutate || busy()}
              onClick={() => props.onAdd?.()}
            >
              <Icon name="plus" />
              {props.kind === "students"
                ? "Add student"
                : props.kind === "sessions"
                  ? "New session"
                  : "New entry"}
            </button>
          </Show>
        </div>
      </section>
      <Show when={props.kind === "journal"}>
        <JournalOrganizer
          collections={props.state.collections}
          tags={props.state.tags}
          archived={props.state.trashedJournalOrganizers}
          disabled={!props.state.snapshot.canMutate}
          busy={busy()}
          onSave={(record, message) =>
            props.onSaveOrganizer?.(record, message) ?? Promise.resolve(false)
          }
          onArchive={(record) => props.onArchiveOrganizer?.(record)}
          onRestore={(record) => props.onRestoreOrganizer?.(record)}
        />
        <div class="journal-filter-row" aria-label="Filter journal entries">
          <span>Show reflections</span>
          <label>
            <span>Filter by collection</span>
            <select
              value={collectionFilter()}
              onChange={(event) => setCollectionFilter(event.currentTarget.value)}
            >
              <option value="">All collections</option>
              <For each={props.state.collections}>
                {(item) => (
                  <option value={item.id}>{field(item, "name", "Untitled collection")}</option>
                )}
              </For>
            </select>
          </label>
          <label>
            <span>Filter by tag</span>
            <select
              value={tagFilter()}
              onChange={(event) => setTagFilter(event.currentTarget.value)}
            >
              <option value="">All tags</option>
              <For each={props.state.tags}>
                {(item) => <option value={item.id}>{field(item, "name", "Untitled tag")}</option>}
              </For>
            </select>
          </label>
          <label>
            <span>Sort</span>
            <select
              value={journalSort()}
              onChange={(event) =>
                setJournalSort(event.currentTarget.value as "newest" | "oldest" | "title")
              }
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title</option>
            </select>
          </label>
          <label>
            <span>From date</span>
            <input
              type="date"
              value={journalFrom()}
              onChange={(event) => setJournalFrom(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>To date</span>
            <input
              type="date"
              value={journalTo()}
              onChange={(event) => setJournalTo(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Has sessions</span>
            <select
              value={hasSessions()}
              onChange={(event) =>
                setHasSessions(event.currentTarget.value as "all" | "yes" | "no")
              }
            >
              <option value="all">Any entry</option>
              <option value="yes">Linked to a session</option>
              <option value="no">No linked sessions</option>
            </select>
          </label>
          <Show
            when={
              collectionFilter() ||
              tagFilter() ||
              journalFrom() ||
              journalTo() ||
              hasSessions() !== "all"
            }
          >
            <button
              class="text-action"
              type="button"
              onClick={() => {
                setCollectionFilter("");
                setTagFilter("");
                setJournalFrom("");
                setJournalTo("");
                setHasSessions("all");
              }}
            >
              Clear filters
            </button>
          </Show>
        </div>
      </Show>
      <section class="record-list-shell">
        <div
          class={`record-list-toolbar ${props.kind === "sessions" ? "session-list-toolbar" : ""}`}
        >
          <span>
            <strong>{visibleRecords().length}</strong> {heading.title.toLowerCase()}
          </span>
          <Show when={props.kind === "sessions"}>
            <div class="session-view-switch" role="group" aria-label="Session archive view">
              <button
                type="button"
                aria-pressed={sessionArchiveView() === "current"}
                classList={{ "is-selected": sessionArchiveView() === "current" }}
                onClick={() => setSessionArchiveView("current")}
              >
                Current <span>{props.state.sessions.length}</span>
              </button>
              <button
                type="button"
                aria-pressed={sessionArchiveView() === "archived"}
                classList={{ "is-selected": sessionArchiveView() === "archived" }}
                onClick={() => setSessionArchiveView("archived")}
              >
                Archived <span>{props.state.archivedSessions.length}</span>
              </button>
            </div>
          </Show>
          <Show when={props.kind !== "sessions"}>
            <span class="list-view-label">
              <Icon name="more" />
              Latest first
            </span>
          </Show>
        </div>
        <Show
          when={visibleRecords().length > 0}
          fallback={
            <EmptyState
              icon={heading.icon}
              title={
                props.kind === "sessions" && sessionArchiveView() === "archived"
                  ? "No archived sessions"
                  : heading.emptyTitle
              }
              text={
                props.kind === "sessions" && sessionArchiveView() === "archived"
                  ? "Archived sessions stay available here until you return them to current sessions."
                  : heading.emptyText
              }
              action={
                props.kind === "sessions" && sessionArchiveView() === "archived"
                  ? ""
                  : heading.action
              }
              onAction={() => (canAdd ? props.onAdd?.() : undefined)}
              disabled={
                !canAdd ||
                !props.state.snapshot.canMutate ||
                (props.kind === "sessions" && sessionArchiveView() === "archived")
              }
            />
          }
        >
          <div class={`record-list record-list-${props.kind}`}>
            <For each={displayedRecords()}>
              {(record) => (
                <RecordCard
                  kind={props.kind}
                  record={record}
                  students={props.state.students}
                  sessions={props.state.sessions}
                  evidence={props.state.evidence}
                  collections={props.state.collections}
                  tags={props.state.tags}
                  guideTemplates={props.state.guideTemplates}
                  snapshot={props.state.snapshot}
                  workspace={props.state}
                  notesDocuments={props.state.notesDocuments}
                  onWriteRecords={props.onWriteRecords}
                  onRestoreSessionVersion={props.onRestoreSessionVersion}
                  disabled={!props.state.snapshot.canMutate}
                  busy={busy()}
                  onProgressReview={props.onProgressReview}
                  onEdit={!props.state.snapshot.canMutate ? undefined : props.onEdit}
                  onTrash={!props.state.snapshot.canMutate ? undefined : props.onTrash}
                  onTransition={!props.state.snapshot.canMutate ? undefined : props.onTransition}
                  onClone={!props.state.snapshot.canMutate ? undefined : props.onClone}
                  onExportSessionPackage={
                    !props.state.snapshot.canMutate ? undefined : props.onExportSessionPackage
                  }
                  onArchive={!props.state.snapshot.canMutate ? undefined : props.onArchive}
                />
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}

function RecordCard(props: {
  kind: RecordPagePropsKind;
  record: ArchiveRecord;
  students: ArchiveRecord[];
  sessions: ArchiveRecord[];
  evidence: ArchiveRecord[];
  collections: ArchiveRecord[];
  tags: ArchiveRecord[];
  guideTemplates: ArchiveRecord[];
  snapshot: ArchiveSnapshot;
  workspace: Workspace;
  notesDocuments: ArchiveRecord[];
  onWriteRecords: ((records: ArchiveRecord[], message: string) => Promise<boolean>) | undefined;
  onRestoreSessionVersion:
    | ((current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>)
    | undefined;
  disabled: boolean;
  busy: boolean;
  onProgressReview:
    | ((input: {
        student: ArchiveRecord;
        skill: string;
        classification: StudentProgressClassification;
        evidenceSourceIds: string[];
        reviewedBy: string;
        note: string;
      }) => Promise<boolean>)
    | undefined;
  onEdit: ((record: ArchiveRecord) => void) | undefined;
  onTrash: ((record: ArchiveRecord) => void) | undefined;
  onTransition: ((record: ArchiveRecord, action: SessionTransitionAction) => void) | undefined;
  onClone: ((record: ArchiveRecord) => void) | undefined;
  onExportSessionPackage: ((record: ArchiveRecord) => void) | undefined;
  onArchive: ((record: ArchiveRecord, archived: boolean) => void) | undefined;
}): JSX.Element {
  const record = props.record;
  if (props.kind === "students") {
    const subjects = field(record, "subjects")
      .split(/[;,]/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3);
    const count = props.students.length
      ? props.students.findIndex((item) => item.id === record.id) + 1
      : 1;
    return (
      <article class="student-record-card">
        <div class={`student-avatar avatar-${count % 5}`}>
          {initials(field(record, "display_name", "S"))}
        </div>
        <div class="student-record-main">
          <div class="record-card-title">
            <h2>{field(record, "display_name", "Student")}</h2>
            <span class="record-badge">{field(record, "grade", "Learner")}</span>
          </div>
          <p>
            {field(record, "learning_objectives", "No learning objectives have been added yet.")}
          </p>
          <Show when={subjects.length}>
            <div class="chip-row">
              <For each={subjects}>{(subject) => <span class="subject-chip">{subject}</span>}</For>
            </div>
          </Show>
          <Show
            when={
              field(record, "known_difficulties") ||
              field(record, "demonstrated_improvements") ||
              field(record, "preferred_guide_template")
            }
          >
            <details class="record-detail">
              <summary>Learning context</summary>
              <Show when={field(record, "known_difficulties")}>
                <p>
                  <strong>Areas to revisit</strong>
                  {field(record, "known_difficulties")}
                </p>
              </Show>
              <Show when={field(record, "demonstrated_improvements")}>
                <p>
                  <strong>Demonstrated improvements</strong>
                  {field(record, "demonstrated_improvements")}
                </p>
              </Show>
              <Show when={field(record, "preferred_guide_template")}>
                <p>
                  <strong>Preferred guide structure</strong>
                  {GUIDE_TEMPLATES.find(
                    (template) => template.id === field(record, "preferred_guide_template"),
                  )?.name ??
                    props.guideTemplates
                      .find((template) => template.id === field(record, "preferred_guide_template"))
                      ?.fields.get("name") ??
                    field(record, "preferred_guide_template")}
                </p>
              </Show>
            </details>
          </Show>
          <Show when={field(record, "tutor_notes")}>
            <details class="record-detail">
              <summary>Private tutor notes</summary>
              <p>{field(record, "tutor_notes")}</p>
            </details>
          </Show>
          <Show when={props.onProgressReview}>
            <StudentProgressPanel
              student={record}
              sessions={props.sessions}
              evidence={props.evidence}
              disabled={props.disabled || !props.onProgressReview}
              busy={props.busy}
              onSave={props.onProgressReview!}
            />
          </Show>
          <Show when={props.onWriteRecords}>
            {(save) => (
              <StudentVersionHistory
                student={record}
                snapshot={props.snapshot}
                disabled={props.disabled || props.busy}
                onSave={save()}
              />
            )}
          </Show>
        </div>
        <Show when={props.onEdit || props.onTrash}>
          <div class="record-actions">
            <button
              class="button button-outline record-action"
              type="button"
              onClick={() => props.onEdit?.(record)}
            >
              Edit
            </button>
            <button
              class="icon-button record-menu"
              type="button"
              title="Move to Trash"
              aria-label={`Move ${field(record, "display_name", "student")} to Trash`}
              onClick={() => props.onTrash?.(record)}
            >
              <Icon name="trash" />
            </button>
          </div>
        </Show>
      </article>
    );
  }
  if (props.kind === "sessions")
    return (
      <SessionRow
        session={record}
        students={props.students}
        expanded
        snapshot={props.snapshot}
        onRestoreVersion={props.onRestoreSessionVersion}
        disabled={props.disabled || props.busy}
        onEdit={props.onEdit}
        onTrash={props.onTrash}
        onTransition={props.onTransition}
        onClone={props.onClone}
        onExportPackage={props.onExportSessionPackage}
        onArchive={props.onArchive}
      />
    );
  if (props.kind === "journal") {
    const date = dateParts(field(record, "entry_date"));
    const undated = !field(record, "entry_date");
    const labels = createMemo(() => {
      const collectionIds = field(props.record, "collection_ids").split(",").filter(Boolean);
      const tagIds = field(props.record, "tag_ids").split(",").filter(Boolean);
      return [
        ...props.collections.filter((item) => collectionIds.includes(item.id)),
        ...props.tags.filter((item) => tagIds.includes(item.id)),
      ];
    });
    return (
      <article class="journal-record-card">
        <div class="journal-date journal-date-large">
          <strong>{undated ? "–" : date.day}</strong>
          <small>{undated ? "NO DATE" : date.month}</small>
        </div>
        <div class="journal-record-main">
          <span class="eyebrow">{undated ? "UNDATED" : date.year}</span>
          <h2>{field(record, "title", "Untitled entry")}</h2>
          <p>
            {record.fields.get("session_ids")
              ? "Linked to a tutoring session"
              : "A teaching reflection"}
          </p>
          <div class="record-inline-meta">
            <span>
              <Icon name="clock" />
              {field(record, "entry_date") || "No date"}
            </span>
            <span>
              <Icon name="book" />
              Journal entry
            </span>
          </div>
          <Show when={labels().length > 0}>
            <div class="chip-row journal-label-chips">
              <For each={labels()}>
                {(item) => (
                  <span
                    class="journal-label-chip"
                    style={{ "--label-color": safeJournalColor(item) }}
                  >
                    <span />
                    {field(item, "name", "Untitled label")}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.onWriteRecords}>
            {(writeRecords) => (
              <JournalHistory
                entry={record}
                notesDocument={props.notesDocuments.find(
                  (document) =>
                    document.id.toLowerCase() === field(record, "notes_document_id").toLowerCase(),
                )}
                snapshot={props.snapshot}
                disabled={props.disabled || props.busy}
                onWriteRecords={writeRecords()}
              />
            )}
          </Show>
          <Show when={props.onWriteRecords}>
            {(writeRecords) => (
              <JournalRelations
                entry={record}
                snapshot={props.snapshot}
                entries={props.workspace.entries}
                sessions={[...props.workspace.sessions, ...props.workspace.archivedSessions]}
                students={props.students}
                guides={props.workspace.guides}
                guideTemplates={props.guideTemplates}
                assets={props.workspace.assets}
                notesDocuments={props.workspace.notesDocuments}
                disabled={props.disabled || props.busy}
                onWriteRecords={writeRecords()}
              />
            )}
          </Show>
        </div>
        <Show when={props.onEdit}>
          <button
            class="button button-outline record-action"
            type="button"
            onClick={() => props.onEdit?.(record)}
          >
            Edit
          </button>
        </Show>
      </article>
    );
  }
  if (props.kind === "guides")
    return (
      <article class="library-record-card">
        <span class="library-icon guide-icon">
          <Icon name="guides" />
        </span>
        <div>
          <span class="eyebrow">STUDY GUIDE</span>
          <h2>{field(record, "title", "Untitled guide")}</h2>
          <p>
            {field(
              record,
              "summary",
              field(record, "description", "A reusable structure for learning."),
            )}
          </p>
          <small>Updated {formatTimestamp(field(record, "updated_at_us"))}</small>
        </div>
        <span class="record-badge">{field(record, "status", "Draft")}</span>
      </article>
    );
  if (props.kind === "evidence")
    return (
      <article class="library-record-card">
        <span class="library-icon evidence-icon">
          <Icon name="evidence" />
        </span>
        <div>
          <span class="eyebrow">LEARNING OBSERVATION</span>
          <h2>{field(record, "title", field(record, "skill", "Untitled observation"))}</h2>
          <p>
            {field(
              record,
              "description",
              field(record, "note", "Evidence linked to a learner’s progress."),
            )}
          </p>
          <small>
            {field(record, "classification", "Observation")} ·{" "}
            {formatTimestamp(field(record, "created_at_us"))}
          </small>
        </div>
      </article>
    );
  return (
    <article class="library-record-card">
      <span class="library-icon asset-icon">
        <Icon name="assets" />
      </span>
      <div>
        <span class="eyebrow">ARCHIVE MATERIAL</span>
        <h2>{field(record, "display_name", field(record, "file_name", "Untitled material"))}</h2>
        <p>
          {field(
            record,
            "media_type",
            field(record, "description", "File attached to the tutoring workspace."),
          )}
        </p>
        <small>
          {formatBytes(BigInt(field(record, "size_bytes", "0")))} ·{" "}
          {formatTimestamp(field(record, "created_at_us"))}
        </small>
      </div>
      <span class="record-badge">{field(record, "status", "Stored")}</span>
    </article>
  );
}

type RecordPagePropsKind = "students" | "sessions" | "journal" | "guides" | "evidence" | "assets";

function TrashPage(props: {
  records: ArchiveRecord[];
  journalEntries: ArchiveRecord[];
  annotations: ArchiveRecord[];
  guides: ArchiveRecord[];
  evidence: ArchiveRecord[];
  evidenceEdges: ArchiveRecord[];
  noteBlocks: RemovedNoteBlock[];
  sessions: ArchiveRecord[];
  disabled: boolean;
  onRestore: (record: ArchiveRecord) => void;
  onRestoreJournalEntry: (record: ArchiveRecord) => void;
  onRestoreAnnotation: (record: ArchiveRecord) => void;
  onRestoreGuide: (record: ArchiveRecord) => void;
  onRestoreEvidence: (record: ArchiveRecord) => void;
  onRestoreEvidenceEdge: (record: ArchiveRecord) => void;
  onRestoreNoteBlock: (block: RemovedNoteBlock) => void;
  onRestoreSession: (record: ArchiveRecord) => void;
  pendingPurge: TrashPurgeReview | null;
  onBeginPurge: () => void;
  onCancelPurge: () => void;
  onConfirmPurge: () => void;
}): JSX.Element {
  const trashed = () => {
    const removedAt = (record: ArchiveRecord): bigint => {
      const raw = field(record, "deleted_at_us");
      return /^\d+$/u.test(raw) ? BigInt(raw) : 0n;
    };
    return [
      ...props.sessions,
      ...props.records,
      ...props.journalEntries,
      ...props.annotations,
      ...props.guides,
      ...props.evidence,
      ...props.evidenceEdges,
    ].sort((left, right) => {
      const a = removedAt(left);
      const b = removedAt(right);
      return a > b ? -1 : a < b ? 1 : left.id.localeCompare(right.id);
    });
  };
  const total = () => trashed().length + props.noteBlocks.length;
  return (
    <div class="page-body record-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">RECOVERABLE ARCHIVE ITEMS</span>
          <h1>Trash</h1>
          <p>
            Restore a session or journal entry with its linked records, or bring back an individual
            item.
          </p>
        </div>
      </section>
      <section class="record-list-shell">
        <div class="record-list-toolbar">
          <span>
            <strong>{total()}</strong> recoverable groups and items
          </span>
          <span class="list-view-label">
            <Icon name="shield" />
            Recoverable
          </span>
          <button
            class="button button-danger trash-purge-start"
            type="button"
            disabled={props.disabled}
            onClick={() => props.onBeginPurge()}
          >
            Permanently purge Trash
          </button>
        </div>
        <Show when={props.pendingPurge}>
          {(review) => (
            <section class="trash-purge-review" aria-label="Permanent Trash purge review">
              <div>
                <span class="eyebrow">PERMANENT ACTION</span>
                <h2>Review permanent purge</h2>
                <p>
                  This removes {review().plan.deletedRecords.toLocaleString()} trashed archive
                  records and their saved revisions from the workspace. Material content is
                  preserved. It cannot be undone after you save the archive.
                </p>
              </div>
              <Show when={review().plan.blockers.length > 0}>
                <div class="trash-purge-blockers" role="alert">
                  <strong>Active links block this purge.</strong>
                  <p>Restore these items or remove the active links before purging Trash.</p>
                  <ul>
                    <For each={review().plan.blockers}>
                      {(blocker) => (
                        <li>
                          <strong>{blocker.label}</strong>
                          <span>
                            {blocker.recordType} {blocker.recordId} is linked from{" "}
                            {blocker.references
                              .map(
                                (reference) =>
                                  `${reference.label} (${reference.fields.join(", ")})`,
                              )
                              .join("; ")}
                            .
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={review().plan.opaqueRecords > 0}>
                <p class="trash-purge-blockers" role="alert">
                  {review().plan.opaqueRecords} record(s) from a newer archive version cannot be
                  checked for active links. Open the archive in a compatible version before purging
                  Trash.
                </p>
              </Show>
              <div class="trash-purge-actions">
                <button
                  class="button button-outline"
                  type="button"
                  disabled={props.disabled}
                  onClick={props.onCancelPurge}
                >
                  Cancel
                </button>
                <button
                  class="button button-danger"
                  type="button"
                  disabled={
                    props.disabled ||
                    review().plan.deletedRecords === 0 ||
                    review().plan.blockers.length > 0 ||
                    review().plan.opaqueRecords > 0
                  }
                  onClick={props.onConfirmPurge}
                >
                  Permanently purge {review().plan.deletedRecords.toLocaleString()} records
                </button>
              </div>
            </section>
          )}
        </Show>
        <Show
          when={total() > 0}
          fallback={
            <EmptyState
              icon="trash"
              title="Trash is empty"
              text="Sessions, journal entries, students, observations, study guides, and evidence you move here can be restored at any time."
              action="Back to students"
              onAction={() => undefined}
              disabled
            />
          }
        >
          <Show when={props.noteBlocks.length > 0}>
            <div class="record-list" aria-label="Removed note blocks">
              <For each={props.noteBlocks}>
                {(block) => (
                  <article class="library-record-card trash-record">
                    <span class="library-icon">
                      <Icon name="journal" />
                    </span>
                    <div>
                      <span class="eyebrow">REMOVED NOTE BLOCK</span>
                      <h2>{block.text || "Empty note block"}</h2>
                      <p>
                        {block.kind} block removed from{" "}
                        {block.sessionId ? "session notes" : "journal notes"}
                      </p>
                    </div>
                    <button
                      class="button button-outline record-action"
                      type="button"
                      disabled={props.disabled}
                      onClick={() => props.onRestoreNoteBlock(block)}
                    >
                      Restore
                    </button>
                  </article>
                )}
              </For>
            </div>
          </Show>
          <div class="record-list">
            <For each={trashed()}>
              {(record) => {
                const journalEntry =
                  record.type === RecordType.settings &&
                  field(record, "record_role") === "journal-entry";
                const evidenceEdge = record.type === RecordType.evidenceEdge;
                return (
                  <article class="library-record-card trash-record">
                    <span class="library-icon">
                      <Icon
                        name={
                          journalEntry
                            ? "journal"
                            : record.type === RecordType.session
                              ? "sessions"
                              : record.type === RecordType.annotation
                                ? "annotations"
                                : record.type === RecordType.guide
                                  ? "guides"
                                  : record.type === RecordType.evidenceNode
                                    ? "evidence"
                                    : evidenceEdge
                                      ? "evidence"
                                      : "students"
                        }
                      />
                    </span>
                    <div>
                      <span class="eyebrow">
                        {journalEntry
                          ? "JOURNAL ENTRY GROUP"
                          : record.type === RecordType.session
                            ? "SESSION GROUP"
                            : record.type === RecordType.annotation
                              ? "SESSION OBSERVATION"
                              : record.type === RecordType.guide
                                ? "STUDY GUIDE"
                                : record.type === RecordType.evidenceNode
                                  ? "EVIDENCE ITEM"
                                  : evidenceEdge
                                    ? "EVIDENCE RELATIONSHIP"
                                    : "STUDENT PROFILE"}
                      </span>
                      <h2>
                        {journalEntry
                          ? field(record, "title", "Untitled entry")
                          : record.type === RecordType.session
                            ? field(record, "title", "Untitled session")
                            : record.type === RecordType.annotation
                              ? field(
                                  record,
                                  "title",
                                  annotationTypeLabel(field(record, "type", "observation")),
                                )
                              : record.type === RecordType.guide
                                ? field(record, "title", "Untitled guide")
                                : record.type === RecordType.evidenceNode
                                  ? field(record, "title", "Evidence item")
                                  : evidenceEdge
                                    ? `${field(record, "relationship", "relationship")} · ${field(record, "from_id")} → ${field(record, "to_id")}`
                                    : field(record, "display_name", "Unnamed student")}
                      </h2>
                      <p>
                        {journalEntry
                          ? "Journal reflection"
                          : record.type === RecordType.session
                            ? [field(record, "subject"), field(record, "session_state")]
                                .filter(Boolean)
                                .join(" · ") || "Tutoring session"
                            : record.type === RecordType.annotation
                              ? field(record, "content", "Observation")
                              : record.type === RecordType.guide
                                ? `${field(record, "approval_state", "draft")} · ${field(record, "template_id", "general")}`
                                : record.type === RecordType.evidenceNode
                                  ? field(record, "content", "Evidence")
                                  : evidenceEdge
                                    ? "Removed evidence relationship"
                                    : field(record, "grade", "Learner")}
                        {field(record, "deleted_at_us")
                          ? ` · Deleted ${formatTimestamp(field(record, "deleted_at_us"))}`
                          : " · Deletion date unavailable"}
                      </p>
                      <Show when={record.type === RecordType.session}>
                        <span class="session-trash-detail">
                          Notes, recordings, transcripts, observations, materials, guides, and
                          evidence restore together; journal links reconnect automatically.
                        </span>
                      </Show>
                      <Show when={journalEntry}>
                        <span class="session-trash-detail">
                          The entry and its linked notes restore together.
                        </span>
                      </Show>
                    </div>
                    <button
                      class="button button-outline record-action"
                      type="button"
                      disabled={props.disabled}
                      onClick={() =>
                        journalEntry
                          ? props.onRestoreJournalEntry(record)
                          : record.type === RecordType.session
                            ? props.onRestoreSession(record)
                            : record.type === RecordType.annotation
                              ? props.onRestoreAnnotation(record)
                              : record.type === RecordType.guide
                                ? props.onRestoreGuide(record)
                                : record.type === RecordType.evidenceNode
                                  ? props.onRestoreEvidence(record)
                                  : evidenceEdge
                                    ? props.onRestoreEvidenceEdge(record)
                                    : props.onRestore(record)
                      }
                    >
                      Restore
                    </button>
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}

function SessionRow(props: {
  session: ArchiveRecord;
  students: ArchiveRecord[];
  expanded?: boolean;
  snapshot?: ArchiveSnapshot;
  onRestoreVersion?:
    | ((current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>)
    | undefined;
  disabled?: boolean;
  onEdit?: ((record: ArchiveRecord) => void) | undefined;
  onTrash?: ((record: ArchiveRecord) => void) | undefined;
  onTransition?: ((record: ArchiveRecord, action: SessionTransitionAction) => void) | undefined;
  onClone?: ((record: ArchiveRecord) => void) | undefined;
  onExportPackage?: ((record: ArchiveRecord) => void) | undefined;
  onArchive?: ((record: ArchiveRecord, archived: boolean) => void) | undefined;
}): JSX.Element {
  const student = props.students.find((item) => item.id === field(props.session, "student_id"));
  const sessionState = field(props.session, "session_state", "active");
  const displayState = sessionState === "in-progress" ? "active" : sessionState;
  return (
    <article class={`session-record ${props.expanded ? "is-expanded" : ""}`}>
      <div class="session-date">
        <strong>{dateParts(formatTimestamp(field(props.session, "started_at_us"))).day}</strong>
        <span>{dateParts(formatTimestamp(field(props.session, "started_at_us"))).month}</span>
      </div>
      <span class="session-kind-icon">
        <Icon name="sessions" />
      </span>
      <div class="session-record-main">
        <div class="record-card-title">
          <h2>{field(props.session, "title", "Untitled session")}</h2>
          <span class={`session-state state-${displayState}`}>{displayState}</span>
        </div>
        <p>
          {[
            student ? field(student, "display_name") : "Independent session",
            field(props.session, "subject"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <Show when={field(props.session, "learning_objectives")}>
          <span class="session-objective">{field(props.session, "learning_objectives")}</span>
        </Show>
        <div class="record-inline-meta">
          <span>
            <Icon name="clock" />
            {formatTimestamp(field(props.session, "started_at_us"))}
          </span>
          <Show when={field(props.session, "notes_document_id")}>
            <span>
              <Icon name="journal" />
              Notes attached
            </span>
          </Show>
        </div>
        <Show when={props.snapshot && props.onRestoreVersion}>
          <SessionVersionHistory
            session={props.session}
            snapshot={props.snapshot!}
            disabled={Boolean(props.disabled)}
            onRestore={props.onRestoreVersion!}
          />
        </Show>
      </div>
      <Show
        when={
          props.expanded &&
          (props.onEdit ||
            props.onTrash ||
            props.onTransition ||
            props.onClone ||
            props.onExportPackage ||
            props.onArchive)
        }
      >
        <div class="record-actions session-actions">
          <Show when={props.onTransition && sessionState === "created"}>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onTransition?.(props.session, "start")}
            >
              Start
            </button>
          </Show>
          <Show
            when={
              props.onTransition && (sessionState === "active" || sessionState === "in-progress")
            }
          >
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled || field(props.session, "recording_state") === "recording"}
              title={
                field(props.session, "recording_state") === "recording"
                  ? "Stop recording before completing this session."
                  : undefined
              }
              onClick={() => props.onTransition?.(props.session, "complete")}
            >
              Complete
            </button>
          </Show>
          <Show
            when={
              props.onTransition && (sessionState === "completed" || sessionState === "reviewed")
            }
          >
            <Show when={sessionState === "completed"}>
              <button
                class="button button-outline record-action"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onTransition?.(props.session, "review")}
              >
                Review
              </button>
            </Show>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onTransition?.(props.session, "resume")}
            >
              Resume
            </button>
          </Show>
          <Show when={props.onClone}>
            <button
              class="button button-outline record-action"
              type="button"
              title="Create a fresh session from these details"
              disabled={props.disabled}
              onClick={() => props.onClone?.(props.session)}
            >
              Duplicate
            </button>
          </Show>
          <Show when={props.onExportPackage}>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onExportPackage?.(props.session)}
            >
              Export session package
            </button>
          </Show>
          <Show when={props.onArchive}>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={
                props.disabled ||
                (field(props.session, "recording_state") === "recording" &&
                  field(props.session, "archived") !== "true")
              }
              title={
                field(props.session, "recording_state") === "recording" &&
                field(props.session, "archived") !== "true"
                  ? "Stop recording before archiving this session."
                  : undefined
              }
              onClick={() =>
                props.onArchive?.(props.session, field(props.session, "archived") !== "true")
              }
            >
              {field(props.session, "archived") === "true" ? "Unarchive" : "Archive"}
            </button>
          </Show>
          <Show when={props.onEdit}>
            <button
              class="button button-outline session-open"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onEdit?.(props.session)}
            >
              Edit session <Icon name="arrow" />
            </button>
          </Show>
          <Show when={props.onTrash}>
            <button
              class="icon-button record-menu"
              type="button"
              title="Review session and linked records before moving them to Trash"
              aria-label={`Review moving ${field(props.session, "title", "session")} and linked records to Trash`}
              disabled={props.disabled}
              onClick={() => props.onTrash?.(props.session)}
            >
              <Icon name="trash" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={!props.expanded}>
        <Icon name="chevron" />{" "}
      </Show>
    </article>
  );
}

function TranscriptPage(props: {
  snapshot: ArchiveSnapshot;
  sessions: ArchiveRecord[];
  records: ArchiveRecord[];
  assets: ArchiveRecord[];
  tracks: AudioTrackDescriptor[];
  recordingTakes: ArchiveRecord[];
  trashedRecordingTakes: ArchiveRecord[];
  trashedRecordingTracks: ArchiveRecord[];
  selectedSessionId: string;
  disabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onImport: (file: File, sessionId: string) => void;
  onImportAudio: (file: File, sessionId: string, allowAdditionalTrack: boolean) => void;
  onImportCompressedAudio: (sessionId: string, allowAdditionalTrack: boolean) => void;
  onRecoverAudio: (sessionId: string) => void;
  onRecoverNativeAudio: (sessionId: string) => void;
  onRecordAudio: (file: File, sessionId: string, consentAtUs: string) => Promise<void>;
  onExportAudio: (
    sessionId: string,
    trackId: string,
    label: string,
    fillGapsWithSilence: boolean,
  ) => void;
  onRenameRecordingTake: (take: ArchiveRecord, label: string) => void;
  onRenameRecordingTrack: (track: AudioTrackDescriptor, label: string) => void;
  onTrashRecordingTrack: (track: AudioTrackDescriptor) => void;
  onRestoreRecordingTrack: (track: ArchiveRecord) => void;
  onTrashRecordingTake: (take: ArchiveRecord) => void;
  onRestoreRecordingTake: (take: ArchiveRecord) => void;
  onSaveMix: (
    snapshot: ArchiveSnapshot,
    records: ArchiveRecord[],
    message: string,
  ) => Promise<boolean>;
  onCheckpointPersisted: (snapshot: ArchiveSnapshot) => void;
  onSaveWhisper: (
    records: ArchiveRecord[],
    message: string,
    snapshot: ArchiveSnapshot,
  ) => Promise<boolean>;
  onExport: (sessionId: string, format: TranscriptExportFormat) => void;
  onSave: (
    record: ArchiveRecord,
    text: string,
    start: string,
    end: string,
    speaker: string,
  ) => void;
  onVerify: (record: ArchiveRecord) => void;
  onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
  onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
  onSplit: (
    record: ArchiveRecord,
    beforeText: string,
    afterText: string,
    splitAt?: string,
  ) => Promise<boolean>;
  onMerge: (records: readonly ArchiveRecord[]) => Promise<boolean>;
  onLinkAssets: (record: ArchiveRecord, assetIds: readonly string[]) => Promise<boolean>;
}): JSX.Element {
  const [exportFormat, setExportFormat] = createSignal<TranscriptExportFormat>("text");
  const [trackId, setTrackId] = createSignal("");
  const [addSeparateTrack, setAddSeparateTrack] = createSignal(false);
  const [selectedCueIds, setSelectedCueIds] = createSignal<string[]>([]);
  const [captureConsent, setCaptureConsent] = createSignal(false);
  const [captureState, setCaptureState] = createSignal<
    "idle" | "requesting" | "recording" | "saving"
  >("idle");
  const [captureElapsed, setCaptureElapsed] = createSignal(0);
  const [captureError, setCaptureError] = createSignal("");
  const [audioUrl, setAudioUrl] = createSignal<string | null>(null);
  const [audioPreview, setAudioPreview] = createSignal<AudioPreview | null>(null);
  const [playbackError, setPlaybackError] = createSignal("");
  const selectedSession = createMemo(
    () =>
      props.sessions.find((session) => session.id === props.selectedSessionId) ??
      props.sessions[0] ??
      null,
  );
  const sessionRecords = createMemo(() => {
    const session = selectedSession();
    return session
      ? sortTranscriptRecords(
          props.records.filter((record) => field(record, "session_id") === session.id),
        )
      : [];
  });
  const sessionTracks = createMemo(() => {
    const session = selectedSession();
    return session
      ? props.tracks.filter((track) => track.sessionId === session.id.toLowerCase())
      : [];
  });
  const sessionRecordingTakes = createMemo(() => {
    const session = selectedSession();
    return session
      ? props.recordingTakes.filter(
          (take) => field(take, "session_id").toLowerCase() === session.id.toLowerCase(),
        )
      : [];
  });
  const trashedSessionRecordingTakes = createMemo(() => {
    const session = selectedSession();
    return session
      ? props.trashedRecordingTakes.filter(
          (take) => field(take, "session_id").toLowerCase() === session.id.toLowerCase(),
        )
      : [];
  });
  const sessionAssets = createMemo(() => {
    const session = selectedSession();
    if (!session) return [];
    return props.assets.filter((asset) => {
      const role = field(asset, "record_role");
      const assetSessionId = field(asset, "session_id").toLowerCase();
      return (
        asset.type === RecordType.assetMetadata &&
        role !== "recording-take" &&
        role !== "audio-track" &&
        (field(asset, "filename") || field(asset, "blob_id")) &&
        (!assetSessionId || assetSessionId === session.id.toLowerCase())
      );
    });
  });
  const trashedSessionRecordingTracks = createMemo(() => {
    const session = selectedSession();
    if (!session) return [];
    const activeTakeIds = new Set(sessionRecordingTakes().map((take) => take.id.toLowerCase()));
    return props.trashedRecordingTracks.filter(
      (track) =>
        field(track, "session_id").toLowerCase() === session.id.toLowerCase() &&
        activeTakeIds.has(field(track, "recording_take_id").toLowerCase()),
    );
  });
  const selectedCues = createMemo(() => {
    const selected = new Set(selectedCueIds());
    return sessionRecords().filter((record) => selected.has(record.id));
  });
  const selectedTrack = createMemo(
    () => sessionTracks().find((track) => track.id === trackId()) ?? sessionTracks()[0] ?? null,
  );
  const sessionHasAudio = createMemo(() => {
    const session = selectedSession();
    return (
      sessionTracks().length > 0 ||
      ["recording_track_id", "recording_track_ids", "audio_import_track_id"].some((key) =>
        Boolean(session?.fields.get(key)?.trim()),
      )
    );
  });
  const recoverableWavImport = createMemo(() => {
    const session = selectedSession();
    if (!session || !field(session, "audio_import_track_id")) return false;
    return ["importing", "finalizing", "interrupted", "completed"].includes(
      field(session, "audio_import_state"),
    );
  });
  const recoverableNativeCapture = createMemo(() => {
    const session = selectedSession();
    return Boolean(
      session &&
      ["recording_track_id", "recording_track_ids"].some((key) => field(session, key).trim()),
    );
  });
  let fileInput: HTMLInputElement | undefined;
  let audioFileInput: HTMLInputElement | undefined;
  let audioPlayer: HTMLAudioElement | undefined;
  let currentAudioUrl: string | null = null;
  let captureRecorder: MediaRecorder | undefined;
  let captureStream: MediaStream | undefined;
  let captureChunks: Blob[] = [];
  let captureTimer: number | undefined;
  let captureByteCount = 0;
  let captureStartedAt = 0;
  let captureConsentAtUs = "";
  let captureExceededLimit = false;
  let captureFailed = false;
  let captureCancelled = false;

  function clearAudio(): void {
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
    setAudioUrl(null);
    setAudioPreview(null);
    setPlaybackError("");
  }

  onCleanup(() => {
    captureCancelled = true;
    clearAudio();
    if (captureTimer !== undefined) window.clearInterval(captureTimer);
    if (captureRecorder && captureRecorder.state !== "inactive") {
      try {
        captureRecorder.stop();
      } catch {
        captureStream?.getTracks().forEach((track) => track.stop());
      }
    }
    captureStream?.getTracks().forEach((track) => track.stop());
  });

  const microphoneAvailable = () =>
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  function resetCapture(): void {
    if (captureTimer !== undefined) window.clearInterval(captureTimer);
    captureTimer = undefined;
    captureStream?.getTracks().forEach((track) => track.stop());
    captureStream = undefined;
    captureRecorder = undefined;
    captureChunks = [];
    captureByteCount = 0;
    setCaptureElapsed(0);
    setCaptureState("idle");
  }

  async function finishCapture(
    sessionId: string,
    sessionTitle: string,
    mimeType: string,
  ): Promise<void> {
    setCaptureState("saving");
    if (captureTimer !== undefined) window.clearInterval(captureTimer);
    captureTimer = undefined;
    captureStream?.getTracks().forEach((track) => track.stop());
    captureStream = undefined;

    if (captureExceededLimit || captureFailed) {
      resetCapture();
      return;
    }
    const blob = new Blob(captureChunks, { type: mimeType });
    if (blob.size === 0) {
      setCaptureError("The microphone did not produce an audio recording.");
      resetCapture();
      return;
    }
    if (blob.size > MAX_ASSET_BYTES) {
      setCaptureError("This recording exceeds the 256 MiB limit and was not saved.");
      resetCapture();
      return;
    }

    const normalizedMimeType = blob.type || mimeType;
    const baseMimeType = normalizedMimeType.split(";", 1)[0]?.toLowerCase() ?? "";
    const extension = baseMimeType.includes("ogg")
      ? "ogg"
      : baseMimeType.includes("mp4")
        ? "m4a"
        : baseMimeType.includes("wav")
          ? "wav"
          : "webm";
    const dateStamp = new Date(captureStartedAt).toISOString().replace(/[:.]/gu, "-");
    const file = new File(
      [blob],
      `${safeFileName(sessionTitle)}-recording-${dateStamp}.${extension}`,
      {
        type: normalizedMimeType,
      },
    );
    setCaptureState("saving");
    try {
      await props.onRecordAudio(file, sessionId, captureConsentAtUs);
    } finally {
      resetCapture();
    }
  }

  async function startCapture(): Promise<void> {
    const session = selectedSession();
    if (!session || !captureConsent()) return;
    setCaptureError("");
    if (!microphoneAvailable()) {
      setCaptureError("Microphone recording is not available in this window.");
      return;
    }

    setCaptureState("requesting");
    captureCancelled = false;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (captureCancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferredMimeType = [
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/mp4",
        "audio/webm",
      ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      const mimeType = recorder.mimeType || preferredMimeType || "";
      if (!mimeType) throw new Error("This system does not provide a supported audio format.");

      captureStream = stream;
      captureRecorder = recorder;
      captureChunks = [];
      captureByteCount = 0;
      captureExceededLimit = false;
      captureFailed = false;
      captureStartedAt = Date.now();
      setCaptureElapsed(0);
      captureConsentAtUs = (BigInt(captureStartedAt) * 1000n).toString();
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        captureByteCount += event.data.size;
        if (captureByteCount > MAX_ASSET_BYTES) {
          captureExceededLimit = true;
          setCaptureError("Recording reached the 256 MiB limit and is stopping.");
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        captureChunks.push(event.data);
      };
      recorder.onerror = () => {
        captureFailed = true;
        setCaptureError("The microphone recorder stopped unexpectedly. Try again.");
        if (recorder.state !== "inactive") recorder.stop();
      };
      recorder.onstop = () => {
        void finishCapture(session.id, field(session, "title", "Tutoring session"), mimeType);
      };
      recorder.start(1000);
      setCaptureState("recording");
      captureTimer = window.setInterval(
        () => setCaptureElapsed(Math.floor((Date.now() - captureStartedAt) / 1000)),
        250,
      );
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      captureStream = undefined;
      captureRecorder = undefined;
      if (captureCancelled) return;
      setCaptureState("idle");
      const name = error instanceof DOMException ? error.name : "";
      setCaptureError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was denied. Allow it in your system privacy settings and try again."
          : name === "NotFoundError"
            ? "No microphone was found. Connect a microphone and try again."
            : errorMessage(error),
      );
    }
  }

  function stopCapture(): void {
    const recorder = captureRecorder;
    if (!recorder || recorder.state === "inactive") return;
    setCaptureState("saving");
    recorder.stop();
  }

  async function playFromCue(record: ArchiveRecord): Promise<void> {
    await playAudioAt(field(record, "start_time_us", "0"));
  }

  async function playAudioAt(startTimeUs: string): Promise<void> {
    const session = selectedSession();
    const track = selectedTrack();
    if (!session || !track) return;
    setPlaybackError("");
    try {
      const preview = await buildAudioPreview(props.snapshot, session.id, track.id, startTimeUs);
      clearAudio();
      const url = URL.createObjectURL(
        new Blob([preview.wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }),
      );
      currentAudioUrl = url;
      setAudioPreview(preview);
      setAudioUrl(url);
      queueMicrotask(() => {
        void audioPlayer?.play().catch(() => {
          setPlaybackError("Audio is ready. Press Play in the player to start listening.");
        });
      });
    } catch (error) {
      setPlaybackError(errorMessage(error));
    }
  }

  function chooseImport(): void {
    fileInput?.click();
  }

  function receiveFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const session = selectedSession();
    if (file && session) props.onImport(file, session.id);
    input.value = "";
  }

  function chooseAudioImport(): void {
    audioFileInput?.click();
  }

  function receiveAudioFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    const session = selectedSession();
    if (file && session) {
      props.onImportAudio(file, session.id, sessionHasAudio() && addSeparateTrack());
    }
    input.value = "";
  }

  return (
    <div class="page-body transcript-page">
      <section class="record-heading transcript-heading">
        <div>
          <span class="eyebrow">LISTEN CLOSELY, KEEP THE WORDS</span>
          <h1>Transcripts</h1>
          <p>
            Bring in text or subtitle cues, correct the wording, and mark what you’ve reviewed.
            Imported speech stays provisional until you verify it.
          </p>
        </div>
        <span class="transcript-page-mark" aria-hidden="true">
          <Icon name="transcripts" />
        </span>
      </section>

      <section class="transcript-controls" aria-label="Transcript actions">
        <label class="transcript-session-picker">
          <span class="eyebrow">SESSION</span>
          <select
            value={selectedSession()?.id ?? ""}
            disabled={props.sessions.length === 0 || captureState() !== "idle"}
            onChange={(event) => {
              clearAudio();
              setAddSeparateTrack(false);
              setSelectedCueIds([]);
              setCaptureConsent(false);
              setCaptureError("");
              setCaptureElapsed(0);
              props.onSelectSession(event.currentTarget.value);
            }}
            aria-label="Transcript session"
          >
            <Show when={props.sessions.length === 0}>
              <option value="">No sessions yet</option>
            </Show>
            <For each={props.sessions}>
              {(session) => (
                <option value={session.id}>{field(session, "title", "Untitled session")}</option>
              )}
            </For>
          </select>
        </label>
        <Show when={sessionHasAudio()}>
          <label class="transcript-audio-add-checkbox">
            <input
              type="checkbox"
              checked={addSeparateTrack()}
              disabled={props.disabled}
              onChange={(event) => setAddSeparateTrack(event.currentTarget.checked)}
            />
            <span>Keep existing audio and add this as a separate track</span>
          </label>
        </Show>
        <div class="transcript-control-actions">
          <input
            ref={(element) => (fileInput = element)}
            class="visually-hidden"
            type="file"
            accept=".txt,.srt,.vtt,text/plain,text/vtt,application/x-subrip"
            onChange={receiveFile}
            aria-label="Choose transcript source file"
          />
          <input
            ref={(element) => (audioFileInput = element)}
            class="visually-hidden"
            type="file"
            accept=".wav,audio/wav,audio/x-wav"
            onChange={receiveAudioFile}
            aria-label="Choose WAV audio file"
          />
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || !selectedSession()}
            onClick={chooseImport}
          >
            <Icon name="plus" />
            Import cues
          </button>
          <button
            class="button button-outline"
            type="button"
            disabled={
              props.disabled || !selectedSession() || (sessionHasAudio() && !addSeparateTrack())
            }
            onClick={chooseAudioImport}
          >
            {sessionHasAudio() ? "Add WAV track" : "Import WAV"}
          </button>
          <Show when={platform.kind === "desktop"}>
            <button
              class="button button-outline"
              type="button"
              disabled={
                props.disabled || !selectedSession() || (sessionHasAudio() && !addSeparateTrack())
              }
              onClick={() => {
                const session = selectedSession();
                if (session) {
                  props.onImportCompressedAudio(
                    session.id,
                    sessionHasAudio() && addSeparateTrack(),
                  );
                }
              }}
            >
              Import FLAC, MP3, or M4A
            </button>
          </Show>
          <Show when={recoverableWavImport()}>
            <button
              class="button button-outline"
              type="button"
              disabled={props.disabled || !selectedSession()}
              onClick={() => {
                const session = selectedSession();
                if (session) props.onRecoverAudio(session.id);
              }}
            >
              {selectedSession()?.fields.get("audio_import_state") === "completed"
                ? "Verify WAV import"
                : "Recover WAV import"}
            </button>
          </Show>
          <Show when={recoverableNativeCapture()}>
            <button
              class="button button-outline"
              type="button"
              disabled={props.disabled || captureRecorder?.state === "recording"}
              onClick={() => {
                const session = selectedSession();
                if (session) props.onRecoverNativeAudio(session.id);
              }}
            >
              Recover saved recording
            </button>
          </Show>
          <label class="transcript-export-picker">
            <span class="visually-hidden">Export format</span>
            <select
              value={exportFormat()}
              disabled={props.disabled || !selectedSession()}
              onChange={(event) =>
                setExportFormat(event.currentTarget.value as TranscriptExportFormat)
              }
              aria-label="Transcript export format"
            >
              <option value="text">Text</option>
              <option value="srt">SubRip</option>
              <option value="vtt">WebVTT</option>
              <option value="json">JSON</option>
            </select>
          </label>
          <button
            class="button button-outline"
            type="button"
            disabled={props.disabled || !selectedSession()}
            onClick={() => {
              const session = selectedSession();
              if (session) props.onExport(session.id, exportFormat());
            }}
          >
            Export
          </button>
        </div>
      </section>

      <section class="transcript-capture-panel" aria-label="Microphone recording">
        <div class="transcript-capture-copy">
          <span class="eyebrow">SESSION AUDIO</span>
          <strong>Record from microphone</strong>
          <span>
            Saved locally as an audio material for playback, export, or cue links. Recording stops
            and saves when you leave this view.
          </span>
        </div>
        <label class="transcript-capture-consent">
          <input
            type="checkbox"
            checked={captureConsent()}
            disabled={props.disabled || captureState() !== "idle"}
            onChange={(event) => setCaptureConsent(event.currentTarget.checked)}
          />
          <span>I have permission to record this session</span>
        </label>
        <div class="transcript-capture-state">
          <Show when={captureState() === "recording"}>
            <span class="transcript-capture-live" role="timer" aria-live="off">
              <i aria-hidden="true" />
              Recording
              <strong>
                {`${Math.floor(captureElapsed() / 60)
                  .toString()
                  .padStart(2, "0")}:${(captureElapsed() % 60).toString().padStart(2, "0")}`}
              </strong>
            </span>
          </Show>
          <div class="transcript-capture-actions">
            <Show when={captureState() === "idle"}>
              <button
                class="button button-primary"
                type="button"
                disabled={
                  props.disabled ||
                  !selectedSession() ||
                  !captureConsent() ||
                  !microphoneAvailable()
                }
                onClick={() => void startCapture()}
              >
                <Icon name="microphone" />
                Record
              </button>
            </Show>
            <Show when={captureState() === "recording"}>
              <button class="button button-danger" type="button" onClick={stopCapture}>
                Stop and save
              </button>
            </Show>
            <Show when={captureState() === "saving"}>
              <span class="transcript-capture-saving" role="status" aria-live="polite">
                Saving recording…
              </span>
            </Show>
            <Show when={captureState() === "requesting"}>
              <span class="transcript-capture-saving" role="status" aria-live="polite">
                Waiting for microphone permission…
              </span>
            </Show>
          </div>
        </div>
        <Show when={!microphoneAvailable()}>
          <span class="transcript-capture-note">
            Microphone recording is not available in this window.
          </span>
        </Show>
        <Show when={captureError()}>
          <span class="transcript-capture-error" role="alert">
            {captureError()}
          </span>
        </Show>
      </section>

      <Show
        when={
          sessionRecordingTakes().length > 0 ||
          trashedSessionRecordingTakes().length > 0 ||
          trashedSessionRecordingTracks().length > 0
        }
      >
        <section class="transcript-takes-panel" aria-label="Recording takes">
          <div class="transcript-takes-heading">
            <div>
              <span class="eyebrow">SESSION AUDIO</span>
              <strong>Recording takes</strong>
              <span>
                Rename takes and tracks, then move individual items to Trash or restore them here.
              </span>
            </div>
            <span class="transcript-takes-count">
              {sessionRecordingTakes().length} active takes ·{" "}
              {trashedSessionRecordingTakes().length} takes and{" "}
              {trashedSessionRecordingTracks().length} tracks in Trash
            </span>
          </div>
          <div class="transcript-takes-list">
            <For each={sessionRecordingTakes()}>
              {(take) => {
                const trackIds = new Set(
                  field(take, "track_ids")
                    .split(",")
                    .map((id) => id.trim().toLowerCase())
                    .filter(Boolean),
                );
                return (
                  <RecordingTakeRow
                    take={take}
                    tracks={sessionTracks().filter((track) => trackIds.has(track.id.toLowerCase()))}
                    trashedTracks={trashedSessionRecordingTracks().filter(
                      (track) =>
                        field(track, "recording_take_id").toLowerCase() === take.id.toLowerCase(),
                    )}
                    disabled={props.disabled}
                    onRenameTake={props.onRenameRecordingTake}
                    onRenameTrack={props.onRenameRecordingTrack}
                    onTrashTrack={props.onTrashRecordingTrack}
                    onRestoreTrack={props.onRestoreRecordingTrack}
                    onTrash={props.onTrashRecordingTake}
                  />
                );
              }}
            </For>
            <For each={trashedSessionRecordingTakes()}>
              {(take) => (
                <article class="transcript-take-card transcript-take-card-trashed">
                  <div class="transcript-take-copy">
                    <strong>{field(take, "label", "Recording take")}</strong>
                    <span>Moved to Trash with its audio tracks and timeline data.</span>
                  </div>
                  <button
                    class="button button-outline"
                    type="button"
                    disabled={props.disabled}
                    onClick={() => props.onRestoreRecordingTake(take)}
                  >
                    Restore take
                  </button>
                </article>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={selectedSession()}>
        {(session) => (
          <>
            <MicrophoneTrackRecorder
              snapshot={props.snapshot}
              session={session()}
              trackIds={sessionTracks().map((track) => track.id)}
              disabled={props.disabled}
              onSave={(records, message, snapshot) => props.onSaveMix(snapshot, records, message)}
            />
            <SynchronizedRecorder
              snapshot={props.snapshot}
              session={session()}
              trackIds={sessionTracks().map((track) => track.id)}
              disabled={props.disabled}
              onSave={(records, message, snapshot) => props.onSaveMix(snapshot, records, message)}
              onCheckpointPersisted={props.onCheckpointPersisted}
            />
            <AudioMixer
              snapshot={props.snapshot}
              sessionId={session().id}
              takes={props.recordingTakes}
              tracks={props.tracks}
              disabled={props.disabled}
              onSave={props.onSaveMix}
            />
          </>
        )}
      </Show>
      <Show when={sessionTracks().length > 0}>
        <section class="transcript-audio-panel" aria-label="Session recording playback">
          <div class="transcript-audio-copy">
            <span class="eyebrow">SESSION RECORDING</span>
            <strong>{selectedTrack()?.label ?? "Recording"}</strong>
            <span>Load up to 30 seconds from the beginning or a transcript cue.</span>
          </div>
          <Show when={sessionTracks().length > 1}>
            <label class="transcript-audio-picker">
              <span class="visually-hidden">Audio track</span>
              <select
                value={selectedTrack()?.id ?? ""}
                aria-label="Audio track"
                onChange={(event) => {
                  clearAudio();
                  setTrackId(event.currentTarget.value);
                }}
              >
                <For each={sessionTracks()}>
                  {(track) => <option value={track.id}>{track.label}</option>}
                </For>
              </select>
            </label>
          </Show>
          <button
            class="button button-outline"
            type="button"
            disabled={!selectedTrack()}
            onClick={() => void playAudioAt("0")}
          >
            Play from start
          </button>
          <div class="transcript-audio-export-actions">
            <button
              class="button button-outline transcript-audio-export"
              type="button"
              disabled={props.disabled || !selectedTrack()}
              onClick={() => {
                const session = selectedSession();
                const track = selectedTrack();
                if (session && track) props.onExportAudio(session.id, track.id, track.label, false);
              }}
            >
              Export WAV
            </button>
            <button
              class="button button-outline transcript-audio-export"
              type="button"
              disabled={props.disabled || !selectedTrack()}
              onClick={() => {
                const session = selectedSession();
                const track = selectedTrack();
                if (session && track) props.onExportAudio(session.id, track.id, track.label, true);
              }}
            >
              Export with gap silence
            </button>
          </div>
          <p class="transcript-audio-export-note">
            Export WAV requires a continuous track. If audio is missing from the timeline, choose
            “Export with gap silence” to preserve timing by inserting silence. Tracks over 4 GiB use
            RF64, which currently requires Tutorux for desktop because browser downloads cannot
            safely save files this large.
          </p>
          <Show when={audioUrl() && audioPreview()}>
            <AudioWaveform
              preview={audioPreview()!}
              url={audioUrl()!}
              onPlayer={(element) => (audioPlayer = element)}
            />
          </Show>
          <Show when={selectedSession() && selectedTrack()}>
            <FullTrackWaveform
              snapshot={props.snapshot}
              sessionId={selectedSession()!.id}
              trackId={selectedTrack()!.id}
              disabled={props.disabled}
              onSave={(record, snapshot) => props.onSaveMix(snapshot, [record], "Waveform saved.")}
              onSelectTime={(timeUs) => void playAudioAt(timeUs.toString())}
            />
          </Show>
          <Show when={audioPreview() && selectedSession() && selectedTrack()}>
            <WhisperTranscription
              snapshot={props.snapshot}
              preview={audioPreview()!}
              sessionId={selectedSession()!.id}
              trackId={selectedTrack()!.id}
              records={sessionRecords()}
              disabled={props.disabled}
              onSave={props.onSaveWhisper}
            />
          </Show>
          <Show when={playbackError()}>
            <span class="transcript-audio-error" role="alert">
              {playbackError()}
            </span>
          </Show>
        </section>
      </Show>

      <section class="record-list-shell transcript-list-shell">
        <div class="record-list-toolbar">
          <span>
            <strong>{sessionRecords().length}</strong> transcript cues
            <Show when={selectedSession()}>
              {(session) => <span> · {field(session(), "title", "Untitled session")}</span>}
            </Show>
          </span>
          <span class="list-view-label">
            <Icon name="shield" />
            Review before reuse
          </span>
          <button
            class="button button-outline transcript-merge-button"
            type="button"
            disabled={props.disabled || selectedCues().length < 2}
            onClick={async () => {
              if (await props.onMerge(selectedCues())) setSelectedCueIds([]);
            }}
          >
            Merge {selectedCues().length ? `(${selectedCues().length})` : "selected cues"}
          </button>
        </div>
        <Show
          when={selectedSession()}
          fallback={
            <EmptyState
              icon="sessions"
              title="Start with a session"
              text="Transcript cues belong to a tutoring session, so create or open one first."
              action="Create a session"
              onAction={props.onNewSession}
              disabled={props.disabled}
            />
          }
        >
          <Show
            when={sessionRecords().length > 0}
            fallback={
              <EmptyState
                icon="transcripts"
                title="No transcript cues yet"
                text="Import a plain text, SubRip, or WebVTT file to begin reviewing what was said."
                action="Import a transcript"
                onAction={chooseImport}
                disabled={props.disabled}
              />
            }
          >
            <div class="transcript-list">
              <For each={sessionRecords()}>
                {(record, index) => (
                  <TranscriptCueCard
                    record={record}
                    displayIndex={index() + 1}
                    disabled={props.disabled}
                    audioAvailable={sessionTracks().length > 0}
                    selected={selectedCueIds().includes(record.id)}
                    assets={sessionAssets()}
                    onListen={(cue) => void playFromCue(cue)}
                    onToggleSelection={(cue, selected) =>
                      setSelectedCueIds((current) =>
                        selected
                          ? [...new Set([...current, cue.id])]
                          : current.filter((id) => id !== cue.id),
                      )
                    }
                    onSave={props.onSave}
                    onVerify={props.onVerify}
                    onHistory={props.onHistory}
                    onRestore={props.onRestore}
                    onSplit={props.onSplit}
                    onLinkAssets={props.onLinkAssets}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>
    </div>
  );
}

function RecordingTakeRow(props: {
  take: ArchiveRecord;
  tracks: AudioTrackDescriptor[];
  trashedTracks: ArchiveRecord[];
  disabled: boolean;
  onRenameTake: (take: ArchiveRecord, label: string) => void;
  onRenameTrack: (track: AudioTrackDescriptor, label: string) => void;
  onTrashTrack: (track: AudioTrackDescriptor) => void;
  onRestoreTrack: (track: ArchiveRecord) => void;
  onTrash: (take: ArchiveRecord) => void;
}): JSX.Element {
  const [label, setLabel] = createSignal(
    untrack(() => field(props.take, "label", "Recording take")),
  );

  return (
    <article class="transcript-take-card">
      <div class="transcript-take-card-heading">
        <label>
          <span>Take name</span>
          <input
            value={label()}
            maxLength={120}
            onInput={(event) => setLabel(event.currentTarget.value)}
            aria-label="Recording take name"
          />
        </label>
        <button
          class="button button-outline"
          type="button"
          disabled={props.disabled || label().trim() === field(props.take, "label")}
          onClick={() => props.onRenameTake(props.take, label())}
        >
          Save name
        </button>
        <button
          class="button button-outline transcript-take-trash"
          type="button"
          disabled={props.disabled}
          onClick={() => props.onTrash(props.take)}
        >
          Move to Trash
        </button>
      </div>
      <div class="transcript-take-meta">
        <span>{field(props.take, "state", "saved")}</span>
        <span>
          {props.tracks.length} {props.tracks.length === 1 ? "track" : "tracks"}
        </span>
        <span>{field(props.take, "source", "saved audio")}</span>
      </div>
      <Show when={props.tracks.length > 0}>
        <div class="transcript-take-tracks" aria-label="Tracks in this take">
          <For each={props.tracks}>
            {(track) => (
              <RecordingTrackName
                track={track}
                disabled={props.disabled}
                onRename={props.onRenameTrack}
                onTrash={props.onTrashTrack}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={props.trashedTracks.length > 0}>
        <div
          class="transcript-take-tracks transcript-take-trashed-tracks"
          aria-label="Tracks in Trash"
        >
          <strong>Tracks in Trash</strong>
          <For each={props.trashedTracks}>
            {(track) => (
              <div class="transcript-take-trashed-track-row">
                <span>{field(track, "label", "Recording track")}</span>
                <button
                  class="button button-outline"
                  type="button"
                  disabled={props.disabled}
                  aria-label={`Restore track: ${field(track, "label", "Recording track")}`}
                  onClick={() => props.onRestoreTrack(track)}
                >
                  Restore track
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </article>
  );
}

function RecordingTrackName(props: {
  track: AudioTrackDescriptor;
  disabled: boolean;
  onRename: (track: AudioTrackDescriptor, label: string) => void;
  onTrash: (track: AudioTrackDescriptor) => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal(props.track.label);
  const changed = () => draft().trim() !== props.track.label;
  let lastLabel = props.track.label;
  createEffect(() => {
    const label = props.track.label;
    if (label === lastLabel) return;
    lastLabel = label;
    setDraft(label);
  });

  return (
    <div class="transcript-take-track-row">
      <label>
        <span>Track name</span>
        <input
          value={draft()}
          maxLength={120}
          onInput={(event) => setDraft(event.currentTarget.value)}
          aria-label={`Track name: ${props.track.label}`}
        />
      </label>
      <button
        class="button button-outline"
        type="button"
        disabled={props.disabled || !changed()}
        onClick={() => props.onRename(props.track, draft().trim() || props.track.label)}
      >
        Save track name
      </button>
      <button
        class="button button-outline transcript-take-trash"
        type="button"
        disabled={props.disabled}
        aria-label={`Move track to Trash: ${props.track.label}`}
        onClick={() => props.onTrash(props.track)}
      >
        Move to Trash
      </button>
    </div>
  );
}

function TranscriptCueCard(props: {
  record: ArchiveRecord;
  displayIndex: number;
  disabled: boolean;
  audioAvailable: boolean;
  selected: boolean;
  assets: ArchiveRecord[];
  onListen: (record: ArchiveRecord) => void;
  onToggleSelection: (record: ArchiveRecord, selected: boolean) => void;
  onSave: (
    record: ArchiveRecord,
    text: string,
    start: string,
    end: string,
    speaker: string,
  ) => void;
  onVerify: (record: ArchiveRecord) => void;
  onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
  onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
  onSplit: (
    record: ArchiveRecord,
    beforeText: string,
    afterText: string,
    splitAt?: string,
  ) => Promise<boolean>;
  onLinkAssets: (record: ArchiveRecord, assetIds: readonly string[]) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [splitting, setSplitting] = createSignal(false);
  const [linkingAssets, setLinkingAssets] = createSignal(false);
  const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [text, setText] = createSignal("");
  const [start, setStart] = createSignal("");
  const [end, setEnd] = createSignal("");
  const [speaker, setSpeaker] = createSignal("");
  const [beforeText, setBeforeText] = createSignal("");
  const [afterText, setAfterText] = createSignal("");
  const [splitAt, setSplitAt] = createSignal("");
  const [draftAssetIds, setDraftAssetIds] = createSignal<string[]>([]);
  const availableAssets = createMemo(() => props.assets);
  const linkedAssetIds = createMemo(() =>
    field(props.record, "linked_asset_ids")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
  const linkedAssets = createMemo(() => {
    const linked = new Set(linkedAssetIds());
    return props.assets.filter((asset) => linked.has(asset.id.toLowerCase()));
  });
  const verification = createMemo(() => field(props.record, "verification_state", "provisional"));
  const statusLabel = createMemo(() =>
    verification() === "human-verified"
      ? "Human verified"
      : verification() === "human-corrected"
        ? "Corrected · review"
        : verification() === "needs-review"
          ? "Needs review"
          : "Provisional",
  );

  async function toggleHistory(): Promise<void> {
    if (history() !== null) {
      setHistory(null);
      return;
    }
    setHistoryLoading(true);
    try {
      setHistory(await props.onHistory(props.record));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function restoreRevision(historyIndex: number): Promise<void> {
    if (!(await props.onRestore(props.record, historyIndex))) return;
    setHistory(await props.onHistory(props.record));
  }

  function beginEditing(): void {
    setText(field(props.record, "text"));
    setStart(transcriptTimeInput(field(props.record, "start_time_us")));
    setEnd(transcriptTimeInput(field(props.record, "end_time_us")));
    setSpeaker(field(props.record, "speaker_label", field(props.record, "speaker_name")));
    setEditing(true);
  }

  function beginSplitting(): void {
    const characters = Array.from(field(props.record, "text"));
    let splitIndex = Math.floor(characters.length / 2);
    for (let index = splitIndex; index < characters.length - 1; index += 1) {
      if (/\s/u.test(characters[index]!)) {
        splitIndex = index + 1;
        break;
      }
    }
    if (splitIndex <= 0 || splitIndex >= characters.length) {
      splitIndex = Math.floor(characters.length / 2);
    }
    setBeforeText(characters.slice(0, splitIndex).join(""));
    setAfterText(characters.slice(splitIndex).join(""));
    const isTimestamped = field(props.record, "timestamp_state") !== "not-timestamped";
    if (isTimestamped) {
      const startTime = safeBigInt(field(props.record, "start_time_us", "0"));
      const endTime = safeBigInt(field(props.record, "end_time_us", "0"));
      setSplitAt(formatTranscriptTimestampUs(startTime + (endTime - startTime) / 2n));
    } else {
      setSplitAt("");
    }
    setSplitting(true);
  }

  async function saveSplit(): Promise<void> {
    const timestamped = field(props.record, "timestamp_state") !== "not-timestamped";
    const saved = await props.onSplit(
      props.record,
      beforeText(),
      afterText(),
      timestamped ? splitAt() : undefined,
    );
    if (saved) setSplitting(false);
  }

  function beginAssetLinking(): void {
    setDraftAssetIds(linkedAssetIds());
    setLinkingAssets(true);
  }

  async function saveAssetLinks(): Promise<void> {
    if (await props.onLinkAssets(props.record, draftAssetIds())) setLinkingAssets(false);
  }

  return (
    <article class="transcript-cue">
      <div class="transcript-cue-marker">
        <input
          type="checkbox"
          aria-label={"Select cue " + props.displayIndex + " to merge"}
          checked={props.selected}
          disabled={props.disabled}
          onChange={(event) => props.onToggleSelection(props.record, event.currentTarget.checked)}
        />
        <span>{String(props.displayIndex).padStart(2, "0")}</span>
      </div>
      <div class="transcript-cue-content">
        <div class="transcript-cue-meta">
          <span class="transcript-time">
            {field(props.record, "timestamp_state") === "not-timestamped"
              ? "Time not provided"
              : transcriptTimeRangeLabel(props.record)}
          </span>
          <span class={`transcript-status status-${verification()}`}>
            <span />
            {statusLabel()}
          </span>
        </div>
        <Show when={field(props.record, "speaker_label", field(props.record, "speaker_name"))}>
          <span class="transcript-speaker">
            {field(props.record, "speaker_label", field(props.record, "speaker_name"))}
          </span>
        </Show>
        <p class="transcript-cue-text">{field(props.record, "text")}</p>
        <div class="transcript-cue-actions">
          <Show when={props.audioAvailable}>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={
                props.disabled || field(props.record, "timestamp_state") === "not-timestamped"
              }
              onClick={() => props.onListen(props.record)}
              title={
                field(props.record, "timestamp_state") === "not-timestamped"
                  ? "Add a timestamp before playing from this cue"
                  : undefined
              }
            >
              Listen from cue
            </button>
          </Show>
          <button
            class="button button-outline record-action"
            type="button"
            disabled={props.disabled}
            onClick={beginEditing}
          >
            Correct cue
          </button>
          <button
            class="button button-outline record-action"
            type="button"
            disabled={props.disabled}
            onClick={() => (splitting() ? setSplitting(false) : beginSplitting())}
          >
            {splitting() ? "Cancel split" : "Split cue"}
          </button>
          <Show when={availableAssets().length > 0}>
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => (linkingAssets() ? setLinkingAssets(false) : beginAssetLinking())}
            >
              {linkingAssets()
                ? "Cancel links"
                : `Materials${linkedAssetIds().length ? ` (${linkedAssetIds().length})` : ""}`}
            </button>
          </Show>
          <Show when={props.record.previousOffset > 0n}>
            <button
              class="button button-quiet record-action"
              type="button"
              disabled={historyLoading()}
              aria-expanded={history() !== null}
              onClick={() => void toggleHistory()}
            >
              {historyLoading()
                ? "Loading history…"
                : history() === null
                  ? "View history"
                  : "Hide history"}
            </button>
          </Show>
          <Show when={verification() !== "human-verified"}>
            <button
              class="button button-quiet record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onVerify(props.record)}
            >
              Mark verified
            </button>
          </Show>
        </div>
        <Show when={history() !== null}>
          <section class="transcript-history-panel" aria-label="Transcript cue version history">
            <div class="transcript-history-heading">
              <span class="eyebrow">VERSION HISTORY</span>
              <span>{Math.max(0, (history()?.length ?? 1) - 1)} earlier versions</span>
            </div>
            <Show
              when={(history()?.length ?? 0) > 1}
              fallback={
                <p class="transcript-history-empty">This transcript cue has no earlier versions.</p>
              }
            >
              <div class="transcript-history-list">
                <For
                  each={(history()?.slice(1) ?? []).map((revision, index) => ({
                    revision,
                    historyIndex: index + 1,
                  }))}
                >
                  {(entry) => (
                    <article class="transcript-history-entry">
                      <div>
                        <strong>Version {entry.historyIndex}</strong>
                        <small>
                          {formatTimestamp(
                            field(
                              entry.revision,
                              "updated_at_us",
                              field(entry.revision, "created_at_us"),
                            ),
                          )}
                          {field(entry.revision, "_deleted") === "true" ? " · removed" : ""}
                        </small>
                      </div>
                      <p>{field(entry.revision, "text")}</p>
                      <button
                        class="button button-outline record-action"
                        type="button"
                        disabled={props.disabled}
                        onClick={() => void restoreRevision(entry.historyIndex)}
                      >
                        Restore version {entry.historyIndex}
                      </button>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>
        <Show when={linkedAssets().length > 0 && !linkingAssets()}>
          <div class="transcript-linked-materials" aria-label="Linked materials">
            <span>Linked materials</span>
            <For each={linkedAssets()}>
              {(asset) => (
                <span class="transcript-material-chip">{field(asset, "filename", "Material")}</span>
              )}
            </For>
          </div>
        </Show>
        <Show when={linkingAssets()}>
          <section class="transcript-material-editor" aria-label="Link materials to cue">
            <strong>Materials for this cue</strong>
            <For each={availableAssets()}>
              {(asset) => (
                <label>
                  <input
                    type="checkbox"
                    checked={draftAssetIds().includes(asset.id.toLowerCase())}
                    disabled={props.disabled}
                    onChange={(event) =>
                      setDraftAssetIds((current) =>
                        event.currentTarget.checked
                          ? [...new Set([...current, asset.id.toLowerCase()])]
                          : current.filter((id) => id !== asset.id.toLowerCase()),
                      )
                    }
                  />
                  <span>{field(asset, "filename", "Untitled material")}</span>
                </label>
              )}
            </For>
            <button
              class="button button-primary record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => void saveAssetLinks()}
            >
              Save material links
            </button>
          </section>
        </Show>
        <Show when={splitting()}>
          <section class="transcript-split-editor" aria-label="Split transcript cue">
            <label>
              Before
              <textarea
                rows={3}
                value={beforeText()}
                onInput={(event) => setBeforeText(event.currentTarget.value)}
              />
            </label>
            <label>
              After
              <textarea
                rows={3}
                value={afterText()}
                onInput={(event) => setAfterText(event.currentTarget.value)}
              />
            </label>
            <Show when={field(props.record, "timestamp_state") !== "not-timestamped"}>
              <label>
                Split time
                <input
                  type="text"
                  inputmode="decimal"
                  value={splitAt()}
                  onInput={(event) => setSplitAt(event.currentTarget.value)}
                />
              </label>
            </Show>
            <p>Keep the words unchanged; the two parts must join to the original cue.</p>
            <button
              class="button button-primary record-action"
              type="button"
              disabled={
                props.disabled ||
                !beforeText() ||
                !afterText() ||
                beforeText() + afterText() !== field(props.record, "text")
              }
              onClick={() => void saveSplit()}
            >
              Save split
            </button>
          </section>
        </Show>
        <Show when={editing()}>
          <div class="transcript-editor">
            <label>
              Cue text
              <textarea
                rows={4}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
              />
            </label>
            <div class="transcript-time-fields">
              <label>
                Start time
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="HH:MM:SS"
                  value={start()}
                  onInput={(event) => setStart(event.currentTarget.value)}
                />
              </label>
              <label>
                End time
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="HH:MM:SS"
                  value={end()}
                  onInput={(event) => setEnd(event.currentTarget.value)}
                />
              </label>
              <label>
                Speaker
                <input
                  type="text"
                  value={speaker()}
                  onInput={(event) => setSpeaker(event.currentTarget.value)}
                />
              </label>
            </div>
            <div class="transcript-editor-actions">
              <button
                class="button button-primary record-action"
                type="button"
                disabled={props.disabled || !text().trim()}
                onClick={() => props.onSave(props.record, text(), start(), end(), speaker())}
              >
                Save correction
              </button>
              <button
                class="button button-quiet record-action"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Show>
      </div>
    </article>
  );
}

function annotationTypeLabel(type: string): string {
  return type
    .split("-")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function transcriptTimeInput(raw: string): string {
  if (!/^\d+$/u.test(raw)) return "";
  return formatTranscriptTimestampUs(BigInt(raw));
}

function transcriptTimeRangeLabel(record: ArchiveRecord): string {
  const start = transcriptTimeInput(field(record, "start_time_us"));
  const end = transcriptTimeInput(field(record, "end_time_us"));
  return end ? `${start} – ${end}` : start;
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
    } finally {
      setPassphrase("");
    }
  };

  return (
    <form class="locked-unlock-form" onSubmit={submit}>
      <label class="form-field" for="archive-passphrase">
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
        />
      </label>
      <button class="button button-primary" type="submit" disabled={props.busy || !passphrase()}>
        {props.busy ? "Unlocking…" : "Unlock archive"}
      </button>
      <Show when={error()}>
        <p id="archive-unlock-error" class="locked-unlock-error" role="alert">
          {error()}
        </p>
      </Show>
    </form>
  );
}

function ArchivePage(props: {
  state: Workspace;
  busy: boolean;
  onApplyMaintenance: (original: ArchiveSnapshot, replacement: ArchiveSnapshot) => Promise<boolean>;
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
      setVerificationError(error instanceof Error ? error.message : "Archive verification failed.");
    } finally {
      setVerifying(false);
    }
  };
  return (
    <div class="page-body archive-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">YOUR DATA, IN YOUR HANDS</span>
          <h1>Archive health</h1>
          <p>Review the portable file that holds your tutoring workspace.</p>
        </div>
        <button class="button button-primary" type="button" onClick={() => props.onSave()}>
          <Icon name="check" />
          {props.state.dirty ? "Save changes" : "Save a copy"}
        </button>
      </section>
      <section class="archive-summary-card">
        <div class="archive-card-art">
          <img src={brandLogo} alt="" />
          <span class="archive-card-glow" />
        </div>
        <div class="archive-summary-copy">
          <span class="eyebrow">TUTORUX PORTABLE ARCHIVE</span>
          <h2>{props.state.manifest.displayName}</h2>
          <p>
            {props.state.manifest.description || "A private workspace for your tutoring practice."}
          </p>
          <div class="archive-chip-row">
            <span>
              <i class="dot-green" />
              {props.state.snapshot.locked
                ? "Encrypted · locked"
                : props.state.snapshot.encrypted
                  ? "Encrypted · unlocked"
                  : "Ready to use"}
            </span>
            <span>
              <Icon name="archive" />
              Format v{props.state.snapshot.header.majorVersion}.
              {props.state.snapshot.header.minorVersion}
            </span>
            <span>
              <Icon name="clock" />
              Generation {props.state.snapshot.commit.generation.toString()}
            </span>
          </div>
        </div>
        <div class="archive-size">
          <span>FILE SIZE</span>
          <strong>{formatBytes(props.state.snapshot.source.size)}</strong>
          <small>{props.state.location ?? "Browser copy"}</small>
        </div>
      </section>
      <Show when={props.state.snapshot.encrypted && !props.state.snapshot.locked}>
        <div class="archive-lock-action">
          <span>Archive contents are unlocked for this session.</span>
          <button class="button button-outline" type="button" onClick={() => props.onLock()}>
            <Icon name="shield" />
            Lock archive
          </button>
        </div>
      </Show>
      <div class="archive-info-grid">
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
          value={props.state.snapshot.indexEntryCount().toLocaleString()}
          icon="archive"
        />
        <InfoCard label="Archive ID" value={props.state.snapshot.header.id} icon="shield" mono />
      </div>
      <section class="surface-card archive-integrity">
        <div class="integrity-icon">
          <Icon name="shield" />
        </div>
        <div class="archive-integrity-copy">
          <h2>
            {verification()
              ? "Every current record passed verification"
              : props.state.snapshot.locked
                ? "Unlock to verify archive records"
                : "Verify every current record"}
          </h2>
          <p>
            {verification()
              ? `${verification()!.currentRecords.toLocaleString()} records checked, including ${verification()!.deletedRecords.toLocaleString()} in Trash.`
              : "Read every indexed record and check its index reference, including records in Trash."}
          </p>
          <Show when={verificationError()}>
            <p class="archive-integrity-error" role="alert">
              {verificationError()}
            </p>
          </Show>
          <Show when={historyVerification()}>
            {(result) => (
              <p>
                {result().historicalRevisions.toLocaleString()} historical revisions and{" "}
                {result().verifiedGenerationRecords.toLocaleString()} indexed records across{" "}
                {result().verifiedCommits.toLocaleString()} committed generations checked. Records
                present in multiple generations are counted once per generation.
              </p>
            )}
          </Show>
        </div>
        <div class="archive-integrity-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={props.state.snapshot.locked || verifying()}
            onClick={() => void verify()}
          >
            {verifying() ? "Checking records…" : "Verify archive"}
          </button>
          <button
            class="button button-outline"
            type="button"
            disabled={props.state.snapshot.locked || verifying()}
            onClick={() => void verify(true)}
          >
            Verify history
          </button>
          <span class="integrity-status" role="status">
            <i />
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
      <section class="archive-actions-card">
        <div>
          <span class="eyebrow">PORTABLE BY DESIGN</span>
          <h2>Keep a safe copy</h2>
          <p>
            Your archive is a single file. Save a copy somewhere you trust, then open it on another
            supported device when you need it.
          </p>
        </div>
        <div>
          <button class="button button-outline" type="button" onClick={() => props.onOpen()}>
            <Icon name="folder" />
            Open another archive
          </button>
          <button class="button button-primary" type="button" onClick={() => props.onSave()}>
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
  const [keys, setKeys] = createSignal(markerKeys(props.state));
  createEffect(() => {
    setKeys(markerKeys(props.state));
  });
  return (
    <div class="page-body settings-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">MAKE THE SPACE YOURS</span>
          <h1>Preferences</h1>
          <p>A few small choices for a workspace that feels right to use.</p>
        </div>
      </section>
      <section class="settings-section" aria-labelledby="keyboard-shortcuts-title">
        <div class="settings-section-heading">
          <h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
          <p>
            Core commands work throughout Tutorux; observation and note-editing shortcuts are
            available in their matching workspace pages.
          </p>
        </div>
        <dl class="shortcut-matrix">
          <For
            each={keyboardShortcutRows(
              navigator.platform.includes("Mac"),
              platform.kind === "desktop",
              keys(),
            )}
          >
            {(shortcut) => (
              <div class="shortcut-matrix-row">
                <dt>{shortcut.action}</dt>
                <dd>{shortcut.keys}</dd>
              </div>
            )}
          </For>
        </dl>
      </section>
      <section class="settings-section">
        <div class="settings-section-heading">
          <h2>Appearance</h2>
          <p>Choose the colors you’d like Tutorux to use.</p>
        </div>
        <div class="preference-row">
          <div class="preference-icon">
            <Icon name={props.theme === "light" ? "sun" : "moon"} />
          </div>
          <div class="preference-copy">
            <strong>Color theme</strong>
            <span>
              {props.themeMode === "system"
                ? `System appearance · ${props.theme}`
                : `${props.themeMode} appearance`}
            </span>
          </div>
          <label class="theme-mode-control">
            <span class="visually-hidden">Color theme</span>
            <select
              aria-label="Color theme"
              value={props.themeMode}
              onChange={(event) => props.onThemeMode(event.currentTarget.value as ThemeMode)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-heading">
          <h2>Observation shortcuts</h2>
          <p>
            On the Observations page, use Ctrl on Windows and Linux or Command on macOS with a key
            to start an observation. These keys travel with your archive. K, O, S, and N are
            reserved for workspace actions.
          </p>
        </div>
        <div class="marker-shortcuts">
          <For each={markerTypes}>
            {(type, index) => (
              <label class="form-field">
                {annotationTypeLabel(type)}
                <input
                  value={keys()[index()] ?? ""}
                  maxlength="1"
                  disabled={
                    props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate
                  }
                  onInput={(event) =>
                    setKeys((current) =>
                      current.map((key, i) => (i === index() ? event.currentTarget.value : key)),
                    )
                  }
                />
              </label>
            )}
          </For>
        </div>
        <div class="marker-shortcut-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate}
            onClick={() => setKeys([...defaultMarkerKeys])}
          >
            Restore defaults
          </button>
          <button
            class="button button-primary"
            type="button"
            disabled={props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate}
            onClick={() => void props.onSaveMarkerKeys(keys())}
          >
            Save shortcuts
          </button>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-heading">
          <h2>Privacy & storage</h2>
          <p>Tutorux keeps your work inside a portable archive you control.</p>
        </div>
        <div class="preference-row">
          <div class="preference-icon secure">
            <Icon name="shield" />
          </div>
          <div class="preference-copy">
            <strong>Local-first workspace</strong>
            <span>
              {platform.kind === "desktop"
                ? "Files are read and written directly on this device."
                : "The application does not upload archive files."}
            </span>
          </div>
          <span class="preference-value">On this device</span>
        </div>
        <Show when={props.state.snapshot.encrypted}>
          <div class="preference-row">
            <div class="preference-icon secure">
              <Icon name="shield" />
            </div>
            <div class="preference-copy">
              <strong>Passphrase protection</strong>
              <span>
                {props.state.snapshot.locked
                  ? "Unlock this archive to change its passphrase."
                  : "Your records are encrypted in this archive."}
              </span>
            </div>
            <button
              class="button button-outline"
              type="button"
              onClick={() => props.onChangePassphrase()}
              disabled={props.busy || props.state.snapshot.locked}
            >
              Change passphrase
            </button>
          </div>
        </Show>
        <div class="preference-row">
          <div class="preference-icon">
            <Icon name="archive" />
          </div>
          <div class="preference-copy">
            <strong>Current archive</strong>
            <span>{props.state.name}</span>
          </div>
          <span class="preference-value">{formatBytes(props.state.snapshot.source.size)}</span>
        </div>
        <Show when={props.state.dirty}>
          <div class="preference-row">
            <div class="preference-icon">
              <Icon name="archive" />
            </div>
            <div class="preference-copy">
              <strong>Changes waiting to be saved</strong>
              <span>The passphrase on disk updates when you save this workspace.</span>
            </div>
            <button
              class="button button-outline"
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
        disabled={props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate}
        onSave={props.onSaveSettings}
        onRename={props.onRenameArchive}
        onEnableEncryption={props.onEnableEncryption}
      />
      <ArchiveSettingsCopy
        archiveId={props.state.snapshot.header.id}
        archiveGeneration={props.state.snapshot.commit.generation.toString()}
        settings={props.state.settings}
        disabled={props.busy || props.state.snapshot.locked || !props.state.snapshot.canMutate}
        onSave={props.onSaveSettings}
      />
      <DiagnosticsReport snapshot={props.state.snapshot} disabled={props.busy} />
      <section class="settings-note">
        <Icon name="book" />
        <div>
          <strong>Built for people who teach</strong>
          <p>Tutorux helps you notice the details and make room for the work that matters.</p>
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
      class="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <ManagedDialog
        class="form-dialog confirm-dialog session-trash-dialog"
        role="alertdialog"
        labelledBy="session-trash-title"
        describedBy="session-trash-description session-trash-side-effects"
        onEscape={() => props.onCancel()}
        canEscape={() => !props.busy}
      >
        <span class="dialog-icon">
          <Icon name="trash" />
        </span>
        <span class="eyebrow">REVIEW SESSION GROUP</span>
        <h2 id="session-trash-title">Move this session to Trash?</h2>
        <p id="session-trash-description" class="dialog-description">
          <strong>{field(props.session, "title", "Untitled session")}</strong> and its linked
          transcripts, observations, recordings, materials, guides, and evidence will move together.
          Journal entries stay in place and reconnect when you restore the group.
        </p>
        <div class="session-trash-total">
          <strong>{props.counts.totalRecords}</strong>
          <span>records affected</span>
        </div>
        <dl class="session-trash-scope">
          <For each={details()}>
            {(detail) => (
              <div>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            )}
          </For>
        </dl>
        <p id="session-trash-side-effects" class="session-trash-note">
          Journal entries will be detached from this session and reconnected when the group is
          restored. Existing cross-session source links must be resolved first.
        </p>
        <div class="dialog-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={props.busy}
            onClick={() => props.onCancel()}
          >
            Keep session
          </button>
          <button
            class="button button-danger"
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
      class="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <ManagedDialog
        class="form-dialog confirm-dialog"
        role="alertdialog"
        labelledBy="trash-dialog-title"
        describedBy="trash-dialog-description"
        onEscape={() => props.onCancel()}
        canEscape={() => !props.busy}
      >
        <span class="dialog-icon">
          <Icon name="trash" />
        </span>
        <span class="eyebrow">RECOVERABLE ACTION</span>
        <h2 id="trash-dialog-title">
          Move {props.kind === "student" ? "student" : "observation"} to Trash?
        </h2>
        <p id="trash-dialog-description" class="dialog-description">
          <strong>{props.name}</strong> will leave the active workspace. You can restore this
          {props.kind === "student" ? " profile" : " observation"} from Trash later.
        </p>
        <div class="dialog-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={props.busy}
            onClick={() => props.onCancel()}
          >
            Keep {props.kind === "student" ? "student" : "observation"}
          </button>
          <button
            class="button button-danger"
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
      eyebrow: "A HOME FOR YOUR WORK",
      title: "Create a workspace",
      description:
        "Your workspace lives in one portable .tux file. You can move it or make a backup whenever you like.",
      submit: "Create workspace",
      icon: "archive",
    },
    passphrase: {
      eyebrow: "KEEP YOUR WORK PROTECTED",
      title: "Change passphrase",
      description:
        "Tutorux checks your current passphrase and every retained revision, then re-encrypts the archive with a fresh data key.",
      submit: "Change passphrase",
      icon: "shield",
    },
    student: {
      eyebrow: "THE PERSON FIRST",
      title: "Add a student",
      description: "Start with the details that help you see and support this learner.",
      submit: "Add student",
      icon: "students",
    },
    session: {
      eyebrow: "MAKE THE MOMENT COUNT",
      title: "New session",
      description: "Capture what you worked on and what you want to carry into next time.",
      submit: "Save session",
      icon: "sessions",
    },
    journal: {
      eyebrow: "NOTICE, REFLECT, RETURN",
      title: "New journal entry",
      description: "A short reflection can help you notice how a learner is growing.",
      submit: "Save entry",
      icon: "journal",
    },
  };
  const content = props.record
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
    : titles[props.kind];
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
  const today = new Date().toISOString().slice(0, 10);
  const [journalDate, setJournalDate] = createSignal(
    props.kind === "journal" ? (props.record ? field(props.record, "entry_date") : today) : "",
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
        const passphraseInput = form.querySelector<HTMLInputElement>('input[name="passphrase"]');
        const confirmationInput = form.querySelector<HTMLInputElement>(
          'input[name="confirmPassphrase"]',
        );
        try {
          await props.onCreateArchive(value("name"), value("description"), passphrase);
        } finally {
          if (passphraseInput) passphraseInput.value = "";
          if (confirmationInput) confirmationInput.value = "";
        }
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
        try {
          await props.onChangePassphrase(currentPassphrase, passphrase);
        } finally {
          if (currentPassphraseInputElement) currentPassphraseInputElement.value = "";
          if (passphraseInput) passphraseInput.value = "";
          if (confirmationInput) confirmationInput.value = "";
        }
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
        <div class="notes-autosave">
          <label>
            <input
              type="checkbox"
              checked={autosaveEnabled()}
              disabled={
                props.busy || autosavePermissionPending() || !props.state?.snapshot.canMutate
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
                    else setAutosaveStatus("Autosave could not get permission for this archive.");
                  })
                  .catch((error: unknown) => {
                    if (!editorDisposed)
                      setAutosaveStatus(`Autosave could not start: ${errorMessage(error)}`);
                  })
                  .finally(() => {
                    if (!editorDisposed) setAutosavePermissionPending(false);
                  });
              }}
            />
            Autosave notes
          </label>
          <small>
            {platform.kind === "desktop" && props.state?.location
              ? "Autosave writes all current workspace changes to the open archive file."
              : "When available, grant file access to save workspace changes to the open archive. Otherwise save the archive manually."}
          </small>
          <Show when={autosaveStatus()}>
            <small role="status" aria-live="polite">
              {autosaveStatus()}
            </small>
          </Show>
        </div>
      </Show>
    );
  }

  return (
    <div
      class="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) void closeForm();
      }}
    >
      <ManagedDialog
        class="form-dialog"
        role="dialog"
        labelledBy="form-dialog-title"
        onEscape={() => void closeForm()}
        canEscape={() => !props.busy}
      >
        <button
          class="icon-button dialog-close"
          type="button"
          onClick={() => void closeForm()}
          disabled={props.busy}
          aria-label="Close"
        >
          <Icon name="close" />
        </button>
        <span class="dialog-icon">
          <Icon name={content.icon} />
        </span>
        <span class="eyebrow">{content.eyebrow}</span>
        <h2 id="form-dialog-title">{content.title}</h2>
        <p class="dialog-description">{content.description}</p>
        <form onSubmit={submit}>
          <Show when={props.kind === "archive"}>
            <label class="form-field">
              Workspace name
              <input
                ref={(element) => {
                  nameInput = element;
                }}
                name="name"
                placeholder="e.g. Maya’s tutoring"
                maxlength="200"
                required
              />
            </label>
            <label class="form-field">
              A short description <span class="optional">Optional</span>
              <textarea
                name="description"
                rows="3"
                placeholder="What will this workspace hold?"
                maxlength="1000"
              />
            </label>
            <label class="archive-encryption-toggle">
              <input
                type="checkbox"
                checked={encryptOnCreate()}
                onChange={(event) => setEncryptOnCreate(event.currentTarget.checked)}
              />
              <span>
                <strong>Protect this workspace with a passphrase</strong>
                <small>Encrypt learner records and private notes on disk.</small>
              </span>
            </label>
            <Show when={encryptOnCreate()}>
              <label class="form-field">
                Archive passphrase
                <input
                  type="password"
                  name="passphrase"
                  autocomplete="new-password"
                  maxlength="4096"
                  required
                />
              </label>
              <label class="form-field">
                Confirm passphrase
                <input
                  type="password"
                  name="confirmPassphrase"
                  autocomplete="new-password"
                  maxlength="4096"
                  required
                />
              </label>
              <p class="archive-encryption-help">
                Keep this passphrase safe. Tutorux cannot recover it if it is lost.
              </p>
            </Show>
          </Show>
          <Show when={props.kind === "passphrase"}>
            <label class="form-field">
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
              />
            </label>
            <label class="form-field">
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
              />
            </label>
            <label class="form-field">
              Confirm new passphrase
              <input
                type="password"
                name="confirmPassphrase"
                autocomplete="new-password"
                maxlength="4096"
                required
              />
            </label>
            <p class="archive-encryption-help">
              Use 12–4096 UTF-8 bytes. Save the workspace after changing it; the previous passphrase
              remains active on disk until then. Older backup files keep their original passphrase.
            </p>
          </Show>
          <Show when={props.kind === "student"}>
            <label class="form-field">
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
              />
            </label>
            <div class="form-field-grid">
              <label class="form-field">
                Grade or level
                <input
                  name="grade"
                  placeholder="e.g. Year 8"
                  maxlength="128"
                  value={props.record ? field(props.record, "grade") : ""}
                />
              </label>
              <label class="form-field">
                Subjects
                <input
                  name="subjects"
                  placeholder="e.g. Algebra, Science"
                  maxlength="2048"
                  value={props.record ? field(props.record, "subjects") : ""}
                />
              </label>
            </div>
            <label class="form-field">
              Learning goals
              <textarea
                name="objectives"
                rows="3"
                placeholder="What are they working towards?"
                maxlength="4096"
                value={props.record ? field(props.record, "learning_objectives") : ""}
              />
            </label>
            <div class="form-field-grid">
              <label class="form-field">
                Areas to revisit
                <textarea
                  name="difficulties"
                  rows="3"
                  placeholder="Concepts or approaches that still need practice"
                  maxlength="4096"
                  value={props.record ? field(props.record, "known_difficulties") : ""}
                />
              </label>
              <label class="form-field">
                Demonstrated improvements
                <textarea
                  name="demonstratedImprovements"
                  rows="3"
                  placeholder="Skills the learner is showing more independently"
                  maxlength="4096"
                  value={props.record ? field(props.record, "demonstrated_improvements") : ""}
                />
              </label>
            </div>
            <label class="form-field">
              Preferred study-guide structure <span class="optional">Optional</span>
              <select
                name="preferredGuideTemplate"
                value={props.record ? field(props.record, "preferred_guide_template") : ""}
              >
                <option value="">Choose when creating a guide</option>
                <Show
                  when={
                    props.record &&
                    field(props.record, "preferred_guide_template") &&
                    !GUIDE_TEMPLATES.some(
                      (template) =>
                        template.id === field(props.record!, "preferred_guide_template"),
                    ) &&
                    !props.state?.guideTemplates.some(
                      (template) =>
                        template.id === field(props.record!, "preferred_guide_template"),
                    )
                  }
                >
                  <option value={field(props.record!, "preferred_guide_template")}>
                    {field(props.record!, "preferred_guide_template")} · saved in this archive
                  </option>
                </Show>
                <For each={GUIDE_TEMPLATES}>
                  {(template) => <option value={template.id}>{template.name}</option>}
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
              class="optional-fields"
              open={Boolean(props.record && field(props.record, "tutor_notes"))}
            >
              <summary>
                Private tutor notes <span>Only in this archive</span>
              </summary>
              <textarea
                name="notes"
                rows="3"
                placeholder="Anything useful to keep in mind?"
                maxlength="16384"
                value={props.record ? field(props.record, "tutor_notes") : ""}
              />
            </details>
          </Show>
          <Show when={props.kind === "session"}>
            <label class="form-field">
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
              />
            </label>
            <div class="form-field-grid">
              <label class="form-field">
                Student
                <select
                  name="student"
                  value={props.record ? field(props.record, "student_id") : ""}
                >
                  <option value="">Independent session</option>
                  <For each={props.state?.students ?? []}>
                    {(student) => (
                      <option value={student.id}>{field(student, "display_name")}</option>
                    )}
                  </For>
                </select>
              </label>
              <label class="form-field">
                Subject
                <input
                  name="subject"
                  placeholder="e.g. Algebra"
                  maxlength="200"
                  value={props.record ? field(props.record, "subject") : ""}
                />
              </label>
            </div>
            <label class="form-field">
              Learning objective
              <input
                name="objectives"
                placeholder="What did you want to work on?"
                maxlength="4000"
                value={props.record ? field(props.record, "learning_objectives") : ""}
              />
            </label>
            <div class="form-field document-form-field">
              <span>Session notes</span>
              <Show
                when={noteState.editable}
                fallback={
                  <span class="form-help">
                    These notes contain content this editor cannot safely change. They remain
                    preserved while you edit the other session details.
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
            <label class="form-field">
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
              />
            </label>
            <div class="form-field">
              <span>Date</span>
              <div style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}>
                <input
                  type="date"
                  name="date"
                  value={journalDate()}
                  onInput={(event) => setJournalDate(event.currentTarget.value)}
                  style={{ flex: "1" }}
                />
                <button
                  class="button button-quiet record-action"
                  type="button"
                  disabled={!journalDate()}
                  onClick={() => setJournalDate("")}
                >
                  Clear date
                </button>
              </div>
              <span class="form-help">Leave the date empty for an undated reflection.</span>
            </div>
            <div class="form-field document-form-field">
              <span>Reflection</span>
              <Show
                when={noteState.editable}
                fallback={
                  <span class="form-help">
                    These notes contain content this editor cannot safely change. They remain
                    preserved while you edit the other entry details.
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
            <div class="journal-link-fields">
              <fieldset class="journal-link-group">
                <legend>Collections</legend>
                <Show
                  when={(props.state?.collections.length ?? 0) > 0}
                  fallback={
                    <p class="form-help">
                      Create a collection in the journal to group related reflections.
                    </p>
                  }
                >
                  <For each={props.state?.collections ?? []}>
                    {(item) => (
                      <label class="journal-check-label">
                        <input
                          type="checkbox"
                          name="collectionIds"
                          value={item.id}
                          checked={journalIds("collection_ids").includes(item.id)}
                        />
                        <span
                          class="journal-label-dot"
                          style={{ "--label-color": safeJournalColor(item) }}
                        />
                        {field(item, "name", "Untitled collection")}
                      </label>
                    )}
                  </For>
                </Show>
                <For
                  each={journalIds("collection_ids").filter(
                    (id) => !props.state?.collections.some((item) => item.id === id),
                  )}
                >
                  {(id) => <input type="hidden" name="collectionIds" value={id} />}
                </For>
              </fieldset>
              <fieldset class="journal-link-group">
                <legend>Tags</legend>
                <Show
                  when={(props.state?.tags.length ?? 0) > 0}
                  fallback={
                    <p class="form-help">Create a tag in the journal to mark a useful detail.</p>
                  }
                >
                  <For each={props.state?.tags ?? []}>
                    {(item) => (
                      <label class="journal-check-label">
                        <input
                          type="checkbox"
                          name="tagIds"
                          value={item.id}
                          checked={journalIds("tag_ids").includes(item.id)}
                        />
                        <span
                          class="journal-label-dot"
                          style={{ "--label-color": safeJournalColor(item) }}
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
                  {(id) => <input type="hidden" name="tagIds" value={id} />}
                </For>
              </fieldset>
            </div>
            <Show
              when={
                journalIds("collection_ids").some(
                  (id) => !props.state?.collections.some((item) => item.id === id),
                ) ||
                journalIds("tag_ids").some(
                  (id) => !props.state?.tags.some((item) => item.id === id),
                )
              }
            >
              <span class="form-help">
                Unavailable legacy labels remain linked when this entry is saved.
              </span>
            </Show>
            <Show when={props.record && !noteState.editable}>
              <span class="form-help">
                This reflection contains structured blocks. They are preserved while you edit the
                title or date.
              </span>
            </Show>
          </Show>
          <Show when={validationError()}>
            <p class="form-error" role="alert">
              {validationError()}
            </p>
          </Show>
          <div class="dialog-actions">
            <button
              class="button button-outline"
              type="button"
              onClick={() => void closeForm()}
              disabled={props.busy}
            >
              Cancel
            </button>
            <button
              class="button button-primary"
              type="submit"
              disabled={
                props.busy ||
                (props.kind !== "archive" && (!props.state || !props.state.snapshot.canMutate))
              }
            >
              {props.busy ? "Saving…" : content.submit}
              <Icon name="arrow" />
            </button>
          </div>
        </form>
        <span class="dialog-privacy">
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
    <button class="stat-card" type="button" onClick={() => props.onClick()}>
      <span class={`stat-icon stat-${props.icon}`}>
        <Icon name={props.icon} />
      </span>
      <span class="stat-copy">
        <span>{props.label}</span>
        <strong>{props.value.toLocaleString()}</strong>
        <small>{props.detail}</small>
      </span>
      <Icon name="arrow" />
    </button>
  );
}

function Feature(props: { icon: IconName; title: string; text: string }): JSX.Element {
  return (
    <article class="welcome-feature">
      <span class="feature-icon">
        <Icon name={props.icon} />
      </span>
      <h3>{props.title}</h3>
      <p>{props.text}</p>
    </article>
  );
}

function EmptyMini(props: {
  title: string;
  text: string;
  action: string;
  onAction: () => void;
}): JSX.Element {
  return (
    <div class="empty-mini">
      <span class="empty-mini-mark">
        <Icon name="spark" />
      </span>
      <div>
        <strong>{props.title}</strong>
        <p>{props.text}</p>
        <button class="text-action" type="button" onClick={() => props.onAction()}>
          {props.action}
          <Icon name="arrow" />
        </button>
      </div>
    </div>
  );
}

function EmptyState(props: {
  icon: IconName;
  title: string;
  text: string;
  action: string;
  onAction: () => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div class="empty-state">
      <span class="empty-illustration">
        <span class="empty-illustration-back" />
        <span class="empty-illustration-paper">
          <Icon name={props.icon} />
          <i />
          <i />
          <i />
        </span>
        <span class="empty-illustration-spark">✳</span>
      </span>
      <h2>{props.title}</h2>
      <p>{props.text}</p>
      <Show when={!props.disabled}>
        <button class="button button-primary" type="button" onClick={() => props.onAction()}>
          <Icon name="plus" />
          {props.action}
        </button>
      </Show>
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
    <article class="archive-info-card">
      <span class="info-card-icon">
        <Icon name={props.icon} />
      </span>
      <span class="eyebrow">{props.label}</span>
      <strong class={props.mono ? "mono" : ""} title={props.value}>
        {props.value}
      </strong>
    </article>
  );
}

function Icon(props: { name: IconName }): JSX.Element {
  const common = {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.7,
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
  };
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" {...common}>
      {props.name === "home" && (
        <>
          <path d="m3.5 10.5 8.5-7 8.5 7" />
          <path d="M5.5 9.8V20h13V9.8M9.5 20v-6.5h5V20" />
        </>
      )}
      {props.name === "journal" && (
        <>
          <path d="M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A2.5 2.5 0 0 1 3.5 17V7A2.5 2.5 0 0 1 6 4.5Z" />
          <path d="M3.5 17A2.5 2.5 0 0 1 6 14.5h13.5M8 8h7M8 11h7" />
        </>
      )}
      {props.name === "students" && (
        <>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 6.2M17 15a5 5 0 0 1 3.5 4.8" />
        </>
      )}
      {props.name === "sessions" && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5l3.2 2" />
        </>
      )}
      {props.name === "annotations" && (
        <>
          <path d="M12 21s7-6.4 7-12a7 7 0 1 0-14 0c0 5.6 7 12 7 12Z" />
          <circle cx="12" cy="9" r="2.2" />
        </>
      )}
      {props.name === "transcripts" && (
        <>
          <path d="M5.5 4.5h13v15h-13z" />
          <path d="M8.5 8h7M8.5 11h7M8.5 14h4" />
          <path d="M3.5 7v12a1.5 1.5 0 0 0 1.5 1.5h11" />
        </>
      )}
      {props.name === "guides" && (
        <>
          <path d="M5.5 4.5h13v15h-13zM8.5 8h7M8.5 11h7M8.5 14h4" />
          <path d="M5.5 18c0-1.1.9-2 2-2h11" />
        </>
      )}
      {props.name === "evidence" && (
        <>
          <path d="M4 19.5h16M6.5 16v-4M12 16V7M17.5 16V9" />
          <path d="m5.5 9 5-3 5 1 3-3" />
        </>
      )}
      {props.name === "assets" && (
        <>
          <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
          <path d="m8 15 2-2 2 2 2.5-3 2.5 3" />
        </>
      )}
      {props.name === "archive" && (
        <>
          <path d="M4 7h16v13H4zM3 4h18v3H3z" />
          <path d="M9 11h6" />
        </>
      )}
      {props.name === "trash" && (
        <>
          <path d="M4.5 7.5h15M9 7.5V5h6v2.5M7 7.5l.8 12h8.4l.8-12M10 11v5M14 11v5" />
        </>
      )}
      {props.name === "settings" && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path
            d="m19.4 15 .1.1 1.1.9-1.2 2.1-1.4-.5a7.8 7.8 0 0 1-1.4.8l-.3 1.5h-2.5l-.3-1.5a7.8 7.8 0 0 1-1.4-.8l-1.4.5-1.2-2.1 1.1-.9a6.9 6.9 0 0 1 0-1.7l-1.1-.9 1.2-2.1 1.4.5a7.8 7.8 0 0 1 1.4-.8l.3-1.5h2.5l.3 1.5a7.8 7.8 0 0 1 1.4.8l1.4-.5 1.2 2.1-1.1.9a6.9 6.9 0 0 1 0 1.6Z"
            transform="translate(-2 -1) scale(.9)"
          />
        </>
      )}
      {props.name === "plus" && <path d="M12 5v14M5 12h14" />}
      {props.name === "microphone" && (
        <>
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
        </>
      )}
      {props.name === "search" && (
        <>
          <circle cx="10.8" cy="10.8" r="6.8" />
          <path d="m16 16 4.5 4.5" />
        </>
      )}
      {props.name === "sun" && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2.5 12h2m15 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      )}
      {props.name === "moon" && (
        <path d="M20.5 15.1A8.5 8.5 0 0 1 8.9 3.5 8.6 8.6 0 1 0 20.5 15.1Z" />
      )}
      {props.name === "chevron" && <path d="m9 5 7 7-7 7" />}
      {props.name === "arrow" && (
        <>
          <path d="M5 12h13M13 6l6 6-6 6" />
        </>
      )}
      {props.name === "book" && (
        <>
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z" />
          <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h7M8 10h7" />
        </>
      )}
      {props.name === "clock" && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5l3 1.8" />
        </>
      )}
      {props.name === "spark" && (
        <>
          <path d="m12 3 1.6 6.1L20 11l-6.4 1.9L12 19l-1.7-6.1L4 11l6.3-1.9z" />
          <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z" />
        </>
      )}
      {props.name === "folder" && (
        <>
          <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" />
          <path d="M3.5 10h17" />
        </>
      )}
      {props.name === "shield" && (
        <>
          <path d="M12 3 19 6v5c0 4.4-2.8 7.8-7 10-4.2-2.2-7-5.6-7-10V6z" />
          <path d="m9 12 2 2 4-4" />
        </>
      )}
      {props.name === "close" && (
        <>
          <path d="m6 6 12 12M18 6 6 18" />
        </>
      )}
      {props.name === "check" && <path d="m5 12.5 4.5 4.5L19 7" />}
      {props.name === "more" && (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  );
}

function alive(records: ArchiveRecord[]): ArchiveRecord[] {
  return records.filter((record) => record.fields.get("_deleted") !== "true");
}

function field(record: ArchiveRecord, name: string, fallback = ""): string {
  return record.fields.get(name) ?? fallback;
}

function safeJournalColor(record: ArchiveRecord): string {
  const color = field(record, "color");
  return /^#[\da-f]{6}$/iu.test(color) ? color : "var(--accent)";
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase() ?? "")
      .join("") || "T"
  );
}

function safeFileName(value: string): string {
  const slug = value
    .trim()
    // eslint-disable-next-line no-control-regex -- Remove platform-invalid filename controls.
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
  return (slug || "Tutorux-workspace").slice(0, 100);
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatTimestamp(value: string): string {
  try {
    const microseconds = BigInt(value || "0");
    const milliseconds = Number(microseconds / 1000n);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Date not set";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(milliseconds),
    );
  } catch {
    return "Date not set";
  }
}

function formatMicroseconds(value: bigint): string {
  return formatTimestamp(value.toString());
}

function dateParts(value: string): { day: string; month: string; year: string } {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return { day: "–", month: "---", year: "" };
  return {
    day: new Intl.DateTimeFormat(undefined, { day: "2-digit" }).format(date),
    month: new Intl.DateTimeFormat(undefined, { month: "short" }).format(date).toUpperCase(),
    year: new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(date),
  };
}

function formatBytes(size: bigint): string {
  if (size < 1024n) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = Number(size);
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function recordSort(kind: RecordPagePropsKind, record: ArchiveRecord): string {
  if (kind === "journal") return field(record, "entry_date");
  if (kind === "sessions") return field(record, "started_at_us");
  return field(record, "updated_at_us", field(record, "created_at_us"));
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
        label: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date),
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

function errorMessage(error: unknown): string {
  if (error instanceof ArchiveFormatError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

render(() => <App />, document.getElementById("root")!);
