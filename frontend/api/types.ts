export interface WorkspaceSummary {
    path: string;
    name: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    studentCount: number;
    sessionCount: number;
    materialCount: number;
    encrypted: boolean;
    schemaVersion: number;
    sizeBytes: number;
}

export interface Student {
    id: string;
    displayName: string;
    year: string;
    subjects: string[];
    goals: string[];
    notes: string;
    archived: boolean;
    createdAt: number;
    updatedAt: number;
    sessionCount: number;
    lastSessionAt: number | null;
}

export interface StudentInput {
    displayName: string;
    year: string;
    subjects: string[];
    goals: string[];
    notes: string;
}

export interface Session {
    id: string;
    studentId: string | null;
    studentName: string;
    title: string;
    subject: string;
    scheduledAt: number | null;
    startedAt: number | null;
    endedAt: number | null;
    status: string;
    notes: string;
    createdAt: number;
    updatedAt: number;
    journalCount: number;
    observationCount: number;
    materialCount: number;
    cueCount: number;
    guideCount: number;
    recordingCount: number;
}

export interface SessionDetail {
    session: Session;
    journal: JournalEntry[];
    observations: Observation[];
    materials: Material[];
    recordings: Recording[];
    cues: TranscriptCue[];
    guides: Guide[];
    evidence: Evidence[];
}

export interface SessionInput {
    studentId: string | null;
    title: string;
    subject: string;
    scheduledAt: number | null;
    startedAt: number | null;
    endedAt: number | null;
    status: string;
    notes: string;
}

export interface ScheduleEvent {
    id: string;
    studentId: string | null;
    studentName: string;
    title: string;
    subject: string;
    startAt: number;
    durationMin: number;
    recurrence: string;
    recurrenceInterval: number;
    recurrenceUntil: number | null;
    location: string;
    notes: string;
    calendarProvider: string;
    createdAt: number;
    updatedAt: number;
}

export interface ScheduleInput {
    studentId: string | null;
    title: string;
    subject: string;
    startAt: number;
    durationMin: number;
    recurrence: string;
    recurrenceInterval: number;
    recurrenceUntil: number | null;
    location: string;
    notes: string;
}

export interface ScheduleConflict {
    eventId: string;
    title: string;
    studentName: string;
    startAt: number;
    endAt: number;
    sameStudent: boolean;
}

export interface JournalEntry {
    id: string;
    sessionId: string | null;
    studentId: string | null;
    entryDate: string;
    title: string;
    body: string;
    createdAt: number;
    updatedAt: number;
}

export interface JournalInput {
    sessionId: string | null;
    studentId: string | null;
    entryDate: string;
    title: string;
    body: string;
}

export interface Observation {
    id: string;
    sessionId: string | null;
    studentId: string | null;
    kind: string;
    priority: string;
    startUs: number;
    endUs: number;
    title: string;
    body: string;
    createdAt: number;
    updatedAt: number;
}

export interface ObservationInput {
    sessionId: string | null;
    studentId: string | null;
    kind: string;
    priority: string;
    startUs: number;
    endUs: number;
    title: string;
    body: string;
}

