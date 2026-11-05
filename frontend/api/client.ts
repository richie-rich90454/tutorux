import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
    BackupResult,
    CalendarAccount,
    CalendarClientStatus,
    CalendarSyncResult,
    Evidence,
    EvidenceGraph,
    EvidenceInput,
    EvidenceLink,
    EvidenceLinkInput,
    Goal,
    GoalInput,
    Guide,
    GuideInput,
    ImportedSession,
    JournalEntry,
    JournalInput,
    LinkInput,
    MaintenanceResult,
    Material,
    Observation,
    ObservationInput,
    PackageResult,
    Recording,
    Reminder,
    ScheduleEvent,
    ScheduleInput,
    SearchHit,
    Session,
    SessionDetail,
    SessionInput,
    SkillRating,
    SkillRatingInput,
    Student,
    StudentDetail,
    StudentInput,
    TodayData,
    TranscriptCue,
    TranscriptCueInput,
    TrashItem,
    WorkspaceSummary,
} from "./types";

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Something went wrong.";
}

export async function chooseWorkspaceFile(): Promise<string | null> {
    const selected = await open({
        title: "Open Tutorux workspace",
        multiple: false,
        filters: [{ name: "Tutorux workspace", extensions: ["tutor"] }],
    });
    return typeof selected === "string" ? selected : null;
}

export async function chooseNewWorkspaceFile(defaultName: string): Promise<string | null> {
    const selected = await save({
        title: "Create Tutorux workspace",
        defaultPath: `${defaultName.replace(/[<>:"/\\|?*]+/gu, "-").trim() || "Workspace"}.tutor`,
        filters: [{ name: "Tutorux workspace", extensions: ["tutor"] }],
    });
    return selected ?? null;
}

export async function chooseMaterialFiles(): Promise<string[]> {
    const selected = await open({
        title: "Add materials",
        multiple: true,
        filters: [
            {
                name: "Materials",
                extensions: [
                    "pdf",
                    "png",
                    "jpg",
                    "jpeg",
                    "gif",
                    "webp",
                    "svg",
                    "mp3",
                    "wav",
                    "flac",
                    "ogg",
                    "opus",
                    "m4a",
                    "mp4",
                    "webm",
                    "mov",
                    "doc",
                    "docx",
                    "xls",
                    "xlsx",
                    "csv",
                    "txt",
                    "md",
                    "json",
                ],
            },
            { name: "All files", extensions: ["*"] },
        ],
    });
    if (Array.isArray(selected)) return selected;
    return typeof selected === "string" ? [selected] : [];
}

export async function chooseBackupFile(defaultName: string): Promise<string | null> {
    return save({
        title: "Back up workspace",
        defaultPath: `${defaultName.replace(/[<>:"/\\|?*]+/gu, "-").trim() || "Workspace"}-backup.tutor`,
        filters: [{ name: "Tutorux backup", extensions: ["tutor"] }],
    });
}

export async function chooseWorkingCopy(
    defaultName: string,
    title: string,
    suffix: string,
): Promise<string | null> {
    return save({
        title,
        defaultPath: `${defaultName.replace(/[<>:"/\\|?*]+/gu, "-").trim() || "Workspace"}-${suffix}.tutor`,
        filters: [{ name: "Tutorux workspace", extensions: ["tutor"] }],
    });
}

export async function chooseSessionPackageExport(defaultName: string): Promise<string | null> {
    return save({
        title: "Export session package",
        defaultPath: `${defaultName.replace(/[<>:"/\\|?*]+/gu, "-").trim() || "Session"}.tutorpkg`,
        filters: [{ name: "Tutorux session package", extensions: ["tutorpkg"] }],
    });
}

export async function chooseSessionPackageImport(): Promise<string | null> {
    const selected = await open({
        title: "Import session package",
        multiple: false,
        filters: [{ name: "Tutorux session package", extensions: ["tutorpkg"] }],
    });
    return typeof selected === "string" ? selected : null;
}

export async function chooseTextExport(
    defaultName: string,
    extension: string,
    label: string,
): Promise<string | null> {
    return save({
        title: label,
        defaultPath: defaultName,
        filters: [{ name: label, extensions: [extension] }],
    });
}

export async function writeExportFile(path: string, contents: string): Promise<void> {
    await invoke("write_export_file", { path, contents });
}

