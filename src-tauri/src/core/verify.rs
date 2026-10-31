use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::core::archive::{
    audio_session_index_key, secondary_index_keys, secondary_index_migrations, sha256, valid_uuid,
    ArchiveSnapshot, SECONDARY_INDEX_PREFIXES,
};
use crate::core::error::{err, Result};
use crate::core::format::{
    decode_stored_payload, record_type_name, ArchiveRecord, RecordType, ARCHIVE_HEADER_SIZE,
};
use crate::core::index::{decode_index_page, primary_index_key, read_frame_at, MAX_INDEX_DEPTH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullVerificationResult {
    pub generation: u64,
    pub current_records: usize,
    pub live_records: usize,
    pub deleted_records: usize,
    pub index_entries: usize,
    pub records_checked: usize,
    pub index_pages_checked: usize,
    pub valid: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryVerificationResult {
    pub current: FullVerificationResult,
    pub historical_revisions: usize,
    pub verified_commits: usize,
    pub verified_generation_records: usize,
}

struct VerificationLookup<'a> {
    live: &'a BTreeMap<String, ArchiveRecord>,
    revisions: &'a BTreeMap<String, Vec<ArchiveRecord>>,
    any_live: bool,
}

impl<'a> VerificationLookup<'a> {
    fn get(&self, record_type: u16, id: &str) -> Option<&'a ArchiveRecord> {
        let key = primary_index_key(record_type, id);
        if self.any_live {
            self.revisions
                .get(&key)?
                .iter()
                .find(|record| !record.deleted())
        } else {
            self.live.get(&key)
        }
    }

    fn live(&self, record_type: u16, id: &str) -> Option<&'a ArchiveRecord> {
        self.live.get(&primary_index_key(record_type, id))
    }
}

type SpanMap = BTreeMap<u64, (u64, String)>;

fn add_span(spans: &mut SpanMap, issues: &mut Vec<String>, offset: u64, end: u64, label: String) {
    match spans.get(&offset) {
        None => {
            spans.insert(offset, (end, label));
        }
        Some((existing_end, existing_label)) if *existing_end != end => {
            issues.push(format!(
                "One archive offset resolves to inconsistent frame spans: {existing_label} and {label}."
            ));
        }
        Some(_) => {}
    }
}

