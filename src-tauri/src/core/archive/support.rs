use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::core::format::{ArchiveRecord, RecordType};

pub(crate) const SECONDARY_INDEX_PREFIXES: [&str; 7] = [
    "ANNOTATIONSESSION:",
    "STUDENTSESSION:",
    "EVIDENCEADJ:",
    "TRANSCRIPTSESSION:",
    "GUIDESOURCE:",
    "AUDIOSESSION:",
    "BLOB:",
];

pub(crate) const CREDENTIAL_METADATA_FIELDS: [&str; 20] = [
    "credentialstorage",
    "apikeyenv",
    "tokenbudget",
    "tokensbudget",
    "tokencount",
    "tokenscount",
    "tokenlimit",
    "tokenslimit",
    "tokenusage",
    "tokensusage",
    "maxoutputtokens",
    "maximumoutputtokens",
    "tokenizerinformation",
    "contexttokens",
    "trainingcontexttokens",
    "usedtokens",
    "estimatedtokens",
    "requestedoutputtokens",
    "inputtokenupperbound",
    "",
];

pub(crate) const CREDENTIAL_MARKERS: [&str; 12] = [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "credential",
    "apikey",
    "authorization",
    "privatekey",
    "accesskey",
    "authkey",
    "bearertoken",
    "refreshtoken",
];

pub(crate) const NON_SECRET_TOKEN_SUFFIXES: [&str; 8] = [
    "tokenbudget",
    "tokensbudget",
    "tokencount",
    "tokenscount",
    "tokenlimit",
    "tokenslimit",
    "tokenusage",
    "tokensusage",
];

pub fn now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_micros() as u64)
        .unwrap_or(0)
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn valid_uuid(value: &str) -> bool {
    crate::core::format::valid_uuid(value)
}

pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

pub fn is_supported_manifest(record: Option<&ArchiveRecord>) -> bool {
    let Some(record) = record else {
        return false;
    };
    if record.field("record_role") == Some("archive-manifest") {
        return true;
    }
    record.field("record_role") == Some("tutorux-session-package")
        && record.field("package_version") == Some("1")
        && valid_uuid(record.field("source_session_id").unwrap_or(""))
}

pub fn canonical_setting_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        .collect()
}

pub fn is_sensitive_setting_key(value: &str) -> bool {
    let normalized = canonical_setting_key(value);
    if CREDENTIAL_METADATA_FIELDS.contains(&normalized.as_str()) {
        return false;
    }
    if CREDENTIAL_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return true;
    }
    if !normalized.contains("token") {
        return false;
    }
    !NON_SECRET_TOKEN_SUFFIXES
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

pub fn is_credential_settings_record(record: &ArchiveRecord) -> bool {
    if record.record_type != RecordType::SETTINGS {
        return false;
    }
    let mut found_role = false;
    for (name, value) in &record.fields {
        if canonical_setting_key(name) != "recordrole" {
            continue;
        }
        found_role = true;
        if value.to_lowercase() != "credential" {
            return false;
        }
    }
    found_role
}

pub fn has_sensitive_credential_material(record: &ArchiveRecord) -> bool {
    if record.record_type != RecordType::SETTINGS {
        return false;
    }
    for (name, value) in &record.fields {
        if is_sensitive_setting_key(name) {
            return true;
        }
        if canonical_setting_key(name) == "key" && is_sensitive_setting_key(value) {
            return true;
        }
    }
    false
}

pub(crate) fn manifest_counts(
    student_by_id: &BTreeMap<String, ArchiveRecord>,
    session_by_id: &BTreeMap<String, ArchiveRecord>,
) -> (String, String) {
    let students = student_by_id
        .values()
        .filter(|record| !record.deleted())
        .count();
    let sessions = session_by_id
        .values()
        .filter(|record| !record.deleted())
        .count();
    (students.to_string(), sessions.to_string())
}
