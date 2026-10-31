use super::*;
#[path = "evidence_graph.rs"]
mod evidence_graph;
#[path = "evidence_mutations.rs"]
mod evidence_mutations;

#[path = "evidence_extract.rs"]
mod evidence_extract;
pub(crate) use evidence_extract::*;

fn validate_evidence_text(value: &str, label: &str, maximum_bytes: usize) -> CliResult<()> {
    if value.len() > maximum_bytes {
        return Err(CliError(format!(
            "{label} must be {maximum_bytes} UTF-8 bytes or fewer."
        ))
        .into());
    }
    if value.chars().any(|character| {
        let code = character as u32;
        code == 0x7f || (code < 0x20 && !matches!(code, 0x09 | 0x0a | 0x0d))
    }) {
        return Err(CliError(format!("{label} contains unsupported control characters.")).into());
    }
    Ok(())
}

fn validate_priority(priority: &str) -> CliResult<()> {
    if ["low", "normal", "high", "critical"].contains(&priority) {
        Ok(())
    } else {
        Err(CliError("Priority must be low, normal, high, or critical.".to_owned()).into())
    }
}

fn normalized_type(value: &str) -> String {
    let trimmed = value.trim().to_lowercase();
    let mut output = String::with_capacity(trimmed.len());
    let mut pending_dash = false;
    for character in trimmed.chars() {
        if character.is_whitespace() {
            pending_dash = !output.is_empty();
        } else {
            if pending_dash {
                output.push('-');
                pending_dash = false;
            }
            output.push(character);
        }
    }
    output
}

fn edge_restore(snapshot: &ArchiveSnapshot, edge: &ArchiveRecord) -> CliResult<ArchiveRecord> {
    for key in ["from_id", "to_id"] {
        let endpoint_id = edge.field(key).unwrap_or("");
        match snapshot.get_record(RecordType::EVIDENCE_NODE, endpoint_id)? {
            Some(endpoint) if !endpoint.deleted() => {}
            _ => {
                return Err(CliError(
                    "Restore both linked evidence items before restoring this relationship."
                        .to_owned(),
                )
                .into())
            }
        }
    }
    Ok(restore_evidence_edge(edge, &now_us().to_string()))
}

