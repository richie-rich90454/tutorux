use super::*;

const PACKAGE_ROLE: &str = "tutorux-session-package";
const PACKAGE_VERSION: &str = "1";

fn is_internal_asset_role(role: Option<&str>) -> bool {
    matches!(
        role,
        Some("audio-track")
            | Some("recording-take")
            | Some("waveform-pyramid")
            | Some("sparse-timestamp-seek-index")
            | Some("asset-blob-manifest")
            | Some("asset-blob-chunk")
    )
}

fn collect_id_list(record: &ArchiveRecord, key: &str, ids: &mut BTreeSet<String>) {
    for id in split_ids(record.field(key).unwrap_or("")) {
        ids.insert(id);
    }
}

fn collect_history(
    snapshot: &ArchiveSnapshot,
    record: &ArchiveRecord,
) -> CliResult<Vec<ArchiveRecord>> {
    let history = snapshot.get_record_history(record.record_type, &record.id, 10_000)?;
    if history.is_empty() {
        return Ok(vec![record.clone()]);
    }
    if history
        .last()
        .and_then(|record| Some(record.previous_offset))
        .is_some_and(|offset| offset != 0)
    {
        return Err(CliError(
            "A session package cannot include more than 10,000 revisions of one record.".to_owned(),
        )
        .into());
    }
    let mut revisions = history;
    revisions.reverse();
    Ok(revisions)
}

