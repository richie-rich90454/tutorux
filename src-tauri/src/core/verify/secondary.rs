use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::core::archive::{
    audio_session_index_key, secondary_index_keys, secondary_index_migrations, ArchiveRecord,
    ArchiveSnapshot, SECONDARY_INDEX_PREFIXES,
};
use crate::core::format::record_type_name;
use crate::core::index::{primary_index_key, read_frame_at};

use super::{add_span, SpanMap};

#[allow(clippy::too_many_arguments)]
pub(crate) fn check_secondary_indexes(
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
