use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{CliError, CliResult};
use crate::core::format::{ArchiveRecord, RecordType};

const DEFAULT_TOKEN_BUDGET: usize = 8192;
const MAX_TOKEN_BUDGET: usize = 10_000_000;
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CANDIDATES: usize = 100_000;
const INTERNAL_ASSET_ROLES: [&str; 5] = [
    "audio-track",
    "waveform-pyramid",
    "sparse-timestamp-seek-index",
    "asset-blob-manifest",
    "asset-blob-chunk",
];

struct Candidate {
    record_id: String,
    source_kind: &'static str,
    content: String,
    priority: i32,
    confidence: f64,
    tutor_authored: bool,
    required: bool,
    updated_at_us: u128,
    order: usize,
}

pub(super) fn pack(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    token_budget: u64,
    maximum_item_tokens: u64,
) -> CliResult<Value> {
    validate_limits(token_budget, maximum_item_tokens)?;
    if !snapshot
        .get_record(RecordType::SESSION, session_id)?
        .is_some_and(|record| !record.deleted())
    {
        return Err(CliError("Choose an active session before packing AI context.".to_owned()).into());
    }
    let transcripts = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
    let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
    let evidence = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
    let assets = snapshot.list_records(RecordType::ASSET_METADATA, false)?;
    let mut candidates = Vec::new();
    let mut total_source_bytes = 0usize;

    for record in transcripts.iter().filter(|record| belongs_to(record, session_id)) {
        add(
            &mut candidates,
            &mut total_source_bytes,
            record,
            "transcript",
            record.field("text").unwrap_or(""),
            if record.field("verification_state") == Some("human-verified") {
                2
            } else {
                1
            },
            0.7,
            false,
            false,
        )?;
    }
    for record in annotations.iter().filter(|record| belongs_to(record, session_id)) {
        let title = record.field("title").unwrap_or("");
        let content = record.field("content").unwrap_or("");
        let text = if title.is_empty() {
            content.to_owned()
        } else {
            format!("{title}\n{content}")
        };
        add(
            &mut candidates,
            &mut total_source_bytes,
            record,
            "tutor-annotation",
            &text,
            priority_of(record.field("priority")),
            1.0,
            true,
            record.field("type") == Some("explicit-instruction"),
        )?;
    }
    for record in evidence.iter().filter(|record| belongs_to(record, session_id)) {
        let has_sources = ["source_annotation_id", "source_segment_ids", "source_asset_ids"]
            .iter()
            .any(|name| !record.field(name).unwrap_or("").is_empty());
        if (has_sources || record.field("origin") == Some("transcript-derived-candidate"))
            && !evidence_sources_are_current(snapshot, record)?
        {
            continue;
        }
        let verified = record.field("verification_state") == Some("human-verified");
        let priority = priority_of(record.field("priority"));
        add(
            &mut candidates,
            &mut total_source_bytes,
            record,
            "evidence",
            record.field("content").unwrap_or(""),
            if verified || priority == 3 {
                3
            } else if priority == 0 {
                1
            } else {
                priority
            },
            if verified { 1.0 } else { 0.5 },
            record.field("origin") == Some("tutor-authored"),
            false,
        )?;
    }
    for record in assets.iter().filter(|record| belongs_to(record, session_id)) {
        if INTERNAL_ASSET_ROLES.contains(&record.field("record_role").unwrap_or("")) {
            continue;
        }
        let filename = record
            .field("file_name")
            .or_else(|| record.field("filename"))
            .unwrap_or("");
        let extracted = record.field("extracted_text").unwrap_or("");
        let content = if extracted.is_empty() {
            format!("Imported asset: {filename}")
        } else {
            format!("Imported asset: {filename}\n{extracted}")
        };
        add(
            &mut candidates,
            &mut total_source_bytes,
            record,
            "asset",
            &content,
            0,
            0.4,
            false,
            false,
        )?;
    }

    candidates.sort_by(|left, right| {
        right
            .required
            .cmp(&left.required)
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| right.tutor_authored.cmp(&left.tutor_authored))
            .then_with(|| {
                right
                    .confidence
                    .partial_cmp(&left.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| right.updated_at_us.cmp(&left.updated_at_us))
            .then_with(|| right.record_id.cmp(&left.record_id))
            .then_with(|| left.order.cmp(&right.order))
    });

    let mut included = Vec::new();
    let mut omitted = Vec::new();
    let mut used_tokens = 0usize;
    for candidate in &candidates {
        if !candidate.confidence.is_finite()
            || candidate.confidence < 0.0
            || candidate.confidence > 1.0
        {
            return Err(CliError("AI context confidence must be between zero and one.".to_owned()).into());
        }
        let characters: Vec<char> = candidate.content.chars().collect();
        for (fragment_index, (start, end, byte_start, byte_end)) in
            split_by_token_limit(&characters, maximum_item_tokens as usize).into_iter().enumerate()
        {
            let content: String = characters[start..end].iter().collect();
            let estimated_tokens = estimate_tokens(&content);
            if estimated_tokens as u64 > maximum_item_tokens {
                omitted.push(json!({
                    "source_id": candidate.record_id,
                    "reason": "exceeds-item-token-limit",
                    "estimated_tokens": estimated_tokens,
                    "fragment_index": fragment_index,
                }));
            } else if estimated_tokens as u64 > token_budget - used_tokens as u64 {
                omitted.push(json!({
                    "source_id": candidate.record_id,
                    "reason": "exceeds-remaining-context-budget",
                    "estimated_tokens": estimated_tokens,
                    "fragment_index": fragment_index,
                }));
            } else {
                included.push(json!({
                    "source_id": candidate.record_id,
                    "source_kind": candidate.source_kind,
                    "content": content,
                    "source_byte_start": byte_start,
                    "source_byte_end": byte_end,
                    "estimated_tokens": estimated_tokens,
                    "fragment_index": fragment_index,
                    "tutor_authored": candidate.tutor_authored,
                }));
                used_tokens += estimated_tokens;
            }
        }
    }
    Ok(json!({
        "session_id": session_id,
        "token_budget": token_budget,
        "used_tokens": used_tokens,
        "complete": omitted.is_empty(),
        "included": included,
        "omitted": omitted,
    }))
}

pub(super) fn default_token_budget() -> u64 {
    DEFAULT_TOKEN_BUDGET as u64
}

fn add(
    candidates: &mut Vec<Candidate>,
    total_source_bytes: &mut usize,
    record: &ArchiveRecord,
    source_kind: &'static str,
    content: &str,
    priority: i32,
    confidence: f64,
    tutor_authored: bool,
    required: bool,
) -> CliResult<()> {
    if candidates.len() >= MAX_CANDIDATES {
        return Err(CliError("AI context contains too many source records to pack safely.".to_owned()).into());
    }
    let content_bytes = content.len();
    if content_bytes > MAX_SOURCE_BYTES {
        return Err(CliError("An AI context source exceeds the 64 MiB per-record limit.".to_owned()).into());
    }
    if *total_source_bytes > MAX_SOURCE_BYTES - content_bytes {
        return Err(CliError("The selected AI context sources exceed the 64 MiB total limit.".to_owned()).into());
    }
    *total_source_bytes += content_bytes;
    candidates.push(Candidate {
        record_id: record.id.clone(),
        source_kind,
        content: content.to_owned(),
        priority,
        confidence,
        tutor_authored,
        required,
        updated_at_us: record
            .field("updated_at_us")
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        order: candidates.len(),
    });
    Ok(())
}

fn belongs_to(record: &ArchiveRecord, session_id: &str) -> bool {
    record.field("session_id") == Some(session_id) && !record.deleted()
}

fn priority_of(value: Option<&str>) -> i32 {
    match value {
        Some("critical") => 3,
        Some("high") => 2,
        Some("low") => 0,
        _ => 1,
    }
}

fn evidence_sources_are_current(
    snapshot: &ArchiveSnapshot,
    record: &ArchiveRecord,
) -> CliResult<bool> {
    let session_id = record.field("session_id").unwrap_or("");
    let mut has_sources = false;
    let mut validate = |record_type: u16,
                        ids: &[String],
                        revisions: &BTreeMap<String, u64>|
     -> CliResult<bool> {
        for id in ids {
            has_sources = true;
            if !crate::core::format::valid_uuid(id) {
                return Ok(false);
            }
            let Some(source) = snapshot.get_record(record_type, id)? else {
                return Ok(false);
            };
            let source_session = source.field("session_id").unwrap_or("");
            if source.deleted() || (!source_session.is_empty() && source_session != session_id) {
                return Ok(false);
            }
            if let Some(expected) = revisions.get(&id.to_lowercase()) {
                if source.revision != *expected {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    };

    let annotation_id = record.field("source_annotation_id").unwrap_or("");
    if !annotation_id.is_empty() {
        let mut revisions = BTreeMap::new();
        if let Some(revision) = record.field("source_annotation_revision") {
            let Some(value) = parse_revision(revision) else {
                return Ok(false);
            };
            revisions.insert(annotation_id.to_lowercase(), value);
        }
        if !validate(RecordType::ANNOTATION, &[annotation_id.to_owned()], &revisions)? {
            return Ok(false);
        }
    }
    let mut segment_revisions = BTreeMap::new();
    for entry in split_comma(record.field("source_segment_revisions").unwrap_or("")) {
        let Some((id, revision)) = entry.split_once('=') else {
            return Ok(false);
        };
        if id.is_empty() || revision.is_empty() {
            return Ok(false);
        }
        let Some(revision) = parse_revision(revision) else {
            return Ok(false);
        };
        segment_revisions.insert(id.to_lowercase(), revision);
    }
    let segments: Vec<String> = split_comma(record.field("source_segment_ids").unwrap_or(""))
        .into_iter()
        .map(|id| id.to_owned())
        .collect();
    if !validate(RecordType::TRANSCRIPT_SEGMENT, &segments, &segment_revisions)? {
        return Ok(false);
    }
    let assets: Vec<String> = split_comma(record.field("source_asset_ids").unwrap_or(""))
        .into_iter()
        .map(|id| id.to_owned())
        .collect();
    if !validate(RecordType::ASSET_METADATA, &assets, &BTreeMap::new())? {
        return Ok(false);
    }
    Ok(has_sources)
}

fn split_comma(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect()
}

fn parse_revision(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn estimate_tokens(value: &str) -> usize {
    value.len().div_ceil(3)
}

fn validate_limits(token_budget: u64, maximum_item_tokens: u64) -> CliResult<()> {
    if token_budget < 1 || token_budget > MAX_TOKEN_BUDGET as u64 {
        return Err(CliError("AI context token budget must be between 1 and 10,000,000.".to_owned()).into());
    }
    if maximum_item_tokens < 1 || maximum_item_tokens > token_budget {
        return Err(CliError("Maximum AI context item tokens must be between 1 and its context budget.".to_owned()).into());
    }
    Ok(())
}

fn split_by_token_limit(
    characters: &[char],
    maximum_tokens: usize,
) -> Vec<(usize, usize, usize, usize)> {
    if characters.is_empty() {
        return vec![(0, 0, 0, 0)];
    }
    let mut byte_offsets = Vec::with_capacity(characters.len() + 1);
    byte_offsets.push(0usize);
    for character in characters {
        byte_offsets.push(byte_offsets.last().copied().unwrap_or(0) + character.len_utf8());
    }
    let mut fragments = Vec::new();
    let mut start = 0usize;
    while start < characters.len() {
        let mut low = start;
        let mut high = characters.len() + 1;
        while low + 1 < high {
            let middle = low + (high - low) / 2;
            let candidate: String = characters[start..middle].iter().collect();
            if estimate_tokens(&candidate) <= maximum_tokens {
                low = middle;
            } else {
                high = middle;
            }
        }
        let mut end = low;
        if end == start {
            end = (start + 1).min(characters.len());
        }
        if end < characters.len() {
            end = prefer_line_boundary(characters, start, end);
        }
        fragments.push((start, end, byte_offsets[start], byte_offsets[end]));
        start = end;
    }
    fragments
}

fn prefer_line_boundary(characters: &[char], start: usize, end: usize) -> usize {
    let segment = &characters[start..end];
    let preferred_minimum = segment.len() / 2;
    if segment.len() >= 2 {
        for index in (preferred_minimum..=segment.len() - 2).rev() {
            if segment[index] == '\n' && segment[index + 1] == '\n' {
                return start + index + 2;
            }
        }
    }
    for index in (preferred_minimum..segment.len()).rev() {
        if segment[index] == '\n' {
            return start + index + 1;
        }
    }
    end
}

#[cfg(test)]
mod tests {
    use super::{estimate_tokens, split_by_token_limit};

    #[test]
    fn estimates_use_the_shared_utf8_byte_rule() {
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("abcd"), 2);
        assert_eq!(estimate_tokens("é"), 1);
        assert_eq!(estimate_tokens("🌍"), 2);
    }

    #[test]
    fn fragments_prefer_paragraph_boundaries() {
        let characters: Vec<char> = "aaaa\n\nbbbbbb".chars().collect();
        let fragments = split_by_token_limit(&characters, 2);
        assert_eq!(fragments[0].0, 0);
        assert_eq!(fragments[0].1, 6);
    }
}
