use super::*;

pub(crate) struct SessionTrashPlan {
    pub(crate) changes: Vec<ArchiveRecord>,
    pub(crate) scope_records: Vec<ArchiveRecord>,
    pub(crate) audio_chunks: Vec<ArchiveRecord>,
    pub(crate) audio_chunk_count: usize,
    pub(crate) waveform_indices: usize,
    pub(crate) session_notes: usize,
    pub(crate) transcript_segments: usize,
    pub(crate) annotations: usize,
    pub(crate) guides: usize,
    pub(crate) assets: usize,
    pub(crate) entries_updated: usize,
    pub(crate) evidence_nodes: usize,
    pub(crate) evidence_edges: usize,
    pub(crate) total_records: usize,
}

pub(crate) fn plan_session_trash(
    snapshot: &ArchiveSnapshot,
    session: &ArchiveRecord,
) -> Result<SessionTrashPlan> {
    let session_id = session.id.to_lowercase();
    let timestamp = now_us().to_string();
    let audio_chunks = session_audio_chunks(snapshot, session, false)?;
    let mut deletion = Vec::new();
    let mut guides = Vec::new();
    let mut assets = Vec::new();
    let mut evidence_nodes = Vec::new();
    let mut session_notes = Vec::new();
    let mut transcript_segments = 0usize;
    let mut annotations = 0usize;
    let mut waveform_indices = 0usize;
    let mut asset_count = 0usize;
    for record_type in [
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
        RecordType::GUIDE,
        RecordType::WAVEFORM_INDEX,
    ] {
        for record in snapshot.list_records(record_type, false)? {
            if record.field("session_id").map(str::to_lowercase).as_deref()
                != Some(session_id.as_str())
            {
                continue;
            }
            let trashed = mark_session_trashed(&record, &session_id, &timestamp);
            match record_type {
                RecordType::GUIDE => guides.push(trashed),
                RecordType::ASSET_METADATA => {
                    asset_count += 1;
                    assets.push(trashed);
                }
                RecordType::EVIDENCE_NODE => evidence_nodes.push(trashed),
                RecordType::TRANSCRIPT_SEGMENT => {
                    transcript_segments += 1;
                    deletion.push(trashed);
                }
                RecordType::ANNOTATION => {
                    annotations += 1;
                    deletion.push(trashed);
                }
                RecordType::WAVEFORM_INDEX => {
                    waveform_indices += 1;
                    deletion.push(trashed);
                }
                _ => deletion.push(trashed),
            }
        }
    }
    for record in snapshot.list_records(RecordType::SETTINGS, false)? {
        if record.field("record_role") == Some("journal-notes")
            && record.field("session_id").map(str::to_lowercase).as_deref()
                == Some(session_id.as_str())
        {
            session_notes.push(mark_session_trashed(&record, &session_id, &timestamp));
        }
    }
    let mut removed_ids: BTreeSet<String> = BTreeSet::new();
    removed_ids.insert(session_id.clone());
    for record in deletion
        .iter()
        .chain(guides.iter())
        .chain(assets.iter())
        .chain(evidence_nodes.iter())
        .chain(session_notes.iter())
        .chain(audio_chunks.iter())
    {
        removed_ids.insert(record.id.to_lowercase());
    }
    let mut evidence_edges = 0usize;
    for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, false)? {
        if edge.field("session_id").map(str::to_lowercase).as_deref()
            == Some(session_id.as_str())
            || removed_ids.contains(&edge.field("from_id").unwrap_or("").to_lowercase())
            || removed_ids.contains(&edge.field("to_id").unwrap_or("").to_lowercase())
        {
            evidence_edges += 1;
            deletion.push(mark_session_trashed(&edge, &session_id, &timestamp));
        }
    }
    for guide in snapshot.list_records(RecordType::GUIDE, false)? {
        if guide.field("session_id").map(str::to_lowercase).as_deref()
            == Some(session_id.as_str())
        {
            continue;
        }
        if guide_references_any(&guide, &removed_ids) {
            return Err(CoreError::new(
                "session_guide_dependency",
                "Another study guide references this session. Remove or replace its source links before deleting the session.",
            ));
        }
    }
    for annotation in snapshot.list_records(RecordType::ANNOTATION, false)? {
        if annotation.field("session_id").map(str::to_lowercase).as_deref()
            == Some(session_id.as_str())
        {
            continue;
        }
        if ["linked_asset_ids", "linked_evidence_ids", "source_segment_ids"]
            .iter()
            .any(|key| {
                split_ids(annotation.field(key).unwrap_or(""))
                    .iter()
                    .any(|id| removed_ids.contains(id))
            })
        {
            return Err(CoreError::new(
                "session_annotation_dependency",
                "Another session annotation references this session. Remove or replace its links before deleting the session.",
            ));
        }
    }
    for node in snapshot.list_records(RecordType::EVIDENCE_NODE, false)? {
        if node.field("session_id").map(str::to_lowercase).as_deref()
            == Some(session_id.as_str())
        {
            continue;
        }
        let source_annotation = node.field("source_annotation_id").unwrap_or("").to_lowercase();
        if (!source_annotation.is_empty() && removed_ids.contains(&source_annotation))
            || ["source_segment_ids", "source_asset_ids"].iter().any(|key| {
                split_ids(node.field(key).unwrap_or(""))
                    .iter()
                    .any(|id| removed_ids.contains(id))
            })
        {
            return Err(CoreError::new(
                "session_evidence_dependency",
                "Another session evidence node references this session. Remove or replace its source links before deleting the session.",
            ));
        }
    }
    let removed_guides: BTreeSet<String> = guides.iter().map(|record| record.id.to_lowercase()).collect();
    let removed_assets: BTreeSet<String> = assets.iter().map(|record| record.id.to_lowercase()).collect();
    let mut updated_entries = Vec::new();
    for entry in snapshot.list_records(RecordType::SETTINGS, false)? {
        if entry.field("record_role") != Some("journal-entry") {
            continue;
        }
        let mut fields = entry.fields.clone();
        let mut restore_session_refs = Vec::new();
        let mut restore_guide_refs = Vec::new();
        let mut restore_asset_refs = Vec::new();
        let mut changed = false;
        let remove_references = |value: &str, removed: &BTreeSet<String>, restore: &mut Vec<String>| -> Option<String> {
            let references = split_ids(value);
            let retained: Vec<String> = references
                .iter()
                .filter(|id| {
                    if removed.contains(*id) {
                        restore.push((*id).clone());
                        false
                    } else {
                        true
                    }
                })
                .cloned()
                .collect();
            (retained.len() != references.len()).then(|| retained.join(","))
        };
        if let Some(value) = remove_references(fields.get("session_ids").map(String::as_str).unwrap_or(""), &BTreeSet::from([session_id.clone()]), &mut restore_session_refs) {
            fields.insert("session_ids".to_owned(), value);
            changed = true;
        }
        if let Some(value) = remove_references(fields.get("study_guide_ids").map(String::as_str).unwrap_or(""), &removed_guides, &mut restore_guide_refs) {
            fields.insert("study_guide_ids".to_owned(), value);
            changed = true;
        }
        if let Some(value) = remove_references(fields.get("attachment_ids").map(String::as_str).unwrap_or(""), &removed_assets, &mut restore_asset_refs) {
            fields.insert("attachment_ids".to_owned(), value);
            changed = true;
        }
        if !changed {
            continue;
        }
        fields.insert("_trash_session_group_id".to_owned(), session_id.clone());
        if !restore_session_refs.is_empty() {
            fields.insert("_trash_restore_session_refs".to_owned(), restore_session_refs.join(","));
        }
        if !restore_guide_refs.is_empty() {
            fields.insert("_trash_restore_guide_refs".to_owned(), restore_guide_refs.join(","));
        }
        if !restore_asset_refs.is_empty() {
            fields.insert("_trash_restore_asset_refs".to_owned(), restore_asset_refs.join(","));
        }
        fields.insert("updated_at_us".to_owned(), timestamp.clone());
        let mut updated = entry;
        updated.fields = fields;
        updated_entries.push(updated);
    }
    let trashed_session = mark_session_trashed(session, &session_id, &timestamp);
    let scope_records: Vec<ArchiveRecord> = audio_chunks
        .iter()
        .chain(deletion.iter())
        .chain(guides.iter())
        .chain(assets.iter())
        .chain(evidence_nodes.iter())
        .chain(session_notes.iter())
        .chain(updated_entries.iter())
        .chain(std::iter::once(&trashed_session))
        .cloned()
        .collect();
    let changes: Vec<ArchiveRecord> = scope_records
        .iter()
        .filter(|record| record.record_type != RecordType::AUDIO_CHUNK)
        .cloned()
        .collect();
    Ok(SessionTrashPlan {
        total_records: scope_records.len(),
        entries_updated: updated_entries.len(),
        evidence_edges,
        evidence_nodes: evidence_nodes.len(),
        assets: asset_count,
        guides: guides.len(),
        annotations,
        transcript_segments,
        session_notes: session_notes.len(),
        waveform_indices,
        audio_chunk_count: audio_chunks.len(),
        audio_chunks,
        changes,
        scope_records,
    })
}