export const workspace = {
    create: (path: string, name: string, description: string, passphrase: string | null = null) =>
        invoke<WorkspaceSummary>("workspace_create", { path, name, description, passphrase }),
    open: (path: string, passphrase: string | null = null) =>
        invoke<WorkspaceSummary>("workspace_open", { path, passphrase }),
    close: () => invoke<void>("workspace_close"),
    summary: () => invoke<WorkspaceSummary>("workspace_summary"),
    rename: (name: string, description: string) =>
        invoke<WorkspaceSummary>("workspace_rename", { name, description }),
    rekey: (newPassphrase: string) =>
        invoke<WorkspaceSummary>("workspace_rekey", { newPassphrase }),
    check: () => invoke<string>("workspace_check"),
    compact: () => invoke<MaintenanceResult>("workspace_compact"),
    reindex: () => invoke<MaintenanceResult>("workspace_reindex"),
    recoveryCopy: (path: string) => invoke<BackupResult>("workspace_recovery_copy", { path }),
    sanitizedCopy: (path: string) => invoke<BackupResult>("workspace_sanitized_copy", { path }),
};

export const today = {
    data: () => invoke<TodayData>("today_data"),
};

export const students = {
    list: (query = "") => invoke<Student[]>("students_list", { query }),
    get: (id: string) => invoke<Student>("student_get", { id }),
    create: (input: StudentInput) => invoke<Student>("student_create", { input }),
    update: (id: string, input: StudentInput) => invoke<Student>("student_update", { id, input }),
    remove: (id: string) => invoke<void>("student_delete", { id }),
    detail: (id: string) => invoke<StudentDetail>("student_detail", { id }),
};

export const sessions = {
    list: (studentId: string | null = null, status: string | null = null, limit = 500) =>
        invoke<Session[]>("sessions_list", { studentId, status, limit }),
    get: (id: string) => invoke<Session>("session_get", { id }),
    create: (input: SessionInput) => invoke<Session>("session_create", { input }),
    update: (id: string, input: SessionInput) => invoke<Session>("session_update", { id, input }),
    remove: (id: string) => invoke<void>("session_delete", { id }),
    start: (id: string) => invoke<Session>("session_start", { id }),
    detail: (id: string) => invoke<SessionDetail>("session_detail", { id }),
    exportPackage: (sessionId: string, path: string) =>
        invoke<PackageResult>("session_package_export", { sessionId, path }),
    importPackage: (path: string) => invoke<ImportedSession>("session_package_import", { path }),
};

export const schedule = {
    list: (from: number | null = null, to: number | null = null) =>
        invoke<ScheduleEvent[]>("schedule_list", { from, to }),
    create: (input: ScheduleInput) => invoke<ScheduleEvent>("schedule_create", { input }),
    update: (id: string, input: ScheduleInput) =>
        invoke<ScheduleEvent>("schedule_update", { id, input }),
    remove: (id: string) => invoke<void>("schedule_delete", { id }),
};

export const journal = {
    list: (sessionId: string | null = null) =>
        invoke<JournalEntry[]>("journal_list", { sessionId }),
    create: (input: JournalInput) => invoke<JournalEntry>("journal_create", { input }),
    update: (id: string, input: JournalInput) =>
        invoke<JournalEntry>("journal_update", { id, input }),
    remove: (id: string) => invoke<void>("journal_delete", { id }),
};

export const observations = {
    list: (sessionId: string | null = null) =>
        invoke<Observation[]>("observations_list", { sessionId }),
    create: (input: ObservationInput) => invoke<Observation>("observation_create", { input }),
    update: (id: string, input: ObservationInput) =>
        invoke<Observation>("observation_update", { id, input }),
    remove: (id: string) => invoke<void>("observation_delete", { id }),
};

export const cues = {
    list: (sessionId: string, limit = 10_000) =>
        invoke<TranscriptCue[]>("cues_list", { sessionId, limit }),
    create: (input: TranscriptCueInput) => invoke<TranscriptCue>("cue_create", { input }),
    update: (id: string, input: TranscriptCueInput) =>
        invoke<TranscriptCue>("cue_update", { id, input }),
    remove: (id: string) => invoke<void>("cue_delete", { id }),
};

export const materials = {
    list: (sessionId: string | null = null, studentId: string | null = null, query = "") =>
        invoke<Material[]>("materials_list", { sessionId, studentId, query }),
    importFile: (path: string, sessionId: string | null = null, studentId: string | null = null) =>
        invoke<Material>("material_import", { path, sessionId, studentId }),
    link: (input: LinkInput) => invoke<Material>("material_link", { input }),
    update: (id: string, title: string, notes: string) =>
        invoke<Material>("material_update", { id, title, notes }),
    remove: (id: string) => invoke<void>("material_delete", { id }),
    read: async (id: string, maximumBytes = 64 * 1024 * 1024) => {
        const bytes = await invoke<number[]>("material_read", { id, maximumBytes });
        return Uint8Array.from(bytes);
    },
    ocr: (id: string) => invoke<Material>("material_ocr", { id }),
};

