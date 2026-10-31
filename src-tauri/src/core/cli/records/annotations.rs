use super::*;
#[path = "annotation_plan.rs"]
mod annotation_plan;

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

pub(crate) fn parse_timestamp(value: &str) -> CliResult<i64> {
    let normalized = value.trim().replace(',', ".");
    if normalized.is_empty() {
        return Ok(0);
    }
    if !normalized.contains(':') {
        if !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()).into());
        }
        let seconds: i64 = normalized
            .parse()
            .map_err(|_| CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()))?;
        return Ok(seconds.saturating_mul(1_000_000));
    }
    let normalized = if normalized.matches(':').count() == 1 {
        format!("00:{normalized}")
    } else {
        normalized
    };
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() != 3 {
        return Err(CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()).into());
    }
    let hours: i64 = parts[0]
        .parse()
        .map_err(|_| CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()))?;
    let minutes: i64 = parts[1]
        .parse()
        .map_err(|_| CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()))?;
    let seconds_part: Vec<&str> = parts[2].split('.').collect();
    if seconds_part.len() > 2
        || parts[1].len() > 2
        || seconds_part[0].len() > 2
        || !parts[0].bytes().all(|byte| byte.is_ascii_digit())
        || !parts[1].bytes().all(|byte| byte.is_ascii_digit())
        || !seconds_part[0].bytes().all(|byte| byte.is_ascii_digit())
        || minutes > 59
        || seconds_part[0].parse::<i64>().unwrap_or(60) > 59
    {
        return Err(CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()).into());
    }
    let seconds: i64 = seconds_part[0]
        .parse()
        .map_err(|_| CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()))?;
    let fraction = seconds_part.get(1).copied().unwrap_or("");
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) || fraction.len() > 6 {
        return Err(CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()).into());
    }
    let micros = if fraction.is_empty() {
        0
    } else {
        let padded = format!("{fraction:0<6}");
        padded[..6]
            .parse::<i64>()
            .map_err(|_| CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()))?
    };
    Ok(((hours * 3600 + minutes * 60 + seconds) * 1_000_000) + micros)
}

pub(crate) const ANNOTATION_TYPES: [&str; 10] = [
    "general-note",
    "important-concept",
    "student-mistake",
    "tutor-correction",
    "explicit-instruction",
    "worked-example",
    "follow-up-priority",
    "student-question",
    "learning-outcome",
    "custom",
];

