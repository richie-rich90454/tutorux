use super::*;

#[path = "guide_actions.rs"]
mod guide_actions;
#[path = "guide_inspect.rs"]
mod guide_inspect;

pub(crate) fn guide_source_records(snapshot: &ArchiveSnapshot) -> Result<Vec<ArchiveRecord>> {
    let mut records = Vec::new();
    for record_type in [
        RecordType::STUDENT,
        RecordType::SESSION,
        RecordType::SETTINGS,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
    ] {
        records.extend(snapshot.list_records(record_type, false)?);
    }
    Ok(records)
}

pub(crate) fn read_guide_scope(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
) -> CliResult<GuideScope> {
    let session = require_live(snapshot, RecordType::SESSION, session_id)?;
    Ok(GuideScope {
        session: Some(session),
        entry: None,
        records: guide_source_records(snapshot)?,
    })
}

pub(crate) fn read_guide_entry_scope(
    snapshot: &ArchiveSnapshot,
    entry_id: &str,
) -> CliResult<GuideScope> {
    let entry = require_live(snapshot, RecordType::SETTINGS, entry_id)?;
    if entry.field("record_role") != Some("journal-entry") {
        return Err(CliError(format!("Journal entry {entry_id} was not found.")).into());
    }
    Ok(GuideScope {
        session: None,
        entry: Some(entry),
        records: guide_source_records(snapshot)?,
    })
}

pub(crate) fn read_guide_context(
    snapshot: &ArchiveSnapshot,
    id: &str,
) -> CliResult<(ArchiveRecord, GuideDraft, GuideScope)> {
    let current = require_live(snapshot, RecordType::GUIDE, id)?;
    let draft = guide_draft(&current);
    let scope = if !draft.session_id.is_empty() {
        read_guide_scope(snapshot, &draft.session_id)?
    } else if !draft.entry_id.is_empty() {
        read_guide_entry_scope(snapshot, &draft.entry_id)?
    } else {
        return Err(
            CliError("This guide has no journal entry or session scope.".to_owned()).into(),
        );
    };
    Ok((current, draft, scope))
}

pub(crate) fn run_guide(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "list" => {
            let mut records =
                snapshot.list_records(RecordType::GUIDE, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                let session = session.to_lowercase();
                records.retain(|record| {
                    record.field("session_id").map(str::to_lowercase).as_deref()
                        == Some(session.as_str())
                });
            }
            if let Some(entry) = args.option("entry-id") {
                let entry = entry.to_lowercase();
                let session_ids: BTreeSet<String> = snapshot
                    .list_records(RecordType::SESSION, false)?
                    .into_iter()
                    .filter(|session| {
                        session.field("entry_id").map(str::to_lowercase).as_deref()
                            == Some(entry.as_str())
                    })
                    .map(|session| session.id.to_lowercase())
                    .collect();
                records.retain(|record| {
                    record.field("entry_id").map(str::to_lowercase).as_deref()
                        == Some(entry.as_str())
                        || session_ids
                            .contains(&record.field("session_id").unwrap_or("").to_lowercase())
                });
            }
            let count = records.len();
            emit(
                output,
                plain_array(&records),
                if count == 0 {
                    "No study guides."
                } else if count == 1 {
                    "1 study guide."
                } else {
                    return emit_guide_list(output, records, count, args.json());
                },
                args.json(),
            );
            Ok(0)
        }
        "create" => guide_actions::guide_create(&snapshot, &args, output, path),
        "generate" => guide_actions::guide_generate(&snapshot, &args, output, path),
        "regenerate" | "approve" | "duplicate" | "update" | "edit" | "add-section" | "section"
        | "remove-section" | "move-section" | "add-block" | "remove-block" | "move-block"
        | "update-block" => guide_actions::guide_edit(action, &snapshot, &args, output, path),
        "validate" | "compare" | "show" | "export" | "history" | "trash" | "delete" | "restore" => {
            guide_inspect::run_guide_inspect(action, &snapshot, &args, output, path)
        }
        _ => Err(CliError(format!(
            "guide {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

fn emit_guide_list(
    output: &mut dyn CliOutput,
    records: Vec<ArchiveRecord>,
    count: usize,
    json: bool,
) -> CliResult<i32> {
    emit(
        output,
        plain_array(&records),
        &format!("{count} study guides."),
        json,
    );
    Ok(0)
}