/// Full semantic verification covering records, lineage, references, indexes, and framing.
pub fn verify_full(snapshot: &ArchiveSnapshot) -> Result<FullVerificationResult> {
    let base = FullVerificationResult {
        generation: snapshot.commit.generation,
        current_records: 0,
        live_records: 0,
        deleted_records: 0,
        index_entries: snapshot.index_entry_count(),
        records_checked: 0,
        index_pages_checked: 0,
        valid: false,
        issues: Vec::new(),
    };
    if snapshot.locked() {
        return Ok(FullVerificationResult {
            issues: vec!["Unlock the archive before verifying its contents.".to_owned()],
            ..base
        });
    }
    let mut issues: Vec<String> = Vec::new();
    if let Err(error) = snapshot.get_manifest() {
        issues.push(error.message);
        return Ok(FullVerificationResult { issues, ..base });
    }
    if let Err(error) = snapshot.verify_authenticated() {
        issues.push(error.message);
        return Ok(FullVerificationResult { issues, ..base });
    }

    let mut spans: SpanMap = BTreeMap::new();
    let mut index_pages_checked = 0usize;
    let mut commit = snapshot.commit.clone();
    let mut visited_commits: HashSet<u64> = HashSet::new();
    loop {
        if visited_commits.len() >= 1_000_000 || !visited_commits.insert(commit.offset) {
            issues.push(
                "Commit history contains a cycle or exceeds the verification limit.".to_owned(),
            );
            break;
        }
        let decoded =
            match crate::core::archive::decode_commit(snapshot.source.as_ref(), commit.offset) {
                Ok(decoded) => decoded,
                Err(error) => {
                    issues.push(error.message);
                    break;
                }
            };
        match read_frame_at(snapshot.source.as_ref(), commit.offset) {
            Ok(frame) => add_span(
                &mut spans,
                &mut issues,
                commit.offset,
                frame.end_offset,
                format!("commit at {}", commit.offset),
            ),
            Err(error) => issues.push(error.message),
        }
        if decoded != commit {
            issues.push(format!(
                "Commit at offset {} disagrees with the selected chain.",
                commit.offset
            ));
        }
        match read_verified_index_tree(snapshot, &commit) {
            Ok((entries, page_offsets)) => {
                for page_offset in &page_offsets {
                    match read_frame_at(snapshot.source.as_ref(), *page_offset) {
                        Ok(frame) => add_span(
                            &mut spans,
                            &mut issues,
                            *page_offset,
                            frame.end_offset,
                            format!("index page at {page_offset}"),
                        ),
                        Err(error) => issues.push(error.message),
                    }
                }
                if commit.offset == snapshot.commit.offset {
                    index_pages_checked = page_offsets.len();
                    if entries != snapshot.index {
                        issues.push(
                            "Authenticated index does not match the opened archive index."
                                .to_owned(),
                        );
                    }
                }
            }
            Err(error) => issues.push(error.message),
        }
        if commit.previous_offset == 0 {
            if commit.generation != 1 {
                issues.push("Commit chain ends before generation one.".to_owned());
            }
            break;
        }
        match crate::core::archive::decode_commit(snapshot.source.as_ref(), commit.previous_offset)
        {
            Ok(previous) => {
                if previous.generation + 1 != commit.generation {
                    issues.push("Commit generations are not consecutive.".to_owned());
                    break;
                }
                commit = previous;
            }
            Err(error) => {
                issues.push(error.message);
                break;
            }
        }
    }

    let mut current_records: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    let mut revisions_by_key: BTreeMap<String, Vec<ArchiveRecord>> = BTreeMap::new();
    let mut record_by_offset: BTreeMap<u64, ArchiveRecord> = BTreeMap::new();
    let mut latest_offsets: BTreeMap<String, u64> = BTreeMap::new();
    let mut visited_frames: HashSet<u64> = HashSet::new();
    let mut records_checked = 0usize;

    for (key, latest_offset) in snapshot.all_index_entries() {
        if let Some((type_name, id)) = single_colon_key(key) {
            if is_known_type_name(type_name) && !valid_uuid(id) {
                issues.push(format!("Primary record index key '{key}' is invalid."));
                continue;
            }
        }
        let latest_frame = match read_frame_at(snapshot.source.as_ref(), *latest_offset) {
            Ok(frame) => frame,
            Err(error) => {
                issues.push(format!("Index key '{key}': {}", error.message));
                continue;
            }
        };
        if key != &primary_index_key(latest_frame.record_type, &latest_frame.id) {
            continue;
        }
        if current_records.contains_key(key) {
            continue;
        }
        let mut chain: Vec<ArchiveRecord> = Vec::new();
        let mut chain_offsets: Vec<u64> = Vec::new();
        let mut offset = *latest_offset;
        let mut newer_revision: Option<u64> = None;
        while offset != 0 {
            if !visited_frames.insert(offset) {
                issues.push(format!(
                    "Record revision chain for '{key}' contains a cycle or shared frame."
                ));
                break;
            }
            let frame = match read_frame_at(snapshot.source.as_ref(), offset) {
                Ok(frame) => frame,
                Err(error) => {
                    issues.push(format!("Index key '{key}': {}", error.message));
                    break;
                }
            };
            add_span(
                &mut spans,
                &mut issues,
                offset,
                frame.end_offset,
                format!("record at {offset}"),
            );
            if frame.end_offset > snapshot.commit.offset
                || frame.record_type != latest_frame.record_type
                || !frame.id.eq_ignore_ascii_case(&latest_frame.id)
                || newer_revision
                    .map(|revision| frame.revision >= revision || frame.revision + 1 != revision)
                    .unwrap_or(false)
                || (frame.previous_offset != 0 && frame.previous_offset >= offset)
            {
                issues.push(format!(
                    "Record revision lineage is inconsistent for {}.",
                    latest_frame.id
                ));
                break;
            }
            records_checked += 1;
            if record_type_name(frame.record_type) == "unknown" {
                if let Err(error) = snapshot.decode_frame_payload(&frame) {
                    issues.push(format!("Index key '{key}': {}", error.message));
                    break;
                }
            } else {
                match snapshot.decode_frame_record(&frame) {
                    Ok(record) => {
                        chain.push(record.clone());
                        chain_offsets.push(offset);
                        record_by_offset.insert(offset, record);
                    }
                    Err(error) => {
                        issues.push(format!("Index key '{key}': {}", error.message));
                        break;
                    }
                }
            }
            newer_revision = Some(frame.revision);
            offset = frame.previous_offset;
        }
        if chain.is_empty() {
            continue;
        }
        let latest = chain[0].clone();
        current_records.insert(key.clone(), latest);
        revisions_by_key.insert(key.clone(), chain);
        latest_offsets.insert(key.clone(), *latest_offset);
    }

    let mut latest_by_key: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    for (key, records) in &revisions_by_key {
        latest_by_key.insert(key.clone(), records[0].clone());
    }
    let mut live_by_key: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
    for (key, record) in &latest_by_key {
        if !record.deleted() {
            live_by_key.insert(key.clone(), record.clone());
        }
    }
    let live_records = live_by_key.len();
    let deleted_records = latest_by_key
        .values()
        .filter(|record| record.deleted())
        .count();

    check_manifest_counts(snapshot, &live_by_key, &mut issues);

    let live_lookup = VerificationLookup {
        live: &live_by_key,
        revisions: &revisions_by_key,
        any_live: false,
    };
    for record in live_by_key.values() {
        check_live_record_references(record, &live_lookup, &live_by_key, &mut issues);
    }

    let any_live_lookup = VerificationLookup {
        live: &live_by_key,
        revisions: &revisions_by_key,
        any_live: true,
    };
    for records in revisions_by_key.values() {
        let latest_revision = records[0].revision;
        for record in records {
            if record.deleted() || record.revision == latest_revision {
                continue;
            }
            check_historical_references(record, &any_live_lookup, &mut issues);
        }
    }

    for records in revisions_by_key.values() {
        for record in records {
            if record.record_type != RecordType::SETTINGS {
                continue;
            }
            if crate::core::archive::is_credential_settings_record(record) && !snapshot.encrypted()
            {
                issues.push(format!(
                    "Credential record {} is stored in an unencrypted archive.",
                    record.id
                ));
            }
            if crate::core::archive::has_sensitive_credential_material(record)
                && !crate::core::archive::is_credential_settings_record(record)
            {
                issues.push(format!(
                    "Settings record {} contains credential-looking data outside the credential representation.",
                    record.id
                ));
            }
        }
    }

    let version_enabled = |field: &str| -> bool {
        live_by_key
            .get(&primary_index_key(
                RecordType::SETTINGS,
                &snapshot.header.id,
            ))
            .and_then(|manifest| manifest.field(field))
            == Some("1")
    };
    let enabled_prefixes: BTreeSet<&'static str> = secondary_index_migrations()
        .iter()
        .filter(|migration| version_enabled(migration.version_field))
        .map(|migration| migration.prefix)
        .collect();
    let audio_enabled = version_enabled("audio_chunk_index_version")
        || live_by_key.values().any(|record| {
            record.record_type == RecordType::SESSION
                && record.field("audio_chunk_index_version") == Some("1")
        });
    let guide_enabled = version_enabled("guide_source_index_version");

    check_secondary_indexes(
        snapshot,
        &latest_by_key,
        &latest_offsets,
        &record_by_offset,
        &visited_frames,
        &enabled_prefixes,
        audio_enabled,
        guide_enabled,
        &mut spans,
        &mut issues,
    );

    let mut previous_end = 0u64;
    let mut previous_label = String::new();
    for (offset, (end, label)) in &spans {
        if *offset < previous_end {
            issues.push(format!(
                "Physical archive record spans overlap: {previous_label} and {label}."
            ));
        }
        if *end > previous_end {
            previous_end = *end;
            previous_label = label.clone();
        }
    }

    Ok(FullVerificationResult {
        generation: snapshot.commit.generation,
        current_records: current_records.len(),
        live_records,
        deleted_records,
        index_entries: snapshot.index_entry_count(),
        records_checked,
        index_pages_checked,
        valid: issues.is_empty(),
        issues,
    })
}