pub(crate) fn run_annotation(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "plan" => annotation_plan::run_annotation_plan(&snapshot, &args, output),
        "add" => {
            let session_id = args.required_option("session")?.to_lowercase();
            require_live(&snapshot, RecordType::SESSION, &session_id)?;
            let annotation_type = args.option("type").unwrap_or("general-note");
            if !ANNOTATION_TYPES.contains(&annotation_type) {
                return Err(CliError("Unsupported annotation type.".to_owned()).into());
            }
            let priority = args.option("priority").unwrap_or("normal");
            if !matches!(priority, "low" | "normal" | "high" | "critical") {
                return Err(CliError("Priority must be low, normal, high, or critical.".to_owned()).into());
            }
            let start = parse_timestamp(args.required_option("at")?)?;
            let end = match args.option("end") {
                Some(value) if !value.trim().is_empty() => parse_timestamp(value)?,
                _ => start,
            };
            if end < start {
                return Err(CliError("Annotation end time precedes its start.".to_owned()).into());
            }
            let timestamp = now_us().to_string();
            let record = ArchiveRecord::new(
                RecordType::ANNOTATION,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session_id),
                    ("start_time_us", start.to_string()),
                    ("end_time_us", end.to_string()),
                    ("type", annotation_type.to_owned()),
                    ("priority", priority.to_owned()),
                    ("title", args.option("title").unwrap_or("").to_owned()),
                    ("content", args.option("text").unwrap_or("").to_owned()),
                    ("origin", "tutor-authored".to_owned()),
                    ("created_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            emit(output, plain(&saved[0]), "Annotation added.", args.json());
            Ok(0)
        }
        "list" => {
            let mut records = snapshot.list_records(RecordType::ANNOTATION, args.flag("include-deleted"))?;
            if let Some(session) = args.option("session") {
                records.retain(|record| record.field("session_id").map(str::to_lowercase) == Some(session.to_lowercase()));
            }
            records.sort_by(|left, right| {
                let left_start: i64 = left.field("start_time_us").unwrap_or("0").parse().unwrap_or(0);
                let right_start: i64 = right.field("start_time_us").unwrap_or("0").parse().unwrap_or(0);
                left_start.cmp(&right_start).then_with(|| left.id.cmp(&right.id))
            });
            emit(output, plain_array(&records), &format!("{} annotation(s).", records.len()), args.json());
            Ok(0)
        }
        "show" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::ANNOTATION, &id)?;
            emit(output, plain(&record), "Annotation.", args.json());
            Ok(0)
        }
        "update" | "duplicate" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ANNOTATION, &id)?;
            if action == "duplicate" {
                let mut duplicate = current.clone();
                duplicate.id = crate::core::archive::new_uuid();
                duplicate.fields.remove("_deleted");
                let timestamp = now_us().to_string();
                duplicate.fields.insert("created_at_us".to_owned(), timestamp.clone());
                duplicate.fields.insert("updated_at_us".to_owned(), timestamp);
                let saved = mutate(path, &snapshot, &[duplicate])?;
                emit(output, plain(&saved[0]), "Annotation duplicated.", args.json());
                return Ok(0);
            }
            let mut fields = current.fields.clone();
            let mut changed = false;
            for (option, field) in [
                ("text", "content"),
                ("title", "title"),
                ("type", "type"),
                ("priority", "priority"),
            ] {
                if let Some(value) = args.option(option) {
                    if field == "type" && !ANNOTATION_TYPES.contains(&value) {
                        return Err(CliError("Unsupported annotation type.".to_owned()).into());
                    }
                    if field == "priority"
                        && !matches!(value, "low" | "normal" | "high" | "critical")
                    {
                        return Err(CliError(
                            "Priority must be low, normal, high, or critical.".to_owned(),
                        )
                        .into());
                    }
                    fields.insert(field.to_owned(), value.to_owned());
                    changed = true;
                }
            }
            let start = if let Some(value) = args.option("start").or_else(|| args.option("at")) {
                changed = true;
                parse_timestamp(value)?
            } else {
                current.field("start_time_us").unwrap_or("0").parse().unwrap_or(0)
            };
            let end = if let Some(value) = args.option("end").or_else(|| args.option("at")) {
                changed = true;
                parse_timestamp(value)?
            } else {
                current.field("end_time_us").unwrap_or("0").parse().unwrap_or(0)
            };
            if !changed {
                return Err(CliError("Provide an annotation field to update.".to_owned()).into());
            }
            fields.insert("start_time_us".to_owned(), start.to_string());
            fields.insert("end_time_us".to_owned(), end.to_string());
            fields.insert("updated_at_us".to_owned(), timestamp_now());
            let mut updated = current;
            updated.fields = fields;
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(output, plain(&saved[0]), "Annotation updated.", args.json());
            Ok(0)
        }
        "remove" | "prioritize" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ANNOTATION, &id)?;
            let updated = if action == "remove" {
                trash(&current)
            } else {
                let priority = args.option("priority").ok_or_else(|| CliError("--priority is required.".to_owned()))?;
                let mut updated = current;
                updated.fields.insert("priority".to_owned(), priority.to_owned());
                updated.fields.insert("updated_at_us".to_owned(), timestamp_now());
                updated
            };
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(output, plain(&saved[0]), "Annotation updated.", args.json());
            Ok(0)
        }
        "history" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
            let history = snapshot.get_record_history(RecordType::ANNOTATION, &id, limit)?;
            let rows: Vec<Value> = history
                .iter()
                .enumerate()
                .map(|(index, record)| {
                    let mut value = plain(record);
                    if let Value::Object(map) = &mut value {
                        map.insert("history_index".to_owned(), Value::Number(index.into()));
                    }
                    value
                })
                .collect();
            emit(output, Value::Array(rows), &format!("{} revision(s).", history.len()), args.json());
            Ok(0)
        }
        "restore" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let limit = parse_integer(args.option("limit"), "limit", 100, 1, 10_000)? as usize;
            let history = snapshot.get_record_history(RecordType::ANNOTATION, &id, limit)?;
            if history.is_empty() {
                return Err(CliError(format!("Annotation was not found: {id}")).into());
            }
            let revision = parse_integer(args.option("revision"), "revision", 0, 1, 10_000)? as usize;
            if revision == 0 {
                return Err(CliError("--revision must be an integer from 1 through 10000.".to_owned()).into());
            }
            let record = history
                .get(revision)
                .ok_or_else(|| CliError(format!("Annotation history index {revision} was not found.")))?;
            let mut restored = record.clone();
            restored.fields.remove("_deleted");
            restored.fields.remove("deleted_at_us");
            restored
                .fields
                .insert("restored_from_revision".to_owned(), revision.to_string());
            restored
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            restored
                .fields
                .insert("human_edited_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[restored])?;
            emit(
                output,
                plain(&saved[0]),
                &format!("Annotation revision {revision} restored."),
                args.json(),
            );
            Ok(0)
        }
        "merge" => {
            let ids: Vec<String> = args.positionals.iter().map(|value| value.to_lowercase()).collect();
            if ids.len() < 2 {
                return Err(CliError("Provide at least two annotation IDs to merge.".to_owned()).into());
            }
            let unique: BTreeSet<&String> = ids.iter().collect();
            if unique.len() != ids.len() {
                return Err(CliError(
                    "Each annotation ID may appear only once in a merge.".to_owned(),
                )
                .into());
            }
            let mut annotations = Vec::new();
            for id in &ids {
                annotations.push(require_live(&snapshot, RecordType::ANNOTATION, id)?);
            }
            let first = annotations[0].clone();
            let session_id = first.field("session_id").unwrap_or("").to_owned();
            let annotation_type = first.field("type").unwrap_or("general-note").to_owned();
            let priority = first.field("priority").unwrap_or("normal").to_owned();
            let mut contents = Vec::new();
            let mut titles: Vec<String> = Vec::new();
            let mut links: BTreeMap<&str, BTreeSet<String>> = [
                ("linked_asset_ids", BTreeSet::new()),
                ("linked_evidence_ids", BTreeSet::new()),
                ("source_segment_ids", BTreeSet::new()),
            ]
            .into_iter()
            .collect();
            let mut end = first.field("end_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
            let mut previous_start: i64 = -1;
            for record in &annotations {
                if record.field("session_id") != Some(session_id.as_str()) {
                    return Err(CliError("All annotations must belong to the same session.".to_owned()).into());
                }
                if record.field("type") != Some(annotation_type.as_str())
                    || record.field("priority") != Some(priority.as_str())
                {
                    return Err(CliError("Annotations must have the same type and priority to merge.".to_owned()).into());
                }
                let start = record.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                if start < previous_start {
                    return Err(CliError("Provide annotations in chronological order.".to_owned()).into());
                }
                previous_start = start;
                contents.push(record.field("content").unwrap_or("").to_owned());
                if let Some(title) = record.field("title") {
                    if !title.is_empty() && !titles.iter().any(|existing| existing == title) {
                        titles.push(title.to_owned());
                    }
                }
                for (field, values) in &mut links {
                    for value in record.field(field).unwrap_or("").split(',').map(str::trim) {
                        if !value.is_empty() {
                            values.insert(value.to_owned());
                        }
                    }
                }
                end = end.max(record.field("end_time_us").unwrap_or("0").parse().unwrap_or(0));
            }
            let separator = args.option("separator").unwrap_or("\n");
            let mut merged = first;
            merged.fields.insert("content".to_owned(), contents.join(separator));
            merged.fields.insert("end_time_us".to_owned(), end.to_string());
            merged.fields.insert("merged_titles".to_owned(), titles.join("\n"));
            merged.fields.insert("source_annotation_ids".to_owned(), ids.join(","));
            for (field, values) in links {
                merged
                    .fields
                    .insert(field.to_owned(), values.into_iter().collect::<Vec<_>>().join(","));
            }
            merged.fields.insert("updated_at_us".to_owned(), timestamp_now());
            let mut changes = vec![merged];
            for record in annotations.iter().skip(1) {
                changes.push(trash(record));
            }
            let saved = mutate(path, &snapshot, &changes)?;
            emit(output, plain(&saved[0]), "Annotations merged.", args.json());
            Ok(0)
        }
        "split" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::ANNOTATION, &id)?;
            let before = args
                .option("before")
                .ok_or_else(|| CliError("--before and --after are required.".to_owned()))?;
            let after = args
                .option("after")
                .ok_or_else(|| CliError("--before and --after are required.".to_owned()))?;
            if before.is_empty()
                || after.is_empty()
                || format!("{before}{after}") != current.field("content").unwrap_or("")
            {
                return Err(CliError(
                    "The before and after text must be non-empty and exactly preserve the original annotation."
                        .to_owned(),
                )
                .into());
            }
            let start = current.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
            let end = current.field("end_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
            let split = match args.option("at") {
                Some(value) => parse_timestamp(value)?,
                None => {
                    if start != end {
                        return Err(CliError("Splitting a time range requires --at within the annotation.".to_owned()).into());
                    }
                    start
                }
            };
            if split < start || split > end || (start != end && (split == start || split == end)) {
                return Err(CliError("The split time must be inside the annotation range.".to_owned()).into());
            }
            let timestamp = now_us().to_string();
            let mut first = current.clone();
            first.fields.insert("content".to_owned(), before.to_owned());
            first.fields.insert("end_time_us".to_owned(), split.to_string());
            first.fields.insert("updated_at_us".to_owned(), timestamp.clone());
            let mut second = current.clone();
            second.id = crate::core::archive::new_uuid();
            second.fields.insert("content".to_owned(), after.to_owned());
            second.fields.insert("start_time_us".to_owned(), split.to_string());
            second.fields.insert("end_time_us".to_owned(), end.to_string());
            second.fields.insert("created_at_us".to_owned(), timestamp.clone());
            second.fields.insert("updated_at_us".to_owned(), timestamp);
            let saved = mutate(path, &snapshot, &[first, second])?;
            emit(output, plain(&saved[1]), "Annotation split.", args.json());
            Ok(0)
        }
        "link" | "unlink" => {
            let id = args.required_position(0, "annotation ID")?.to_lowercase();
            let target = args.required_option("to")?.to_lowercase();
            let target_id = args.required_option("target-id")?.to_lowercase();
            let field = match target.as_str() {
                "asset" => "linked_asset_ids",
                "evidence" => "linked_evidence_ids",
                _ => return Err(CliError("--to must be asset or evidence.".to_owned()).into()),
            };
            let mut current = require_live(&snapshot, RecordType::ANNOTATION, &id)?;
            let value = if action == "link" {
                merge_ids(current.field(field).unwrap_or(""), &target_id)
            } else {
                remove_ids(current.field(field).unwrap_or(""), &target_id)
            };
            current.fields.insert(field.to_owned(), value);
            current.fields.insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, &snapshot, &[current])?;
            emit(output, plain(&saved[0]), "Annotation link updated.", args.json());
            Ok(0)
        }
        _ => Err(CliError(format!("annotation {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

