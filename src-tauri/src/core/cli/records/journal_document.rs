use super::*;

pub(crate) fn run_journal_document(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    const KINDS: [&str; 7] = [
        "paragraph",
        "heading",
        "bullet-list",
        "numbered-list",
        "checklist",
        "quote",
        "code",
    ];
    let Some(action) = args.positionals.first().map(String::as_str) else {
        return Err(CliError("Choose a journal document action and provide a document ID.".to_owned()).into());
    };
    if !matches!(
        action,
        "show" | "update" | "add-block" | "remove-block" | "restore-block" | "move-block"
    ) {
        return Err(CliError("Choose a journal document action and provide a document ID.".to_owned()).into());
    }
    let id = args
        .positionals
        .get(1)
        .map(|value| value.to_lowercase())
        .ok_or_else(|| CliError("Choose a journal document action and provide a document ID.".to_owned()))?;
    let mut document = require_live(snapshot, RecordType::SETTINGS, &id)?;
    if document.field("record_role") != Some("journal-notes") {
        return Err(CliError("Journal notes document was not found.".to_owned()).into());
    }
    if let Some(revision) = args.option("revision") {
        if action != "show" {
            return Err(CliError("--revision is only supported when showing a document.".to_owned()).into());
        }
        let index = parse_integer(Some(revision), "revision", 1, 1, 10_000)? as usize - 1;
        let history = snapshot.get_record_history(RecordType::SETTINGS, &id, index + 1)?;
        document = history
            .get(index)
            .cloned()
            .ok_or_else(|| CliError("Document revision was not found.".to_owned()))?;
    }
    let mut blocks = note_blocks(&document);
    if action == "show" {
        let text = blocks
            .iter()
            .map(|(_, _, text)| text.clone())
            .collect::<Vec<_>>()
            .join("\n");
        let block_values: Vec<Value> = blocks
            .iter()
            .map(|(id, kind, text)| json!({"id": id, "kind": kind, "text": text}))
            .collect();
        let blocks_json = serde_json::to_string(&block_values).unwrap_or_else(|_| "[]".to_owned());
        emit(
            output,
            json!({
                "document_id": document.id,
                "entry_id": document.field("entry_id").unwrap_or(""),
                "session_id": document.field("session_id").unwrap_or(""),
                "revision": document.revision.to_string(),
                "text": text,
                "blocks_json": blocks_json,
                "created_at_us": document.field("created_at_us").unwrap_or(""),
                "updated_at_us": document.field("updated_at_us").unwrap_or(""),
                "blocks": block_values,
            }),
            &blocks
                .iter()
                .map(|(_, _, text)| text.clone())
                .collect::<Vec<_>>()
                .join("\n"),
            args.json(),
        );
        return Ok(0);
    }

    let mut removed: Vec<((String, String, String), usize)> = Vec::new();
    let removed_count = parse_integer(
        document.field("removed_block_count"),
        "removed block count",
        0,
        0,
        256,
    )? as usize;
    for index in 0..removed_count {
        let prefix = format!("removed_block_{index}_");
        let block_id = document.field(&format!("{prefix}id")).unwrap_or("").to_owned();
        let kind = document.field(&format!("{prefix}kind")).unwrap_or("").to_owned();
        let position = document.field(&format!("{prefix}index")).unwrap_or("");
        if block_id.is_empty()
            || !KINDS.contains(&kind.as_str())
            || position.is_empty()
            || !position.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(CliError("Removed block recovery data is invalid.".to_owned()).into());
        }
        removed.push((
            (
                block_id,
                kind,
                document.field(&format!("{prefix}text")).unwrap_or("").to_owned(),
            ),
            position.parse().unwrap_or(0),
        ));
    }
    if removed.is_empty() {
        if let Some(block_id) = document.field("last_removed_block_id") {
            let kind = document.field("last_removed_block_kind").unwrap_or("");
            let index = document.field("last_removed_block_index").unwrap_or("");
            if !KINDS.contains(&kind) || index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(CliError("Legacy block recovery data is invalid.".to_owned()).into());
            }
            removed.push((
                (
                    block_id.to_owned(),
                    kind.to_owned(),
                    document.field("last_removed_block_text").unwrap_or("").to_owned(),
                ),
                index.parse().unwrap_or(0),
            ));
        }
    }
    let read_kind = || -> CliResult<String> {
        let kind = args.required_option("kind")?.to_owned();
        if !KINDS.contains(&kind.as_str()) {
            return Err(CliError("Unsupported note block kind.".to_owned()).into());
        }
        Ok(kind)
    };
    match action {
        "add-block" => {
            let index = parse_integer(
                args.option("block-index"),
                "block-index",
                blocks.len() as u64,
                0,
                blocks.len() as u64,
            )? as usize;
            blocks.insert(
                index,
                (
                    crate::core::archive::new_uuid(),
                    read_kind()?,
                    args.required_option("text")?.to_owned(),
                ),
            );
        }
        "remove-block" => {
            let block_id = args.required_option("block-id")?.to_lowercase();
            let Some(index) = blocks.iter().position(|(id, _, _)| id.to_lowercase() == block_id) else {
                return Err(CliError("Note block was not found.".to_owned()).into());
            };
            if removed.len() >= 256 {
                return Err(CliError("Restore a removed block before deleting more.".to_owned()).into());
            }
            removed.push((blocks.remove(index), index));
        }
        "restore-block" => {
            let block_id = args.required_option("block-id")?.to_lowercase();
            let Some(last) = removed.last().cloned() else {
                return Err(CliError("Restore removed note blocks in reverse order.".to_owned()).into());
            };
            if last.0 .0.to_lowercase() != block_id {
                return Err(CliError("Restore removed note blocks in reverse order.".to_owned()).into());
            }
            if blocks.iter().any(|(id, _, _)| id.to_lowercase() == block_id) {
                return Err(CliError("The block is already present.".to_owned()).into());
            }
            removed.pop();
            let position = last.1.min(blocks.len());
            blocks.insert(position, last.0);
        }
        "move-block" => {
            if blocks.is_empty() {
                return Err(CliError("There are no note blocks to move.".to_owned()).into());
            }
            let from = args.option("from").map(str::to_owned);
            let to = args.option("to").map(str::to_owned);
            let from = parse_integer(from.as_deref(), "from", u64::MAX, 0, (blocks.len() - 1) as u64)?;
            let to = parse_integer(to.as_deref(), "to", u64::MAX, 0, (blocks.len() - 1) as u64)?;
            if from == u64::MAX || to == u64::MAX {
                return Err(CliError("--from and --to are required.".to_owned()).into());
            }
            let block = blocks.remove(from as usize);
            blocks.insert(to as usize, block);
        }
        _ => {
            if let Some(block_id) = args.option("block-id") {
                let block_id = block_id.to_lowercase();
                let Some(block) = blocks.iter_mut().find(|(id, _, _)| id.to_lowercase() == block_id) else {
                    return Err(CliError("Note block was not found.".to_owned()).into());
                };
                block.2 = args.required_option("text")?.to_owned();
                if args.option("kind").is_some() {
                    block.1 = read_kind()?;
                }
            } else if let Some(text) = args.option("text") {
                blocks = reconcile_note_blocks(&blocks, text);
            } else {
                return Err(CliError("Provide --text TEXT, optionally with --block-id ID.".to_owned()).into());
            }
        }
    }

    let session_id = document.field("session_id").unwrap_or("").to_owned();
    let owner_id = if session_id.is_empty() {
        document.field("entry_id").unwrap_or("").to_owned()
    } else {
        session_id.clone()
    };
    if owner_id.is_empty() {
        return Err(CliError("Select an active session or journal entry to save notes.".to_owned()).into());
    }
    let owner = require_live(
        snapshot,
        if session_id.is_empty() {
            RecordType::SETTINGS
        } else {
            RecordType::SESSION
        },
        &owner_id,
    )?;
    if session_id.is_empty() && owner.field("record_role") != Some("journal-entry") {
        return Err(CliError("Select an active session or journal entry to save notes.".to_owned()).into());
    }
    let timestamp = now_us().to_string();
    let mut changes = Vec::new();
    if owner.field("notes_document_id") != Some(document.id.as_str()) {
        let mut updated_owner = owner;
        updated_owner
            .fields
            .insert("notes_document_id".to_owned(), document.id.clone());
        updated_owner
            .fields
            .insert("updated_at_us".to_owned(), timestamp.clone());
        changes.push(updated_owner);
    }
    apply_blocks(&mut document, &blocks);
    for key in document
        .fields
        .keys()
        .filter(|key| key.starts_with("removed_block_") || key.starts_with("last_removed_block_"))
        .cloned()
        .collect::<Vec<_>>()
    {
        document.fields.remove(&key);
    }
    document
        .fields
        .insert("removed_block_count".to_owned(), removed.len().to_string());
    for (index, ((block_id, kind, text), position)) in removed.iter().enumerate() {
        let prefix = format!("removed_block_{index}_");
        document.fields.insert(format!("{prefix}id"), block_id.clone());
        document.fields.insert(format!("{prefix}kind"), kind.clone());
        document.fields.insert(format!("{prefix}text"), text.clone());
        document.fields.insert(format!("{prefix}index"), position.to_string());
    }
    if let Some(((block_id, kind, text), position)) = removed.last() {
        document
            .fields
            .insert("last_removed_block_id".to_owned(), block_id.clone());
        document
            .fields
            .insert("last_removed_block_kind".to_owned(), kind.clone());
        document
            .fields
            .insert("last_removed_block_text".to_owned(), text.clone());
        document
            .fields
            .insert("last_removed_block_index".to_owned(), position.to_string());
    }
    document.fields.insert("entry_id".to_owned(), owner_id.clone());
    document.fields.insert("session_id".to_owned(), session_id);
    changes.push(document);
    let saved = mutate(path, snapshot, &changes)?;
    let saved_document = saved
        .iter()
        .find(|record| record.id == id)
        .or_else(|| changes.iter().find(|record| record.id == id))
        .ok_or_else(|| CliError("Unable to update the notes document.".to_owned()))?;
    emit(
        output,
        json!({
            "document_id": saved_document.id,
            "entry_id": saved_document.field("entry_id").unwrap_or(""),
            "revision": saved_document.revision.to_string(),
            "status": "saved",
        }),
        "Journal notes document updated.",
        args.json(),
    );
    Ok(0)
}

pub(crate) fn apply_blocks(record: &mut ArchiveRecord, blocks: &[(String, String, String)]) {
    let keys: Vec<String> = record
        .fields
        .keys()
        .filter(|key| key.starts_with("block."))
        .cloned()
        .collect();
    for key in keys {
        record.fields.remove(&key);
    }
    record
        .fields
        .insert("block_count".to_owned(), blocks.len().to_string());
    for (index, (id, kind, text)) in blocks.iter().enumerate() {
        record.fields.insert(format!("block.{index}.id"), id.clone());
        record
            .fields
            .insert(format!("block.{index}.kind"), kind.clone());
        record
            .fields
            .insert(format!("block.{index}.text"), text.clone());
    }
    record
        .fields
        .insert("updated_at_us".to_owned(), now_us().to_string());
}