/// Verify every committed generation and every retained revision.
pub fn verify_history(snapshot: &ArchiveSnapshot) -> Result<HistoryVerificationResult> {
    let current = verify_full(snapshot)?;
    if !current.valid {
        return err(
            "archive_verification_failed",
            &format!("Archive is not fully valid: {}", current.issues.join("; ")),
        );
    }
    let mut visited_frames: HashSet<u64> = HashSet::new();
    let mut historical_revisions = 0usize;
    for (key, latest_offset) in snapshot.all_index_entries() {
        let Some((_, id)) = single_colon_key(key) else {
            continue;
        };
        if !valid_uuid(id) {
            continue;
        }
        let latest = read_frame_at(snapshot.source.as_ref(), *latest_offset)?;
        if key != &primary_index_key(latest.record_type, &latest.id) {
            continue;
        }
        let mut offset = *latest_offset;
        let mut newer: Option<u64> = None;
        while offset != 0 {
            if !visited_frames.insert(offset) {
                return err(
                    "revision_cycle",
                    "Archive revision history contains a cycle or shared record frame.",
                );
            }
            let frame = read_frame_at(snapshot.source.as_ref(), offset)?;
            if frame.end_offset > snapshot.commit.offset
                || frame.record_type != latest.record_type
                || !frame.id.eq_ignore_ascii_case(&latest.id)
                || newer
                    .map(|revision| frame.revision >= revision || frame.revision + 1 != revision)
                    .unwrap_or(false)
                || (frame.previous_offset != 0 && frame.previous_offset >= offset)
            {
                return err(
                    "revision_lineage_invalid",
                    "Archive revision history contains an invalid or out-of-order link.",
                );
            }
            snapshot.verify_revision_frame(&frame)?;
            if newer.is_some() {
                historical_revisions += 1;
            }
            newer = Some(frame.revision);
            offset = frame.previous_offset;
        }
    }

    let mut commit = snapshot.commit.clone();
    let mut verified_commits = 0usize;
    let mut verified_generation_records = 0usize;
    let mut commits: HashSet<u64> = HashSet::new();
    loop {
        if commits.len() >= 1_000_000 || !commits.insert(commit.offset) {
            return err(
                "archive_commit_chain_invalid",
                "Archive commit history contains a cycle or exceeds the verification limit.",
            );
        }
        let consistent = crate::core::archive::find_consistent_commit(
            snapshot.source.as_ref(),
            &snapshot.header,
            commit.clone(),
        )?
        .filter(|(candidate, _)| candidate.offset == commit.offset);
        let Some((candidate, index_entries)) = consistent else {
            return err(
                "archive_commit_chain_invalid",
                "A historical commit or index tree is invalid.",
            );
        };
        let view =
            snapshot.open_generation(candidate.clone(), index_entries, snapshot.source.size());
        view.get_manifest()?;
        let verified = verify_full(&view)?;
        if !verified.valid {
            return err(
                "archive_commit_chain_invalid",
                &format!(
                    "Generation {} is not fully valid: {}",
                    candidate.generation,
                    verified.issues.join("; ")
                ),
            );
        }
        verified_generation_records += verified.current_records;
        verified_commits += 1;
        if candidate.previous_offset == 0 {
            if candidate.generation != 1 {
                return err(
                    "archive_commit_chain_invalid",
                    "The initial commit generation is invalid.",
                );
            }
            break;
        }
        if candidate.previous_offset >= candidate.offset {
            return err(
                "archive_commit_chain_invalid",
                "A commit points forward in the archive.",
            );
        }
        let previous = crate::core::archive::decode_commit(
            snapshot.source.as_ref(),
            candidate.previous_offset,
        )?;
        if previous.generation + 1 != candidate.generation {
            return err(
                "archive_commit_chain_invalid",
                "Archive commit generations are not consecutive.",
            );
        }
        commit = previous;
    }

    Ok(HistoryVerificationResult {
        current,
        historical_revisions,
        verified_commits,
        verified_generation_records,
    })
}

