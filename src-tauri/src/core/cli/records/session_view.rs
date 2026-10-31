use super::*;

pub(crate) fn run_session_show(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let id = args.required_position(0, "session ID")?.to_lowercase();
    let session = require_live(snapshot, RecordType::SESSION, &id)?;
    let mut value = plain(&session);
    if let Value::Object(map) = &mut value {
        map.insert(
            "entry_id".to_owned(),
            Value::String(session.field("entry_id").unwrap_or("").to_owned()),
        );
        map.insert(
            "notes_document_id".to_owned(),
            Value::String(session.field("notes_document_id").unwrap_or("").to_owned()),
        );
        map.insert(
            "session_state".to_owned(),
            Value::String(
                session
                    .field("session_state")
                    .unwrap_or("active")
                    .to_owned(),
            ),
        );
        map.insert(
            "session_type".to_owned(),
            Value::String(
                session
                    .field("session_type")
                    .unwrap_or(if session.field("recording_state") == Some("not-started") {
                        "notes-only"
                    } else {
                        "record-audio"
                    })
                    .to_owned(),
            ),
        );
        map.insert(
            "started_at_us".to_owned(),
            Value::String(
                session
                    .field("started_at_us")
                    .or_else(|| session.field("created_at_us"))
                    .unwrap_or("0")
                    .to_owned(),
            ),
        );
        map.insert(
            "ended_at_us".to_owned(),
            Value::String(session.field("ended_at_us").unwrap_or("0").to_owned()),
        );
        map.insert(
            "reviewed_at_us".to_owned(),
            Value::String(session.field("reviewed_at_us").unwrap_or("0").to_owned()),
        );
    }
    emit(
        output,
        value,
        &format!("session {} (revision {})", session.id, session.revision),
        args.json(),
    );
    Ok(0)
}

pub(crate) fn run_session_verify(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let id = args.required_position(0, "session ID")?.to_lowercase();
    let session = require_live(snapshot, RecordType::SESSION, &id)?;
    let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
    let transcripts = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
    let assets = snapshot.list_records(RecordType::ASSET_METADATA, false)?;
    let count = |records: &[ArchiveRecord], internal: bool| {
        records
            .iter()
            .filter(|record| {
                record.field("session_id").map(str::to_lowercase) == Some(session.id.clone())
            })
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
