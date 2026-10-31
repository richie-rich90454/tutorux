use std::collections::{BTreeMap, BTreeSet};

use crate::core::error::{err, Result};
use crate::core::format::{ArchiveRecord, RecordType};

use super::plan::{has_kept_session, recordings_requested, session_is_kept, NormalizedOptions};
use super::refs::{guide_references, recording_asset};
use super::types::{active, field, lower, parse_uuid, split_ids, SanitizedCopyPlan};

pub(crate) fn plan_notes_and_guides(
    plan: &mut SanitizedCopyPlan,
    is_scoped: bool,
) -> BTreeSet<String> {
    let mut requested_assets = BTreeSet::new();
    for record_type in [RecordType::ANNOTATION, RecordType::TRANSCRIPT_SEGMENT] {
        for record in plan.records(record_type).to_vec() {
            if !plan.kept(record_type).contains(&record.id.to_lowercase()) {
                continue;
            }
            for id in split_ids(&field(&record, "linked_asset_ids")) {
                if let Some(id) = parse_uuid(&id) {
                    requested_assets.insert(id);
                }
            }
        }
    }
    for record in plan.records(RecordType::SETTINGS).to_vec() {
        if !active(&record) || lower(&field(&record, "record_role")) != "journal-entry" {
            continue;
        }
        let sessions = split_ids(&field(&record, "session_ids"));
        let in_scope = !is_scoped
            || (!sessions.is_empty()
                && sessions
                    .iter()
                    .any(|id| plan.has_kept(RecordType::SESSION, id)));
        if !in_scope {
            continue;
        }
        plan.keep_set(RecordType::SETTINGS)
            .insert(record.id.to_lowercase());
        for id in split_ids(&field(&record, "attachment_ids")) {
            if let Some(id) = parse_uuid(&id) {
                requested_assets.insert(id);
            }
        }
    }
    let mut retained_notes: BTreeSet<String> = BTreeSet::new();
    for record in plan.records(RecordType::SESSION).to_vec() {
        if !plan
            .kept(RecordType::SESSION)
            .contains(&record.id.to_lowercase())
        {
            continue;
        }
        if let Some(id) = parse_uuid(&field(&record, "notes_document_id")) {
            retained_notes.insert(id);
        }
    }
    for record in plan.records(RecordType::SETTINGS).to_vec() {
        if plan
            .kept(RecordType::SETTINGS)
            .contains(&record.id.to_lowercase())
            && lower(&field(&record, "record_role")) == "journal-entry"
        {
            if let Some(id) = parse_uuid(&field(&record, "notes_document_id")) {
                retained_notes.insert(id);
            }
        }
    }
    for record in plan.records(RecordType::GUIDE).to_vec() {
        if !active(&record) {
            continue;
        }
        let Some((_, images)) = guide_references(&record) else {
            continue;
        };
        let entry_id = field(&record, "entry_id");
        let session_id = field(&record, "session_id");
        if is_scoped
            && session_id.is_empty()
            && (entry_id.is_empty() || !plan.has_kept(RecordType::SETTINGS, &entry_id))
        {
            continue;
        }
        if !session_id.is_empty() && !plan.has_kept(RecordType::SESSION, &session_id) {
            continue;
        }
        requested_assets.extend(images);
    }
    plan.retained_notes = retained_notes;
    requested_assets
}