#[allow(clippy::too_many_arguments)]
fn check_secondary_indexes(
    snapshot: &ArchiveSnapshot,
    latest_by_key: &BTreeMap<String, ArchiveRecord>,
    latest_offsets: &BTreeMap<String, u64>,
    record_by_offset: &BTreeMap<u64, ArchiveRecord>,
    visited_frames: &HashSet<u64>,
    enabled_prefixes: &BTreeSet<&'static str>,
    audio_enabled: bool,
    guide_enabled: bool,
    spans: &mut SpanMap,
    issues: &mut Vec<String>,
) {
    let migrations = secondary_index_migrations();
    for (key, offset) in snapshot.all_index_entries() {
        let prefix = SECONDARY_INDEX_PREFIXES
            .iter()
            .find(|prefix| key.starts_with(**prefix))
            .copied();
        let Some(prefix) = prefix else {
            if let Ok(frame) = read_frame_at(snapshot.source.as_ref(), *offset) {
                add_span(
                    spans,
                    issues,
                    *offset,
                    frame.end_offset,
                    format!("indexed record at {offset}"),
                );
            }
            continue;
        };
        if !visited_frames.contains(offset) {
            issues.push(format!(
                "Secondary index key '{key}' references a record outside its primary revision chain."
            ));
        }
        let record = match record_by_offset.get(offset) {
            Some(record) => Some(record.clone()),
            None => match read_frame_at(snapshot.source.as_ref(), *offset) {
                Ok(frame) => {
                    if record_type_name(frame.record_type) == "unknown" {
                        None
                    } else {
                        match snapshot.decode_frame_record(&frame) {
                            Ok(record) => Some(record),
                            Err(error) => {
                                issues.push(format!(
                                    "Secondary index key '{key}': {}",
                                    error.message
                                ));
                                continue;
                            }
                        }
                    }
                }
                Err(error) => {
                    issues.push(format!("Secondary index key '{key}': {}", error.message));
                    continue;
                }
            },
        };
        let Some(record) = record else {
            issues.push(format!(
                "Secondary index key '{key}' points to an opaque record."
            ));
            continue;
        };
        let primary_offset = snapshot
            .all_index_entries()
            .get(&primary_index_key(record.record_type, &record.id))
            .copied();
        let primary_matches = primary_offset == Some(*offset);
        let expected = match secondary_index_keys(&record) {
            Ok(keys) => keys.iter().any(|candidate| candidate == key),
            Err(error) => {
                issues.push(format!("Secondary index key '{key}': {}", error.message));
                continue;
            }
        };
        let migration = migrations
            .iter()
            .find(|migration| migration.prefix == prefix);
        if prefix == "AUDIOSESSION:" {
            if !audio_enabled {
                issues.push(format!(
                    "Audio session index '{key}' is not enabled by its manifest."
                ));
            }
            if expected
                && (!primary_matches || audio_session_index_key(&record).ok().flatten().is_none())
            {
                issues.push("Audio session index key does not match its record.".to_owned());
            }
        } else if prefix == "GUIDESOURCE:" {
            if !guide_enabled {
                issues.push(format!(
                    "Guide source index '{key}' is not enabled by its manifest."
                ));
            }
            if expected && !primary_matches {
                issues.push(
                    "Guide source index does not reference the current guide revision.".to_owned(),
                );
            }
        } else if let Some(migration) = migration {
            if !enabled_prefixes.contains(migration.prefix) {
                issues.push(format!(
                    "Secondary index '{key}' is not enabled by its manifest."
                ));
            }
            if expected && !primary_matches {
                issues.push(format!(
                    "Secondary index key '{key}' does not reference the current record revision."
                ));
            }
        }
        if !expected && prefix != "BLOB:" {
            issues.push(format!(
                "Secondary index key '{key}' does not match its record."
            ));
        }
    }

    for (key, record) in latest_by_key {
        let Some(offset) = latest_offsets.get(key).copied() else {
            continue;
        };
        let expected_keys = match secondary_index_keys(record) {
            Ok(keys) => keys,
            Err(error) => {
                issues.push(format!("Record {}: {}", record.id, error.message));
                continue;
            }
        };
        for secondary_key in expected_keys {
            let Some(prefix) = SECONDARY_INDEX_PREFIXES
                .iter()
                .find(|prefix| secondary_key.starts_with(**prefix))
                .copied()
            else {
                continue;
            };
            let migration = migrations
                .iter()
                .find(|migration| migration.prefix == prefix);
            let required = if prefix == "AUDIOSESSION:" {
                audio_enabled
            } else if prefix == "GUIDESOURCE:" {
                guide_enabled
            } else {
                migration
                    .map(|migration| enabled_prefixes.contains(migration.prefix))
                    .unwrap_or(false)
            };
            if !required {
                continue;
            }
            if snapshot.all_index_entries().get(&secondary_key) != Some(&offset) {
                issues.push(format!(
                    "Secondary index '{secondary_key}' is missing its current record mapping."
                ));
            }
        }
    }
}

