use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::core::archive::{decode_commit, ArchiveRecord, ArchiveSnapshot, RecordType};
use crate::core::format::{record_type_name, ARCHIVE_HEADER_SIZE};
use crate::core::index::{primary_index_key, read_frame_at};

use super::helpers::{is_known_type_name, single_colon_key};
use super::references::{
    check_historical_references, check_live_record_references, check_manifest_counts,
};
use super::secondary::check_secondary_indexes;
use super::tree::read_verified_index_tree;
use super::{add_span, FullVerificationResult, SpanMap, VerificationLookup};

pub fn verify_full(
    snapshot: &ArchiveSnapshot,
) -> crate::core::error::Result<FullVerificationResult> {
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
        let decoded = match decode_commit(snapshot.source.as_ref(), commit.offset) {
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
        match decode_commit(snapshot.source.as_ref(), commit.previous_offset) {
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
            if is_known_type_name(type_name) && !crate::core::archive::valid_uuid(id) {
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
    let enabled_prefixes: BTreeSet<&'static str> =
        crate::core::archive::secondary_index_migrations()
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

    let _ = ARCHIVE_HEADER_SIZE;
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
