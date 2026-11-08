use serde::{Deserialize, Serialize};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub path: String,
    pub name: String,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub student_count: i64,
    pub session_count: i64,
    pub material_count: i64,
    pub encrypted: bool,
    pub schema_version: i64,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Student {
    pub id: String,
    pub display_name: String,
    pub year: String,
    pub subjects: Vec<String>,
    pub goals: Vec<String>,
    pub notes: String,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub session_count: i64,
    pub last_session_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentInput {
    pub display_name: String,
    pub year: String,
    pub subjects: Vec<String>,
    pub goals: Vec<String>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub student_id: Option<String>,
    pub student_name: String,
    pub title: String,
    pub subject: String,
    pub scheduled_at: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub status: String,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub journal_count: i64,
    pub observation_count: i64,
    pub material_count: i64,
    pub cue_count: i64,
    pub guide_count: i64,
    pub recording_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub student_id: Option<String>,
    pub title: String,
    pub subject: String,
    pub scheduled_at: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub status: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEvent {
    pub id: String,
    pub student_id: Option<String>,
    pub student_name: String,
    pub title: String,
    pub subject: String,
    pub start_at: i64,
    pub duration_min: i64,
    pub recurrence: String,
    pub recurrence_interval: i64,
    pub recurrence_until: Option<i64>,
    pub location: String,
    pub notes: String,
    pub calendar_provider: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    pub student_id: Option<String>,
    pub title: String,
    pub subject: String,
    pub start_at: i64,
    pub duration_min: i64,
    pub recurrence: String,
    #[serde(default = "default_recurrence_interval")]
    pub recurrence_interval: i64,
    #[serde(default)]
    pub recurrence_until: Option<i64>,
    pub location: String,
    pub notes: String,
}

fn default_recurrence_interval() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConflict {
    pub event_id: String,
    pub title: String,
    pub student_name: String,
    pub start_at: i64,
    pub end_at: i64,
    pub same_student: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub entry_date: String,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalInput {
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub entry_date: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub id: String,
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub kind: String,
    pub priority: String,
    pub start_us: i64,
    pub end_us: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationInput {
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub kind: String,
    pub priority: String,
    pub start_us: i64,
    pub end_us: i64,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCue {
    pub id: String,
    pub session_id: String,
    pub start_us: i64,
    pub end_us: i64,
    pub speaker: String,
    pub body: String,
    pub verified: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCueInput {
    pub session_id: String,
    pub start_us: i64,
    pub end_us: i64,
    pub speaker: String,
    pub body: String,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub source: String,
    pub sample_rate: i64,
    pub channels: i64,
    pub started_at: i64,
    pub duration_us: i64,
    pub byte_size: i64,
    pub tracks: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTrackInput {
    pub track: String,
    pub sample_rate: i64,
    pub channels: i64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub id: String,
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub kind: String,
    pub filename: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub hash: String,
    pub source_url: String,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub extracted_text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub session_id: Option<String>,
    pub student_id: Option<String>,
    pub title: String,
    pub url: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guide {
    pub id: String,
    pub student_id: Option<String>,
    pub session_id: Option<String>,
    pub title: String,
    pub status: String,
    pub body: String,
    pub source_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideInput {
    pub student_id: Option<String>,
    pub session_id: Option<String>,
    pub title: String,
    pub status: String,
    pub body: String,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub student_id: Option<String>,
    pub session_id: Option<String>,
    pub source_type: String,
    pub source_id: String,
    pub kind: String,
    pub statement: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceInput {
    pub student_id: Option<String>,
    pub session_id: Option<String>,
    pub source_type: String,
    pub source_id: String,
    pub kind: String,
    pub statement: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLink {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub relationship: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLinkInput {
    pub from_id: String,
    pub to_id: String,
    pub relationship: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceGraph {
    pub nodes: Vec<Evidence>,
    pub links: Vec<EvidenceLink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRating {
    pub id: String,
    pub student_id: String,
    pub skill: String,
    pub rating: i64,
    pub note: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRatingInput {
    pub student_id: String,
    pub skill: String,
    pub rating: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub student_id: String,
    pub title: String,
    pub status: String,
    pub target_date: String,
    pub notes: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalInput {
    pub student_id: String,
    pub title: String,
    pub status: String,
    pub target_date: String,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub snippet: String,
    pub student_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub deleted_at: i64,
    pub session_id: String,
    pub student_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayData {
    pub workspace: WorkspaceSummary,
    pub upcoming: Vec<ScheduleEvent>,
    pub upcoming_sessions: Vec<Session>,
    pub recent_sessions: Vec<Session>,
    pub students: Vec<Student>,
    pub unfinished_session: Option<Session>,
    pub backup_last_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentDetail {
    pub student: Student,
    pub sessions: Vec<Session>,
    pub goals: Vec<Goal>,
    pub skills: Vec<SkillRating>,
    pub evidence: Vec<Evidence>,
    pub materials: Vec<Material>,
    pub guides: Vec<Guide>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: Session,
    pub journal: Vec<JournalEntry>,
    pub observations: Vec<Observation>,
    pub materials: Vec<Material>,
    pub recordings: Vec<Recording>,
    pub cues: Vec<TranscriptCue>,
    pub guides: Vec<Guide>,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalvageReport {
    pub path: String,
    pub copied_rows: i64,
    pub skipped_rows: i64,
    pub tables: std::collections::HashMap<String, i64>,
    pub warnings: Vec<String>,
    pub integrity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub before_bytes: i64,
    pub after_bytes: i64,
    pub integrity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResult {
    pub path: String,
    pub bytes: i64,
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSession {
    pub session_id: String,
    pub student_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub entity_type: String,
    pub title: String,
    pub student_name: String,
    pub start_at: i64,
    pub minutes_until: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccount {
    pub id: String,
    pub provider: String,
    pub account_email: String,
    pub last_sync_at: i64,
    pub event_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncResult {
    pub account_id: String,
    pub created: usize,
    pub updated: usize,
    pub removed: usize,
}

pub fn unix_ms() -> i64 {
    now_ms()
}

pub fn parse_json_array(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

pub fn json_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_owned())
}
