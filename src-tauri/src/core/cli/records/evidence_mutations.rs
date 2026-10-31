use super::*;

pub(crate) fn run_evidence_link(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let from = args.required_option("from")?.to_lowercase();
    let to = args.required_option("to")?.to_lowercase();
    let relationship = args.required_option("relationship")?.trim().to_lowercase();
    if !is_uuid(&from) || !is_uuid(&to) || from == to {
        return Err(CliError("Choose two different evidence items.".to_owned()).into());
    }
    if !EVIDENCE_RELATIONSHIPS.contains(&relationship.as_str()) {
        return Err(CoreError::new(
            "evidence_edge_relationship_invalid",
            "Choose a supported evidence relationship.",
        )
        .into());
    }
    let from_record = require_live(snapshot, RecordType::EVIDENCE_NODE, &from)?;
    let to_record = require_live(snapshot, RecordType::EVIDENCE_NODE, &to)?;
    let session_id = from_record.field("session_id").unwrap_or("");
    if session_id.is_empty() || session_id != to_record.field("session_id").unwrap_or("") {
        return Err(CoreError::new(
            "evidence_edge_session_mismatch",
            "Evidence relationships must stay within one session.",
        )
        .into());
    }
    let duplicate = snapshot
        .list_records(RecordType::EVIDENCE_EDGE, false)?
        .iter()
        .any(|edge| {
            edge.field("from_id") == Some(from_record.id.as_str())
                && edge.field("to_id") == Some(to_record.id.as_str())
                && edge.field("relationship") == Some(relationship.as_str())
        });
    if duplicate {
        return Err(CliError("That evidence relationship already exists.".to_owned()).into());
    }
    let record = ArchiveRecord::new(
        RecordType::EVIDENCE_EDGE,
        crate::core::archive::new_uuid(),
        [
            ("session_id", session_id.to_owned()),
            ("from_id", from_record.id.clone()),
            ("to_id", to_record.id.clone()),
            ("relationship", relationship),
            ("created_at_us", now_us().to_string()),
        ],
    );
    let saved = mutate(path, snapshot, &[record])?;
    emit(
        output,
        plain(&saved[0]),
        "Evidence relationship created.",
        args.json(),
    );
    Ok(0)
}

pub(crate) fn run_evidence_unlink(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let id = args
        .required_position(0, "Evidence relationship ID")?
        .to_lowercase();
    let record = require_live(snapshot, RecordType::EVIDENCE_EDGE, &id)?;
    let timestamp = now_us().to_string();
    let saved = mutate(
        path,
        snapshot,
        &[mark_evidence_deleted(&record, &id, &timestamp)],
    )?;
    emit(
        output,
        plain(&saved[0]),
        "Evidence relationship moved to Trash.",
        args.json(),
    );
    Ok(0)
}