pub(crate) fn run_evidence(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "extract" => {
            let session_id = args.required_option("session")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let records = extract_session_evidence(&snapshot, &session, &session_id)?;
            if records.is_empty() {
                emit(
                    output,
                    json!([]),
                    "No new evidence was found for this session.",
                    args.json(),
                );
                return Ok(0);
            }
            let saved = mutate(path, &snapshot, &records)?;
            emit(
                output,
                plain_array(&saved),
                &format!(
                    "Added {} evidence item(s). Transcript candidates need human review.",
                    saved.len()
                ),
                args.json(),
            );
            Ok(0)
        }
        "list" | "review" => {
            let mut records =
                snapshot.list_records(RecordType::EVIDENCE_NODE, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                records.retain(|record| record.field("session_id") == Some(session));
            }
            if action == "review" {
                records
                    .retain(|record| record.field("verification_state") != Some("human-verified"));
            }
            let count = records.len();
            emit(
                output,
                plain_array(&records),
                if count == 0 {
                    if action == "review" {
                        "No evidence needs review."
                    } else {
                        "No evidence found."
                    }
                } else if count == 1 {
                    "1 evidence item."
                } else {
                    return emit_count(output, records, count, args.json());
                },
                args.json(),
            );
            Ok(0)
        }
        "show" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            emit(
                output,
                plain(&record),
                &format!("Evidence {id}."),
                args.json(),
            );
            Ok(0)
        }
        "create" => {
            let session_id = args.required_option("session")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let source_segment = args.required_option("source-segment")?.to_lowercase();
            let segment = require_live(&snapshot, RecordType::TRANSCRIPT_SEGMENT, &source_segment)?;
            if segment
                .field("session_id")
                .map(str::to_lowercase)
                .as_deref()
                != Some(session_id.as_str())
            {
                return Err(CliError(
                    "Choose a transcript segment from the selected session.".to_owned(),
                )
                .into());
            }
            let evidence_type_raw = args.required_option("type")?;
            validate_evidence_text(evidence_type_raw, "Evidence type", 128)?;
            let title = args.required_option("title")?;
            validate_evidence_text(title, "Evidence title", 512)?;
            let content = args.required_option("content")?;
            validate_evidence_text(content, "Evidence content", 16 * 1024 * 1024)?;
            let evidence_type = evidence_type_raw.trim().to_lowercase();
            if evidence_type.is_empty() || title.trim().is_empty() || content.trim().is_empty() {
                return Err(
                    CliError("Evidence needs a type, title, and content.".to_owned()).into(),
                );
            }
            let priority = args.option("priority").unwrap_or("normal");
            validate_priority(priority)?;
            let record = ArchiveRecord::new(
                RecordType::EVIDENCE_NODE,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session.id.to_lowercase()),
                    (
                        "student_id",
                        session.field("student_id").unwrap_or("").to_owned(),
                    ),
                    ("type", evidence_type),
                    ("title", title.to_owned()),
                    ("content", content.to_owned()),
                    ("priority", priority.to_owned()),
                    ("origin", "tutor-authored".to_owned()),
                    ("source_annotation_id", String::new()),
                    ("source_segment_ids", segment.id.to_lowercase()),
                    ("source_segment_revision", segment.revision.to_string()),
                    (
                        "source_segment_revisions",
                        format!("{}={}", segment.id.to_lowercase(), segment.revision),
                    ),
                    ("source_asset_ids", String::new()),
                    (
                        "source_speaker_label",
                        segment.field("speaker_label").unwrap_or("").to_owned(),
                    ),
                    (
                        "start_time_us",
                        segment.field("start_time_us").unwrap_or("0").to_owned(),
                    ),
                    (
                        "end_time_us",
                        segment.field("end_time_us").unwrap_or("0").to_owned(),
                    ),
                    ("verification_state", "needs-review".to_owned()),
                    ("created_at_us", timestamp_now()),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            emit(
                output,
                plain(&saved[0]),
                "Evidence added to review.",
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
            if action == "approve" && !evidence_sources_are_current(&snapshot, &record)? {
                return Err(CliError(
                    "Evidence cannot be approved because its sources are missing, stale, or from another session."
                        .to_owned(),
                )
                .into());
            }
            record.fields.insert(
                "verification_state".to_owned(),
                if action == "approve" {
                    "human-verified"
                } else {
                    "rejected"
                }
                .to_owned(),
            );
            record
                .fields
                .insert("reviewed_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[record])?;
            emit(
                output,
                plain(&saved[0]),
                "Evidence status updated.",
                args.json(),
            );
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let mut record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            let mut changed = false;
            for (option, field, maximum, multiline) in [
                ("title", "title", 512usize, false),
                ("content", "content", 16 * 1024 * 1024, true),
                ("type", "type", 128, false),
                ("priority", "priority", 128, false),
            ] {
                if let Some(value) = args.option(option) {
                    validate_evidence_text(value, &format!("Evidence {field}"), maximum)?;
                    if value.trim().is_empty() {
                        return Err(CliError(format!("Evidence {field} cannot be empty.")).into());
                    }
                    if field == "priority" {
                        validate_priority(value)?;
                    }
                    let normalized = if field == "type" {
                        normalized_type(value)
                    } else {
                        let mut text = value.to_owned();
                        if !multiline {
                            text = text.trim().to_owned();
                        }
                        text
                    };
                    record.fields.insert(field.to_owned(), normalized);
                    changed = true;
                }
            }
            if !changed {
                return Err(CliError(
                    "Provide a title, content, type, or priority to update.".to_owned(),
                )
                .into());
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
            emit(
                output,
                plain(&saved[0]),
                "Evidence item updated.",
                args.json(),
            );
            Ok(0)
        }
        "delete" => {
            let id = args.required_position(0, "evidence ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::EVIDENCE_NODE, &id)?;
            let timestamp = now_us().to_string();
            let mut changes = vec![mark_evidence_deleted(&record, &id, &timestamp)];
            for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
                if edge.deleted() {
                    continue;
                }
                if edge.field("from_id").map(str::to_lowercase).as_deref() == Some(id.as_str())
                    || edge.field("to_id").map(str::to_lowercase).as_deref() == Some(id.as_str())
                {
                    changes.push(mark_evidence_deleted(&edge, &id, &timestamp));
                }
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let result = saved
                .iter()
                .find(|record| record.id == id)
                .cloned()
                .unwrap_or_else(|| changes[0].clone());
            emit(
                output,
                plain(&result),
                "Evidence item and relationships moved to Trash.",
                args.json(),
            );
            Ok(0)
        }
        "restore" => {
            let id = args
                .required_position(0, "Evidence ID or relationship ID")?
                .to_lowercase();
            let mut changes: Vec<ArchiveRecord> = Vec::new();
            let timestamp = now_us().to_string();
            let node = snapshot.get_record(RecordType::EVIDENCE_NODE, &id)?;
            if node.as_ref().is_some_and(|record| record.deleted()) {
                let node = node.expect("checked record");
                changes.push(restore_evidence_node(&node, &timestamp));
                for edge in snapshot.list_records(RecordType::EVIDENCE_EDGE, true)? {
                    if edge.deleted()
                        && edge
                            .field("_trash_group_id")
                            .map(str::to_lowercase)
                            .as_deref()
                            == Some(id.as_str())
                    {
                        changes.push(restore_evidence_node(&edge, &timestamp));
                    }
                }
            } else {
                let edge = snapshot
                    .get_record(RecordType::EVIDENCE_EDGE, &id)?
                    .filter(ArchiveRecord::deleted)
                    .ok_or_else(|| CliError(format!("Evidence {id} was not found in Trash.")))?;
                changes.push(edge_restore(&snapshot, &edge)?);
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let result = saved
                .iter()
                .find(|record| record.id.to_lowercase() == id)
                .cloned()
                .unwrap_or_else(|| changes[0].clone());
            emit(
                output,
                plain(&result),
                "Evidence restore complete.",
                args.json(),
            );
            Ok(0)
        }
        "link" => evidence_mutations::run_evidence_link(&snapshot, &args, output, path),
        "unlink" => evidence_mutations::run_evidence_unlink(&snapshot, &args, output, path),
        "edges" => evidence_graph::run_evidence_edges(&snapshot, &args, output),
        "graph" => evidence_graph::run_evidence_graph(&snapshot, &args, output),
        _ => Err(CliError(format!(
            "evidence {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

fn emit_count(
    output: &mut dyn CliOutput,
    records: Vec<ArchiveRecord>,
    count: usize,
    json: bool,
) -> CliResult<i32> {
    emit(
        output,
        plain_array(&records),
        &format!("{count} evidence items."),
        json,
    );
    Ok(0)
}

pub(crate) fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value
            .chars()
            .enumerate()
            .all(|(index, character)| match index {
                8 | 13 | 18 | 23 => character == '-',
                _ => character.is_ascii_hexdigit(),
            })
}

fn mark_evidence_deleted(record: &ArchiveRecord, group_id: &str, timestamp: &str) -> ArchiveRecord {
    let mut updated = record.clone();
    updated
        .fields
        .insert("_deleted".to_owned(), "true".to_owned());
    updated
        .fields
        .insert("_trash_group_id".to_owned(), group_id.to_owned());
    updated
        .fields
        .insert("deleted_at_us".to_owned(), timestamp.to_owned());
    updated
}

fn restore_evidence_record(record: &ArchiveRecord, timestamp: &str) -> ArchiveRecord {
    let mut updated = record.clone();
    updated.fields.remove("_deleted");
    updated.fields.remove("_trash_group_id");
    updated.fields.remove("deleted_at_us");
    updated
        .fields
        .insert("restored_at_us".to_owned(), timestamp.to_owned());
    updated
}

fn restore_evidence_node(record: &ArchiveRecord, timestamp: &str) -> ArchiveRecord {
    let mut updated = record.clone();
    updated.fields.remove("_deleted");
    updated.fields.remove("_trash_group_id");
    updated
        .fields
        .insert("restored_at_us".to_owned(), timestamp.to_owned());
    updated
}

fn restore_evidence_edge(record: &ArchiveRecord, timestamp: &str) -> ArchiveRecord {
    let mut updated = restore_evidence_record(record, timestamp);
    updated
        .fields
        .insert("updated_at_us".to_owned(), timestamp.to_owned());
    updated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restoring_clears_deleted_flags_and_edges_refresh_updated_at() {
        let record = ArchiveRecord::new(
            RecordType::EVIDENCE_NODE,
            "00000000-0000-0000-0000-000000000001",
            [
                ("_deleted", "true".to_owned()),
                ("_trash_group_id", "group".to_owned()),
                ("deleted_at_us", "1".to_owned()),
                ("updated_at_us", "1".to_owned()),
                ("title", "Evidence".to_owned()),
            ],
        );
        let node = restore_evidence_node(&record, "2");
        assert!(!node.fields.contains_key("_deleted"));
        assert!(node.fields.contains_key("deleted_at_us"));
        assert_eq!(node.field("updated_at_us"), Some("1"));
        let edge = restore_evidence_edge(&record, "3");
        assert!(!edge.fields.contains_key("deleted_at_us"));
        assert_eq!(edge.field("updated_at_us"), Some("3"));
    }
}
