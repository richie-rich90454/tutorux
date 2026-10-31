use super::*;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

pub(crate) fn evidence_sources_are_current(
    snapshot: &ArchiveSnapshot,
    record: &ArchiveRecord,
) -> CliResult<bool> {
    let session_id = record.field("session_id").unwrap_or("");
    let mut has_sources = false;
    let mut validate = |record_type: u16, ids: &[String], revisions: &BTreeMap<String, i64>| -> CliResult<bool> {
        for id in ids {
            has_sources = true;
            let Some(source) = snapshot.get_record(record_type, id)? else {
                return Ok(false);
            };
            if source.deleted() {
                return Ok(false);
            }
            let source_session = source.field("session_id").unwrap_or("");
            if !source_session.is_empty() && source_session != session_id {
                return Ok(false);
            }
            if let Some(expected) = revisions.get(&id.to_lowercase()) {
                if source.revision != *expected as u64 {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    };
    let annotation_id = record.field("source_annotation_id").unwrap_or("");
    if !annotation_id.is_empty() {
        let mut revisions = BTreeMap::new();
        if let Some(raw) = record.field("source_annotation_revision").filter(|value| !value.is_empty()) {
            let Ok(revision) = raw.parse::<i64>() else { return Ok(false) };
            if revision <= 0 {
                return Ok(false);
            }
            revisions.insert(annotation_id.to_lowercase(), revision);
        }
        if !validate(RecordType::ANNOTATION, &[annotation_id.to_owned()], &revisions)? {
            return Ok(false);
        }
    }
    let segment_ids = split_ids(record.field("source_segment_ids").unwrap_or(""));
    let mut segment_revisions = BTreeMap::new();
    for entry in split_ids(record.field("source_segment_revisions").unwrap_or("")) {
        let Some((id, raw)) = entry.split_once('=') else { return Ok(false) };
        let Ok(revision) = raw.parse::<i64>() else { return Ok(false) };
        if revision <= 0 {
            return Ok(false);
        }
        segment_revisions.insert(id.to_lowercase(), revision);
    }
    if !validate(RecordType::TRANSCRIPT_SEGMENT, &segment_ids, &segment_revisions)? {
        return Ok(false);
    }
    let asset_ids = split_ids(record.field("source_asset_ids").unwrap_or(""));
    if !validate(RecordType::ASSET_METADATA, &asset_ids, &BTreeMap::new())? {
        return Ok(false);
    }
    Ok(has_sources)
}

pub(crate) const EVIDENCE_RELATIONSHIPS: [&str; 15] = [
    "explains",
    "corrects",
    "demonstrates",
    "supports",
    "contradicts",
    "elaborates",
    "causes",
    "precedes",
    "exemplifies",
    "assesses",
    "references",
    "depends-on",
    "reinforces",
    "recommends",
    "derived-from",
];

