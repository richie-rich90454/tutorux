use std::collections::{BTreeMap, BTreeSet};

use crate::core::archive::{valid_uuid, ArchiveRecord, RecordType};

use super::helpers::is_digits;
use super::VerificationLookup;

pub(crate) fn validate_guide_semantics(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    live_by_key: &BTreeMap<String, ArchiveRecord>,
    strict: bool,
) -> Vec<String> {
    let mut issues = Vec::new();
    if strict {
        if record.field("title").unwrap_or("").is_empty() {
            issues.push("title is required.".to_owned());
        }
        if record.field("session_id").unwrap_or("").is_empty()
            && record.field("entry_id").unwrap_or("").is_empty()
        {
            issues.push("a journal entry or session scope is required.".to_owned());
        }
        let approval = record.field("approval_state").unwrap_or("draft");
        if !["draft", "proposed", "approved"].contains(&approval) {
            issues.push("approval state is invalid.".to_owned());
        }
    }
    let session_id = record.field("session_id").unwrap_or("").to_lowercase();
    let entry_id = record.field("entry_id").unwrap_or("").to_lowercase();
    let mut scope_session_ids: BTreeSet<String> = BTreeSet::new();
    let mut scope_student_ids: BTreeSet<String> = BTreeSet::new();
    if strict {
        if !entry_id.is_empty() {
            let valid = lookup
                .live(RecordType::SETTINGS, &entry_id)
                .map(|entry| entry.field("record_role") == Some("journal-entry"))
                .unwrap_or(false);
            if !valid {
                issues.push("journal entry reference does not resolve.".to_owned());
            }
        }
        for candidate in live_by_key.values() {
            if candidate.record_type != RecordType::SESSION {
                continue;
            }
            if !entry_id.is_empty()
                && candidate
                    .field("entry_id")
                    .map(str::to_lowercase)
                    .as_deref()
                    == Some(entry_id.as_str())
            {
                if session_id.is_empty() {
                    scope_session_ids.insert(candidate.id.to_lowercase());
                }
                if let Some(student_id) = candidate.field("student_id") {
                    if !student_id.is_empty() {
                        scope_student_ids.insert(student_id.to_lowercase());
                    }
                }
            }
        }
        if !session_id.is_empty() {
            match lookup.live(RecordType::SESSION, &session_id) {
                None => issues.push("session reference does not resolve.".to_owned()),
                Some(session) => {
                    if !entry_id.is_empty()
                        && session.field("entry_id").map(str::to_lowercase).as_deref()
                            != Some(entry_id.as_str())
                    {
                        issues.push("session does not belong to its journal entry.".to_owned());
                    }
                    scope_session_ids.insert(session_id.clone());
                    let student_id = session.field("student_id").unwrap_or("").to_lowercase();
                    if !student_id.is_empty() && student_id != "anonymous" {
                        scope_student_ids.insert(student_id);
                    }
                }
            }
        }
    }
    let section_count = match parse_bounded_count(record, "section_count", "guide section") {
        Ok(value) => value,
        Err(issue) => {
            issues.push(issue);
            return issues;
        }
    };
    for section_index in 0..section_count {
        let prefix = format!("section.{section_index}.");
        if strict
            && record
                .field(&format!("{prefix}heading"))
                .unwrap_or("")
                .is_empty()
        {
            issues.push(format!("section {} needs a heading.", section_index + 1));
        }
        let block_count =
            match parse_bounded_count(record, &format!("{prefix}block_count"), "guide block") {
                Ok(value) => value,
                Err(issue) => {
                    issues.push(issue);
                    continue;
                }
            };
        for block_index in 0..block_count {
            let block_prefix = format!("{prefix}block.{block_index}.");
            let kind = record.field(&format!("{block_prefix}kind")).unwrap_or("");
            let text = record.field(&format!("{block_prefix}text")).unwrap_or("");
            if strict && kind.is_empty() {
                issues.push(format!("block {} kind is required.", block_index + 1));
            }
            let mut source_ids: BTreeSet<String> = record
                .field(&format!("{block_prefix}source_ids"))
                .unwrap_or("")
                .split(',')
                .map(|id| id.trim().to_lowercase())
                .filter(|id| !id.is_empty())
                .collect();
            let (inline_ids, inline_valid) = parse_inline_sources(text);
            for id in inline_ids {
                source_ids.insert(id);
            }
            if !inline_valid {
                issues.push(format!(
                    "block {} has an invalid inline source reference.",
                    block_index + 1
                ));
            }
            if kind == "image" || kind == "figure" || text.starts_with("![") {
                match parse_asset_image_reference(text) {
                    Some(asset_id) => {
                        source_ids.insert(asset_id);
                    }
                    None => issues.push(format!(
                        "block {} has an invalid image reference.",
                        block_index + 1
                    )),
                }
            }
            for source_id in source_ids {
                if !valid_uuid(&source_id) {
                    issues.push(format!(
                        "block {} has an invalid source identifier.",
                        block_index + 1
                    ));
                    continue;
                }
                let mut found = false;
                if strict {
                    for record_type in [
                        RecordType::TRANSCRIPT_SEGMENT,
                        RecordType::ANNOTATION,
                        RecordType::EVIDENCE_NODE,
                        RecordType::ASSET_METADATA,
                        RecordType::SESSION,
                        RecordType::STUDENT,
                    ] {
                        let Some(source) = lookup.live(record_type, &source_id) else {
                            continue;
                        };
                        found = if record_type == RecordType::SESSION {
                            scope_session_ids.contains(&source_id)
                        } else if record_type == RecordType::STUDENT {
                            scope_student_ids.contains(&source_id)
                        } else if record_type == RecordType::ASSET_METADATA {
                            let source_session =
                                source.field("session_id").unwrap_or("").to_lowercase();
                            let source_student =
                                source.field("student_id").unwrap_or("").to_lowercase();
                            scope_session_ids.contains(&source_session)
                                || scope_student_ids.contains(&source_student)
                        } else {
                            scope_session_ids
                                .contains(&source.field("session_id").unwrap_or("").to_lowercase())
                        };
                        if found {
                            break;
                        }
                    }
                } else {
                    for record_type in [
                        RecordType::TRANSCRIPT_SEGMENT,
                        RecordType::ANNOTATION,
                        RecordType::EVIDENCE_NODE,
                        RecordType::ASSET_METADATA,
                        RecordType::SESSION,
                        RecordType::STUDENT,
                    ] {
                        if lookup.get(record_type, &source_id).is_some() {
                            found = true;
                            break;
                        }
                    }
                }
                if !found {
                    if let Some(notes) = lookup.get(RecordType::SETTINGS, &source_id) {
                        if notes.field("record_role") == Some("journal-notes") {
                            let entry_match = !entry_id.is_empty()
                                && notes.field("entry_id").map(str::to_lowercase).as_deref()
                                    == Some(entry_id.as_str());
                            let session_match = !session_id.is_empty()
                                && notes.field("session_id").map(str::to_lowercase).as_deref()
                                    == Some(session_id.as_str());
                            found = entry_match || session_match;
                        }
                    }
                }
                if !found {
                    issues.push(format!(
                        "source {source_id} does not resolve to a live archive record."
                    ));
                }
            }
        }
    }
    issues
}

