use super::*;

pub(crate) fn session_list(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
            let mut records = snapshot.list_records(RecordType::SESSION, args.flag("include-deleted"))?;
            if args.flag("unarchived") || !args.flag("archived") {
                records.retain(|record| record.field("archived") != Some("true"));
            }
            if let Some(student_id) = args.option("student-id") {
                let student_id = student_id.to_lowercase();
                records.retain(|record| {
                    record.field("student_id").map(str::to_lowercase).as_deref()
                        == Some(student_id.as_str())
                });
            }
            if let Some(entry_id) = args.option("entry-id") {
                let entry_id = crate::core::format::valid_uuid(entry_id)
                    .then(|| entry_id.to_lowercase())
                    .ok_or_else(|| CliError("--entry-id must be a valid UUID.".to_owned()))?;
                records.retain(|record| {
                    record.field("entry_id").map(str::to_lowercase).as_deref()
                        == Some(entry_id.as_str())
                });
            }
            let from = date_bound(args.option("from"), false)?;
            let to = date_bound(args.option("to"), true)?;
            if let (Some(from), Some(to)) = (from, to) {
                if from > to {
                    return Err(CliError("--from must not be later than --to.".to_owned()).into());
                }
            }
            if from.is_some() || to.is_some() {
                records.retain(|record| {
                    let started = session_started_at_us(record) as i128;
                    from.map(|value| started >= value).unwrap_or(true)
                        && to.map(|value| started <= value).unwrap_or(true)
                });
            }
            records.sort_by(|left, right| {
                session_started_at_us(right)
                    .cmp(&session_started_at_us(left))
                    .then_with(|| left.id.cmp(&right.id))
            });
            let mut transcript_counts: BTreeMap<String, usize> = BTreeMap::new();
            if args.json() {
                for transcript in snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)? {
                    let session_id = transcript
                        .field("session_id")
                        .unwrap_or("")
                        .to_lowercase();
                    if !session_id.is_empty() {
                        *transcript_counts.entry(session_id).or_insert(0) += 1;
                    }
                }
            }
            let rows: Vec<Value> = records
                .iter()
                .map(|record| {
                    let audio_chunk_count = record.field("recording_audio_chunks").unwrap_or("0");
                    let audio_duration = record.field("recording_duration_us").unwrap_or("0");
                    let transcript_count = transcript_counts
                        .get(&record.id.to_lowercase())
                        .copied()
                        .unwrap_or(0);
                    let mut row = match plain(record) {
                        Value::Object(map) => map,
                        _ => Map::new(),
                    };
                    let fallback_type = if record.field("recording_state") == Some("not-started") {
                        "notes-only"
                    } else {
                        "record-audio"
                    };
                    row.insert("entry_id".to_owned(), Value::String(record.field("entry_id").unwrap_or("").to_owned()));
                    row.insert("notes_document_id".to_owned(), Value::String(record.field("notes_document_id").unwrap_or("").to_owned()));
                    row.insert("session_id".to_owned(), Value::String(record.id.clone()));
                    row.insert("title".to_owned(), Value::String(record.field("title").unwrap_or("Untitled session").to_owned()));
                    row.insert("session_type".to_owned(), Value::String(record.field("session_type").unwrap_or(fallback_type).to_owned()));
                    row.insert("session_state".to_owned(), Value::String(record.field("session_state").unwrap_or("active").to_owned()));
                    row.insert("recording_state".to_owned(), Value::String(record.field("recording_state").unwrap_or("not-started").to_owned()));
                    row.insert("started_at_us".to_owned(), Value::String(record.field("started_at_us").or_else(|| record.field("created_at_us")).unwrap_or("0").to_owned()));
                    row.insert("ended_at_us".to_owned(), Value::String(record.field("ended_at_us").unwrap_or("0").to_owned()));
                    row.insert("reviewed_at_us".to_owned(), Value::String(record.field("reviewed_at_us").unwrap_or("0").to_owned()));
                    row.insert("audio_chunk_count".to_owned(), Value::String(audio_chunk_count.to_owned()));
                    row.insert("audio_duration_us".to_owned(), Value::String(audio_duration.to_owned()));
                    row.insert("has_audio".to_owned(), Value::String(if audio_chunk_count != "0" || audio_duration != "0" { "true" } else { "false" }.to_owned()));
                    row.insert("transcript_segment_count".to_owned(), Value::String(transcript_count.to_string()));
                    row.insert("has_transcript".to_owned(), Value::String(if transcript_count > 0 { "true" } else { "false" }.to_owned()));
                    Value::Object(row)
                })
                .collect();
            let summary = if records.is_empty() {
                "No sessions in this archive.".to_owned()
            } else {
                records
                    .iter()
                    .map(|record| {
                        format!(
                            "{}  {} · {}  [{}]",
                            record.id,
                            record.field("subject").unwrap_or(""),
                            record.field("title").unwrap_or(""),
                            record.field("processing_state").unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            emit(output, Value::Array(rows), &summary, args.json());
            Ok(0)
}
