use super::*;

pub(crate) fn run_evidence(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "list" | "review" => {
            let mut records = snapshot.list_records(RecordType::EVIDENCE_NODE, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                records.retain(|record| record.field("session_id").map(str::to_lowercase) == Some(session.to_lowercase()));
            }
            if action == "review" {
                records.retain(|record| record.field("verification_state") != Some("human-verified"));
            }
            emit(output, plain_array(&records), &format!("{} evidence item(s).", records.len()), args.json());
            Ok(0)
        }
        "show" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            emit(output, plain(&record), "Evidence item.", args.json());
            Ok(0)
        }
        "create" => {
            let session_id = args.required_option("session")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let source_segment = args.required_option("source-segment")?.to_lowercase();
            let segment = require_live(&snapshot, RecordType::TRANSCRIPT_SEGMENT, &source_segment)?;
            if segment.field("session_id").map(str::to_lowercase).as_deref() != Some(session_id.as_str()) {
                return Err(CliError("Choose a transcript segment from the selected session.".to_owned()).into());
            }
            let evidence_type = args.required_option("type")?.trim().to_lowercase();
            let title = args.required_option("title")?.to_owned();
            let content = args.required_option("content")?.to_owned();
            if evidence_type.is_empty() || title.is_empty() || content.is_empty() {
                return Err(CliError("Evidence needs a type, title, and content.".to_owned()).into());
            }
            let priority = args.option("priority").unwrap_or("normal");
            if !["low", "normal", "high", "critical"].contains(&priority) {
                return Err(CliError("Priority must be low, normal, high, or critical.".to_owned()).into());
            }
            let timestamp = now_us().to_string();
            let record = ArchiveRecord::new(
                RecordType::EVIDENCE_NODE,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session_id),
                    ("student_id", session.field("student_id").unwrap_or("anonymous").to_owned()),
                    ("type", evidence_type),
                    ("title", title),
                    ("content", content),
                    ("priority", priority.to_owned()),
                    ("origin", "tutor-authored".to_owned()),
                    ("source_annotation_id", String::new()),
                    ("source_segment_ids", segment.id.clone()),
                    ("source_segment_revision", segment.revision.to_string()),
                    (
                        "source_segment_revisions",
                        format!("{}={}", segment.id, segment.revision),
                    ),
                    ("source_asset_ids", String::new()),
                    ("source_speaker_label", segment.field("speaker_label").unwrap_or("").to_owned()),
                    ("start_time_us", segment.field("start_time_us").unwrap_or("0").to_owned()),
                    ("end_time_us", segment.field("end_time_us").unwrap_or("0").to_owned()),
                    ("verification_state", "needs-review".to_owned()),
                    ("created_at_us", timestamp),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Evidence added to review.", args.json());
            Ok(0)
        }
        "extract" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
            let timestamp = now_us().to_string();
            let mut records = Vec::new();
            for annotation in annotations {
                if annotation.field("session_id").map(str::to_lowercase) != Some(session_id.clone()) {
                    continue;
                }
                records.push(ArchiveRecord::new(
                    RecordType::EVIDENCE_NODE,
                    crate::core::archive::new_uuid(),
                    [
                        ("session_id", session_id.clone()),
                        ("source_segment_id", annotation.id.clone()),
                        ("type", annotation.field("type").unwrap_or("general-note").to_owned()),
                        (
                            "title",
                            annotation
                                .field("title")
                                .filter(|value| !value.is_empty())
                                .unwrap_or("Extracted annotation")
                                .to_owned(),
                        ),
                        ("content", annotation.field("content").unwrap_or("").to_owned()),
                        ("status", "pending".to_owned()),
                        ("origin", "annotation-extraction".to_owned()),
                        ("created_at_us", timestamp.clone()),
                        ("updated_at_us", timestamp.clone()),
                    ],
                ));
            }
            let saved = mutate(path, &snapshot, &records)?;
            emit(
                output,
                plain_array(&saved),
                &format!("Extracted {} evidence item(s).", saved.len()),
                args.json(),
            );
            Ok(0)
        }
        "approve" | "reject" | "verify" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            if action == "verify" {
                let valid = evidence_sources_are_current(&snapshot, &record)?;
                emit(
                    output,
                    json!({"evidence_id": id, "source_valid": valid}),
                    if valid {
                        "Evidence sources are current."
                    } else {
                        "Evidence sources are missing, stale, or cross-session."
                    },
                    args.json(),
                );
                return Ok(if valid { 0 } else { 2 });
            }
            record.fields.insert(
                "verification_state".to_owned(),
                if action == "approve" { "human-verified" } else { "rejected" }.to_owned(),
            );
            record
                .fields
                .insert("reviewed_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Evidence status updated.", args.json());
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            let mut changed = false;
            for (option, field) in [
                ("title", "title"),
                ("content", "content"),
                ("type", "type"),
                ("priority", "priority"),
            ] {
                if let Some(value) = args.option(option) {
                    let value = if field == "type" {
                        value.trim().to_lowercase().replace(' ', "-")
                    } else {
                        value.to_owned()
                    };
                    record.fields.insert(field.to_owned(), value);
                    changed = true;
                }
            }
            if !changed {
                return Err(CliError(
                    "Provide a title, content, type, or priority to update.".to_owned(),
                )
                .into());
            }
            if let Some(priority) = args.option("priority") {
                if !["low", "normal", "high", "critical"].contains(&priority) {
                    return Err(CliError("Priority must be low, normal, high, or critical.".to_owned()).into());
                }
            }
            record
                .fields
                .insert("verification_state".to_owned(), "needs-review".to_owned());
            record
                .fields
                .insert("reviewed_at_us".to_owned(), String::new());
            record
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Evidence item updated.", args.json());
            Ok(0)
        }
        "delete" | "restore" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            if action == "delete" {
                let record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
                let timestamp = now_us().to_string();
                let mut changes = vec![mark_session_trashed(&record, &id, &timestamp)];
                for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
                    if !edge.deleted()
                        && (edge.field("from_id").map(str::to_lowercase).as_deref()
                            == Some(id.as_str())
                            || edge.field("to_id").map(str::to_lowercase).as_deref()
                                == Some(id.as_str()))
                    {
                        changes.push(mark_session_trashed(&edge, &id, &timestamp));
                    }
                }
                let saved = mutate(path, &snapshot, &changes)?;
                let result = saved
                    .iter()
                    .find(|record| record.id == id)
                    .cloned()
                    .unwrap_or_else(|| changes[0].clone());
                emit(output, plain(&result), "Evidence item and relationships moved to Trash.", args.json());
                return Ok(0);
            }
            let record = snapshot
                .get_record(RecordType::EVIDENCE_NODE, &id)?
                .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?;
            if !record.deleted() {
                return Err(CliError("Select an evidence item from Trash to restore it.".to_owned()).into());
            }
            let timestamp = now_us().to_string();
            let mut changes = vec![restore_grouped_record(&record, &timestamp)];
            for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
                if edge.deleted()
                    && edge.field("_trash_group_id").map(str::to_lowercase).as_deref()
                        == Some(id.as_str())
                {
                    changes.push(restore_grouped_record(&edge, &timestamp));
                }
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let result = saved
                .iter()
                .find(|record| record.id == id)
                .cloned()
                .unwrap_or_else(|| changes[0].clone());
            emit(output, plain(&result), "Evidence item and relationships restored.", args.json());
            Ok(0)
        }
        "link" => {
            let from = args.required_option("from")?.to_lowercase();
            let to = args.required_option("to")?.to_lowercase();
            let relationship = args.required_option("relationship")?.to_owned();
            if from == to {
                return Err(CoreError::new(
                    "evidence_edge_endpoint_invalid",
                    "Choose two different evidence items.",
                )
                .into());
            }
            if !EVIDENCE_RELATIONSHIPS.contains(&relationship.as_str()) {
                return Err(CoreError::new(
                    "evidence_edge_relationship_invalid",
                    "Choose a supported evidence relationship.",
                )
                .into());
            }
            let from_record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &from)?;
            let to_record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &to)?;
            if from_record.field("session_id") != to_record.field("session_id") {
                return Err(CoreError::new(
                    "evidence_edge_session_mismatch",
                    "Evidence relationships must connect items from the same session.",
                )
                .into());
            }
            let timestamp = now_us().to_string();
            let record = ArchiveRecord::new(
                RecordType::EVIDENCE_EDGE,
                crate::core::archive::new_uuid(),
                [
                    ("from_id", from),
                    ("to_id", to),
                    ("relationship", relationship),
                    ("created_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Evidence edge created.", args.json());
            Ok(0)
        }
        "unlink" => {
            let id = args.required_position(0, "evidence edge ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::EVIDENCE_EDGE, &id)?;
            let saved = mutate(path, &snapshot, &[trash(&record)])?;
            emit(output, plain(&saved[0]), "Evidence edge removed.", args.json());
            Ok(0)
        }
        "edges" => {
            let session = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session)?;
            let nodes = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
            let node_by_id: BTreeMap<String, &ArchiveRecord> = nodes
                .iter()
                .filter(|record| record.field("session_id").map(str::to_lowercase).as_deref() == Some(session.as_str()))
                .map(|record| (record.id.clone(), record))
                .collect();
            let edge_records = snapshot.list_records(RecordType::EVIDENCE_EDGE, false)?;
            let edges: Vec<&ArchiveRecord> = edge_records
                .iter()
                .filter(|record| {
                    node_by_id.contains_key(record.field("from_id").unwrap_or(""))
                        && node_by_id.contains_key(record.field("to_id").unwrap_or(""))
                })
                .collect();
            let rows: Vec<Value> = edges
                .iter()
                .map(|edge| {
                    let from = node_by_id.get(edge.field("from_id").unwrap_or("")).copied();
                    let to = node_by_id.get(edge.field("to_id").unwrap_or("")).copied();
                    let mut value = plain(edge);
                    if let Value::Object(map) = &mut value {
                        map.insert(
                            "from_title".to_owned(),
                            Value::String(
                                from.and_then(|node| node.field("title").or_else(|| node.field("type")))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or("Evidence")
                                    .to_owned(),
                            ),
                        );
                        map.insert(
                            "to_title".to_owned(),
                            Value::String(
                                to.and_then(|node| node.field("title").or_else(|| node.field("type")))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or("Evidence")
                                    .to_owned(),
                            ),
                        );
                    }
                    value
                })
                .collect();
            emit(output, Value::Array(rows), &format!("{} evidence relationship(s).", edges.len()), args.json());
            Ok(0)
        }
        "graph" => {
            let session = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session)?;
            let nodes: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::EVIDENCE_NODE, false)?
                .into_iter()
                .filter(|record| record.field("session_id").map(str::to_lowercase).as_deref() == Some(session.as_str()))
                .collect();
            for node in &nodes {
                if node.field("content").unwrap_or("").is_empty() {
                    return Err(CliError(format!("Evidence {} needs a statement.", node.id)).into());
                }
            }
            let node_ids: BTreeSet<String> = nodes.iter().map(|record| record.id.to_lowercase()).collect();
            let mut edge_count = 0usize;
            let mut contradictions: BTreeMap<String, Value> = BTreeMap::new();
            for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, false)? {
                let from = edge.field("from_id").unwrap_or("").to_lowercase();
                let to = edge.field("to_id").unwrap_or("").to_lowercase();
                let from_here = node_ids.contains(&from);
                let to_here = node_ids.contains(&to);
                if !from_here && !to_here {
                    continue;
                }
                if !from_here || !to_here {
                    return Err(CliError(
                        "An evidence relationship connects a session node to a missing or cross-session node."
                            .to_owned(),
                    )
                    .into());
                }
                let relationship = edge.field("relationship").unwrap_or("");
                if from == to || !EVIDENCE_RELATIONSHIPS.contains(&relationship) {
                    return Err(CliError(format!(
                        "Evidence relationship {} has invalid endpoints or type.",
                        edge.id
                    ))
                    .into());
                }
                edge_count += 1;
                if relationship == "contradicts" {
                    let (first, second) = if from <= to { (from, to) } else { (to, from) };
                    contradictions.insert(
                        format!("{first}:{second}"),
                        json!({"first_evidence_id": first, "second_evidence_id": second}),
                    );
                }
            }
            let pairs: Vec<Value> = contradictions.into_values().collect();
            let details = pairs
                .iter()
                .map(|pair| {
                    format!(
                        "  {} contradicts {}",
                        pair["first_evidence_id"].as_str().unwrap_or(""),
                        pair["second_evidence_id"].as_str().unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            emit(
                output,
                json!({
                    "session_id": session,
                    "node_count": nodes.len(),
                    "edge_count": edge_count,
                    "contradiction_count": pairs.len(),
                    "contradictions": pairs,
                    "valid": true,
                }),
                &format!(
                    "Evidence graph: {} node(s), {edge_count} relationship(s), {} explicit contradiction(s).{}",
                    nodes.len(),
                    pairs.len(),
                    if details.is_empty() { String::new() } else { format!("\n{details}") }
                ),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("evidence {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

