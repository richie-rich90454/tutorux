use super::*;

pub(crate) fn run_journal_organizer(
    kind: &str,
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    let is_collection = kind == "collection";
    let role = if is_collection { "journal-collection" } else { "journal-tag" };
    let label = if is_collection { "Collection" } else { "Tag" };
    let Some(action) = args.positionals.first().map(String::as_str) else {
        return Err(CliError(format!("Choose a {kind} action.")).into());
    };
    let record_id = args.positionals.get(1).map(|value| value.to_lowercase());
    let find_organizer = |include_deleted: bool| -> CliResult<ArchiveRecord> {
        let id = record_id
            .clone()
            .ok_or_else(|| CliError(format!("{kind} {action} requires a {kind} ID.")))?;
        let record = snapshot
            .get_record(RecordType::SETTINGS, &id)?
            .ok_or_else(|| CliError(format!("{label} {id} was not found.")))?;
        if record.field("record_role") != Some(role)
            || (!include_deleted && record.deleted())
            || (include_deleted && !record.deleted())
        {
            return Err(CliError(format!("{label} {id} was not found.")).into());
        }
        Ok(record)
    };
    let ensure_unique = |name: &str, except: &str| -> CliResult<()> {
        let normalized = name.trim().to_lowercase();
        if normalized.is_empty() {
            return Err(CliError("Journal label name cannot be empty.".to_owned()).into());
        }
        for record in snapshot.list_records(RecordType::SETTINGS, false)? {
            if record.field("record_role") == Some(role)
                && record.id != except
                && record.field("name").unwrap_or("").trim().to_lowercase() == normalized
            {
                return Err(CliError(format!(
                    "{label} name already exists in this archive."
                ))
                .into());
            }
        }
        Ok(())
    };
    match action {
        "list" => {
            let mut records: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::SETTINGS, args.flag("include-deleted"))?
                .into_iter()
                .filter(|record| record.field("record_role") == Some(role))
                .collect();
            records.sort_by(|left, right| {
                left.field("name")
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&right.field("name").unwrap_or("").to_lowercase())
            });
            let rows = plain_array(&records);
            let summary = if records.is_empty() {
                format!("No {kind}s in this archive.")
            } else {
                records
                    .iter()
                    .map(|record| format!("{}  {}", record.id, record.field("name").unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            emit(output, rows, &summary, args.json());
            Ok(0)
        }
        "create" => {
            let name = args.required_option("name")?.to_owned();
            ensure_unique(&name, "")?;
            if let Some(color) = args.option("color") {
                if !color.is_empty()
                    && (color.len() != 7
                        || !color.starts_with('#')
                        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
                {
                    return Err(CliError("Choose a color in #RRGGBB format.".to_owned()).into());
                }
            }
            let timestamp = now_us().to_string();
            let mut fields = vec![
                ("record_role", role.to_owned()),
                ("name", name.clone()),
                ("color", args.option("color").unwrap_or("").to_lowercase()),
            ];
            if is_collection {
                fields.push(("description", args.option("description").unwrap_or("").to_owned()));
            }
            fields.push(("created_at_us", timestamp.clone()));
            fields.push(("updated_at_us", timestamp));
            let record = ArchiveRecord::new(
                RecordType::SETTINGS,
                crate::core::archive::new_uuid(),
                fields,
            );
            let saved = mutate(path, snapshot, &[record])?;
            let result = &saved[0];
            emit(
                output,
                plain(result),
                &format!("Created {kind} {} ({}).", result.field("name").unwrap_or(""), result.id),
                args.json(),
            );
            Ok(0)
        }
        "show" => {
            let record = find_organizer(false)?;
            emit(
                output,
                plain(&record),
                &format!("{} ({})", record.field("name").unwrap_or(""), record.id),
                args.json(),
            );
            Ok(0)
        }
        "update" => {
            let provides_field = ["name", "color"].iter().any(|key| args.option(key).is_some())
                || (is_collection && args.option("description").is_some());
            if !provides_field {
                return Err(CliError("Provide at least one supported field to update.".to_owned()).into());
            }
            let mut record = find_organizer(false)?;
            let name = args
                .option("name")
                .map(str::to_owned)
                .unwrap_or_else(|| record.field("name").unwrap_or("").to_owned());
            ensure_unique(&name, &record.id)?;
            record.fields.insert("name".to_owned(), name);
            if let Some(color) = args.option("color") {
                if !color.is_empty()
                    && (color.len() != 7
                        || !color.starts_with('#')
                        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
                {
                    return Err(CliError("Choose a color in #RRGGBB format.".to_owned()).into());
                }
                record
                    .fields
                    .insert("color".to_owned(), color.to_lowercase());
            }
            if is_collection {
                if let Some(description) = args.option("description") {
                    record
                        .fields
                        .insert("description".to_owned(), description.to_owned());
                }
            }
            record
                .fields
                .insert("updated_at_us".to_owned(), timestamp_now());
            let saved = mutate(path, snapshot, &[record])?;
            let result = &saved[0];
            emit(
                output,
                plain(result),
                &format!("Updated {kind} {} ({}).", result.field("name").unwrap_or(""), result.id),
                args.json(),
            );
            Ok(0)
        }
        "delete" | "restore" => {
            let current = find_organizer(action == "restore")?;
            let mut changes = Vec::new();
            if action == "delete" {
                let mut trashed = trash(&current);
                trashed
                    .fields
                    .insert("_trash_group_id".to_owned(), current.id.clone());
                changes.push(trashed);
            } else {
                changes.push(restore(&current));
            }
            if let Some(id) = record_id.as_deref() {
                let restore_field = if is_collection {
                    "_trash_restore_collection_refs"
                } else {
                    "_trash_restore_tag_refs"
                };
                for entry in snapshot.list_records(RecordType::SETTINGS, true)? {
                    if entry.field("record_role") != Some("journal-entry") {
                        continue;
                    }
                    let key = if is_collection { "collection_ids" } else { "tag_ids" };
                    let mut fields = entry.fields.clone();
                    let mut changed = false;
                    if action == "delete" {
                        let existing = split_ids(fields.get(key).map(String::as_str).unwrap_or(""));
                        if existing.iter().any(|item| item == id) {
                            fields.insert(
                                key.to_owned(),
                                existing
                                    .iter()
                                    .filter(|item| *item != id)
                                    .cloned()
                                    .collect::<Vec<_>>()
                                    .join(","),
                            );
                            fields.insert(
                                restore_field.to_owned(),
                                merge_ids(
                                    fields.get(restore_field).map(String::as_str).unwrap_or(""),
                                    id,
                                ),
                            );
                            changed = true;
                        }
                    } else {
                        let pending = split_ids(
                            fields.get(restore_field).map(String::as_str).unwrap_or(""),
                        );
                        if pending.iter().any(|item| item == id) {
                            fields.insert(
                                key.to_owned(),
                                merge_ids(fields.get(key).map(String::as_str).unwrap_or(""), id),
                            );
                            let remaining: Vec<String> =
                                pending.into_iter().filter(|item| item != id).collect();
                            if remaining.is_empty() {
                                fields.remove(restore_field);
                            } else {
                                fields.insert(restore_field.to_owned(), remaining.join(","));
                            }
                            changed = true;
                        }
                    }
                    if changed {
                        fields.insert("updated_at_us".to_owned(), timestamp_now());
                        let mut entry = entry;
                        entry.fields = fields;
                        changes.push(entry);
                    }
                }
            }
            mutate(path, snapshot, &changes)?;
            emit(
                output,
                json!({"status": if action == "delete" { "deleted" } else { "restored" }, "id": record_id.unwrap_or_default()}),
                &format!(
                    "{label} {}.",
                    if action == "delete" {
                        "archived and detached from entries"
                    } else {
                        "restored with its prior entry links"
                    }
                ),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("journal {kind} {action} is not implemented.")).into()),
    }
}