fn check_live_record_references(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    live_by_key: &BTreeMap<String, ArchiveRecord>,
    issues: &mut Vec<String>,
) {
    if record.record_type == RecordType::SESSION {
        let student_id = record.field("student_id").unwrap_or("").to_lowercase();
        if !student_id.is_empty()
            && student_id != "anonymous"
            && (!valid_uuid(&student_id) || lookup.live(RecordType::STUDENT, &student_id).is_none())
        {
            issues.push(format!(
                "Session {} references a missing student.",
                record.id
            ));
        }
    } else if is_session_manifest_type(record.record_type) {
        check_session_reference(record, lookup, false, issues);
    }
    if record.record_type == RecordType::ASSET_BLOB
        && record.field("record_role") == Some("asset-blob-manifest")
    {
        let content = collect_asset_content(record, lookup);
        match content.issue {
            Some(issue) => issues.push(format!("Asset blob manifest {}: {issue}", record.id)),
            None => {
                if (record.field("content_hash").is_some() || record.field("byte_size").is_some())
                    && !asset_fields_match(record, &content.bytes)
                {
                    issues.push(format!(
                        "Asset blob manifest {} content does not match its hash.",
                        record.id
                    ));
                }
            }
        }
    }
    if record.record_type == RecordType::ASSET_METADATA {
        let role = record.field("record_role").unwrap_or("");
        if role != "audio-track" && role != "recording-take" {
            let blob_id = record.field("blob_id").unwrap_or("").to_lowercase();
            let blob = if valid_uuid(&blob_id) {
                lookup.live(RecordType::ASSET_BLOB, &blob_id)
            } else {
                None
            };
            let Some(blob) = blob else {
                issues.push(format!("Asset {} references a missing blob.", record.id));
                return;
            };
            let content = collect_asset_content(blob, lookup);
            match content.issue {
                Some(issue) => issues.push(format!("Asset {}: {issue}", record.id)),
                None => {
                    if !asset_fields_match(record, &content.bytes) {
                        issues.push(format!(
                            "Asset {} content is missing or does not match its hash.",
                            record.id
                        ));
                    }
                }
            }
        }
    }
    if record.record_type == RecordType::EVIDENCE_EDGE {
        for field in ["from_id", "to_id"] {
            let id = record.field(field).unwrap_or("").to_lowercase();
            if !valid_uuid(&id) || lookup.live(RecordType::EVIDENCE_NODE, &id).is_none() {
                issues.push(format!(
                    "Evidence edge {} references a missing node.",
                    record.id
                ));
            }
        }
    }
    if record.record_type == RecordType::GUIDE {
        for issue in validate_guide_semantics(record, lookup, live_by_key, true) {
            issues.push(format!("Guide {}: {issue}", record.id));
        }
    }
}

fn check_historical_references(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    issues: &mut Vec<String>,
) {
    if record.record_type == RecordType::SESSION {
        let student_id = record.field("student_id").unwrap_or("").to_lowercase();
        if !student_id.is_empty()
            && student_id != "anonymous"
            && (!valid_uuid(&student_id) || lookup.get(RecordType::STUDENT, &student_id).is_none())
        {
            issues.push(format!(
                "Historical revision {} references a missing student.",
                record.id
            ));
        }
    } else if is_session_manifest_type(record.record_type) {
        check_session_reference(record, lookup, true, issues);
    }
    if record.record_type == RecordType::ASSET_METADATA {
        let blob_id = record.field("blob_id").unwrap_or("").to_lowercase();
        if !valid_uuid(&blob_id) || lookup.get(RecordType::ASSET_BLOB, &blob_id).is_none() {
            issues.push(format!(
                "Historical revision {} references a missing asset blob.",
                record.id
            ));
        }
    }
    if record.record_type == RecordType::ASSET_BLOB
        && record.field("record_role") == Some("asset-blob-manifest")
    {
        let content = collect_asset_content(record, lookup);
        if let Some(issue) = content.issue {
            issues.push(format!(
                "Historical asset blob manifest {}: {issue}",
                record.id
            ));
        }
    }
    if record.record_type == RecordType::EVIDENCE_EDGE {
        for field in ["from_id", "to_id"] {
            let id = record.field(field).unwrap_or("").to_lowercase();
            if !valid_uuid(&id) || lookup.get(RecordType::EVIDENCE_NODE, &id).is_none() {
                issues.push(format!(
                    "Historical revision {} references a missing evidence node.",
                    record.id
                ));
            }
        }
    }
    if record.record_type == RecordType::GUIDE {
        let empty_live: BTreeMap<String, ArchiveRecord> = BTreeMap::new();
        for issue in validate_guide_semantics(record, lookup, &empty_live, false) {
            issues.push(format!("Historical revision {}: {issue}", record.id));
        }
    }
}

fn check_session_reference(
    record: &ArchiveRecord,
    lookup: &VerificationLookup<'_>,
    historical: bool,
    issues: &mut Vec<String>,
) {
    let session_id = record.field("session_id").unwrap_or("");
    if session_id.is_empty() {
        return;
    }
    let normalized = session_id.to_lowercase();
    if !valid_uuid(&normalized) {
        issues.push(format!("Invalid session reference in {}.", record.id));
        return;
    }
    let found = if historical {
        lookup.get(RecordType::SESSION, &normalized).is_some()
    } else {
        lookup.live(RecordType::SESSION, &normalized).is_some()
    };
    if !found {
        issues.push(format!(
            "{} {} references a missing session {}.",
            if historical {
                "Historical revision"
            } else {
                "Record"
            },
            record.id,
            session_id
        ));
    }
}

fn is_session_manifest_type(record_type: u16) -> bool {
    matches!(
        record_type,
        RecordType::TRANSCRIPT_SEGMENT
            | RecordType::ANNOTATION
            | RecordType::AUDIO_CHUNK
            | RecordType::ASSET_METADATA
            | RecordType::EVIDENCE_NODE
            | RecordType::GUIDE
    )
}

struct AssetContent {
    bytes: Vec<u8>,
    issue: Option<String>,
}

