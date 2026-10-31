use super::*;

pub(crate) fn run_transcript_edit(
    action: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args
        .required_position(0, "transcript segment ID")?
        .to_lowercase();
    if action == "history" {
        let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
        let history = snapshot.get_record_history(RecordType::TRANSCRIPT_SEGMENT, &id, limit)?;
        if history.is_empty() {
            return Err(CliError(format!("Transcript segment was not found: {id}")).into());
        }
        let rows: Vec<Value> = history
            .iter()
            .enumerate()
            .map(|(index, record)| {
                let mut value = transcript_json(record);
                if let Value::Object(map) = &mut value {
                    map.insert("type".to_owned(), Value::String("transcript".to_owned()));
                    map.insert("history_index".to_owned(), Value::Number(index.into()));
                }
                value
            })
            .collect();
        emit(
            output,
            Value::Array(rows),
            &format!("{} revision(s).", history.len()),
            args.json(),
        );
        return Ok(0);
    }
    if action == "restore" {
        let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
        let history = snapshot.get_record_history(RecordType::TRANSCRIPT_SEGMENT, &id, limit)?;
        if history.is_empty() {
            return Err(CliError(format!("Transcript segment was not found: {id}")).into());
        }
        let revision = parse_integer(args.option("revision"), "revision", 0, 1, 10_000)? as usize;
        if revision == 0 {
            return Err(
                CliError("--revision must be an integer from 1 through 10000.".to_owned()).into(),
            );
        }
        let record = history.get(revision).ok_or_else(|| {
            CliError(format!(
                "Transcript history index {revision} was not found."
            ))
        })?;
        let mut restored = record.clone();
        restored.fields.remove("_deleted");
        restored.fields.remove("deleted_at_us");
        restored
            .fields
            .insert("restored_from_revision".to_owned(), revision.to_string());
        restored
            .fields
            .insert("updated_at_us".to_owned(), timestamp_now());
        let saved = mutate(path, snapshot, &[restored])?;
        emit(
            output,
            transcript_json(&saved[0]),
            &format!("Transcript revision {revision} restored as a new revision."),
            args.json(),
        );
        return Ok(0);
    }
    let current = require_live(snapshot, RecordType::TRANSCRIPT_SEGMENT, &id)?;
    match action {
        "correct" => {
            let text = args.required_option("text")?;
            if text.is_empty() {
                return Err(CliError("--text is required.".to_owned()).into());
            }
            validate_cue_text(text)?;
            let mut updated = current;
            updated.fields.insert("text".to_owned(), text.to_owned());
            updated.fields.insert(
                "verification_state".to_owned(),
                "human-corrected".to_owned(),
            );
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            updated
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, snapshot, &[updated])?;
            emit(
                output,
                transcript_json(&saved[0]),
                "Transcript segment corrected.",
                args.json(),
            );
            Ok(0)
        }
        "timestamp" => {
            let start = parse_transcript_timestamp(args.required_option("start")?)?;
            let end = parse_transcript_timestamp(args.required_option("end")?)?;
            if end < start {
                return Err(
                    CliError("Transcript end time precedes its start time.".to_owned()).into(),
                );
            }
            let mut updated = current;
            updated
                .fields
                .insert("start_time_us".to_owned(), start.to_string());
            updated
                .fields
                .insert("end_time_us".to_owned(), end.to_string());
            updated
                .fields
                .insert("timestamp_state".to_owned(), "timestamped".to_owned());
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            updated
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, snapshot, &[updated])?;
            emit(
                output,
                transcript_json(&saved[0]),
                "Transcript timestamp updated.",
                args.json(),
            );
            Ok(0)
        }
        "verify" => {
            let state = args.option("state").unwrap_or("human-verified");
            if !matches!(state, "human-verified" | "provisional" | "needs-review") {
                return Err(CliError(
                    "Verification state must be human-verified, provisional, or needs-review."
                        .to_owned(),
                )
                .into());
            }
            let mut updated = current;
            updated
                .fields
                .insert("verification_state".to_owned(), state.to_owned());
            updated
                .fields
                .insert("verified_at_us".to_owned(), timestamp_now());
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            updated
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, snapshot, &[updated])?;
            emit(
                output,
                transcript_json(&saved[0]),
                "Transcript verification updated.",
                args.json(),
            );
            Ok(0)
        }
        "speaker" => {
            let name_provided = args.option("name").is_some();
            let speaker_provided = args.option("speaker").is_some();
            if args.flag("unknown") && (name_provided || speaker_provided) {
                return Err(CliError(
                    "Use either --unknown or a speaker name, not both.".to_owned(),
                )
                .into());
            }
            let label = args.option("name").or_else(|| args.option("speaker"));
            let mut updated = current;
            if args.flag("unknown") {
                updated
                    .fields
                    .insert("speaker_label".to_owned(), "Unknown speaker".to_owned());
                updated
                    .fields
                    .insert("speaker_assignment_state".to_owned(), "unknown".to_owned());
            } else if let Some(label) = label.filter(|value| !value.is_empty()) {
                updated
                    .fields
                    .insert("speaker_label".to_owned(), label.trim().to_owned());
                updated.fields.insert(
                    "speaker_assignment_state".to_owned(),
                    "tutor-labeled".to_owned(),
                );
            } else {
                return Err(CliError(
                    "Provide --name <label>, --speaker <label>, or --unknown.".to_owned(),
                )
                .into());
            }
            updated
                .fields
                .insert("speaker_identity_verified".to_owned(), "false".to_owned());
            updated
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            updated
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, snapshot, &[updated])?;
            emit(
                output,
                transcript_json(&saved[0]),
                "Transcript speaker updated.",
                args.json(),
            );
            Ok(0)
        }
        "split" => {
            let before = args
                .option("before")
                .ok_or_else(|| CliError("--before and --after are required.".to_owned()))?
                .to_owned();
            let after = args
                .option("after")
                .ok_or_else(|| CliError("--before and --after are required.".to_owned()))?
                .to_owned();
            if before.is_empty()
                || after.is_empty()
                || format!("{before}{after}") != current.field("text").unwrap_or("")
            {
                return Err(CoreError::new(
                    "transcript_split_invalid",
                    "The before and after text must exactly preserve the original cue.",
                )
                .into());
            }
            validate_cue_text(&before)?;
            validate_cue_text(&after)?;
            let timestamp = now_us().to_string();
            let mut first = current.clone();
            first.fields.insert("text".to_owned(), before);
            first
                .fields
                .insert("updated_at_us".to_owned(), timestamp.clone());
            first
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp.clone());
            let mut second = current.clone();
            second.id = crate::core::archive::new_uuid();
            second.fields.insert("text".to_owned(), after);
            second
                .fields
                .insert("created_at_us".to_owned(), timestamp.clone());
            second
                .fields
                .insert("updated_at_us".to_owned(), timestamp.clone());
            second
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp.clone());
            if current.field("timestamp_state") != Some("not-timestamped") {
                let raw = args.option("at").ok_or_else(|| {
                    CoreError::new(
                        "transcript_split_time_required",
                        "Choose a split time for this timestamped cue.",
                    )
                })?;
                let split = parse_transcript_timestamp(raw)?;
                let start = current
                    .field("start_time_us")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                let end = current
                    .field("end_time_us")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                if split <= start || split >= end {
                    return Err(CoreError::new(
                        "transcript_split_time_invalid",
                        "The split time must fall strictly inside the cue's timestamp range.",
                    )
                    .into());
                }
                first
                    .fields
                    .insert("end_time_us".to_owned(), split.to_string());
                second
                    .fields
                    .insert("start_time_us".to_owned(), split.to_string());
            }
            let saved = mutate(path, snapshot, &[first, second])?;
            emit(
                output,
                transcript_json(&saved[1]),
                "Transcript segment split.",
                args.json(),
            );
            Ok(0)
        }
        "merge" => {
            let ids: Vec<String> = args
                .positionals
                .iter()
                .map(|value| value.to_lowercase())
                .collect();
            if ids.len() < 2 {
                return Err(CliError(
                    "Provide at least two transcript segment IDs to merge.".to_owned(),
                )
                .into());
            }
            let mut records = Vec::new();
            let mut seen_ids = BTreeSet::new();
            for id in &ids {
                if !seen_ids.insert(id.clone()) {
                    return Err(CliError(
                        "A transcript cue can only appear once in a merge.".to_owned(),
                    )
                    .into());
                }
                records.push(require_live(snapshot, RecordType::TRANSCRIPT_SEGMENT, id)?);
            }
            let session_id = records[0].field("session_id").unwrap_or("").to_owned();
            let speaker = records[0].field("speaker_label").unwrap_or("").to_owned();
            let timestamped = records[0].field("timestamp_state") != Some("not-timestamped");
            let mut texts = Vec::new();
            let mut linked_assets: BTreeSet<String> = BTreeSet::new();
            let mut previous_start = records[0]
                .field("start_time_us")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            for (index, record) in records.iter().enumerate() {
                if record.field("session_id") != Some(session_id.as_str()) {
                    return Err(CoreError::new(
                        "transcript_merge_session_mismatch",
                        "All transcript cues must belong to the same session.",
                    )
                    .into());
                }
                if record.field("speaker_label").unwrap_or("") != speaker {
                    return Err(CoreError::new(
                        "transcript_merge_speaker_mismatch",
                        "Cues with different speaker labels cannot be merged.",
                    )
                    .into());
                }
                if (record.field("timestamp_state") != Some("not-timestamped")) != timestamped {
                    return Err(CoreError::new(
                        "transcript_merge_timestamp_mismatch",
                        "Timestamped and untimestamped cues cannot be merged together.",
                    )
                    .into());
                }
                if index > 0 && timestamped {
                    let start = record
                        .field("start_time_us")
                        .and_then(|value| value.parse::<i64>().ok())
                        .unwrap_or(0);
                    if start < previous_start {
                        return Err(CoreError::new(
                            "transcript_merge_order",
                            "Provide timestamped cues in chronological order.",
                        )
                        .into());
                    }
                    previous_start = start;
                }
                texts.push(record.field("text").unwrap_or("").to_owned());
                for id in split_ids(record.field("linked_asset_ids").unwrap_or("")) {
                    linked_assets.insert(id);
                }
            }
            let separator = args.option("separator").unwrap_or(" ");
            validate_cue_text(separator)?;
            let mut text = String::new();
            for next in texts {
                if text.is_empty() {
                    text = next;
                    continue;
                }
                let needs_separator = !separator.is_empty()
                    && !text.chars().last().map(char::is_whitespace).unwrap_or(true)
                    && !next.chars().next().map(char::is_whitespace).unwrap_or(true);
                if needs_separator {
                    text.push_str(separator);
                }
                text.push_str(&next);
            }
            let timestamp = now_us().to_string();
            let mut merged = records[0].clone();
            merged.fields.insert("text".to_owned(), text);
            merged.fields.insert(
                "linked_asset_ids".to_owned(),
                linked_assets.into_iter().collect::<Vec<_>>().join(","),
            );
            if timestamped {
                merged.fields.insert(
                    "start_time_us".to_owned(),
                    records[0].field("start_time_us").unwrap_or("0").to_owned(),
                );
                merged.fields.insert(
                    "end_time_us".to_owned(),
                    records
                        .last()
                        .and_then(|record| record.field("end_time_us"))
                        .unwrap_or("0")
                        .to_owned(),
                );
            }
            merged
                .fields
                .insert("updated_at_us".to_owned(), timestamp.clone());
            merged
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp.clone());
            let mut changes = vec![merged];
            for record in records.iter().skip(1) {
                let mut deleted = record.clone();
                deleted
                    .fields
                    .insert("_deleted".to_owned(), "true".to_owned());
                deleted
                    .fields
                    .insert("updated_at_us".to_owned(), timestamp.clone());
                changes.push(deleted);
            }
            let saved = mutate(path, snapshot, &changes)?;
            emit(
                output,
                transcript_json(&saved[0]),
                "Transcript segments merged.",
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!(
            "transcript {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}
