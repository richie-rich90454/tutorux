use std::collections::BTreeMap;

pub const ARCHIVE_HEADER_SIZE: u64 = 64;
pub const RECORD_HEADER_SIZE: usize = 64;
pub const MAX_RECORD_PAYLOAD: u64 = 256 * 1024 * 1024;
pub const SUPPORTED_ARCHIVE_MAJOR: u16 = 1;
pub const SUPPORTED_ARCHIVE_MINOR: u16 = 0;
pub const CAPABILITY_ENCRYPTED: u64 = 1;
pub const ZERO_UUID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RecordType;

impl RecordType {
    pub const STUDENT: u16 = 1;
    pub const SESSION: u16 = 2;
    pub const AUDIO_CHUNK: u16 = 3;
    pub const TRANSCRIPT_SEGMENT: u16 = 4;
    pub const ANNOTATION: u16 = 5;
    pub const ASSET_METADATA: u16 = 6;
    pub const ASSET_BLOB: u16 = 7;
    pub const EVIDENCE_NODE: u16 = 8;
    pub const EVIDENCE_EDGE: u16 = 9;
    pub const GUIDE: u16 = 10;
    pub const SETTINGS: u16 = 11;
    pub const AI_JOB: u16 = 12;
    pub const ENCRYPTION: u16 = 13;
    pub const WAVEFORM_INDEX: u16 = 14;
    pub const INDEX_PAGE: u16 = 250;
    pub const COMMIT: u16 = 251;
}

pub fn record_type_name(value: u16) -> &'static str {
    match value {
        RecordType::STUDENT => "student",
        RecordType::SESSION => "session",
        RecordType::AUDIO_CHUNK => "audio",
        RecordType::TRANSCRIPT_SEGMENT => "transcript",
        RecordType::ANNOTATION => "annotation",
        RecordType::ASSET_METADATA => "asset",
        RecordType::ASSET_BLOB => "asset-blob",
        RecordType::EVIDENCE_NODE => "evidence",
        RecordType::EVIDENCE_EDGE => "evidence-edge",
        RecordType::GUIDE => "guide",
        RecordType::SETTINGS => "settings",
        RecordType::AI_JOB => "ai-job",
        RecordType::ENCRYPTION => "encryption",
        RecordType::WAVEFORM_INDEX => "waveform-index",
        RecordType::INDEX_PAGE => "index",
        RecordType::COMMIT => "commit",
        _ => "unknown",
    }
}

pub fn record_type_from_name(value: &str) -> Option<u16> {
    let normalized = value.to_ascii_lowercase();
    let record_type = match normalized.as_str() {
        "student" => RecordType::STUDENT,
        "session" => RecordType::SESSION,
        "audio" => RecordType::AUDIO_CHUNK,
        "transcript" => RecordType::TRANSCRIPT_SEGMENT,
        "annotation" => RecordType::ANNOTATION,
        "asset" => RecordType::ASSET_METADATA,
        "asset-blob" => RecordType::ASSET_BLOB,
        "evidence" => RecordType::EVIDENCE_NODE,
        "evidence-edge" => RecordType::EVIDENCE_EDGE,
        "guide" => RecordType::GUIDE,
        "settings" => RecordType::SETTINGS,
        "ai-job" => RecordType::AI_JOB,
        "encryption" => RecordType::ENCRYPTION,
        "waveform-index" => RecordType::WAVEFORM_INDEX,
        "index" => RecordType::INDEX_PAGE,
        "commit" => RecordType::COMMIT,
        _ => return None,
    };
    Some(record_type)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveHeader {
    pub id: String,
    pub major_version: u16,
    pub minor_version: u16,
    pub created_at_us: u64,
    pub capabilities: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArchiveRecord {
    pub record_type: u16,
    pub id: String,
    pub revision: u64,
    pub previous_offset: u64,
    pub fields: BTreeMap<String, String>,
    pub blob: Vec<u8>,
}

impl ArchiveRecord {
    pub fn new(
        record_type: u16,
        id: impl Into<String>,
        fields: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        Self {
            record_type,
            id: id.into(),
            revision: 0,
            previous_offset: 0,
            fields: fields.into_iter().map(|(k, v)| (k.into(), v.into())).collect(),
            blob: Vec::new(),
        }
    }

    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }

    pub fn deleted(&self) -> bool {
        self.field("_deleted") == Some("true")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordFrame {
    pub record_type: u16,
    pub id: String,
    pub revision: u64,
    pub previous_offset: u64,
    pub codec: u8,
    pub flags: u8,
    pub payload_length: u64,
    pub payload_checksum: u32,
    pub stored_payload: Vec<u8>,
    pub end_offset: u64,
}