fn collect_asset_content(blob: &ArchiveRecord, lookup: &VerificationLookup<'_>) -> AssetContent {
    if blob.field("record_role") != Some("asset-blob-manifest") {
        return AssetContent {
            bytes: blob.blob.clone(),
            issue: None,
        };
    }
    let chunk_count = blob.field("chunk_count").unwrap_or("");
    let chunk_ids = blob.field("chunk_ids").unwrap_or("");
    if !is_digits(chunk_count) {
        return AssetContent {
            bytes: Vec::new(),
            issue: Some("manifest chunk count is invalid.".to_owned()),
        };
    }
    let expected = chunk_count.parse::<u64>().unwrap_or(u64::MAX);
    let mut parts: Vec<u8> = Vec::new();
    let mut index: u64 = 0;
    if !chunk_ids.is_empty() {
        for raw_id in chunk_ids.split(',') {
            let id = raw_id.trim().to_lowercase();
            if !valid_uuid(&id) {
                return AssetContent {
                    bytes: Vec::new(),
                    issue: Some("manifest contains an invalid chunk identifier.".to_owned()),
                };
            }
            let chunk = lookup.get(RecordType::ASSET_BLOB, &id);
            let consistent = chunk
                .map(|chunk| {
                    chunk.field("record_role") == Some("asset-blob-chunk")
                        && chunk.field("manifest_id").map(str::to_lowercase).as_deref()
                            == Some(&blob.id.to_lowercase())
                        && chunk
                            .field("chunk_index")
                            .map(|value| value == index.to_string())
                            .unwrap_or(false)
                })
                .unwrap_or(false);
            if !consistent {
                return AssetContent {
                    bytes: Vec::new(),
                    issue: Some("manifest references missing or inconsistent chunks.".to_owned()),
                };
            }
            parts.extend_from_slice(&chunk.unwrap().blob);
            index += 1;
        }
    }
    if index != expected {
        return AssetContent {
            bytes: Vec::new(),
            issue: Some("manifest chunk count is inconsistent.".to_owned()),
        };
    }
    AssetContent {
        bytes: parts,
        issue: None,
    }
}

fn asset_fields_match(record: &ArchiveRecord, bytes: &[u8]) -> bool {
    let expected_bytes = record.field("byte_size").unwrap_or("");
    let expected_hash = record.field("content_hash").unwrap_or("").to_lowercase();
    is_digits(expected_bytes)
        && expected_bytes.parse::<u64>().ok() == Some(bytes.len() as u64)
        && is_sha256_hex(&expected_hash)
        && hex_encode(&sha256(bytes)) == expected_hash
}

