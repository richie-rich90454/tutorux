use super::*;

pub(crate) fn journal_list(
    action: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let query = args.option("query");
    if action == "search" && query.is_none() {
        return Err(CliError("--query is required.".to_owned()).into());
    }
    if let Some(query) = query {
        if query.trim().is_empty() {
            return Err(CliError("Provide non-empty --query text.".to_owned()).into());
        }
    }
    let search_mode = query.is_some();
    let folded_query = query.unwrap_or("").to_lowercase();
    let filter_id = |name: &str| -> CliResult<Option<String>> {
        let Some(value) = args.option(name).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        if !crate::core::format::valid_uuid(value) {
            return Err(CliError(format!("--{name} must be a valid UUID.")).into());
        }
        Ok(Some(value.to_lowercase()))
    };
    let collection_id = filter_id("collection-id")?;
    let tag_id = filter_id("tag-id")?;
    let from = args.option("from");
    let to = args.option("to");
    for (name, date) in [("from", from), ("to", to)] {
        if let Some(date) = date {
            let parts: Vec<&str> = date.split('-').collect();
            let valid = parts.len() == 3
                && parts[0].len() == 4
                && parts[1].len() == 2
                && parts[2].len() == 2
                && parts.iter().all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
                && {
                    let days = days_from_civil(
                        parts[0].parse().unwrap_or(0),
                        parts[1].parse().unwrap_or(0),
                        parts[2].parse().unwrap_or(0),
                    );
                    civil_date(days) == *date
                };
            if !valid {
                return Err(CliError(format!("--{name} must be a valid YYYY-MM-DD date.")).into());
            }
        }
    }
    if let (Some(from), Some(to)) = (from, to) {
        if from > to {
            return Err(CliError("--from must not be later than --to.".to_owned()).into());
        }
    }
    let has_sessions = args.option("has-sessions");
    if let Some(value) = has_sessions {
        if value != "true" && value != "false" {
            return Err(CliError("--has-sessions must be true or false.".to_owned()).into());
        }
    }

    let settings = snapshot.list_records(RecordType::SETTINGS, false)?;
    let sessions = snapshot.list_records(RecordType::SESSION, false)?;
    let transcripts = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
    let guides = snapshot.list_records(RecordType::GUIDE, false)?;
    let mut rows: Vec<(ArchiveRecord, Option<String>, Option<String>, Vec<String>)> = Vec::new();
    for entry in settings
        .iter()
        .filter(|record| record.field("record_role") == Some("journal-entry"))
    {
        let entry_id = entry.id.to_lowercase();
        let linked_sessions: Vec<&ArchiveRecord> = sessions
            .iter()
            .filter(|session| {
                session.field("entry_id").map(str::to_lowercase).as_deref()
                    == Some(entry_id.as_str())
            })
            .collect();
        let session_ids: Vec<String> = linked_sessions
            .iter()
            .map(|session| session.id.to_lowercase())
            .collect();
        let id_set: BTreeSet<&String> = session_ids.iter().collect();
        let ids = |key: &str| -> Vec<String> { split_ids(entry.field(key).unwrap_or("")) };
        if collection_id
            .as_ref()
            .map(|id| !ids("collection_ids").contains(id))
            .unwrap_or(false)
            || tag_id
                .as_ref()
                .map(|id| !ids("tag_ids").contains(id))
                .unwrap_or(false)
        {
            continue;
        }
        let date = entry.field("entry_date").unwrap_or("");
        if from.map(|from| date < from).unwrap_or(false)
            || to.map(|to| date > to).unwrap_or(false)
            || has_sessions == Some("true") && session_ids.is_empty()
            || has_sessions == Some("false") && !session_ids.is_empty()
        {
            continue;
        }
        let mut candidates: Vec<(&str, String)> =
            vec![("title", entry.field("title").unwrap_or("").to_owned())];
        for note in settings
            .iter()
            .filter(|record| record.field("record_role") == Some("journal-notes"))
        {
            let note_entry = note.field("entry_id").unwrap_or("").to_lowercase();
            let note_session = note.field("session_id").unwrap_or("").to_lowercase();
            if note_entry != entry_id && !id_set.contains(&note_session) {
                continue;
            }
            for (key, value) in &note.fields {
                if is_note_text_key(key) {
                    candidates.push(("notes", value.clone()));
                }
            }
        }
        for cue in &transcripts {
            let cue_session = cue.field("session_id").unwrap_or("").to_lowercase();
            if id_set.contains(&cue_session) {
                candidates.push(("transcript", cue.field("text").unwrap_or("").to_owned()));
            }
        }
        for guide in &guides {
            let guide_entry = guide.field("entry_id").unwrap_or("").to_lowercase();
            let guide_session = guide.field("session_id").unwrap_or("").to_lowercase();
            if guide_entry != entry_id && !id_set.contains(&guide_session) {
                continue;
            }
            candidates.push(("guide", guide.field("title").unwrap_or("").to_owned()));
            let section_count = guide
                .field("section_count")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            for index in 0..section_count {
                let prefix = format!("section.{index}.");
                candidates.push((
                    "guide",
                    guide.field(&format!("{prefix}heading")).unwrap_or("").to_owned(),
                ));
                let block_count = guide
                    .field(&format!("{prefix}block_count"))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                for block in 0..block_count {
                    candidates.push((
                        "guide",
                        guide
                            .field(&format!("{prefix}block.{block}.text"))
                            .unwrap_or("")
                            .to_owned(),
                    ));
                }
            }
        }
        let matched = if search_mode {
            candidates
                .into_iter()
                .find(|(_, text)| text.to_lowercase().contains(&folded_query))
        } else {
            None
        };
        if search_mode && matched.is_none() {
            continue;
        }
        let excerpt = matched.as_ref().map(|(_, text)| {
            let folded = text.to_lowercase();
            let offset = folded.find(&folded_query).unwrap_or(0);
            let characters: Vec<char> = text.chars().collect();
            let start = folded[..offset].chars().count();
            let begin = start.saturating_sub(48);
            characters
                .into_iter()
                .skip(begin)
                .take(180)
                .collect::<String>()
        });
        rows.push((
            entry.clone(),
            matched.map(|(source, _)| source.to_owned()),
            excerpt,
            session_ids,
        ));
    }
    rows.sort_by(|left, right| {
        let left_created = left.0.field("created_at_us").unwrap_or("0");
        let right_created = right.0.field("created_at_us").unwrap_or("0");
        right_created
            .cmp(left_created)
            .then_with(|| left.0.id.cmp(&right.0.id))
    });
    let result: Vec<Value> = rows
        .iter()
        .map(|(record, source, excerpt, session_ids)| {
            let mut row = match plain(record) {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            row.insert(
                "session_ids".to_owned(),
                Value::String(session_ids.join(",")),
            );
            row.insert(
                "session_count".to_owned(),
                Value::String(session_ids.len().to_string()),
            );
            if let Some(source) = source {
                row.insert("match_source".to_owned(), Value::String(source.clone()));
            }
            if let Some(excerpt) = excerpt {
                row.insert("excerpt".to_owned(), Value::String(excerpt.clone()));
            }
            Value::Object(row)
        })
        .collect();
    let summary = if rows.is_empty() {
        if search_mode {
            "No journal entries matched the search."
        } else {
            "No journal entries in this archive."
        }
        .to_owned()
    } else {
        rows.iter()
            .map(|(record, source, excerpt, session_ids)| {
                format!(
                    "{}  {}  {}  {} session(s){}",
                    record.id,
                    record.field("title").unwrap_or(""),
                    record.field("entry_date").unwrap_or(""),
                    session_ids.len(),
                    source
                        .as_ref()
                        .map(|source| format!("  [{source}] {}", excerpt.as_deref().unwrap_or("")))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    emit(output, Value::Array(result), &summary, args.json());
    Ok(0)
}

pub(crate) fn is_note_text_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("block.") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once('.') else {
        return false;
    };
    suffix == "text" && !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
}

