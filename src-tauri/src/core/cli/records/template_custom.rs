use super::*;

pub(crate) fn run_template(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "list" => {
            let stored = snapshot.list_records(RecordType::SETTINGS, false)?;
            let mut rows: Vec<Value> = Vec::new();
            for (id, name, subject, description, body, sections) in builtin_templates() {
                let mut effective_name = name;
                let mut effective_subject = subject;
                let mut effective_description = description;
                let mut effective_body = body;
                let mut effective_sections: Vec<String> =
                    sections.iter().map(|value| (*value).to_owned()).collect();
                if let Some(record) = stored.iter().find(|record| {
                    record.field("record_role") == Some("guide-template")
                        && record.field("builtin_template_id") == Some(id)
                }) {
                    if let Some(value) = record.field("name").filter(|value| !value.is_empty()) {
                        effective_name = value;
                    }
                    if let Some(value) = record.field("subject").filter(|value| !value.is_empty()) {
                        effective_subject = value;
                    }
                    if let Some(value) = record.field("description").filter(|value| !value.is_empty()) {
                        effective_description = value;
                    }
                    if let Some(value) = record.field("body").filter(|value| !value.is_empty()) {
                        effective_body = value;
                    }
                    let override_sections = template_sections(record.field("sections").unwrap_or(""));
                    if !override_sections.is_empty() {
                        effective_sections = override_sections;
                    }
                }
                rows.push(json!({
                    "id": id,
                    "name": effective_name,
                    "origin": "built-in",
                    "subject": effective_subject,
                    "description": effective_description,
                    "sections": effective_sections,
                    "body": effective_body,
                }));
            }
            for record in stored.iter().filter(|record| {
                record.field("record_role") == Some("guide-template")
                    && record.field("builtin_template_id").is_none()
            }) {
                let mut value = match plain(record) {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                value.insert("origin".to_owned(), Value::String("custom".to_owned()));
                value.insert(
                    "sections".to_owned(),
                    json!(template_sections(record.field("sections").unwrap_or(""))),
                );
                rows.push(Value::Object(value));
            }
            emit(
                output,
                Value::Array(rows.clone()),
                &format!(
                    "{} study-guide template{}.",
                    rows.len(),
                    if rows.len() == 1 { "" } else { "s" }
                ),
                args.json(),
            );
            Ok(0)
        }
        "show" | "export" => {
            let id_or_name = args.required_position(0, "template ID or name")?.to_lowercase();
            let stored = snapshot.list_records(RecordType::SETTINGS, false)?;
            let template = if let Some((id, name, subject, description, body, sections)) = find_builtin(&id_or_name) {
                let mut effective = template_value(id, name, subject, description, body, sections);
                if let Some(record) = stored.iter().find(|record| {
                    record.field("record_role") == Some("guide-template")
                        && record.field("builtin_template_id") == Some(id)
                }) {
                    if let Value::Object(map) = &mut effective {
                        for field in ["name", "subject", "description", "body"] {
                            if let Some(value) = record.field(field).filter(|value| !value.is_empty()) {
                                map.insert(field.to_owned(), Value::String(value.to_owned()));
                            }
                        }
                        let override_sections = template_sections(record.field("sections").unwrap_or(""));
                        if !override_sections.is_empty() {
                            map.insert("sections".to_owned(), json!(override_sections));
                        }
                    }
                }
                effective
            } else {
                let record = stored
                    .iter()
                    .find(|record| {
                        record.field("record_role") == Some("guide-template")
                            && (record.id.to_lowercase() == id_or_name
                                || record.field("name").map(str::to_lowercase).as_deref()
                                    == Some(id_or_name.as_str()))
                    })
                    .ok_or_else(|| CliError(format!("Template “{id_or_name}” was not found.")))?;
                custom_template_value(record)
            };
            if action == "show" {
                if args.json() {
                    emit(output, template.clone(), "", true);
                } else {
                    let sections = template["sections"]
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    output.stdout(&format!(
                        "{}\n{}\n\n{}",
                        template["name"].as_str().unwrap_or(""),
                        template["description"].as_str().unwrap_or(""),
                        sections
                    ));
                }
                return Ok(0);
            }
            let destination = resolve_path(args.required_option("output")?);
            let mut exported = Map::new();
            exported.insert("format".to_owned(), Value::String("tutorux-guide-template-v1".to_owned()));
            for field in ["name", "subject", "description", "sections", "body"] {
                exported.insert(field.to_owned(), template.get(field).cloned().unwrap_or(Value::Null));
            }
            let text = serde_json::to_string_pretty(&Value::Object(exported)).unwrap_or_else(|_| "{}".to_owned());
            write_file_atomically(&destination, format!("{text}\n").as_bytes())?;
            emit(
                output,
                json!({"id": template.get("id").cloned().unwrap_or(Value::Null), "output": output_path(&destination)}),
                &format!("Exported template to {}.", destination.display()),
                args.json(),
            );
            Ok(0)
        }
        "create" | "import" => {
            let imported = if action == "import" {
                let input = resolve_path(args.required_option("input")?);
                let text = std::fs::read_to_string(&input).map_err(|error| {
                    CoreError::new("template_import_failed", format!("Could not read template: {error}"))
                })?;
                if text.trim_start().starts_with('{') {
                    Some(serde_json::from_str::<Value>(&text).map_err(|error| {
                        CoreError::new("template_import_failed", format!("Template JSON is invalid: {error}"))
                    })?)
                } else {
                    Some(json!({
                        "name": input.file_stem().and_then(|value| value.to_str()).unwrap_or("template"),
                        "body": text,
                    }))
                }
            } else {
                None
            };
            let name = args
                .option("name")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .or_else(|| imported.as_ref().and_then(|value| value["name"].as_str()).map(str::to_owned))
                .ok_or_else(|| CliError("--name is required.".to_owned()))?;
            let sections_value: Vec<String> = if let Some(value) = args.option("sections") {
                parse_template_sections(value)?
            } else if let Some(value) = imported.as_ref().and_then(|value| value.get("sections")) {
                match value {
                    Value::Array(values) => values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .collect(),
                    Value::String(value) => parse_template_sections(value)?,
                    _ => Vec::new(),
                }
            } else {
                Vec::new()
            };
            if action == "create" && sections_value.is_empty() {
                return Err(CliError("Provide at least one template section with --sections.".to_owned()).into());
            }
            if sections_value.len() > 250 {
                return Err(CliError("A template can contain at most 250 sections.".to_owned()).into());
            }
            let timestamp = now_us().to_string();
            let record = ArchiveRecord::new(
                RecordType::SETTINGS,
                crate::core::archive::new_uuid(),
                [
                    ("record_role", "guide-template".to_owned()),
                    ("name", name),
                    (
                        "subject",
                        args.option("subject")
                            .map(str::to_owned)
                            .or_else(|| imported.as_ref().and_then(|value| value["subject"].as_str()).map(str::to_owned))
                            .unwrap_or_else(|| "general".to_owned()),
                    ),
                    (
                        "description",
                        args.option("description")
                            .map(str::to_owned)
                            .or_else(|| imported.as_ref().and_then(|value| value["description"].as_str()).map(str::to_owned))
                            .unwrap_or_default(),
                    ),
                    ("sections", sections_value.join("\n")),
                    (
                        "body",
                        args.option("body")
                            .map(str::to_owned)
                            .or_else(|| imported.as_ref().and_then(|value| value["body"].as_str()).map(str::to_owned))
                            .unwrap_or_default(),
                    ),
                    ("created_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            emit(
                output,
                plain(&saved[0]),
                &format!("Created template {} ({}).", saved[0].field("name").unwrap_or(""), saved[0].id),
                args.json(),
            );
            Ok(0)
        }
        "update" | "delete" | "restore" => {
            let id = args.required_position(0, "template ID")?.to_lowercase();
            let builtin = find_builtin(&id);
            if let Some((builtin_id, builtin_name, builtin_subject, builtin_description, builtin_body, builtin_sections)) = builtin {
                if action == "update" || action == "delete" {
                    let stored = snapshot.list_records(RecordType::SETTINGS, true)?;
                    let matching: Vec<&ArchiveRecord> = stored
                        .iter()
                        .filter(|record| {
                            record.field("record_role") == Some("guide-template")
                                && record.field("builtin_template_id") == Some(builtin_id)
                        })
                        .collect();
                    let override_record = matching
                        .iter()
                        .find(|record| !record.deleted())
                        .or_else(|| matching.first())
                        .copied();
                    if action == "delete" {
                        let Some(override_record) = override_record else {
                            emit(
                                output,
                                json!({"id": builtin_id, "restored": true}),
                                "Built-in template restored to its defaults.",
                                args.json(),
                            );
                            return Ok(0);
                        };
                        if !override_record.deleted() {
                            let saved = mutate(path, &snapshot, &[trash(override_record)])?;
                            emit(
                                output,
                                plain(&saved[0]),
                                "Built-in template restored to its defaults.",
                                args.json(),
                            );
                            return Ok(0);
                        }
                        emit(
                            output,
                            json!({"id": builtin_id, "restored": true}),
                            "Built-in template restored to its defaults.",
                            args.json(),
                        );
                        return Ok(0);
                    }
                    if let Some(override_record) = override_record {
                        if override_record.deleted() {
                            return Err(CliError(format!(
                                "Template {id} is in Trash. Restore it before updating."
                            ))
                            .into());
                        }
                    }
                    let timestamp = now_us().to_string();
                    let existing_sections = override_record
                        .map(|record| template_sections(record.field("sections").unwrap_or("")))
                        .unwrap_or_default();
                    let sections = if let Some(value) = args.option("sections") {
                        parse_template_sections(value)?
                    } else if !existing_sections.is_empty() {
                        existing_sections
                    } else {
                        builtin_sections.iter().map(|value| (*value).to_owned()).collect()
                    };
                    let fields = [
                        (
                            "record_role",
                            "guide-template".to_owned(),
                        ),
                        ("builtin_template_id", builtin_id.to_owned()),
                        (
                            "name",
                            args.option("name").map(str::to_owned).unwrap_or_else(|| {
                                override_record
                                    .and_then(|record| record.field("name"))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or(builtin_name)
                                    .to_owned()
                            }),
                        ),
                        (
                            "subject",
                            args.option("subject").map(str::to_owned).unwrap_or_else(|| {
                                override_record
                                    .and_then(|record| record.field("subject"))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or(builtin_subject)
                                    .to_owned()
                            }),
                        ),
                        (
                            "description",
                            args.option("description").map(str::to_owned).unwrap_or_else(|| {
                                override_record
                                    .and_then(|record| record.field("description"))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or(builtin_description)
                                    .to_owned()
                            }),
                        ),
                        ("sections", sections.join("\n")),
                        (
                            "body",
                            args.option("body").map(str::to_owned).unwrap_or_else(|| {
                                override_record
                                    .and_then(|record| record.field("body"))
                                    .filter(|value| !value.is_empty())
                                    .unwrap_or(builtin_body)
                                    .to_owned()
                            }),
                        ),
                        ("created_at_us", timestamp.clone()),
                        ("updated_at_us", timestamp),
                    ];
                    let mut record = override_record.cloned().unwrap_or_else(|| {
                        ArchiveRecord::new(RecordType::SETTINGS, crate::core::archive::new_uuid(), std::iter::empty::<(&str, &str)>())
                    });
                    for (key, value) in fields {
                        record.fields.insert(key.to_owned(), value);
                    }
                    let saved = mutate(path, &snapshot, &[record])?;
                    emit(
                        output,
                        plain(&saved[0]),
                        "Built-in template override updated.",
                        args.json(),
                    );
                    return Ok(0);
                }
                // restore on a built-in: treat as creating the override from defaults is not
                // supported by the TypeScript CLI; fall through to the not-found error.
            }
            let record = snapshot
                .get_record(RecordType::SETTINGS, &id)?
                .filter(|record| record.field("record_role") == Some("guide-template"))
                .ok_or_else(|| CliError(format!("Template {id} was not found.")))?;
            if action == "delete" && record.deleted() {
                return Err(CliError(format!("Template {id} is already in Trash.")).into());
            }
            if action == "restore" && !record.deleted() {
                return Err(CliError(format!("Template {id} is not in Trash.")).into());
            }
            if action == "update" && record.deleted() {
                return Err(CliError(format!("Template {id} is in Trash. Restore it before updating.")).into());
            }
            let updated = if action == "delete" {
                trash(&record)
            } else if action == "restore" {
                restore(&record)
            } else {
                let provides_field = ["name", "subject", "description", "sections", "body"]
                    .iter()
                    .any(|key| args.option(key).is_some());
                if !provides_field {
                    return Err(CliError("Provide a template field to update.".to_owned()).into());
                }
                let mut updated = record;
                if let Some(value) = args.option("name") {
                    updated.fields.insert("name".to_owned(), value.to_owned());
                }
                if let Some(value) = args.option("subject") {
                    updated.fields.insert("subject".to_owned(), value.to_owned());
                }
                if let Some(value) = args.option("description") {
                    updated.fields.insert("description".to_owned(), value.to_owned());
                }
                if let Some(value) = args.option("sections") {
                    updated
                        .fields
                        .insert("sections".to_owned(), parse_template_sections(value)?.join("\n"));
                }
                if let Some(value) = args.option("body") {
                    updated.fields.insert("body".to_owned(), value.to_owned());
                }
                updated
                    .fields
                    .insert("updated_at_us".to_owned(), timestamp_now());
                updated
            };
            let saved = mutate(path, &snapshot, &[updated])?;
            let message = match action {
                "delete" => "Template moved to Trash.",
                "restore" => "Template restored.",
                _ => "Template updated.",
            };
            emit(output, plain(&saved[0]), message, args.json());
            Ok(0)
        }
        _ => Err(CliError(format!("template {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