pub(crate) fn plan_assets(
    plan: &mut SanitizedCopyPlan,
    options: &NormalizedOptions,
    is_scoped: bool,
    requested_assets: &BTreeSet<String>,
) -> Result<()> {
    let available_students: BTreeSet<String> = plan
        .records(RecordType::STUDENT)
        .iter()
        .filter(|record| active(record))
        .map(|record| record.id.to_lowercase())
        .collect();
    let wants_recordings = recordings_requested(options);
    for record in plan.records(RecordType::ASSET_METADATA).to_vec() {
        if !active(&record) || !session_is_kept(plan, &record) {
            continue;
        }
        if recording_asset(&record) {
            if !wants_recordings {
                continue;
            }
            let role = lower(&field(&record, "record_role"));
            if role == "audio-track" {
                let Some(session_id) = parse_uuid(&field(&record, "session_id")) else {
                    continue;
                };
                let Some(track_id) = parse_uuid(&field(&record, "track_id")) else {
                    continue;
                };
                let Some(tracks) = plan.recording_tracks_by_session.get(&session_id) else {
                    continue;
                };
                if !tracks.contains(&track_id) {
                    continue;
                }
            } else if role == "recording-take" {
                let Some(session_id) = parse_uuid(&field(&record, "session_id")) else {
                    continue;
                };
                let Some(tracks) = plan.recording_tracks_by_session.get(&session_id) else {
                    continue;
                };
                let retained: Vec<String> = split_ids(&field(&record, "track_ids"))
                    .into_iter()
                    .filter_map(|id| parse_uuid(&id))
                    .filter(|id| tracks.contains(id))
                    .collect();
                if retained.is_empty() {
                    continue;
                }
                let mut fields = record.fields.clone();
                fields.insert("track_ids".to_owned(), retained.join(","));
                let mut updated = record.clone();
                updated.fields = fields;
                plan.metadata_updates.insert(
                    format!("{}:{}", record.record_type, record.id.to_lowercase()),
                    updated,
                );
            } else {
                let track_id = parse_uuid(&field(&record, "track_id"));
                let session_id = parse_uuid(&field(&record, "session_id"));
                if let (Some(track_id), Some(session_id)) = (track_id, session_id) {
                    if !plan
                        .recording_tracks_by_session
                        .get(&session_id)
                        .map(|tracks| tracks.contains(&track_id))
                        .unwrap_or(false)
                    {
                        continue;
                    }
                }
            }
        }
        let student_id = parse_uuid(&field(&record, "student_id"));
        if let Some(student_id) = &student_id {
            if available_students.contains(student_id)
                && !plan.kept(RecordType::STUDENT).contains(student_id)
            {
                continue;
            }
        }
        let associated_student = student_id
            .as_ref()
            .map(|id| plan.kept(RecordType::STUDENT).contains(id))
            .unwrap_or(false);
        if is_scoped
            && field(&record, "session_id").is_empty()
            && !associated_student
            && !requested_assets.contains(&record.id.to_lowercase())
        {
            continue;
        }
        plan.keep_set(RecordType::ASSET_METADATA)
            .insert(record.id.to_lowercase());
    }

    for record in plan.records(RecordType::EVIDENCE_NODE).to_vec() {
        if !active(&record) || !session_is_kept(plan, &record) {
            continue;
        }
        let student_id = parse_uuid(&field(&record, "student_id"));
        if let Some(student_id) = &student_id {
            if available_students.contains(student_id)
                && !plan.kept(RecordType::STUDENT).contains(student_id)
            {
                continue;
            }
        }
        if is_scoped && field(&record, "session_id").is_empty() {
            let keep_student = student_id
                .as_ref()
                .map(|id| plan.kept(RecordType::STUDENT).contains(id))
                .unwrap_or(false);
            if !keep_student {
                continue;
            }
        }
        let source_annotation = field(&record, "source_annotation_id");
        if !source_annotation.is_empty()
            && !plan.has_kept(RecordType::ANNOTATION, &source_annotation)
        {
            continue;
        }
        let segment_refs = split_ids(&field(&record, "source_segment_ids"));
        let asset_refs = split_ids(&field(&record, "source_asset_ids"));
        if segment_refs
            .iter()
            .any(|id| !plan.has_kept(RecordType::TRANSCRIPT_SEGMENT, id))
            || asset_refs
                .iter()
                .any(|id| !plan.has_kept(RecordType::ASSET_METADATA, id))
        {
            continue;
        }
        plan.keep_set(RecordType::EVIDENCE_NODE)
            .insert(record.id.to_lowercase());
    }
    for record in plan.records(RecordType::EVIDENCE_EDGE).to_vec() {
        if active(&record)
            && session_is_kept(plan, &record)
            && (!is_scoped || has_kept_session(plan, &record))
            && plan.has_kept(RecordType::EVIDENCE_NODE, &field(&record, "from_id"))
            && plan.has_kept(RecordType::EVIDENCE_NODE, &field(&record, "to_id"))
        {
            plan.keep_set(RecordType::EVIDENCE_EDGE)
                .insert(record.id.to_lowercase());
        }
    }
    for record in plan.records(RecordType::GUIDE).to_vec() {
        if !active(&record) || !session_is_kept(plan, &record) {
            continue;
        }
        let Some((sources, images)) = guide_references(&record) else {
            continue;
        };
        let entry_id = field(&record, "entry_id");
        let session_id = field(&record, "session_id");
        if is_scoped
            && session_id.is_empty()
            && (entry_id.is_empty() || !plan.has_kept(RecordType::SETTINGS, &entry_id))
        {
            continue;
        }
        let mut refs_valid = sources.iter().all(|id| {
            plan.has_kept(RecordType::EVIDENCE_NODE, id)
                || plan.has_kept(RecordType::ANNOTATION, id)
                || plan.has_kept(RecordType::TRANSCRIPT_SEGMENT, id)
                || plan.has_kept(RecordType::ASSET_METADATA, id)
        });
        refs_valid &= images
            .iter()
            .all(|id| plan.has_kept(RecordType::ASSET_METADATA, id));
        if !session_id.is_empty() {
            refs_valid &= plan.has_kept(RecordType::SESSION, &session_id);
        }
        if refs_valid {
            plan.keep_set(RecordType::GUIDE)
                .insert(record.id.to_lowercase());
        }
    }
    for record in plan.records(RecordType::SETTINGS).to_vec() {
        if !active(&record) {
            continue;
        }
        let role = lower(&field(&record, "record_role"));
        if role == "archive-manifest" || record.id.to_lowercase() == plan.source_manifest_id {
            continue;
        }
        let credential = crate::core::archive::is_credential_settings_record(&record);
        if credential && !options.include_credentials {
            continue;
        }
        if credential && !plan.encrypted_source {
            return err(
                "sanitized_copy_plaintext_credential",
                "Credential records can only be copied from encrypted source archives.",
            );
        }
        if crate::core::archive::has_sensitive_credential_material(&record) && !credential {
            if options.include_credentials {
                return err(
                    "sanitized_copy_plaintext_credential",
                    "A credential-looking value is not stored as an encrypted credential and cannot be copied. Move it into an encrypted credential record first.",
                );
            }
            continue;
        }
        if role == "journal-entry" {
            let sessions = split_ids(&field(&record, "session_ids"));
            if is_scoped && sessions.is_empty() {
                continue;
            }
            if !sessions.is_empty()
                && !sessions
                    .iter()
                    .any(|id| plan.has_kept(RecordType::SESSION, id))
            {
                continue;
            }
        }
        if role == "journal-notes" {
            let session_id = field(&record, "session_id");
            if !session_id.is_empty() && !plan.has_kept(RecordType::SESSION, &session_id) {
                continue;
            }
            if is_scoped && !plan.retained_notes.contains(&record.id.to_lowercase()) {
                continue;
            }
        }
        plan.keep_set(RecordType::SETTINGS)
            .insert(record.id.to_lowercase());
    }
    for record in plan.records(RecordType::AI_JOB).to_vec() {
        if active(&record)
            && session_is_kept(plan, &record)
            && (!is_scoped || has_kept_session(plan, &record))
            && options.include_generation_logs
        {
            plan.keep_set(RecordType::AI_JOB)
                .insert(record.id.to_lowercase());
        }
    }
    for record in plan.records(RecordType::WAVEFORM_INDEX).to_vec() {
        if !active(&record)
            || !wants_recordings
            || !session_is_kept(plan, &record)
            || (is_scoped && !has_kept_session(plan, &record))
        {
            continue;
        }
        let session_id = parse_uuid(&field(&record, "session_id"));
        let track_id = parse_uuid(&field(&record, "track_id"));
        let keep = match (session_id, track_id) {
            (Some(session_id), Some(track_id)) => plan
                .recording_tracks_by_session
                .get(&session_id)
                .map(|tracks| tracks.contains(&track_id))
                .unwrap_or(false),
            _ => false,
        };
        if keep {
            plan.keep_set(RecordType::WAVEFORM_INDEX)
                .insert(record.id.to_lowercase());
        }
    }
    plan_asset_blobs(plan)
}