pub(crate) fn guide_references_any(guide: &ArchiveRecord, ids: &BTreeSet<String>) -> bool {
    if guide
        .field("entry_id")
        .map(str::to_lowercase)
        .map(|id| ids.contains(&id))
        .unwrap_or(false)
    {
        return true;
    }
    for (key, value) in &guide.fields {
        if key.starts_with("section.") && key.ends_with(".source_ids") {
            if split_ids(value).iter().any(|id| ids.contains(id)) {
                return true;
            }
        } else if key.starts_with("section.") && key.ends_with(".block.0.text") {
            let mut rest = value.as_str();
            while let Some(start) = rest.to_lowercase().find("[[source:") {
                let after = &rest[start + 9..];
                let Some(end) = after.find("]]") else { break };
                if ids.contains(&after[..end].trim().to_lowercase()) {
                    return true;
                }
                rest = &after[end + 2..];
            }
        }
    }
    false
}

pub(crate) fn push_session_change(
    changes: &mut Vec<ArchiveRecord>,
    changed_keys: &mut BTreeSet<(u16, String)>,
    restored_ids: &mut BTreeSet<String>,
    record: ArchiveRecord,
) {
    let key = (record.record_type, record.id.to_lowercase());
    if changed_keys.insert(key) {
        restored_ids.insert(record.id.to_lowercase());
        changes.push(record);
    }
}

