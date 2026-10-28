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
  createArchiveBytes,
  createEncryptedArchiveBytes,
  openArchiveBytes,
  openArchiveSource,
  verifyArchiveSnapshot,
  type ArchiveVerificationResult,
  type ArchiveManifest,
  type ArchiveSnapshot,
} from "./archive/archive";
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "./archive/format";
import { DocumentEditor } from "./DocumentEditor";
import { sourceStream, type ArchiveByteSource } from "./archive/source";
import { AiPage } from "./AiPage";
import { createAiPackageRecord, type AiPackageSummary } from "./ai/package";
import { createAiRequestPreview, type AiRequestPreview } from "./ai/request";
import { executeAiGeneration } from "./ai/execution";
import type { AiExecutionSummary } from "./ai/response";
import {
  createProviderConfigurationRecord,
  createProviderCredentialRecord,
  maskCredentialMetadata,
  providerById,
  type AiProviderConfigurationInput,
} from "./ai/providers";
import { MAX_ASSET_BYTES, makeAssetImport, readAssetBytes } from "./domain/assets";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { configurePdfWorkerSource } from "./domain/document-text";
import {
  buildAudioTrackWavStream,
  buildAudioPreview,
  listSessionAudioTracks,
  type AudioTrackDescriptor,
} from "./domain/audio";
import { makeWaveImportRecords } from "./domain/wav";
import {
  renameRecordingTake,
  renameRecordingTrack,
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
  makeGuideRecord,
  renderGuideHtml,
  renderGuideMarkdown,
  type GuideDraft,
  type GuideTemplate,
} from "./domain/guides";
import {
  makeCustomGuideTemplateRecord,
  serializeGuideTemplate,
  type GuideTemplateInput,
} from "./domain/templates";
import {
  EVIDENCE_RELATIONSHIPS,
  extractSessionEvidence,
  makeEvidenceEdge,
  reviewEvidenceRecord,
  restoreEvidenceRecordGroup,
  trashEvidenceRecord,
  updateEvidenceRecord,
  type EvidenceUpdateInput,
} from "./domain/evidence";
import {
  ANNOTATION_PRIORITIES,
  ANNOTATION_TYPES,
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
  restoreRecordFromTrash,
  restoreJournalOrganizerRecord,
  setSessionArchiveState,
  updateJournalRecords,
  updateSessionRecords,
  updateStudentRecord,
  transitionSessionRecord,
  type JournalInput,
  type JournalNoteBlock,
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
import {
  correctTranscriptRecord,
  formatTranscriptExport,
  formatTranscriptTimestampUs,
  makeTranscriptRecords,
  mergeTranscriptRecords,
  parseTranscriptSource,
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
import type { AiCredentialStorage } from "./platform/types";
import { GuidesPage } from "./GuidesPage";
import { StudentProgressPanel } from "./StudentProgressPanel";
import { JournalOrganizer } from "./JournalOrganizer";
import brandLogo from "../web/assets/tutorux.svg";
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
  entries: ArchiveRecord[];
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
  aiJobs: ArchiveRecord[];
  providerSettings: ArchiveRecord[];
  credentials: ArchiveRecord[];
  dirty: boolean;
}

interface SessionTrashReview {
  session: ArchiveRecord;
  snapshot: ArchiveSnapshot;
  plan: SessionTrashPlan;
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
const [theme, setTheme] = createSignal<"light" | "dark">("light");
const [themeMode, setThemeMode] = createSignal<ThemeMode>("system");
const [loading, setLoading] = createSignal(false);
const [query, setQuery] = createSignal("");
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [paletteQuery, setPaletteQuery] = createSignal("");
const [paletteIndex, setPaletteIndex] = createSignal(0);
const [notice, setNotice] = createSignal<{ message: string; tone: Tone } | null>(null);
const [busy, setBusy] = createSignal(false);
const [selectedTranscriptSessionId, setSelectedTranscriptSessionId] = createSignal("");
const [selectedAnnotationSessionId, setSelectedAnnotationSessionId] = createSignal("");
const [selectedEvidenceSessionId, setSelectedEvidenceSessionId] = createSignal("");
const [guideTemplateManagerOpen, setGuideTemplateManagerOpen] = createSignal(false);

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
  if (persist) localStorage.setItem("tutorux.theme", mode);
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
  return records.filter((record) =>
    [...record.fields.values()].some((value) => value.toLocaleLowerCase().includes(needle)),
  );
});