export interface TranscriptCue {
    id: string;
    sessionId: string;
    startUs: number;
    endUs: number;
    speaker: string;
    body: string;
    verified: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface TranscriptCueInput {
    sessionId: string;
    startUs: number;
    endUs: number;
    speaker: string;
    body: string;
    verified: boolean;
}

export interface Recording {
    id: string;
    sessionId: string;
    title: string;
    source: string;
    sampleRate: number;
    channels: number;
    startedAt: number;
    durationUs: number;
    byteSize: number;
    tracks: string[];
    createdAt: number;
    updatedAt: number;
}

export interface Material {
    id: string;
    sessionId: string | null;
    studentId: string | null;
    kind: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    hash: string;
    sourceUrl: string;
    title: string;
    notes: string;
    status: string;
    extractedText: string;
    createdAt: number;
    updatedAt: number;
}

export interface LinkInput {
    sessionId: string | null;
    studentId: string | null;
    title: string;
    url: string;
    notes: string;
}

export interface Guide {
    id: string;
    studentId: string | null;
    sessionId: string | null;
    title: string;
    status: string;
    body: string;
    sourceIds: string[];
    createdAt: number;
    updatedAt: number;
}

export interface GuideInput {
    studentId: string | null;
    sessionId: string | null;
    title: string;
    status: string;
    body: string;
    sourceIds: string[];
}

export interface Evidence {
    id: string;
    studentId: string | null;
    sessionId: string | null;
    sourceType: string;
    sourceId: string;
    kind: string;
    statement: string;
    status: string;
    createdAt: number;
    updatedAt: number;
}

export interface EvidenceInput {
    studentId: string | null;
    sessionId: string | null;
    sourceType: string;
    sourceId: string;
    kind: string;
    statement: string;
    status: string;
}

export interface EvidenceLink {
    id: string;
    fromId: string;
    toId: string;
    relationship: string;
    createdAt: number;
}

export interface EvidenceLinkInput {
    fromId: string;
    toId: string;
    relationship: string;
}

export interface EvidenceGraph {
    nodes: Evidence[];
    links: EvidenceLink[];
}

export interface SkillRating {
    id: string;
    studentId: string;
    skill: string;
    rating: number;
    note: string;
    updatedAt: number;
}

export interface SkillRatingInput {
    studentId: string;
    skill: string;
    rating: number;
    note: string;
}

export interface Goal {
    id: string;
    studentId: string;
    title: string;
    status: string;
    targetDate: string;
    notes: string;
    updatedAt: number;
}

export interface GoalInput {
    studentId: string;
    title: string;
    status: string;
    targetDate: string;
    notes: string;
}

export interface SearchHit {
    entityType: string;
    entityId: string;
    title: string;
    snippet: string;
    studentId: string;
    sessionId: string;
}

export interface TrashItem {
    entityType: string;
    entityId: string;
    title: string;
    deletedAt: number;
    sessionId: string;
    studentId: string;
}

export interface TodayData {
    workspace: WorkspaceSummary;
    upcoming: ScheduleEvent[];
    upcomingSessions: Session[];
    recentSessions: Session[];
    students: Student[];
    unfinishedSession: Session | null;
    backupLastAt: number | null;
}

export interface StudentDetail {
    student: Student;
    sessions: Session[];
    goals: Goal[];
    skills: SkillRating[];
    evidence: Evidence[];
    materials: Material[];
    guides: Guide[];
}

export interface BackupResult {
    path: string;
    bytes: number;
}

export interface SalvageReport {
    path: string;
    copiedRows: number;
    skippedRows: number;
    tables: Record<string, number>;
    warnings: string[];
    integrity: string;
}

export interface MaintenanceResult {
    beforeBytes: number;
    afterBytes: number;
    integrity: string;
}

export interface PackageResult {
    path: string;
    bytes: number;
    sessionId: string;
    title: string;
}

export interface ImportedSession {
    sessionId: string;
    studentId: string | null;
    title: string;
}

export interface Reminder {
    id: string;
    entityType: string;
    title: string;
    studentName: string;
    startAt: number;
    minutesUntil: number;
}

export interface CalendarClientStatus {
    provider: string;
    hasClientId: boolean;
    hasClientSecret: boolean;
}

export interface CalendarAccount {
    id: string;
    provider: string;
    accountEmail: string;
    lastSyncAt: number;
    eventCount: number;
}

export interface CalendarSyncResult {
    accountId: string;
    created: number;
    updated: number;
    removed: number;
}

export interface CalendarEvent {
    externalId: string;
    title: string;
    startAt: number;
    durationMin: number;
    recurrence: string;
    recurrenceInterval: number;
    recurrenceUntil: number | null;
    location: string;
    notes: string;
    cancelled: boolean;
    etag: string;
}