pub(crate) fn validate_session_records(
    records: &[ArchiveRecord],
    session_id: &str,
) -> CliResult<()> {
    let mut ids: BTreeMap<u16, BTreeSet<String>> = BTreeMap::new();
    for record in records {
        ids.entry(record.record_type)
            .or_default()
            .insert(record.id.to_lowercase());
    }
    let has = |record_type: u16, id: &str| {
        ids.get(&record_type)
            .is_some_and(|set| set.contains(&id.to_lowercase()))
    };
    for record in records {
        let related_session = record.field("session_id").unwrap_or("").to_lowercase();
        if !related_session.is_empty()
            && record.record_type != RecordType::ASSET_METADATA
            && related_session != session_id.to_lowercase()
        {
            return Err(CliError(
                "Package contains a record associated with another session.".to_owned(),
            )
            .into());
        }
        if record.record_type == RecordType::SETTINGS
            && !matches!(
                record.field("record_role"),
                Some("journal-entry") | Some("journal-notes")
            )
        {
            return Err(
                CliError("Session packages cannot contain unrelated settings.".to_owned()).into(),
            );
        }
        if record.record_type == RecordType::ASSET_METADATA
            && !is_internal_asset_role(record.field("record_role"))
            && !has(
                RecordType::ASSET_BLOB,
                record.field("blob_id").unwrap_or(""),
            )
        {
            return Err(CliError(
                "A session asset revision references a missing content blob.".to_owned(),
            )
            .into());
        }
        if record.record_type == RecordType::ASSET_BLOB
            && record.field("record_role") == Some("asset-blob-manifest")
        {
            for id in split_ids(record.field("chunk_ids").unwrap_or("")) {
                if !has(RecordType::ASSET_BLOB, &id) {
                    return Err(CliError(
                        "A session package asset manifest chunk is not included.".to_owned(),
                    )
                    .into());
                }
            }
        }
        if matches!(
            record.record_type,
            RecordType::ANNOTATION | RecordType::TRANSCRIPT_SEGMENT
        ) {
            for id in split_ids(record.field("linked_asset_ids").unwrap_or("")) {
                if !has(RecordType::ASSET_METADATA, &id) {
                    return Err(CliError(
                        "A session package asset link points to a record that is not included."
                            .to_owned(),
                    )
                    .into());
                }
            }
        }
        if record.record_type == RecordType::EVIDENCE_NODE {
            let annotation = record.field("source_annotation_id").unwrap_or("");
            if !annotation.is_empty() && !has(RecordType::ANNOTATION, annotation) {
                return Err(CliError(
                    "Evidence refers to an annotation that is not included.".to_owned(),
                )
                .into());
            }
            for id in split_ids(record.field("source_segment_ids").unwrap_or("")) {
                if !has(RecordType::TRANSCRIPT_SEGMENT, &id) {
                    return Err(CliError(
                        "Evidence refers to a transcript source that is not included.".to_owned(),
                    )
                    .into());
                }
            }
            for id in split_ids(record.field("source_asset_ids").unwrap_or("")) {
                if !has(RecordType::ASSET_METADATA, &id) {
                    return Err(CliError(
                        "Evidence refers to an asset source that is not included.".to_owned(),
                    )
                    .into());
                }
            }
        }
        if record.record_type == RecordType::EVIDENCE_EDGE
            && (!has(
                RecordType::EVIDENCE_NODE,
                record.field("from_id").unwrap_or(""),
            ) || !has(
                RecordType::EVIDENCE_NODE,
                record.field("to_id").unwrap_or(""),
            ))
        {
            return Err(CliError(
                "An evidence relationship points to a missing evidence node.".to_owned(),
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn export_session_package(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let session_id = args.required_position(0, "session ID")?.to_lowercase();
    let destination = resolve_path(args.required_option("output")?);
    if !destination
        .extension()
        .map(|extension| extension.eq_ignore_ascii_case("tux"))
        .unwrap_or(false)
    {
        return Err(CliError("Session packages must use the .tux extension.".to_owned()).into());
    }
    if same_path_public(path, &destination) {
        return Err(CliError("Session package output must be a separate file.".to_owned()).into());
    }
    if destination.exists() && !args.flag("force") {
        return Err(CliError(format!(
            "Session package output already exists: {}",
            output_path(&destination)
        ))
        .into());
    }
    let session = require_live(snapshot, RecordType::SESSION, &session_id)?;
    let timestamp = now_us();
    let bytes = create_archive_bytes(
        "Tutorux session transfer",
        &format!("Portable transfer package for session {session_id}"),
        timestamp,
    )?;
    let mut package = ArchiveSnapshot::open_bytes(bytes)?;
    let manifest = package
        .get_record(RecordType::SETTINGS, &package.header.id)?
        .ok_or_else(|| CliError("The new package archive is missing its manifest.".to_owned()))?;
    let mut manifest_fields = manifest.fields.clone();
    manifest_fields.insert("record_role".to_owned(), PACKAGE_ROLE.to_owned());
    manifest_fields.insert("package_version".to_owned(), PACKAGE_VERSION.to_owned());
    manifest_fields.insert("source_session_id".to_owned(), session.id.clone());
    let source_student = session.field("student_id").unwrap_or("anonymous");
    if !source_student.is_empty() && source_student != "anonymous" {
        manifest_fields.insert(
            "source_student_id".to_owned(),
            source_student.to_lowercase(),
        );
    }
    let mut manifest = manifest;
    manifest.fields = manifest_fields;

    let mut order: Vec<(u16, String)> = Vec::new();
    let mut records: BTreeMap<(u16, String), ArchiveRecord> = BTreeMap::new();
    let add = |record: &ArchiveRecord,
               order: &mut Vec<(u16, String)>,
               records: &mut BTreeMap<(u16, String), ArchiveRecord>| {
        let key = (record.record_type, record.id.to_lowercase());
        if !records.contains_key(&key) {
            order.push(key.clone());
            records.insert(key, record.clone());
        }
    };
    add(&session, &mut order, &mut records);
    let mut asset_ids: BTreeSet<String> = BTreeSet::new();
    let mut evidence_ids: BTreeSet<String> = BTreeSet::new();
    for record_type in [
        RecordType::AUDIO_CHUNK,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
        RecordType::GUIDE,
        RecordType::AI_JOB,
    ] {
        for record in snapshot.list_records(record_type, true)? {
            if record.field("session_id").map(str::to_lowercase).as_deref()
                != Some(session_id.as_str())
            {
                continue;
            }
            if record.record_type == RecordType::EVIDENCE_NODE {
                evidence_ids.insert(record.id.to_lowercase());
            }
            if record.record_type == RecordType::ASSET_METADATA
                && !is_internal_asset_role(record.field("record_role"))
            {
                asset_ids.insert(record.id.to_lowercase());
            }
            collect_id_list(&record, "linked_asset_ids", &mut asset_ids);
            collect_id_list(&record, "source_asset_ids", &mut asset_ids);
            add(&record, &mut order, &mut records);
        }
    }
    for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
        let belongs =
            edge.field("session_id").map(str::to_lowercase).as_deref() == Some(session_id.as_str());
        let connects = evidence_ids.contains(&edge.field("from_id").unwrap_or("").to_lowercase())
            && evidence_ids.contains(&edge.field("to_id").unwrap_or("").to_lowercase());
        if belongs || connects {
            add(&edge, &mut order, &mut records);
        }
    }
    let current_records: Vec<ArchiveRecord> = records.values().cloned().collect();
    for record in &current_records {
        for revision in collect_history(snapshot, record)? {
            collect_id_list(&revision, "linked_asset_ids", &mut asset_ids);
            collect_id_list(&revision, "source_asset_ids", &mut asset_ids);
        }
    }
    let all_assets = snapshot.list_records(RecordType::ASSET_METADATA, true)?;
    let mut found_assets = BTreeSet::new();
    let mut pending_blobs = BTreeSet::new();
    for asset in &all_assets {
        if !asset_ids.contains(&asset.id.to_lowercase()) {
            continue;
        }
        found_assets.insert(asset.id.to_lowercase());
        for revision in collect_history(snapshot, asset)? {
            if let Some(blob_id) = revision.field("blob_id").filter(|id| !id.is_empty()) {
                pending_blobs.insert(blob_id.to_lowercase());
            }
        }
        add(asset, &mut order, &mut records);
    }
    if found_assets.len() != asset_ids.len() {
        return Err(CliError(
            "A session reference points to asset metadata that is not available.".to_owned(),
        )
        .into());
    }
    let all_blobs = snapshot.list_records(RecordType::ASSET_BLOB, true)?;
    let blob_by_id: BTreeMap<String, &ArchiveRecord> = all_blobs
        .iter()
        .map(|blob| (blob.id.to_lowercase(), blob))
        .collect();
    let mut resolved_blobs = BTreeSet::new();
    while let Some(blob_id) = pending_blobs.iter().next().cloned() {
        pending_blobs.remove(&blob_id);
        if !resolved_blobs.insert(blob_id.clone()) {
            continue;
        }
        let Some(blob) = blob_by_id
            .get(&blob_id)
            .copied()
            .filter(|blob| !blob.deleted())
        else {
            return Err(CliError(
                "Session material content is missing from the archive.".to_owned(),
            )
            .into());
        };
        add(blob, &mut order, &mut records);
        if blob.field("record_role") == Some("asset-blob-manifest") {
            for revision in collect_history(snapshot, blob)? {
                for chunk_id in split_ids(revision.field("chunk_ids").unwrap_or("")) {
                    pending_blobs.insert(chunk_id);
                }
            }
        }
    }
    let include_settings = |id: &str,
                            label: &str,
                            snapshot: &ArchiveSnapshot,
                            order: &mut Vec<(u16, String)>,
                            records: &mut BTreeMap<(u16, String), ArchiveRecord>|
     -> CliResult<()> {
        if id.is_empty() {
            return Ok(());
        }
        let record = require_live(snapshot, RecordType::SETTINGS, id)
            .map_err(|_| CliError(format!("{label} was not found.")))?;
        add(&record, order, records);
        Ok(())
    };
    include_settings(
        session.field("entry_id").unwrap_or(""),
        "Session journal entry",
        snapshot,
        &mut order,
        &mut records,
    )?;
    include_settings(
        session.field("notes_document_id").unwrap_or(""),
        "Session notes document",
        snapshot,
        &mut order,
        &mut records,
    )?;
    let guide_entry_ids: Vec<String> = records
        .values()
        .filter(|record| record.record_type == RecordType::GUIDE)
        .map(|record| record.field("entry_id").unwrap_or("").to_owned())
        .collect();
    for guide_entry_id in guide_entry_ids {
        include_settings(
            &guide_entry_id,
            "Guide journal entry",
            snapshot,
            &mut order,
            &mut records,
        )?;
    }
    let entry_document_ids: Vec<String> = records
        .values()
        .filter(|record| {
            record.record_type == RecordType::SETTINGS
                && record.field("record_role") == Some("journal-entry")
        })
        .filter_map(|record| record.field("notes_document_id"))
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    for id in entry_document_ids {
        include_settings(
            &id,
            "Journal notes document",
            snapshot,
            &mut order,
            &mut records,
        )?;
    }

    // Packages carry the current revision of each record only. History is
    // consulted above to discover referenced assets, not to ship revisions.
    let mut packaged: Vec<ArchiveRecord> = Vec::new();
    for key in &order {
        let Some(record) = records.get(key) else {
            continue;
        };
        let mut revision = record.clone();
        if revision.record_type == RecordType::SESSION && revision.id.to_lowercase() == session_id {
            revision
                .fields
                .insert("student_id".to_owned(), "anonymous".to_owned());
        }
        revision.revision = 0;
        revision.previous_offset = 0;
        packaged.push(revision);
    }
    validate_session_records(&packaged, &session_id)?;
    let mut all = vec![manifest];
    all.extend(packaged);
    package = package.append_records(&all)?;
    let package_bytes = package.source.read(0, package.source.size() as usize)?;
    if args.flag("force") {
        write_file_atomically(&destination, &package_bytes)?;
    } else {
        write_new_file(&destination, &package_bytes)?;
    }
    emit(
        output,
        json!({
            "session_id": session.id,
            "output": output_path(&destination),
            "status": "exported",
            "path": output_path(&destination),
            "bytes": package_bytes.len().to_string(),
            "created": true,
        }),
        &format!(
            "Exported session package for {} to {}.",
            session.id,
            destination.display()
        ),
        args.json(),
    );
    Ok(0)
}