function App(): JSX.Element {
  const [lastAiExecution, setLastAiExecution] = createSignal<{
    archiveId: string;
    summary: AiExecutionSummary;
  } | null>(null);
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

  onMount(() => {
    if (platform.kind === "desktop") {
      void platform
        .aiCredentialStoreAvailable()
        .then(setSystemCredentialStoreAvailable)
        .catch(() => setSystemCredentialStoreAvailable(false));
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const savedTheme = localStorage.getItem("tutorux.theme");
    const initialMode: ThemeMode =
      savedTheme === "light" || savedTheme === "dark" || savedTheme === "system"
        ? savedTheme
        : "system";
    applyThemeMode(initialMode, false);
    const updateSystemTheme = (): void => {
      if (themeMode() === "system") applyThemeMode("system", false);
    };
    mediaQuery.addEventListener("change", updateSystemTheme);

    const receiveNotice = (event: Event): void => {
      const detail = (event as CustomEvent<{ message: string; tone?: Tone }>).detail;
      announce(detail.message, detail.tone ?? "info");
    };
    const handleKeys = (event: KeyboardEvent): void => {
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      if (dialog() || pendingDelete() || pendingSessionTrash() || paletteOpen()) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "k") {
        event.preventDefault();
        openPalette();
      } else if (key === "o") {
        event.preventDefault();
        void openArchive();
      } else if (key === "s") {
        event.preventDefault();
        void saveCurrentArchive();
      } else if (key === "n") {
        event.preventDefault();
        openDialog("session");
      }
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
              openPalette();
              break;
            case "preferences":
              setView("settings");
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
    window.addEventListener("keydown", handleKeys);
    onCleanup(() => {
      window.removeEventListener("tutorux:notice", receiveNotice);
      window.removeEventListener("keydown", handleKeys);
      mediaQuery.removeEventListener("change", updateSystemTheme);
      window.clearTimeout(noticeTimer);
      nativeCommandListenerDisposed = true;
      removeNativeCommandListener?.();
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
        entries: [],
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
        aiJobs: [],
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
      entries: alive(settings).filter(
        (record) => record.fields.get("record_role") === "journal-entry",
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
      aiJobs,
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
  ): Promise<void> {
    setLoading(true);
    let accepted = false;
    try {
      const snapshot = await openArchiveSource(source);
      const next = await readWorkspace(snapshot, name, location);
      const previous = workspace();
      setWorkspace(next);
      if (previous && previous.snapshot !== snapshot) previous.snapshot.lock();
      setPendingSessionTrash(null);
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
      providerSettings: [],
      credentials: [],
    });
    setDialog(null);
    setDialogRecord(null);
    setPendingDelete(null);
    setPendingSessionTrash(null);
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
      await acceptArchive(selected.source, selected.name, selected.location);
    } catch (error) {
      if (isCancelled(error)) return;
      announce(errorMessage(error), "error");
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
      setWorkspace({ ...state, location: platform.kind === "desktop" ? path : null, dirty: false });
      announce("Your archive is saved.", "success");
    } catch (error) {
      announce(errorMessage(error), "error");
    } finally {
      setBusy(false);
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
      if (nextSnapshot !== current.snapshot) current.snapshot.lock();
      setView(view());
      announce(successMessage, "success");
      setDialog(null);
      setDialogRecord(null);
      setPendingDelete(null);
      setPendingSessionTrash(null);
      return true;
    } catch (error) {
      if (nextSnapshot && workspace()?.snapshot !== nextSnapshot) nextSnapshot.lock();
      announce(errorMessage(error), "error");
      return false;
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
    );
  }

  async function saveAiPackage(summary: AiPackageSummary): Promise<boolean> {
    return addRecords(
      [summary.job],
      "Reviewed AI package saved in this archive. Save the archive to write it to disk.",
    );
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
    const freshPreview = await createAiRequestPreview(
      savedPackage,
      providerConfiguration,
      preview.maxOutputTokens,
      useSystemCredentialStore ? [] : current.credentials,
      hasSystemCredential,
      current.snapshot,
    );
    if (
      freshPreview.providerId !== preview.providerId ||
      freshPreview.endpoint !== preview.endpoint ||
      freshPreview.guideTemplateId !== expectedTemplateId ||
      freshPreview.model !== preview.model ||
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
      const session = state.sessions.find((item) => item.id === draft.sessionId);
      if (!session) throw new Error("Choose an active session for this study guide.");
      const record = makeGuideRecord(
        draft,
        { session, records: guideSourceRecords(state) },
        current,
      );
      return await addRecords(
        [record],
        current ? "Study guide updated." : "Study guide draft added to the archive.",
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
      const session = state.sessions.find((item) => item.id === draft.sessionId);
      if (!session)
        throw new Error(
          "The source session is unavailable. Restore it before approving this guide.",
        );
      const checked = makeGuideRecord(
        draft,
        { session, records: guideSourceRecords(state) },
        record,
      );
      await addRecords([approveGuideRecord(checked)], "Study guide approved.");
    } catch (error) {
      announce(errorMessage(error), "error");
    }
  }

  async function trashGuide(record: ArchiveRecord): Promise<void> {
    await addRecords([moveRecordToTrash(record)], "Study guide moved to Trash.");
  }

  async function restoreGuide(record: ArchiveRecord): Promise<void> {
    await addRecords([restoreRecordFromTrash(record)], "Study guide restored from Trash.");
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

  async function exportGuide(record: ArchiveRecord, format: "markdown" | "html"): Promise<void> {
    try {
      const isHtml = format === "html";
      const path = await platform.exportTextFile(
        `${safeFileName(field(record, "title", "study-guide"))}.${isHtml ? "html" : "md"}`,
        isHtml ? renderGuideHtml(record) : renderGuideMarkdown(record),
        isHtml ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8",
      );
      if (path) announce(`Study guide exported as ${isHtml ? "HTML" : "Markdown"}.`, "success");
    } catch (error) {
      if (!isCancelled(error)) announce(errorMessage(error), "error");
    }
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
    try {
      const state = workspace();
      const session = state?.sessions.find((record) => record.id === sessionId);
      if (!state || !session) throw new Error("Choose a session before importing a transcript.");
      if (state.snapshot.locked)
        throw new Error("Unlock this archive before importing transcript cues.");
      if (file.size > 256 * 1024 * 1024) {
        throw new Error("Transcript source exceeds the configured 256 MiB limit.");
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const format = resolveTranscriptFormat("auto", file.name);
      const cues = parseTranscriptSource(source, format);
      if (cues.length === 0) {
        announce("No transcript cues were found in that file.", "info");
        return;
      }
      const records = makeTranscriptRecords(session.id, cues, format, file.name);
      const fields = new Map(session.fields);
      fields.set("processing_state", "review-required");
      fields.set(
        "processing_detail",
        "Imported transcript is provisional and ready for tutor review.",
      );
      fields.set("processing_updated_at_us", (BigInt(Date.now()) * 1000n).toString());
      records.push({ ...session, fields });
      await addRecords(records, `Imported ${cues.length} provisional transcript cues.`);
    } catch (error) {
      announce(errorMessage(error), "error");
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

  async function exportAudioTrack(
    sessionId: string,
    trackId: string,
    trackLabel: string,
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
        () => buildAudioTrackWavStream(state.snapshot, sessionId, trackId),
        "audio/wav",
      );
      if (location) announce(`Exported audio track to ${location}.`, "success");
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

  async function importAsset(file: File, sessionId: string): Promise<void> {
    const state = workspace();
    if (!state) {
      announce("Open an archive before importing materials.", "error");
      return;
    }
    if (state.snapshot.locked) {
      announce("Unlock this archive before importing materials.", "error");
      return;
    }
    setBusy(true);
    try {
      const imported = await makeAssetImport(state.snapshot, file, sessionId);
      const message = imported.deduplicated
        ? "Material added. Its verified content is already stored in this archive."
        : "Material and its verified content were added to the archive.";
      await addRecords(imported.records, message);
    } catch (error) {
      announce(errorMessage(error), "error");
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
    if (!state || state.snapshot.locked) {
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
      const imported = await makeAssetImport(state.snapshot, file, sessionId);
      const fields = new Map(imported.metadata.fields);
      const mimeType = field(imported.metadata, "mime_type");
      if (mimeType === "video/webm" && file.name.toLowerCase().endsWith(".webm")) {
        fields.set("mime_type", "audio/webm");
      }
      if (!mimeType.startsWith("audio/") && mimeType !== "video/webm") {
        throw new Error("The recording format is not recognized as audio.");
      }
      fields.set("capture_source", "browser-microphone");
      fields.set("capture_consent_at_us", consentAtUs);
      fields.set("capture_consent_policy", "1");
      const records = imported.records.map((record) =>
        record.type === RecordType.assetMetadata && record.id === imported.metadata.id
          ? { ...record, fields }
          : record,
      );
      await addRecords(records, `Saved ${file.name} as a session audio material.`);
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
      const bytes = await readAssetBytes(state.snapshot, record);
      const name = safeFileName(field(record, "filename") || `material-${record.id}`);
      const location = await platform.exportBinaryFile(
        name,
        bytes,
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
    setBusy(true);
    try {
      return {
        bytes: await readAssetBytes(state.snapshot, record),
        mimeType: field(record, "mime_type", "application/octet-stream"),
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
    applyThemeMode(next);
  }

  function chooseThemeMode(mode: ThemeMode): void {
    applyThemeMode(mode);
  }

  function openPalette(): void {
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteOpen(true);
  }

  function closePalette(): void {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteIndex(0);
  }

  const actions = [
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
        closePalette();
        setView("ai");
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
  const matchingActions = createMemo(() => {
    const needle = paletteQuery().trim().toLocaleLowerCase();
    return actions.filter((action) =>
      `${action.label} ${action.detail}`.toLocaleLowerCase().includes(needle),
    );
  });
  function handlePaletteKeys(event: KeyboardEvent): void {
    const matches = matchingActions();
    if (event.key === "Escape") {
      closePalette();
    } else if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setPaletteIndex((paletteIndex() + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setPaletteIndex((paletteIndex() + matches.length - 1) % matches.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      matches[paletteIndex()]?.run();
    }
  }

  return (
    <div class="app-frame">
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
          >
            <Icon name={theme() === "light" ? "moon" : "sun"} />
          </button>
          <button
            class="button button-outline topbar-open"
            type="button"
            onClick={() => void openArchive()}
          >
            <Icon name="folder" />
            Open
          </button>
          <button
            class="button button-primary topbar-save"
            type="button"
            disabled={!workspace() || busy()}
            onClick={() => void saveCurrentArchive()}
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
              onClick={() => setView("archive")}
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
                onClick={() => setView("settings")}
              >
                <Icon name="more" />
              </button>
            </div>
          </div>
        </aside>

        <main class="main-content" id="main-content">
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
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    placeholder={`Search ${activeView().label.toLocaleLowerCase()}…`}
                    aria-label={`Search ${activeView().label}`}
                  />
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
                    onNavigate={setView}
                    onCreate={openDialog}
                    onOpen={() => void openArchive()}
                  />
                </Show>
                <Show when={view() === "students"}>
                  <RecordPage
                    kind="students"
                    records={filteredRecords()}
                    state={state}
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
                    selectedSessionId={selectedTranscriptSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onSelectSession={setSelectedTranscriptSessionId}
                    onNewSession={() => openDialog("session")}
                    onImport={(file, sessionId) => void importTranscript(file, sessionId)}
                    onImportAudio={(file, sessionId, allowAdditionalTrack) =>
                      void importWave(file, sessionId, allowAdditionalTrack)
                    }
                    onRecordAudio={(file, sessionId, consentAtUs) =>
                      importCapturedAudio(file, sessionId, consentAtUs)
                    }
                    onExportAudio={(sessionId, trackId, label) =>
                      void exportAudioTrack(sessionId, trackId, label)
                    }
                    onRenameRecordingTake={(take, label) => void saveRecordingTakeName(take, label)}
                    onRenameRecordingTrack={(track, label) =>
                      void saveRecordingTrackName(track, label)
                    }
                    onTrashRecordingTake={(take) => void changeRecordingTakeTrash(take, true)}
                    onRestoreRecordingTake={(take) => void changeRecordingTakeTrash(take, false)}
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
                    onSave={saveAiPackage}
                    onLoad={loadAiPackage}
                    onSend={sendAiProviderRequest}
                    onSaveProvider={saveAiProvider}
                    onSaveCredential={saveAiCredential}
                    onRemoveCredential={removeAiCredential}
                  />
                </Show>
                <Show when={view() === "annotations"}>
                  <AnnotationPage
                    sessions={state.sessions}
                    records={filteredRecords()}
                    selectedSessionId={selectedAnnotationSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onSelectSession={setSelectedAnnotationSessionId}
                    onSave={saveAnnotation}
                    onRemove={(record) => setPendingDelete(record)}
                    onNewSession={() => openDialog("session")}
                    onHistory={getAnnotationHistory}
                    onRestore={restoreAnnotationRevision}
                  />
                </Show>
                <Show when={view() === "journal"}>
                  <RecordPage
                    kind="journal"
                    records={filteredRecords()}
                    state={state}
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
                    records={filteredRecords()}
                    sessions={state.sessions}
                    students={state.students}
                    sourceRecords={guideSourceRecords(state)}
                    customTemplates={state.guideTemplates}
                    trashedTemplates={state.trashedGuideTemplates}
                    templateManagerOpen={guideTemplateManagerOpen()}
                    onToggleTemplateManager={() => setGuideTemplateManagerOpen((open) => !open)}
                    disabled={!state.snapshot.canMutate}
                    busy={busy()}
                    onOpenSessions={() => setView("sessions")}
                    onSave={saveGuide}
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
                    sessions={state.sessions}
                    records={filteredRecords()}
                    edges={state.evidenceEdges}
                    selectedSessionId={selectedEvidenceSessionId()}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onSelectSession={setSelectedEvidenceSessionId}
                    onExtract={extractEvidence}
                    onReview={reviewEvidence}
                    onLink={linkEvidence}
                    onUpdate={updateEvidence}
                    onTrash={(record) => void trashEvidence(record)}
                  />
                </Show>
                <Show when={view() === "assets"}>
                  <AssetPage
                    records={filteredRecords()}
                    sessions={state.sessions}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                    onImport={importAsset}
                    onPreview={loadAssetPreview}
                    onExport={(record) => void exportAsset(record)}
                  />
                </Show>
                <Show when={view() === "trash"}>
                  <TrashPage
                    records={state.trashedStudents}
                    annotations={state.trashedAnnotations}
                    guides={state.trashedGuides}
                    evidence={state.trashedEvidence}
                    sessions={state.trashedSessions}
                    onRestore={(record) => void restoreStudent(record)}
                    onRestoreAnnotation={(record) => void restoreTrashedAnnotation(record)}
                    onRestoreGuide={(record) => void restoreGuide(record)}
                    onRestoreEvidence={(record) => void restoreEvidence(record)}
                    onRestoreSession={(record) => void restoreSessionGroup(record)}
                    disabled={state.snapshot.locked || !state.snapshot.canMutate || busy()}
                  />
                </Show>
                <Show when={view() === "archive"}>
                  <ArchivePage
                    state={state}
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
                    onSaveArchive={() => void saveCurrentArchive()}
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
            onSaveSession={(input, record, notesDocument, updateNotes) =>
              void addRecords(
                record
                  ? updateSessionRecords(record, input, notesDocument, updateNotes)
                  : makeSessionRecords(input, {
                      ensureJournalRoot: !(workspace()?.journals.length ?? 0),
                    } satisfies SessionCreateOptions),
                record ? "Session details updated." : undefined,
              ).catch((error: unknown) => announce(errorMessage(error), "error"))
            }
            onSaveJournal={(input, record, notesDocument, updateNotes) =>
              void addRecords(
                record
                  ? updateJournalRecords(record, input, notesDocument, updateNotes)
                  : makeJournalRecords(input),
                record ? "Journal entry updated." : undefined,
              ).catch((error: unknown) => announce(errorMessage(error), "error"))
            }
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
          <section
            class="command-palette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palette-title"
          >
            <div class="palette-search">
              <Icon name="search" />
              <input
                autofocus
                placeholder="What would you like to do?"
                aria-label="Find a quick action"
                value={paletteQuery()}
                onInput={(event) => {
                  setPaletteQuery(event.currentTarget.value);
                  setPaletteIndex(0);
                }}
                onKeyDown={handlePaletteKeys}
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
            <div class="palette-footer">
              <span>Navigate with your keyboard</span>
              <span>
                <kbd>↵</kbd> select <kbd>esc</kbd> close
              </span>
            </div>
          </section>
        </div>
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
                setView(item.id);
                setQuery("");
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
                    (workspace()?.trashedSessions.length ?? 0)
                }
              >
                <span class="nav-count" aria-hidden="true">
                  {(workspace()?.trashedStudents.length ?? 0) +
                    (workspace()?.trashedAnnotations.length ?? 0) +
                    (workspace()?.trashedGuides.length ?? 0) +
                    (workspace()?.trashedEvidence.length ?? 0) +
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

function EvidencePage(props: {
  sessions: ArchiveRecord[];
  records: ArchiveRecord[];
  edges: ArchiveRecord[];
  selectedSessionId: string;
  disabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onExtract: (sessionId: string) => void;
  onReview: (record: ArchiveRecord, outcome: "human-verified" | "rejected") => void;
  onLink: (fromId: string, toId: string, relationship: string) => void;
  onUpdate: (record: ArchiveRecord, input: EvidenceUpdateInput) => Promise<boolean>;
  onTrash: (record: ArchiveRecord) => void;
}): JSX.Element {
  const [fromId, setFromId] = createSignal("");
  const [toId, setToId] = createSignal("");
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
  const sessionEdges = createMemo(() => {
    const ids = new Set(sessionRecords().map((record) => record.id));
    return props.edges.filter(
      (edge) => ids.has(field(edge, "from_id")) && ids.has(field(edge, "to_id")),
    );
  });

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
            onChange={(event) => props.onSelectSession(event.currentTarget.value)}
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
          <section class="evidence-list" aria-label="Session evidence">
            <For each={sessionRecords()}>
              {(record) => (
                <EvidenceCard
                  record={record}
                  disabled={props.disabled}
                  onReview={props.onReview}
                  onUpdate={props.onUpdate}
                  onTrash={props.onTrash}
                />
              )}
            </For>
          </section>

          <section class="evidence-graph surface-card">
            <div class="evidence-graph-heading">
              <div>
                <span class="eyebrow">RELATIONSHIPS</span>
                <h2>Connect the evidence</h2>
              </div>
              <span>
                {sessionEdges().length} {sessionEdges().length === 1 ? "link" : "links"}
              </span>
            </div>
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
                      sessionRecords().find((record) => record.id === field(edge, "from_id"));
                    const to = () =>
                      sessionRecords().find((record) => record.id === field(edge, "to_id"));
                    return (
                      <div class="evidence-edge-row">
                        <span>{field(from()!, "title", field(from()!, "type", "Evidence"))}</span>
                        <strong>{field(edge, "relationship").replaceAll("-", " ")}</strong>
                        <span>{field(to()!, "title", field(to()!, "type", "Evidence"))}</span>
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

function EvidenceCard(props: {
  record: ArchiveRecord;
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
  const sourceLabel = () =>
    field(props.record, "source_annotation_id")
      ? "Tutor observation"
      : field(props.record, "source_segment_ids")
        ? "Transcript candidate"
        : "Imported evidence";
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
    <article class={`evidence-card surface-card evidence-${state()}`}>
      <div class="evidence-card-rail" aria-hidden="true">
        <span />
      </div>
      <div class="evidence-card-content">
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
            <Show when={state() === "needs-review"}>
              <button
                class="button button-primary"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onReview(props.record, "human-verified")}
              >
                Approve source
              </button>
              <button
                class="button button-quiet"
                type="button"
                disabled={props.disabled}
                onClick={() => props.onReview(props.record, "rejected")}
              >
                Reject candidate
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}

function AssetPage(props: {
  records: ArchiveRecord[];
  sessions: ArchiveRecord[];
  disabled: boolean;
  onImport: (file: File, sessionId: string) => Promise<void>;
  onPreview: (record: ArchiveRecord) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  onExport: (record: ArchiveRecord) => void;
}): JSX.Element {
  const [sessionId, setSessionId] = createSignal("");
  const [importing, setImporting] = createSignal(false);
  const [preview, setPreview] = createSignal<{
    record: ArchiveRecord;
    url: string;
    mimeType: string;
    text: string | null;
  } | null>(null);
  let fileInput: HTMLInputElement | undefined;
  let previewTrigger: HTMLButtonElement | undefined;

  onCleanup(() => {
    const active = preview();
    if (active) URL.revokeObjectURL(active.url);
  });

  function receiveFile(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      setImporting(true);
      void props.onImport(file, sessionId()).finally(() => setImporting(false));
    }
    input.value = "";
  }

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
    setPreview({ record, url, mimeType: loaded.mimeType, text });
  }

  function closePreview(): void {
    const active = preview();
    if (active) URL.revokeObjectURL(active.url);
    setPreview(null);
    previewTrigger?.focus();
  }

  return (
    <div class="page-body material-page">
      <section class="record-heading material-heading">
        <div>
          <span class="eyebrow">MATERIALS FOR THE WORK</span>
          <h1>Materials</h1>
          <p>
            Keep lesson files beside the sessions and observations they support. Imports are limited
            to 256 MiB per file.
          </p>
        </div>
        <input
          ref={(element) => (fileInput = element)}
          class="visually-hidden"
          type="file"
          onChange={receiveFile}
          aria-label="Choose a material to import"
        />
        <button
          class="button button-primary"
          type="button"
          disabled={props.disabled || importing()}
          onClick={() => fileInput?.click()}
        >
          <Show
            when={!importing()}
            fallback={<span class="button-loading-dot" aria-hidden="true" />}
          >
            <Icon name="plus" />
          </Show>
          {importing() ? "Adding material…" : "Add material"}
        </button>
      </section>

      <section class="material-library surface-card">
        <div class="material-library-toolbar">
          <div>
            <span class="eyebrow">FILE LIBRARY</span>
            <strong>
              {props.records.length} {props.records.length === 1 ? "item" : "items"}
            </strong>
          </div>
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
          when={props.records.length > 0}
          fallback={
            <div class="material-empty">
              <span class="material-empty-mark">
                <Icon name="assets" />
              </span>
              <div>
                <h2>A thoughtful library starts with one file</h2>
                <p>
                  Import a worksheet, reference image, recording, or document. Tutorux keeps its
                  content inside this archive.
                </p>
              </div>
              <button
                class="button button-outline"
                type="button"
                disabled={props.disabled || importing()}
                onClick={() => fileInput?.click()}
              >
                Add the first material
              </button>
            </div>
          }
        >
          <div class="material-grid">
            <For each={props.records}>
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
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
      <Show when={preview()}>
        {(active) => (
          <div
            class="material-preview-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) closePreview();
            }}
          >
            <section
              class="material-preview-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={`Preview ${field(active().record, "filename", "material")}`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closePreview();
                }
              }}
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
                  ref={(element) => element.focus()}
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
                      <audio controls src={active().url} />
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
            </section>
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
}): JSX.Element {
  const [collectionFilter, setCollectionFilter] = createSignal("");
  const [tagFilter, setTagFilter] = createSignal("");
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
      return (
        (!collectionFilter() || collections.includes(collectionFilter())) &&
        (!tagFilter() || tags.includes(tagFilter()))
      );
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
          <Show when={collectionFilter() || tagFilter()}>
            <button
              class="text-action"
              type="button"
              onClick={() => {
                setCollectionFilter("");
                setTagFilter("");
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
            <For
              each={[...visibleRecords()].sort((a, b) =>
                recordSort(props.kind, b).localeCompare(recordSort(props.kind, a)),
              )}
            >
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
          <strong>{date.day}</strong>
          <small>{date.month}</small>
        </div>
        <div class="journal-record-main">
          <span class="eyebrow">{date.year}</span>
          <h2>{field(record, "title", "Untitled entry")}</h2>
          <p>
            {record.fields.get("session_ids")
              ? "Linked to a tutoring session"
              : "A teaching reflection"}
          </p>
          <div class="record-inline-meta">
            <span>
              <Icon name="clock" />
              {field(record, "entry_date")}
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
  annotations: ArchiveRecord[];
  guides: ArchiveRecord[];
  evidence: ArchiveRecord[];
  sessions: ArchiveRecord[];
  disabled: boolean;
  onRestore: (record: ArchiveRecord) => void;
  onRestoreAnnotation: (record: ArchiveRecord) => void;
  onRestoreGuide: (record: ArchiveRecord) => void;
  onRestoreEvidence: (record: ArchiveRecord) => void;
  onRestoreSession: (record: ArchiveRecord) => void;
}): JSX.Element {
  const trashed = () => {
    const removedAt = (record: ArchiveRecord): bigint => {
      const raw = field(record, "deleted_at_us");
      return /^\d+$/u.test(raw) ? BigInt(raw) : 0n;
    };
    return [
      ...props.sessions,
      ...props.records,
      ...props.annotations,
      ...props.guides,
      ...props.evidence,
    ].sort((left, right) => {
      const a = removedAt(left);
      const b = removedAt(right);
      return a > b ? -1 : a < b ? 1 : left.id.localeCompare(right.id);
    });
  };
  const total = () => trashed().length;
  return (
    <div class="page-body record-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">RECOVERABLE ARCHIVE ITEMS</span>
          <h1>Trash</h1>
          <p>
            Restore a session with its linked learning record, or bring back an individual item.
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
        </div>
        <Show
          when={total() > 0}
          fallback={
            <EmptyState
              icon="trash"
              title="Trash is empty"
              text="Sessions, students, observations, study guides, and evidence you move here can be restored at any time."
              action="Back to students"
              onAction={() => undefined}
              disabled
            />
          }
        >
          <div class="record-list">
            <For each={trashed()}>
              {(record) => (
                <article class="library-record-card trash-record">
                  <span class="library-icon">
                    <Icon
                      name={
                        record.type === RecordType.session
                          ? "sessions"
                          : record.type === RecordType.annotation
                            ? "annotations"
                            : record.type === RecordType.guide
                              ? "guides"
                              : record.type === RecordType.evidenceNode
                                ? "evidence"
                                : "students"
                      }
                    />
                  </span>
                  <div>
                    <span class="eyebrow">
                      {record.type === RecordType.session
                        ? "SESSION GROUP"
                        : record.type === RecordType.annotation
                          ? "SESSION OBSERVATION"
                          : record.type === RecordType.guide
                            ? "STUDY GUIDE"
                            : record.type === RecordType.evidenceNode
                              ? "EVIDENCE ITEM"
                              : "STUDENT PROFILE"}
                    </span>
                    <h2>
                      {record.type === RecordType.session
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
                              : field(record, "display_name", "Unnamed student")}
                    </h2>
                    <p>
                      {record.type === RecordType.session
                        ? [field(record, "subject"), field(record, "session_state")]
                            .filter(Boolean)
                            .join(" · ") || "Tutoring session"
                        : record.type === RecordType.annotation
                          ? field(record, "content", "Observation")
                          : record.type === RecordType.guide
                            ? `${field(record, "approval_state", "draft")} · ${field(record, "template_id", "general")}`
                            : record.type === RecordType.evidenceNode
                              ? field(record, "content", "Evidence")
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
                  </div>
                  <button
                    class="button button-outline record-action"
                    type="button"
                    disabled={props.disabled}
                    onClick={() =>
                      record.type === RecordType.session
                        ? props.onRestoreSession(record)
                        : record.type === RecordType.annotation
                          ? props.onRestoreAnnotation(record)
                          : record.type === RecordType.guide
                            ? props.onRestoreGuide(record)
                            : record.type === RecordType.evidenceNode
                              ? props.onRestoreEvidence(record)
                              : props.onRestore(record)
                    }
                  >
                    Restore
                  </button>
                </article>
              )}
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
  selectedSessionId: string;
  disabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onImport: (file: File, sessionId: string) => void;
  onImportAudio: (file: File, sessionId: string, allowAdditionalTrack: boolean) => void;
  onRecordAudio: (file: File, sessionId: string, consentAtUs: string) => Promise<void>;
  onExportAudio: (sessionId: string, trackId: string, label: string) => void;
  onRenameRecordingTake: (take: ArchiveRecord, label: string) => void;
  onRenameRecordingTrack: (track: AudioTrackDescriptor, label: string) => void;
  onTrashRecordingTake: (take: ArchiveRecord) => void;
  onRestoreRecordingTake: (take: ArchiveRecord) => void;
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
    const session = selectedSession();
    const track = selectedTrack();
    if (!session || !track) return;
    setPlaybackError("");
    try {
      const preview = await buildAudioPreview(
        props.snapshot,
        session.id,
        track.id,
        field(record, "start_time_us", "0"),
      );
      clearAudio();
      const url = URL.createObjectURL(
        new Blob([preview.wav.slice().buffer as ArrayBuffer], { type: "audio/wav" }),
      );
      currentAudioUrl = url;
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

      <Show when={sessionRecordingTakes().length > 0 || trashedSessionRecordingTakes().length > 0}>
        <section class="transcript-takes-panel" aria-label="Recording takes">
          <div class="transcript-takes-heading">
            <div>
              <span class="eyebrow">SESSION AUDIO</span>
              <strong>Recording takes</strong>
              <span>Rename a take, manage its tracks, or recover it from Trash.</span>
            </div>
            <span class="transcript-takes-count">
              {sessionRecordingTakes().length} active · {trashedSessionRecordingTakes().length} in
              Trash
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
                    disabled={props.disabled}
                    onRenameTake={props.onRenameRecordingTake}
                    onRenameTrack={props.onRenameRecordingTrack}
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

      <Show when={sessionTracks().length > 0}>
        <section class="transcript-audio-panel" aria-label="Session recording playback">
          <div class="transcript-audio-copy">
            <span class="eyebrow">SESSION RECORDING</span>
            <strong>{selectedTrack()?.label ?? "Recording"}</strong>
            <span>Load up to 30 seconds from a transcript cue.</span>
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
            class="button button-outline transcript-audio-export"
            type="button"
            disabled={props.disabled || !selectedTrack()}
            onClick={() => {
              const session = selectedSession();
              const track = selectedTrack();
              if (session && track) props.onExportAudio(session.id, track.id, track.label);
            }}
          >
            Export WAV
          </button>
          <Show when={audioUrl()}>
            <audio
              ref={(element) => (audioPlayer = element)}
              src={audioUrl()!}
              controls
              preload="none"
            >
              Audio playback is not supported by this WebView.
            </audio>
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
  disabled: boolean;
  onRenameTake: (take: ArchiveRecord, label: string) => void;
  onRenameTrack: (track: AudioTrackDescriptor, label: string) => void;
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
              />
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
}): JSX.Element {
  const [editVersion, setEditVersion] = createSignal(0);
  let input: HTMLInputElement | undefined;

  function hasChanges(): boolean {
    editVersion();
    const currentInput = input;
    return currentInput !== undefined && currentInput.value.trim() !== props.track.label;
  }

  return (
    <div class="transcript-take-track-row">
      <label>
        <span>Track name</span>
        <input
          ref={(element) => (input = element)}
          value={props.track.label}
          maxLength={120}
          onInput={(event) => {
            input = event.currentTarget;
            setEditVersion((version) => version + 1);
          }}
          aria-label={`Track name: ${props.track.label}`}
        />
      </label>
      <button
        class="button button-outline"
        type="button"
        disabled={props.disabled || !hasChanges()}
        onClick={() => props.onRename(props.track, input?.value ?? props.track.label)}
      >
        Save track name
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

function AnnotationPage(props: {
  sessions: ArchiveRecord[];
  records: ArchiveRecord[];
  selectedSessionId: string;
  disabled: boolean;
  onSelectSession: (sessionId: string) => void;
  onSave: (input: AnnotationInput, current: ArchiveRecord | null) => Promise<boolean>;
  onRemove: (record: ArchiveRecord) => void;
  onNewSession: () => void;
  onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
  onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
}): JSX.Element {
  const [adding, setAdding] = createSignal(false);
  const sessionId = createMemo(() =>
    props.sessions.some((session) => session.id === props.selectedSessionId)
      ? props.selectedSessionId
      : (props.sessions[0]?.id ?? ""),
  );
  const annotations = createMemo(() =>
    props.records
      .filter((record) => field(record, "session_id") === sessionId())
      .sort((left, right) => {
        const a = safeBigInt(field(left, "start_time_us"));
        const b = safeBigInt(field(right, "start_time_us"));
        return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
      }),
  );
  const selectedSession = createMemo(() => props.sessions.find((item) => item.id === sessionId()));

  async function saveNewAnnotation(input: AnnotationInput): Promise<boolean> {
    const saved = await props.onSave(input, null);
    if (saved) setAdding(false);
    return saved;
  }

  return (
    <div class="page-body annotation-page">
      <section class="record-heading annotation-heading">
        <div>
          <span class="eyebrow">NOTICE THE MOMENTS THAT MATTER</span>
          <h1>Observations</h1>
          <p>Mark ideas, questions, corrections, and follow-ups as they happen in a session.</p>
        </div>
        <div class="annotation-count" aria-label={`${annotations().length} observations`}>
          <strong>{annotations().length.toString().padStart(2, "0")}</strong>
          <span>IN THIS SESSION</span>
        </div>
      </section>

      <section class="annotation-controls">
        <label class="transcript-session-picker">
          Session
          <select
            aria-label="Choose a session for observations"
            value={sessionId()}
            disabled={!props.sessions.length}
            onChange={(event) => props.onSelectSession(event.currentTarget.value)}
          >
            <For each={props.sessions}>
              {(session) => (
                <option value={session.id}>
                  {field(session, "title", "Untitled session")} ·{" "}
                  {formatTimestamp(field(session, "started_at_us"))}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={selectedSession()}>
          {(session) => (
            <div class="annotation-session-context">
              <span class="annotation-session-glyph">
                <Icon name="sessions" />
              </span>
              <span>
                <strong>{field(session(), "title", "Untitled session")}</strong>
                <small>{field(session(), "subject", "Session notes and moments")}</small>
              </span>
            </div>
          )}
        </Show>
        <button
          class="button button-primary"
          type="button"
          disabled={props.disabled || !sessionId()}
          onClick={() => setAdding((value) => !value)}
        >
          <Icon name="plus" />
          Add observation
        </button>
      </section>

      <Show when={adding()}>
        <section class="annotation-compose surface-card">
          <div class="annotation-compose-heading">
            <div>
              <span class="eyebrow">CAPTURE A MOMENT</span>
              <h2>New observation</h2>
            </div>
            <button class="button button-quiet" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <AnnotationForm
            initial={{
              sessionId: sessionId(),
              start: "00:00:00",
              end: "",
              type: "general-note",
              priority: "normal",
              title: "",
              content: "",
            }}
            disabled={props.disabled}
            submitLabel="Save observation"
            onCancel={() => setAdding(false)}
            onSave={saveNewAnnotation}
          />
        </section>
      </Show>

      <Show
        when={props.sessions.length > 0}
        fallback={
          <section class="surface-card annotation-empty">
            <div class="annotation-empty-mark">
              <Icon name="annotations" />
            </div>
            <h2>Start with a session</h2>
            <p>Observations are attached to a session so you can revisit the right moment later.</p>
            <button class="button button-primary" type="button" onClick={props.onNewSession}>
              <Icon name="plus" /> Create a session
            </button>
          </section>
        }
      >
        <Show
          when={annotations().length > 0 || adding()}
          fallback={
            <section class="surface-card annotation-empty">
              <div class="annotation-empty-mark">
                <Icon name="annotations" />
              </div>
              <h2>A clear page for this session</h2>
              <p>Add an observation when a useful idea, misunderstanding, or next step appears.</p>
              <button
                class="button button-outline"
                type="button"
                disabled={props.disabled}
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" /> Add the first observation
              </button>
            </section>
          }
        >
          <section class="annotation-timeline" aria-label="Session observations">
            <div class="annotation-timeline-heading">
              <div>
                <span class="eyebrow">SESSION TIMELINE</span>
                <h2>What stood out</h2>
              </div>
              <span>
                {selectedSession()
                  ? formatTimestamp(field(selectedSession()!, "started_at_us"))
                  : ""}
              </span>
            </div>
            <div class="annotation-list">
              <For each={annotations()}>
                {(record) => (
                  <AnnotationCard
                    record={record}
                    disabled={props.disabled}
                    onSave={(input) => props.onSave(input, record)}
                    onRemove={() => props.onRemove(record)}
                    onHistory={props.onHistory}
                    onRestore={props.onRestore}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>
    </div>
  );
}

function AnnotationCard(props: {
  record: ArchiveRecord;
  disabled: boolean;
  onSave: (input: AnnotationInput) => Promise<boolean>;
  onRemove: () => void;
  onHistory: (record: ArchiveRecord) => Promise<ArchiveRecord[]>;
  onRestore: (record: ArchiveRecord, historyIndex: number) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const priority = () => field(props.record, "priority", "normal");
  const kind = () => annotationTypeLabel(field(props.record, "type", "general-note"));
  const time = () => formatAnnotationRange(props.record);

  async function saveEditedAnnotation(input: AnnotationInput): Promise<boolean> {
    const saved = await props.onSave(input);
    if (saved) {
      setEditing(false);
      setHistory(null);
    }
    return saved;
  }

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

  return (
    <article class={`annotation-item priority-${priority()}`}>
      <div class="annotation-timeline-rail" aria-hidden="true">
        <span />
      </div>
      <div class="annotation-card surface-card">
        <header class="annotation-card-header">
          <div class="annotation-type-line">
            <span class="annotation-type-icon">
              <Icon name="annotations" />
            </span>
            <span class="annotation-type-label">{kind()}</span>
            <span class={`annotation-priority priority-label-${priority()}`}>{priority()}</span>
          </div>
          <span class="annotation-card-time">
            <Icon name="clock" /> {time()}
          </span>
        </header>
        <Show when={!editing()}>
          <div class="annotation-card-copy">
            <h3>{field(props.record, "title") || kind()}</h3>
            <p>{field(props.record, "content")}</p>
          </div>
          <div class="annotation-card-actions">
            <button
              class="button button-quiet record-action"
              type="button"
              disabled={props.disabled}
              onClick={() => setEditing(true)}
            >
              Edit observation
            </button>
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
            <button
              class="button button-quiet record-action annotation-remove-action"
              type="button"
              disabled={props.disabled}
              onClick={() => props.onRemove()}
            >
              Move to Trash
            </button>
          </div>
          <Show when={history() !== null}>
            <section class="annotation-history-panel" aria-label="Observation version history">
              <div class="annotation-history-heading">
                <span class="eyebrow">VERSION HISTORY</span>
                <span>{Math.max(0, (history()?.length ?? 1) - 1)} earlier versions</span>
              </div>
              <Show
                when={(history()?.length ?? 0) > 1}
                fallback={
                  <p class="annotation-history-empty">This observation has no earlier versions.</p>
                }
              >
                <div class="annotation-history-list">
                  <For
                    each={(history()?.slice(1) ?? []).map((record, index) => ({
                      record,
                      historyIndex: index + 1,
                    }))}
                  >
                    {(entry) => {
                      const revision = entry.record;
                      const historyIndex = entry.historyIndex;
                      return (
                        <article class="annotation-history-entry">
                          <div>
                            <strong>
                              {field(revision, "title") ||
                                annotationTypeLabel(field(revision, "type"))}
                            </strong>
                            <small>
                              Version {historyIndex} ·{" "}
                              {formatTimestamp(
                                field(revision, "updated_at_us", field(revision, "created_at_us")),
                              )}
                              {field(revision, "_deleted") === "true" ? " · removed" : ""}
                            </small>
                          </div>
                          <p>{field(revision, "content")}</p>
                          <button
                            class="button button-outline record-action"
                            type="button"
                            disabled={props.disabled}
                            onClick={() => void restoreRevision(historyIndex)}
                          >
                            Restore version {historyIndex}
                          </button>
                        </article>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>
          </Show>
        </Show>
        <Show when={editing()}>
          <AnnotationForm
            initial={annotationInput(props.record)}
            disabled={props.disabled}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSave={saveEditedAnnotation}
          />
        </Show>
      </div>
    </article>
  );
}

function AnnotationForm(props: {
  initial: AnnotationInput;
  disabled: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSave: (input: AnnotationInput) => Promise<boolean> | void;
}): JSX.Element {
  const [title, setTitle] = createSignal(props.initial.title);
  const [content, setContent] = createSignal(props.initial.content);
  const [start, setStart] = createSignal(props.initial.start);
  const [end, setEnd] = createSignal(props.initial.end);
  const [type, setType] = createSignal<AnnotationInput["type"]>(props.initial.type);
  const [priority, setPriority] = createSignal<AnnotationInput["priority"]>(props.initial.priority);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await props.onSave({
      sessionId: props.initial.sessionId,
      start: start(),
      end: end(),
      type: type(),
      priority: priority(),
      title: title(),
      content: content(),
    });
    if (result !== false) props.onCancel();
  }

  return (
    <form class="annotation-form" onSubmit={submit}>
      <div class="annotation-form-grid">
        <label class="form-field">
          Type
          <select
            value={type()}
            onChange={(event) => setType(event.currentTarget.value as AnnotationInput["type"])}
          >
            <For each={ANNOTATION_TYPES}>
              {(value) => <option value={value}>{annotationTypeLabel(value)}</option>}
            </For>
          </select>
        </label>
        <label class="form-field">
          Priority
          <select
            value={priority()}
            onChange={(event) =>
              setPriority(event.currentTarget.value as AnnotationInput["priority"])
            }
          >
            <For each={ANNOTATION_PRIORITIES}>
              {(value) => <option value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>}
            </For>
          </select>
        </label>
        <label class="form-field annotation-form-title">
          Title <span class="optional">optional</span>
          <input
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            maxlength="512"
          />
        </label>
        <label class="form-field">
          Start time
          <input
            value={start()}
            onInput={(event) => setStart(event.currentTarget.value)}
            placeholder="HH:MM:SS"
            inputmode="decimal"
            required
          />
        </label>
        <label class="form-field">
          End time <span class="optional">optional</span>
          <input
            value={end()}
            onInput={(event) => setEnd(event.currentTarget.value)}
            placeholder="Same as start"
            inputmode="decimal"
          />
        </label>
      </div>
      <label class="form-field">
        Observation
        <textarea
          value={content()}
          onInput={(event) => setContent(event.currentTarget.value)}
          rows={4}
          maxlength="16000000"
          required
          placeholder="What did you notice? Include context that will help you remember why it matters."
        />
      </label>
      <div class="annotation-form-actions">
        <button
          class="button button-primary record-action"
          type="submit"
          disabled={props.disabled || !content().trim()}
        >
          <Icon name="check" /> {props.submitLabel}
        </button>
        <button
          class="button button-quiet record-action"
          type="button"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function annotationInput(record: ArchiveRecord): AnnotationInput {
  return {
    sessionId: field(record, "session_id"),
    start: transcriptTimeInput(field(record, "start_time_us")) || "00:00:00",
    end: transcriptTimeInput(field(record, "end_time_us")),
    type: ANNOTATION_TYPES.includes(field(record, "type") as AnnotationInput["type"])
      ? (field(record, "type") as AnnotationInput["type"])
      : "custom",
    priority: ANNOTATION_PRIORITIES.includes(
      field(record, "priority") as AnnotationInput["priority"],
    )
      ? (field(record, "priority") as AnnotationInput["priority"])
      : "normal",
    title: field(record, "title"),
    content: field(record, "content"),
  };
}

function formatAnnotationRange(record: ArchiveRecord): string {
  const start = transcriptTimeInput(field(record, "start_time_us"));
  const end = transcriptTimeInput(field(record, "end_time_us"));
  return end && end !== start ? `${start} – ${end}` : start || "Time not provided";
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
  onSave: () => void;
  onOpen: () => void;
  onLock: () => void;
}): JSX.Element {
  const size = props.state.snapshot.source.size;
  const [verification, setVerification] = createSignal<ArchiveVerificationResult | null>(null);
  const [verificationError, setVerificationError] = createSignal("");
  const [verifying, setVerifying] = createSignal(false);
  const [trackedGeneration, setTrackedGeneration] = createSignal("");
  createEffect(() => {
    const generation = props.state.snapshot.commit.generation.toString();
    if (trackedGeneration() === generation) return;
    setTrackedGeneration(generation);
    setVerification(null);
    setVerificationError("");
  });
  const verify = async (): Promise<void> => {
    const snapshot = props.state.snapshot;
    setVerifying(true);
    setVerificationError("");
    try {
      setVerification(await verifyArchiveSnapshot(snapshot));
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
          <strong>{formatBytes(size)}</strong>
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
          <span class="integrity-status" role="status">
            <i />
            {verification()
              ? `Generation ${verification()!.generation} verified`
              : "Header and index checked on open"}
          </span>
        </div>
      </section>
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
  onSaveArchive: () => void;
}): JSX.Element {
  return (
    <div class="page-body settings-page">
      <section class="record-heading">
        <div>
          <span class="eyebrow">MAKE THE SPACE YOURS</span>
          <h1>Preferences</h1>
          <p>A few small choices for a workspace that feels right to use.</p>
        </div>
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
  let cancelButton: HTMLButtonElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  onMount(() => cancelButton?.focus());
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
      <section
        class="form-dialog confirm-dialog session-trash-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-trash-title"
        aria-describedby="session-trash-description session-trash-side-effects"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
          if (event.key === "Tab" && cancelButton && confirmButton) {
            if (event.shiftKey && document.activeElement === cancelButton) {
              event.preventDefault();
              confirmButton.focus();
            } else if (!event.shiftKey && document.activeElement === confirmButton) {
              event.preventDefault();
              cancelButton.focus();
            }
          }
        }}
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
            ref={(element) => {
              cancelButton = element;
            }}
            class="button button-outline"
            type="button"
            disabled={props.busy}
            onClick={() => props.onCancel()}
          >
            Keep session
          </button>
          <button
            ref={(element) => {
              confirmButton = element;
            }}
            class="button button-danger"
            type="button"
            disabled={props.busy}
            onClick={() => props.onConfirm()}
          >
            {props.busy ? "Moving…" : "Move session group to Trash"}
          </button>
        </div>
      </section>
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
      <section
        class="form-dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trash-dialog-title"
        aria-describedby="trash-dialog-description"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
        }}
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
      </section>
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
  const journalIds = (key: "collection_ids" | "tag_ids"): string[] =>
    props.record ? field(props.record, key).split(",").filter(Boolean) : [];
  const today = new Date().toISOString().slice(0, 10);
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
            date: value("date"),
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

  return (
    <div
      class="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <section
        class="form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onClose();
        }}
      >
        <button
          class="icon-button dialog-close"
          type="button"
          onClick={() => props.onClose()}
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
                  onChange={setNoteBlocks}
                />
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
            <label class="form-field">
              Date
              <input
                type="date"
                name="date"
                value={props.record ? field(props.record, "entry_date") : today}
                required
              />
            </label>
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
                <DocumentEditor label="Reflection" blocks={noteBlocks()} onChange={setNoteBlocks} />
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
              onClick={() => props.onClose()}
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
      </section>
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