fn parse_bounded_count(
    record: &ArchiveRecord,
    name: &str,
    label: &str,
) -> std::result::Result<u64, String> {
    let raw = record.field(name).unwrap_or("");
    if !is_digits(raw) {
        return Err(format!("{label} count is invalid."));
    }
    match raw.parse::<u64>() {
        Ok(value) if value <= 10_000 => Ok(value),
        _ => Err(format!("{label} count is invalid.")),
    }
}

pub(crate) fn parse_inline_sources(text: &str) -> (Vec<String>, bool) {
    let lower = text.to_lowercase();
    let mut ids = Vec::new();
    let mut cursor = 0usize;
    while let Some(start) = lower[cursor..].find("[[source:") {
        let start = cursor + start;
        let id_start = start + "[[source:".len();
        let Some(end_offset) = lower[id_start..].find("]]") else {
            break;
        };
        let end = id_start + end_offset;
        let raw = &lower[id_start..end];
        if raw.is_empty() {
            cursor = end + 2;
            continue;
        }
        let id = raw.trim().to_lowercase();
        if !valid_uuid(&id) {
            return (ids, false);
        }
        ids.push(id);
        cursor = end + 2;
    }
    (ids, true)
}

pub(crate) fn parse_asset_image_reference(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    if !lower.starts_with("![") {
        return None;
    }
    let mut index = 2usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b']' => break,
            _ => index += 1,
        }
    }
    if index >= bytes.len() {
        return None;
    }
    let rest = lower[index + 1..].strip_prefix("(asset:")?;
    let id = rest.strip_suffix(')')?;
    if !valid_uuid(id) {
        return None;
    }
    Some(id.to_owned())
}
