import { lazy } from "solid-js";

export const DocumentEditor = lazy(() =>
    import("./DocumentEditor").then((module) => ({ default: module.DocumentEditor })),
);
export const DiagnosticsReport = lazy(() =>
    import("./DiagnosticsReport").then((module) => ({ default: module.DiagnosticsReport })),
);
export const AnnotationPage = lazy(() =>
    import("./AnnotationPage").then((module) => ({ default: module.AnnotationPage })),
);
export const ArchiveSettings = lazy(() =>
    import("./ArchiveSettings").then((module) => ({ default: module.ArchiveSettings })),
);
export const ArchiveSettingsCopy = lazy(() =>
    import("./ArchiveSettingsCopy").then((module) => ({ default: module.ArchiveSettingsCopy })),
);
export const JournalHistory = lazy(() =>
    import("./JournalHistory").then((module) => ({ default: module.JournalHistory })),
);
export const JournalRelations = lazy(() =>
    import("./JournalRelations").then((module) => ({ default: module.JournalRelations })),
);
export const StudentVersionHistory = lazy(() =>
    import("./StudentVersionHistory").then((module) => ({ default: module.StudentVersionHistory })),
);
export const ArchiveMaintenance = lazy(() =>
    import("./ArchiveMaintenance").then((module) => ({ default: module.ArchiveMaintenance })),
);
export const SanitizedCopy = lazy(() =>
    import("./SanitizedCopy").then((module) => ({ default: module.SanitizedCopy })),
);
export const MaterialDetails = lazy(() =>
    import("./MaterialDetails").then((module) => ({ default: module.MaterialDetails })),
);
export const MaterialImportControls = lazy(() =>
    import("./MaterialDetails").then((module) => ({ default: module.MaterialImportControls })),
);
export const MaterialTrash = lazy(() =>
    import("./MaterialDetails").then((module) => ({ default: module.MaterialTrash })),
);
export const MaterialAudioPreview = lazy(() =>
    import("./MaterialAudioPreview").then((module) => ({ default: module.MaterialAudioPreview })),
);
export const EvidenceSources = lazy(() =>
    import("./EvidenceSources").then((module) => ({ default: module.EvidenceSources })),
);
export const SessionVersionHistory = lazy(() =>
    import("./SessionVersionHistory").then((module) => ({ default: module.SessionVersionHistory })),
);
export const AiPage = lazy(() => import("./AiPage").then((module) => ({ default: module.AiPage })));
export const CommandConsole = lazy(() =>
    import("./CommandConsole").then((module) => ({ default: module.CommandConsole })),
);
export const GuidesPage = lazy(() =>
    import("./GuidesPage").then((module) => ({ default: module.GuidesPage })),
);
export const StudentProgressPanel = lazy(() =>
    import("./StudentProgressPanel").then((module) => ({ default: module.StudentProgressPanel })),
);
export const JournalOrganizer = lazy(() =>
    import("./JournalOrganizer").then((module) => ({ default: module.JournalOrganizer })),
);

export const TranscriptPage = lazy(() =>
    import("./TranscriptPage").then((module) => ({ default: module.TranscriptPage })),
);

export const EvidencePage = lazy(() =>
    import("./EvidencePage").then((module) => ({ default: module.EvidencePage })),
);
export const AssetPage = lazy(() =>
    import("./AssetPage").then((module) => ({ default: module.AssetPage })),
);
export const RecordPage = lazy(() =>
    import("./RecordPage").then((module) => ({ default: module.RecordPage })),
);
export const SessionRow = lazy(() =>
    import("./RecordPage").then((module) => ({ default: module.SessionRow })),
);
export const TrashPage = lazy(() =>
    import("./TrashPage").then((module) => ({ default: module.TrashPage })),
);