fn validate_guide_semantics(
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

fn parse_inline_sources(text: &str) -> (Vec<String>, bool) {
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

fn parse_asset_image_reference(text: &str) -> Option<String> {
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

fn check_manifest_counts(
    snapshot: &ArchiveSnapshot,
    live_by_key: &BTreeMap<String, ArchiveRecord>,
    issues: &mut Vec<String>,
) {
    let Some(manifest) = live_by_key.get(&primary_index_key(
        RecordType::SETTINGS,
        &snapshot.header.id,
    )) else {
        return;
    };
    let live_students = live_by_key
        .values()
        .filter(|record| record.record_type == RecordType::STUDENT)
        .count();
    let live_sessions = live_by_key
        .values()
        .filter(|record| record.record_type == RecordType::SESSION)
        .count();
    for (field, actual) in [
        ("student_count", live_students),
        ("session_count", live_sessions),
    ] {
        let Some(raw) = manifest.field(field) else {
            continue;
        };
        if !is_digits(raw) || raw.parse::<u64>().ok() != Some(actual as u64) {
            issues.push(format!(
                "Archive manifest {field} does not match the live record count."
            ));
        }
    }
}

fn read_verified_index_tree(
    snapshot: &ArchiveSnapshot,
    commit: &crate::core::archive::CommitInfo,
) -> Result<(BTreeMap<String, u64>, Vec<u64>)> {
    let root_frame = read_frame_at(snapshot.source.as_ref(), commit.root_offset)?;
    if root_frame.record_type != RecordType::INDEX_PAGE
        || sha256(&root_frame.stored_payload) != commit.root_hash
    {
        return err(
            "archive_commit_root_invalid",
            "Commit root hash does not match its index page.",
        );
    }
    let mut entries: BTreeMap<String, u64> = BTreeMap::new();
    let mut page_offsets = Vec::new();
    let mut visited: HashSet<u64> = HashSet::new();
    visit_index_page(
        snapshot,
        commit,
        commit.root_offset,
        0,
        true,
        &mut entries,
        &mut page_offsets,
        &mut visited,
    )?;
    Ok((entries, page_offsets))
}

#[allow(clippy::too_many_arguments)]
fn visit_index_page(
    snapshot: &ArchiveSnapshot,
    commit: &crate::core::archive::CommitInfo,
    offset: u64,
    depth: usize,
    is_root: bool,
    entries: &mut BTreeMap<String, u64>,
    page_offsets: &mut Vec<u64>,
    visited: &mut HashSet<u64>,
) -> Result<(Option<String>, Option<String>)> {
    if depth > MAX_INDEX_DEPTH || !visited.insert(offset) {
        return err(
            "index_cycle",
            "B+ tree contains a cycle or excessive depth.",
        );
    }
    if offset >= commit.offset {
        return err(
            "index_page_invalid",
            "Index page is outside the committed archive region.",
        );
    }
    let frame = read_frame_at(snapshot.source.as_ref(), offset)?;
    if frame.record_type != RecordType::INDEX_PAGE {
        return err(
            "index_page_invalid",
            "Index page points to a non-index record.",
        );
    }
    let mut payload = decode_stored_payload(frame.codec, frame.flags, &frame.stored_payload)?;
    if snapshot.encrypted() {
        if payload.len() < 32 {
            return err(
                "archive_index_authentication_failed",
                "Encrypted index page is truncated.",
            );
        }
        let authenticated_length = payload.len() - 32;
        if let Some(key) = snapshot.data_key() {
            if !key.authentication_matches(
                "TUTORUX-INDEX-PAGE-V1",
                &payload[..authenticated_length],
                &payload[authenticated_length..],
            ) {
                return err(
                    "archive_index_authentication_failed",
                    "Encrypted archive index authentication failed.",
                );
            }
        }
        payload.truncate(authenticated_length);
    }
    page_offsets.push(offset);
    let page = decode_index_page(&payload)?;
    if page.leaf {
        if !is_root && page.entries.is_empty() {
            return err(
                "index_page_invalid",
                "A non-root leaf index page cannot be empty.",
            );
        }
        let first = page.entries.first().map(|(key, _)| key.clone());
        let last = page.entries.last().map(|(key, _)| key.clone());
        for (entry_key, value_offset) in page.entries {
            if value_offset < ARCHIVE_HEADER_SIZE
                || value_offset >= commit.offset
                || value_offset % 8 != 0
            {
                return err("index_page_invalid", "Leaf record offset is invalid.");
            }
            if entries.insert(entry_key, value_offset).is_some() {
                return err("index_page_order", "Index keys are not globally unique.");
            }
        }
        return Ok((first, last));
    }
    if page.children.len() != page.separators.len() + 1 || page.separators.is_empty() {
        return err(
            "index_page_invalid",
            "Internal index page has invalid children.",
        );
    }
    let mut first: Option<String> = None;
    let mut previous_last: Option<String> = None;
    for (index, child_offset) in page.children.iter().enumerate() {
        let child_frame = read_frame_at(snapshot.source.as_ref(), *child_offset)?;
        if child_frame.record_type != RecordType::INDEX_PAGE {
            return err(
                "index_page_invalid",
                "Internal page points to a non-index record.",
            );
        }
        let (child_first, child_last) = visit_index_page(
            snapshot,
            commit,
            *child_offset,
            depth + 1,
            false,
            entries,
            page_offsets,
            visited,
        )?;
        if index == 0 {
            first = child_first.clone();
        }
        if index > 0 {
            let separator = &page.separators[index - 1];
            if child_first.as_deref() != Some(separator.as_str())
                || previous_last
                    .as_ref()
                    .map(|previous| previous.as_str() >= separator.as_str())
                    .unwrap_or(true)
            {
                return err(
                    "index_page_order",
                    "Internal separators do not match child key ranges.",
                );
            }
        }
        if child_last.is_some() {
            previous_last = child_last;
        }
    }
    Ok((first, previous_last))
}

fn is_known_type_name(name: &str) -> bool {
    if name == "UNKNOWN" || name == "INDEX" || name == "COMMIT" {
        return true;
    }
    (1..=14u16).any(|record_type| record_type_name(record_type).to_uppercase() == name)
}

fn single_colon_key(key: &str) -> Option<(&str, &str)> {
    let mut parts = key.split(':');
    let name = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some() || name.is_empty() || id.is_empty() {
        return None;
    }
    Some((name, id))
}

fn is_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::{
        create_archive_bytes, create_encrypted_archive_bytes, new_uuid, sha256, ArchiveSnapshot,
    };
    use crate::core::format::ArchiveRecord;

    macro_rules! fields {
        ($($key:expr => $value:expr),* $(,)?) => {
            vec![$(($key.to_string(), $value.to_string())),*]
        };
    }

    fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
        ArchiveRecord::new(record_type, id, fields)
    }

    fn all_domain_records() -> Vec<ArchiveRecord> {
        let student = new_uuid();
        let session = new_uuid();
        let track = new_uuid();
        let chunk = new_uuid();
        let transcript = new_uuid();
        let annotation = new_uuid();
        let asset_blob = new_uuid();
        let asset = new_uuid();
        let evidence_node = new_uuid();
        let evidence_edge = new_uuid();
        let guide = new_uuid();
        let job = new_uuid();
        let waveform = new_uuid();
        let content = [1u8, 2, 3, 4, 5];
        let content_hash = hex_encode(&sha256(&content));
        vec![
            record(
                RecordType::STUDENT,
                &student,
                fields! {"display_name" => "Mina"},
            ),
            record(
                RecordType::SESSION,
                &session,
                fields! {"student_id" => student, "title" => "Algebra"},
            ),
            record(
                RecordType::AUDIO_CHUNK,
                &chunk,
                fields! {
                    "session_id" => session,
                    "track_id" => track,
                    "sequence_number" => "0",
                    "codec" => "none"
                },
            ),
            record(
                RecordType::TRANSCRIPT_SEGMENT,
                &transcript,
                fields! {
                    "session_id" => session,
                    "start_time_us" => "0",
                    "end_time_us" => "1000",
                    "text" => "Hello"
                },
            ),
            record(
                RecordType::ANNOTATION,
                &annotation,
                fields! {"session_id" => session, "start_time_us" => "10", "text" => "Note"},
            ),
            ArchiveRecord {
                record_type: RecordType::ASSET_BLOB,
                id: asset_blob.clone(),
                revision: 0,
                previous_offset: 0,
                fields: BTreeMap::new(),
                blob: content.to_vec(),
            },
            record(
                RecordType::ASSET_METADATA,
                &asset,
                fields! {
                    "session_id" => session,
                    "record_role" => "material",
                    "blob_id" => asset_blob,
                    "byte_size" => content.len(),
                    "content_hash" => content_hash
                },
            ),
            record(
                RecordType::EVIDENCE_NODE,
                &evidence_node,
                fields! {"session_id" => session, "kind" => "observation"},
            ),
            record(
                RecordType::EVIDENCE_EDGE,
                &evidence_edge,
                fields! {"from_id" => evidence_node, "to_id" => evidence_node},
            ),
            record(
                RecordType::GUIDE,
                &guide,
                fields! {
                    "title" => "Guide",
                    "session_id" => session,
                    "section_count" => "1",
                    "section.0.heading" => "Evidence",
                    "section.0.block_count" => "1",
                    "section.0.block.0.kind" => "paragraph",
                    "section.0.block.0.text" => "Mina used a number line.",
                    "section.0.block.0.source_ids" => session
                },
            ),
            record(
                RecordType::AI_JOB,
                &job,
                fields! {"session_id" => session, "status" => "complete"},
            ),
            record(
                RecordType::WAVEFORM_INDEX,
                &waveform,
                fields! {"session_id" => session, "track_id" => track},
            ),
        ]
    }

    #[test]
    fn full_verification_accepts_every_domain_type() {
        let archive =
            ArchiveSnapshot::open_bytes(create_archive_bytes("All types", "", 1).unwrap()).unwrap();
        let archive = archive.append_records(&all_domain_records()).unwrap();
        let report = verify_full(&archive).unwrap();
        assert!(report.valid, "{:?}", report.issues);
        assert_eq!(report.generation, 2);
        assert_eq!(report.live_records, 13);
        let history = verify_history(&archive).unwrap();
        assert_eq!(history.verified_commits, 2);
        assert_eq!(history.historical_revisions, 1);
    }

    #[test]
    fn full_verification_reports_dangling_references() {
        let archive =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Dangling", "", 1).unwrap()).unwrap();
        let student = new_uuid();
        let missing_from = new_uuid();
        let missing_to = new_uuid();
        let missing_blob = new_uuid();
        let archive = archive
            .append_records(&[
                record(
                    RecordType::SESSION,
                    &new_uuid(),
                    fields! {"student_id" => student, "title" => "Missing student"},
                ),
                record(
                    RecordType::EVIDENCE_EDGE,
                    &new_uuid(),
                    fields! {"from_id" => missing_from, "to_id" => missing_to},
                ),
                record(
                    RecordType::ASSET_METADATA,
                    &new_uuid(),
                    fields! {
                        "record_role" => "material",
                        "blob_id" => missing_blob,
                        "byte_size" => "0",
                        "content_hash" => "0".repeat(64)
                    },
                ),
            ])
            .unwrap();
        let report = verify_full(&archive).unwrap();
        assert!(!report.valid);
        let joined = report.issues.join("\n");
        assert!(joined.contains("missing student"), "{joined}");
        assert!(joined.contains("missing node"), "{joined}");
        assert!(joined.contains("missing blob"), "{joined}");
        assert!(report.records_checked > 0);
        assert!(report.index_pages_checked > 0);
    }

    #[test]
    fn full_verification_checks_asset_manifest_content() {
        let archive =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Assets", "", 1).unwrap()).unwrap();
        let manifest_id = new_uuid();
        let chunk_one = new_uuid();
        let chunk_two = new_uuid();
        let metadata = new_uuid();
        let content = [9u8, 8, 7, 6];
        let digest = hex_encode(&sha256(&content));
        let archive = archive
            .append_records(&[
                ArchiveRecord {
                    record_type: RecordType::ASSET_BLOB,
                    id: chunk_one.clone(),
                    revision: 0,
                    previous_offset: 0,
                    fields: fields! {
                        "record_role" => "asset-blob-chunk",
                        "manifest_id" => manifest_id,
                        "chunk_index" => "0"
                    }
                    .into_iter()
                    .collect(),
                    blob: content[..2].to_vec(),
                },
                ArchiveRecord {
                    record_type: RecordType::ASSET_BLOB,
                    id: chunk_two.clone(),
                    revision: 0,
                    previous_offset: 0,
                    fields: fields! {
                        "record_role" => "asset-blob-chunk",
                        "manifest_id" => manifest_id,
                        "chunk_index" => "1"
                    }
                    .into_iter()
                    .collect(),
                    blob: content[2..].to_vec(),
                },
                record(
                    RecordType::ASSET_BLOB,
                    &manifest_id,
                    fields! {
                        "record_role" => "asset-blob-manifest",
                        "chunk_count" => "2",
                        "chunk_ids" => format!("{chunk_one},{chunk_two}")
                    },
                ),
                record(
                    RecordType::ASSET_METADATA,
                    &metadata,
                    fields! {
                        "record_role" => "material",
                        "blob_id" => manifest_id,
                        "byte_size" => content.len(),
                        "content_hash" => digest
                    },
                ),
            ])
            .unwrap();
        let report = verify_full(&archive).unwrap();
        assert!(report.valid, "{:?}", report.issues);

        let tampered = archive
            .append_records(&[record(
                RecordType::ASSET_METADATA,
                &metadata,
                fields! {
                    "record_role" => "material",
                    "blob_id" => manifest_id,
                    "byte_size" => content.len(),
                    "content_hash" => "0".repeat(64)
                },
            )])
            .unwrap();
        let report = verify_full(&tampered).unwrap();
        assert!(!report.valid);
        assert!(report.issues.join("\n").contains("does not match its hash"));
    }

    #[test]
    fn full_verification_reports_locked_archives() {
        let locked = ArchiveSnapshot::open_bytes(
            create_encrypted_archive_bytes("Locked", "", "correct horse battery staple", 1)
                .unwrap(),
        )
        .unwrap();
        let report = verify_full(&locked).unwrap();
        assert!(!report.valid);
        assert!(report.issues[0].contains("Unlock"));
    }

    #[test]
    fn verifies_typescript_fixture_fully() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("encrypted-v1.tux");
        let bytes = std::fs::read(path).expect("fixture exists");
        let locked = ArchiveSnapshot::open_bytes(bytes).expect("fixture opens");
        let unlocked = locked
            .unlock("Tutorux cross-language fixture phrase 2026")
            .expect("fixture unlocks");
        let report = verify_full(&unlocked).unwrap();
        assert!(report.valid, "{:?}", report.issues);
    }
}