pub(crate) fn plan_session_restore(snapshot: &ArchiveSnapshot, session: &ArchiveRecord) -> Result<Vec<ArchiveRecord>> {
    let session_id = session.id.to_lowercase();
    let timestamp = now_us().to_string();
    let mut changes: Vec<ArchiveRecord> = Vec::new();
    let mut changed_keys: BTreeSet<(u16, String)> = BTreeSet::new();
    let mut restored_ids: BTreeSet<String> = BTreeSet::new();
    restored_ids.insert(session_id.clone());
    for record_type in [
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
        RecordType::GUIDE,
        RecordType::WAVEFORM_INDEX,
    ] {
        let legacy = matches!(
            record_type,
            RecordType::TRANSCRIPT_SEGMENT
                | RecordType::ANNOTATION
                | RecordType::ASSET_METADATA
                | RecordType::EVIDENCE_NODE
                | RecordType::GUIDE
                | RecordType::WAVEFORM_INDEX
        );
        for record in snapshot.list_records(record_type, true)? {
            if record.deleted()
                && (record.field("_trash_group_id").map(str::to_lowercase).as_deref()
                    == Some(session_id.as_str())
                    || (legacy
                        && record.field("session_id").map(str::to_lowercase).as_deref()
                            == Some(session_id.as_str())))
            {
                push_session_change(&mut changes, &mut changed_keys, &mut restored_ids, restore_grouped_record(&record, &timestamp));
            }
        }
    }
    for record in session_audio_chunks(snapshot, session, true)? {
        if record.deleted()
            && (record.field("_trash_group_id").map(str::to_lowercase).as_deref()
                == Some(session_id.as_str())
                || record.field("session_id").map(str::to_lowercase).as_deref()
                    == Some(session_id.as_str()))
        {
            push_session_change(&mut changes, &mut changed_keys, &mut restored_ids, restore_grouped_record(&record, &timestamp));
        }
    }
    for record in snapshot.list_records(RecordType::SETTINGS, true)? {
        if record.deleted()
            && record.field("record_role") == Some("journal-notes")
            && record.field("_trash_group_id").map(str::to_lowercase).as_deref()
                == Some(session_id.as_str())
        {
            push_session_change(&mut changes, &mut changed_keys, &mut restored_ids, restore_grouped_record(&record, &timestamp));
        }
    }
    for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
        if !edge.deleted() {
            continue;
        }
        if edge.field("session_id").map(str::to_lowercase).as_deref() == Some(session_id.as_str())
            || restored_ids.contains(&edge.field("from_id").unwrap_or("").to_lowercase())
            || restored_ids.contains(&edge.field("to_id").unwrap_or("").to_lowercase())
        {
            push_session_change(&mut changes, &mut changed_keys, &mut restored_ids, restore_grouped_record(&edge, &timestamp));
        }
    }
    let entry_id = session.field("entry_id").unwrap_or("").to_lowercase();
    for entry in snapshot.list_records(RecordType::SETTINGS, true)? {
        if entry.field("record_role") != Some("journal-entry") || entry.deleted() {
            continue;
        }
        let mut fields = entry.fields.clone();
        let mut changed = false;
        if fields
            .get("_trash_session_group_id")
            .map(|value| value.to_lowercase())
            .as_deref()
            == Some(session_id.as_str())
        {
            for (key, marker) in [
                ("session_ids", "_trash_restore_session_refs"),
                ("study_guide_ids", "_trash_restore_guide_refs"),
                ("attachment_ids", "_trash_restore_asset_refs"),
            ] {
                let current = fields.get(key).cloned().unwrap_or_default();
                let mut ids = split_ids(&current);
                for id in split_ids(fields.get(marker).map(String::as_str).unwrap_or("")) {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                if !ids.is_empty() {
                    fields.insert(key.to_owned(), ids.join(","));
                }
            }
            fields.remove("_trash_session_group_id");
            fields.remove("_trash_restore_session_refs");
            fields.remove("_trash_restore_guide_refs");
            fields.remove("_trash_restore_asset_refs");
            changed = true;
        } else if !entry_id.is_empty()
            && entry.id.to_lowercase() == entry_id
            && !split_ids(fields.get("session_ids").map(String::as_str).unwrap_or(""))
                .iter()
                .any(|id| id == &session_id)
        {
            fields.insert(
                "session_ids".to_owned(),
                merge_ids(fields.get("session_ids").map(String::as_str).unwrap_or(""), &session_id),
            );
            changed = true;
        }
        if changed {
            fields.insert("updated_at_us".to_owned(), timestamp.clone());
            let mut updated = entry;
            updated.fields = fields;
            push_session_change(&mut changes, &mut changed_keys, &mut restored_ids, updated);
        }
    }
    push_session_change(
        &mut changes,
        &mut changed_keys,
        &mut restored_ids,
        restore_grouped_record(session, &timestamp),
    );
    Ok(changes)
}