export const recordings = {
    list: (sessionId: string) => invoke<Recording[]>("recordings_list", { sessionId }),
    import: (input: {
        sessionId: string;
        title: string;
        source: string;
        sampleRate: number;
        channels: number;
        durationUs: number;
        bytes: number[];
    }) => invoke<Recording>("recording_import", input),
    importTracks: (input: {
        sessionId: string;
        title: string;
        source: string;
        sampleRate: number;
        channels: number;
        durationUs: number;
        tracks: Array<{
            track: string;
            sampleRate: number;
            channels: number;
            bytes: number[];
        }>;
    }) => invoke<Recording>("recording_import_tracks", input),
    read: (id: string) => invoke<number[]>("recording_read", { id }),
    readTrack: (id: string, track: string) =>
        invoke<number[]>("recording_read_track", { id, track }),
    remove: (id: string) => invoke<void>("recording_delete", { id }),
};

export const guides = {
    list: (studentId: string | null = null, sessionId: string | null = null) =>
        invoke<Guide[]>("guides_list", { studentId, sessionId }),
    get: (id: string) => invoke<Guide>("guide_get", { id }),
    create: (input: GuideInput) => invoke<Guide>("guide_create", { input }),
    update: (id: string, input: GuideInput) => invoke<Guide>("guide_update", { id, input }),
    remove: (id: string) => invoke<void>("guide_delete", { id }),
};

export const evidence = {
    list: (studentId: string | null = null, sessionId: string | null = null) =>
        invoke<Evidence[]>("evidence_list", { studentId, sessionId }),
    graph: (studentId: string | null = null, sessionId: string | null = null) =>
        invoke<EvidenceGraph>("evidence_graph", { studentId, sessionId }),
    create: (input: EvidenceInput) => invoke<Evidence>("evidence_create", { input }),
    update: (id: string, input: EvidenceInput) =>
        invoke<Evidence>("evidence_update", { id, input }),
    remove: (id: string) => invoke<void>("evidence_delete", { id }),
    link: (input: EvidenceLinkInput) => invoke<EvidenceLink>("evidence_link_create", { input }),
    unlink: (id: string) => invoke<void>("evidence_link_delete", { id }),
};

export const goals = {
    list: (studentId: string) => invoke<Goal[]>("goals_list", { studentId }),
    upsert: (id: string | null, input: GoalInput) => invoke<Goal>("goal_upsert", { id, input }),
    remove: (id: string) => invoke<void>("goal_delete", { id }),
};

export const skills = {
    list: (studentId: string) => invoke<SkillRating[]>("skills_list", { studentId }),
    upsert: (id: string | null, input: SkillRatingInput) =>
        invoke<SkillRating>("skill_upsert", { id, input }),
    remove: (id: string) => invoke<void>("skill_delete", { id }),
};

export const search = {
    global: (query: string) => invoke<SearchHit[]>("search_global", { query }),
};

export const trash = {
    list: () => invoke<TrashItem[]>("trash_list"),
    restore: (entityType: string, id: string) => invoke<void>("trash_restore", { entityType, id }),
    remove: (entityType: string, id: string) => invoke<void>("trash_delete", { entityType, id }),
    empty: () => invoke<void>("trash_empty"),
    purgeExpired: () => invoke<number>("trash_purge_expired"),
};

export const settings = {
    all: () => invoke<Record<string, string>>("settings_all"),
    set: (key: string, value: string) => invoke<void>("setting_set", { key, value }),
};

export const backup = {
    create: (path: string) => invoke<BackupResult>("backup_create", { path }),
};

export const reminders = {
    due: (leadMinutes = 15) => invoke<Reminder[]>("reminders_due", { leadMinutes }),
};

export const calendar = {
    status: (provider: string) =>
        invoke<CalendarClientStatus>("calendar_client_status", { provider }),
    saveClient: (provider: string, clientId: string, clientSecret: string | null) =>
        invoke<CalendarClientStatus>("calendar_save_client", {
            provider,
            clientId,
            clientSecret,
        }),
    accounts: () => invoke<CalendarAccount[]>("calendar_accounts"),
    connect: (provider: string) => invoke<CalendarAccount>("calendar_connect", { provider }),
    connectCaldav: (serverUrl: string, username: string, password: string) =>
        invoke<CalendarAccount>("calendar_connect_caldav", { serverUrl, username, password }),
    sync: (accountId: string, from: number | null = null, to: number | null = null) =>
        invoke<CalendarSyncResult>("calendar_sync", { accountId, from, to }),
    disconnect: (accountId: string) => invoke<void>("calendar_disconnect", { accountId }),
};
