use super::*;

pub(crate) fn run_session(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "create" => {
            let records = create_session_records(&snapshot, &args)?;
            let saved = mutate(path, &snapshot, &records)?;
            let session = saved
                .iter()
                .find(|record| record.record_type == RecordType::SESSION)
                .cloned()
                .unwrap_or_else(|| records[0].clone());
            emit(
                output,
                plain(&session),
                &format!(
                    "Created session {} ({}) in journal entry {}.",
                    session.field("title").unwrap_or(""),
                    session.id,
                    session.field("entry_id").unwrap_or("")
                ),
                args.json(),
            );
            Ok(0)
        }
        "list" => session_list(&snapshot, &args, output),
        "show" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &id)?;
            let mut value = plain(&session);
            if let Value::Object(map) = &mut value {
                map.insert("entry_id".to_owned(), Value::String(session.field("entry_id").unwrap_or("").to_owned()));
                map.insert("notes_document_id".to_owned(), Value::String(session.field("notes_document_id").unwrap_or("").to_owned()));
                map.insert("session_state".to_owned(), Value::String(session.field("session_state").unwrap_or("active").to_owned()));
                map.insert("session_type".to_owned(), Value::String(session.field("session_type").unwrap_or(if session.field("recording_state") == Some("not-started") { "notes-only" } else { "record-audio" }).to_owned()));
                map.insert("started_at_us".to_owned(), Value::String(session.field("started_at_us").or_else(|| session.field("created_at_us")).unwrap_or("0").to_owned()));
                map.insert("ended_at_us".to_owned(), Value::String(session.field("ended_at_us").unwrap_or("0").to_owned()));
                map.insert("reviewed_at_us".to_owned(), Value::String(session.field("reviewed_at_us").unwrap_or("0").to_owned()));
            }
            emit(
                output,
                value,
                &format!("session {} (revision {})", session.id, session.revision),
                args.json(),
            );
            Ok(0)
        }
        "verify" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &id)?;
            let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
            let transcripts = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
            let assets = snapshot.list_records(RecordType::ASSET_METADATA, false)?;
            let count = |records: &[ArchiveRecord], internal: bool| {
                records
                    .iter()
                    .filter(|record| record.field("session_id").map(str::to_lowercase) == Some(session.id.clone()))
                    .filter(|record| {
                        !internal
                            || !matches!(
                                record.field("record_role"),
                                Some("audio-track")
                                    | Some("recording-take")
                                    | Some("waveform-pyramid")
                                    | Some("sparse-timestamp-seek-index")
                                    | Some("asset-blob-manifest")
                                    | Some("asset-blob-chunk")
                            )
                    })
                    .count()
            };
            let value = json!({
                "session_id": session.id,
                "annotations": count(&annotations, false).to_string(),
                "transcript_segments": count(&transcripts, false).to_string(),
                "assets": count(&assets, true).to_string(),
            });
            emit(
                output,
                value,
                "Session references are internally readable.",
                args.json(),
            );
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::SESSION, &id)?;
            let mut fields = current.fields.clone();
            let mut changed = false;
            for (option, field) in [
                ("title", "title"),
                ("subject", "subject"),
                ("objectives", "learning_objectives"),
                ("learning-objectives", "learning_objectives"),
                ("student-id", "student_id"),
                ("entry-id", "entry_id"),
            ] {
                if let Some(value) = args.option(option) {
                    fields.insert(field.to_owned(), value.to_owned());
                    changed = true;
                }
            }
            if let Some(student_id) = args.option("student-id") {
                if student_id != "anonymous" {
                    require_live(&snapshot, RecordType::STUDENT, student_id)?;
                }
            }
            let mut changes = Vec::new();
            if changed {
                fields.insert("updated_at_us".to_owned(), timestamp_now());
                let mut updated = current.clone();
                updated.fields = fields;
                changes.push(updated);
            }
            if let Some(text) = args.option("notes") {
                let notes_id = current.field("notes_document_id").unwrap_or("");
                if !notes_id.is_empty() {
                    if let Some(mut notes) = snapshot.get_record(RecordType::SETTINGS, notes_id)? {
                        apply_note_text(&mut notes, text);
                        changes.push(notes);
                    }
                }
            }
            if changes.is_empty() {
                return Err(CliError("Provide a session field to update.".to_owned()).into());
            }
            let saved = mutate(path, &snapshot, &changes)?;
            let session = saved
                .iter()
                .find(|record| record.record_type == RecordType::SESSION)
                .cloned()
                .unwrap_or(current);
            emit(
                output,
                plain(&session),
                &format!(
                    "Updated session {} ({}).",
                    session.field("title").unwrap_or(""),
                    session.id
                ),
                args.json(),
            );
            Ok(0)
        }
        "archive" | "unarchive" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::SESSION, &id)?;
            if action == "archive" && current.field("recording_state") == Some("recording") {
                return Err(CoreError::new(
                    "session_archive_invalid",
                    "Stop the active recording before archiving this session.",
                )
                .into());
            }
            let mut updated = current;
            updated.fields.insert(
                "archived".to_owned(),
                if action == "archive" { "true" } else { "false" }.to_owned(),
            );
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[updated])?;
            let message = if action == "archive" {
                format!("Archived session {id}.")
            } else {
                format!("Returned session {id} to current sessions.")
            };
            emit(
                output,
                plain(&saved[0]),
                &message,
                args.json(),
            );
            Ok(0)
        }
        "start" | "complete" | "review" | "resume" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let mut updated = require_live(&snapshot, RecordType::SESSION, &id)?;
            let timestamp = now_us().to_string();
            let state = updated
                .field("session_state")
                .unwrap_or("active")
                .to_owned();
            match action {
                "start" => {
                    if !matches!(state.as_str(), "created" | "active" | "in-progress") {
                        return Err(CoreError::new(
                            "session_transition_invalid",
                            "A completed session must use resume; starting does not restart audio capture.",
                        )
                        .into());
                    }
                    let started_at = updated.field("started_at_us").unwrap_or("0");
                    if started_at.parse::<i64>().map(|value| value <= 0).unwrap_or(true) {
                        updated
                            .fields
                            .insert("started_at_us".to_owned(), timestamp.clone());
                    }
                    updated
                        .fields
                        .insert("session_state".to_owned(), "active".to_owned());
                    updated
                        .fields
                        .insert("ended_at_us".to_owned(), "0".to_owned());
                }
                "complete" => {
                    if !matches!(state.as_str(), "active" | "in-progress") {
                        return Err(CoreError::new(
                            "session_transition_invalid",
                            "Only an active session can be completed.",
                        )
                        .into());
                    }
                    if updated.field("recording_state") == Some("recording") {
                        return Err(CliError(
                            "Stop the active recording before completing the session.".to_owned(),
                        )
                        .into());
                    }
                    updated
                        .fields
                        .insert("session_state".to_owned(), "completed".to_owned());
                    updated
                        .fields
                        .insert("ended_at_us".to_owned(), timestamp.clone());
                    updated
                        .fields
                        .insert("last_completed_at_us".to_owned(), timestamp.clone());
                }
                "review" => {
                    if !matches!(state.as_str(), "completed" | "reviewed") {
                        return Err(CoreError::new(
                            "session_transition_invalid",
                            "Complete the session before marking it reviewed.",
                        )
                        .into());
                    }
                    updated
                        .fields
                        .insert("session_state".to_owned(), "reviewed".to_owned());
                    updated
                        .fields
                        .insert("reviewed_at_us".to_owned(), timestamp.clone());
                }
                _ => {
                    if !matches!(state.as_str(), "completed" | "reviewed") {
                        return Err(CoreError::new(
                            "session_transition_invalid",
                            "Only a completed or reviewed session can be resumed.",
                        )
                        .into());
                    }
                    updated
                        .fields
                        .insert("session_state".to_owned(), "active".to_owned());
                    updated
                        .fields
                        .insert("resumed_at_us".to_owned(), timestamp.clone());
                    updated
                        .fields
                        .insert("ended_at_us".to_owned(), "0".to_owned());
                }
            }
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp);
            let saved = mutate(path, &snapshot, &[updated])?;
            let action_message = match action {
                "start" => "started",
                "complete" => "completed",
                "review" => "marked reviewed",
                _ => "resumed",
            };
            emit(
                output,
                plain(&saved[0]),
                &format!("Session {id} {action_message}."),
                args.json(),
            );
            Ok(0)
        }
        "delete" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &id)?;
            let plan = plan_session_trash(&snapshot, &session).map_err(|error| CliError(error.message.clone()))?;
            let token = session_scope_token(&plan.scope_records);
            let records_moved = plan.total_records - plan.entries_updated;
            let summary = json!({
                "status": "confirmation-required",
                "session_id": id,
                "scope_token": token,
                "audio_chunks": plan.audio_chunk_count.to_string(),
                "waveform_indices": plan.waveform_indices.to_string(),
                "session_notes": plan.session_notes.to_string(),
                "transcript_segments": plan.transcript_segments.to_string(),
                "annotations": plan.annotations.to_string(),
                "guides": plan.guides.to_string(),
                "assets": plan.assets.to_string(),
                "entries_updated": plan.entries_updated.to_string(),
                "evidence_nodes": plan.evidence_nodes.to_string(),
                "evidence_edges": plan.evidence_edges.to_string(),
                "total_records": plan.total_records.to_string(),
            });
            if args.flag("dry-run") || !args.flag("confirm-scope") {
                emit(
                    output,
                    summary,
                    &format!(
                        "Deleting this session would affect {} records: move {records_moved} to Trash, including {} audio chunks, {} guides, and {} materials; detach {} journal entries. Review the scope, then repeat with --confirm-scope --scope-token {}.",
                        plan.total_records,
                        plan.audio_chunk_count,
                        plan.guides,
                        plan.assets,
                        plan.entries_updated,
                        token
                    ),
                    args.json(),
                );
                return Ok(0);
            }
            if args.option("scope-token") != Some(token.as_str()) {
                return Err(CliError(
                    "Deletion scope confirmation is missing or stale. Review the current scope and confirm it with the returned --scope-token."
                        .to_owned(),
                )
                .into());
            }
            let fresh = load(path, context)?;
            if fresh.commit.generation != snapshot.commit.generation {
                return Err(CliError(
                    "The archive changed after this operation was reviewed. Review it again before retrying."
                        .to_owned(),
                )
                .into());
            }
            let timestamp = now_us().to_string();
            let mut changes = plan.changes.clone();
            for chunk in &plan.audio_chunks {
                changes.push(mark_session_trashed(chunk, &id, &timestamp));
            }
            mutate(path, &fresh, &changes)?;
            let mut result = summary;
            if let Value::Object(map) = &mut result {
                map.insert("status".to_owned(), Value::String("deleted".to_owned()));
            }
            emit(
                output,
                result,
                "Session and associated records moved to recoverable Trash.",
                args.json(),
            );
            Ok(0)
        }
        "restore" => {
            let id = args.required_position(0, "session ID")?.to_lowercase();
            let session = snapshot
                .get_record(RecordType::SESSION, &id)?
                .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?;
            if !session.deleted() {
                return Err(CliError(format!("Session {id} is not in Trash.")).into());
            }
            let changes = plan_session_restore(&snapshot, &session)
                .map_err(|error| CliError(error.message.clone()))?;
            mutate(path, &snapshot, &changes)?;
            emit(
                output,
                json!({
                    "status": "restored",
                    "session_id": id,
                    "restored_records": changes.len().to_string(),
                }),
                &format!(
                    "Restored session {id} and {} associated records.",
                    changes.len().saturating_sub(1)
                ),
                args.json(),
            );
            Ok(0)
        }
        "clone" => session_clone(&snapshot, &args, output, path),
        "export" => run_session_export(&snapshot, &args, output, path),
        "import" => run_session_import(&snapshot, &args, output, path),
        "recover" => {
            let id = args.required_option("session")?.to_lowercase();
            let session = require_live(&snapshot, RecordType::SESSION, &id)?;
            let has_tracks = !session.field("recording_track_id").unwrap_or("").is_empty()
                || !session.field("recording_track_ids").unwrap_or("").is_empty();
            if !has_tracks {
                let import_state = session.field("audio_import_state").unwrap_or("");
                if !["importing", "finalizing", "interrupted", "completed"]
                    .contains(&import_state)
                {
                    return Err(CoreError::new(
                        "audio_recovery_unavailable",
                        "This session has no recoverable WAV import metadata.",
                    )
                    .into());
                }
            }
            let value = json!({
                "session_id": id,
                "status": "no-recovery-required",
                "recovered_chunks": 0,
            });
            emit(
                output,
                value,
                "No unfinished native recording was found for this session.",
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("session {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