fn plan_asset_blobs(plan: &mut SanitizedCopyPlan) -> Result<()> {
    let blobs: BTreeMap<String, ArchiveRecord> = plan
        .records(RecordType::ASSET_BLOB)
        .iter()
        .map(|record| (record.id.to_lowercase(), record.clone()))
        .collect();
    let mut referenced_blobs = BTreeSet::new();
    for record in plan.records(RecordType::ASSET_METADATA).to_vec() {
        if !plan
            .kept(RecordType::ASSET_METADATA)
            .contains(&record.id.to_lowercase())
        {
            continue;
        }
        let blob_text = field(&record, "blob_id");
        if blob_text.is_empty() {
            continue;
        }
        let Some(blob_id) = parse_uuid(&blob_text) else {
            return err(
                "sanitized_copy_asset_blob_id_invalid",
                "A selected asset has an invalid blob reference.",
            );
        };
        referenced_blobs.insert(blob_id);
    }
    let mut referenced_chunks = BTreeSet::new();
    let mut chunk_owners: BTreeMap<String, String> = BTreeMap::new();
    for blob_id in &referenced_blobs {
        let Some(blob) = blobs.get(blob_id) else {
            return err(
                "sanitized_copy_asset_blob_missing",
                "A selected asset refers to a missing blob record.",
            );
        };
        if !active(blob) {
            return err(
                "sanitized_copy_asset_blob_missing",
                "A selected asset refers to a missing blob record.",
            );
        }
        let role = field(blob, "record_role");
        if role == "asset-blob-chunk" {
            return err(
                "sanitized_copy_asset_blob_invalid",
                "An asset points directly to a chunk instead of a blob manifest.",
            );
        }
        if role != "asset-blob-manifest" {
            continue;
        }
        for raw_id in split_ids(&field(blob, "chunk_ids")) {
            let Some(chunk_id) = parse_uuid(&raw_id) else {
                return err(
                    "sanitized_copy_asset_manifest_invalid",
                    "A selected asset manifest contains an invalid chunk reference.",
                );
            };
            referenced_chunks.insert(chunk_id.clone());
            if let Some(owner) = chunk_owners.get(&chunk_id) {
                if owner != blob_id {
                    return err(
                        "sanitized_copy_asset_chunk_shared",
                        "A chunk is assigned to multiple asset manifests.",
                    );
                }
            }
            chunk_owners.insert(chunk_id, blob_id.clone());
        }
    }
    for chunk_id in &referenced_chunks {
        let Some(chunk) = blobs.get(chunk_id) else {
            return err(
                "sanitized_copy_asset_chunk_missing",
                "A selected asset manifest refers to a missing chunk record.",
            );
        };
        if !active(chunk) {
            return err(
                "sanitized_copy_asset_chunk_missing",
                "A selected asset manifest refers to a missing chunk record.",
            );
        }
        if field(chunk, "record_role") != "asset-blob-chunk"
            || lower(&field(chunk, "manifest_id")) != chunk_owners[chunk_id]
        {
            return err(
                "sanitized_copy_asset_chunk_invalid",
                "An asset chunk does not match its selected manifest.",
            );
        }
    }
    let mut keep = referenced_blobs;
    keep.extend(referenced_chunks);
    plan.keep.insert(RecordType::ASSET_BLOB, keep);
    Ok(())
}
