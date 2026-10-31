use super::*;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub(crate) fn deterministic_uuid(seed: &str) -> String {
    let mut digest = crate::core::archive::sha256(seed.as_bytes());
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    let hex: String = digest[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub(crate) fn setting_environment_value(name: &str) -> CliResult<String> {
    let mut bytes = name.bytes();
    let valid = match bytes.next() {
        Some(first) if first.is_ascii_alphabetic() || first == b'_' => {
            bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }
        _ => false,
    };
    if !valid {
        return Err(CliError("The environment variable name is invalid.".to_owned()).into());
    }
    std::env::var(name)
        .map_err(|_| CliError("The requested environment variable is not set.".to_owned()).into())
}

pub(crate) fn make_setting_record(key: &str, value: &str, credential: bool) -> ArchiveRecord {
    let mut fields = BTreeMap::new();
    fields.insert(
        "record_role".to_owned(),
        if credential { "credential" } else { "setting" }.to_owned(),
    );
    fields.insert("key".to_owned(), key.to_owned());
    fields.insert("value".to_owned(), value.to_owned());
    fields.insert("updated_at_us".to_owned(), timestamp_now());
    ArchiveRecord {
        record_type: RecordType::SETTINGS,
        id: deterministic_uuid(&format!(
            "{}:{key}",
            if credential { "credential" } else { "setting" }
        )),
        revision: 0,
        previous_offset: 0,
        fields,
        blob: Vec::new(),
    }
}

pub(crate) fn run_settings(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    let records = snapshot.list_records(RecordType::SETTINGS, false)?;
    let settings: Vec<ArchiveRecord> = records
        .iter()
        .filter(|record| record.field("record_role") == Some("setting"))
        .cloned()
        .collect();
    let credentials: Vec<ArchiveRecord> = records
        .iter()
        .filter(|record| record.field("record_role") == Some("credential"))
        .cloned()
        .collect();
    match action {
        "list" => {
            let visible: Vec<ArchiveRecord> = settings
                .into_iter()
                .filter(|record| !crate::core::archive::has_sensitive_credential_material(record))
                .collect();
            let summary = if visible.is_empty() {
                "No archive-specific settings.".to_owned()
            } else {
                visible
                    .iter()
                    .map(|record| {
                        format!(
                            "{} = {}",
                            record.field("key").unwrap_or(""),
                            record.field("value").unwrap_or("")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            emit(output, plain_array(&visible), &summary, args.json());
            Ok(0)
        }
        "credential-list" => {
            let metadata: Vec<Value> = credentials
                .iter()
                .map(|record| {
                    json!({
                        "key": record.field("key").unwrap_or(""),
                        "provider_id": record.field("provider_id").unwrap_or(""),
                        "updated_at_us": record.field("updated_at_us").unwrap_or(""),
                    })
                })
                .collect();
            let summary = if metadata.is_empty() {
                "No encrypted credentials are stored in this archive.".to_owned()
            } else {
                credentials
                    .iter()
                    .map(|record| record.field("key").unwrap_or("").to_owned())
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            emit(output, Value::Array(metadata), &summary, args.json());
            Ok(0)
        }
        "get" => {
            let key = args
                .positionals
                .first()
                .map(String::as_str)
                .or(args.option("key"))
                .ok_or_else(|| CliError("--key is required.".to_owned()))?;
            if crate::core::archive::is_sensitive_setting_key(key) {
                return Err(CliError("Credential values cannot be read here.".to_owned()).into());
            }
            let id = deterministic_uuid(&format!("setting:{key}"));
            let record = settings
                .into_iter()
                .find(|record| record.id == id)
                .ok_or_else(|| CliError("Setting was not found in this archive.".to_owned()))?;
            emit(
                output,
                plain(&record),
                &format!("{key} = {}", record.field("value").unwrap_or("")),
                args.json(),
            );
            Ok(0)
        }
        "set" => {
            let key = args.required_option("key")?.to_owned();
            if key.trim().is_empty() || key.chars().any(|character| character.is_control()) {
                return Err(CliError(
                    "Setting keys must be nonempty and contain no control characters.".to_owned(),
                )
                .into());
            }
            let sensitive = crate::core::archive::is_sensitive_setting_key(&key);
            if sensitive {
                if !args.flag("store-credential") {
                    return Err(CliError(
                        "Sensitive settings require --store-credential and an encrypted archive."
                            .to_owned(),
                    )
                    .into());
                }
                if !snapshot.encrypted() {
                    return Err(CliError(
                        "Encrypt the archive before storing credentials.".to_owned(),
                    )
                    .into());
                }
                if args.option("value").is_some() {
                    return Err(CliError(
                        "Use --value-env NAME for credentials; command-line values are not accepted."
                            .to_owned(),
                    )
                    .into());
                }
            } else if args.flag("store-credential") {
                return Err(CliError(
                    "--store-credential is only for sensitive keys.".to_owned(),
                )
                .into());
            }
            let value = match (args.option("value"), args.option("value-env")) {
                (Some(value), None) => value.to_owned(),
                (None, Some(name)) => setting_environment_value(name)?,
                (Some(_), Some(_)) => {
                    return Err(CliError("Provide only one of --value and --value-env.".to_owned()).into())
                }
                (None, None) => {
                    return Err(CliError("Provide --value or --value-env.".to_owned()).into())
                }
            };
            let record = make_setting_record(&key, &value, sensitive);
            let saved = mutate(path, &snapshot, &[record])?;
            let result = if sensitive {
                json!({"changed": saved.len(), "credential": true})
            } else {
                plain(&saved[0])
            };
            emit(
                output,
                result,
                if sensitive {
                    "Encrypted credential saved."
                } else {
                    "Setting saved in the archive."
                },
                args.json(),
            );
            Ok(0)
        }
        "reset" => {
            let selected: Vec<ArchiveRecord> = match args.option("key") {
                Some(key) => settings
                    .into_iter()
                    .filter(|record| record.field("key") == Some(key))
                    .collect(),
                None => settings,
            };
            if args.option("key").is_some() && selected.is_empty() {
                return Err(CliError("Setting was not found.".to_owned()).into());
            }
            let changes: Vec<ArchiveRecord> = selected.iter().map(trash).collect();
            let saved = mutate(path, &snapshot, &changes)?;
            emit(
                output,
                json!({"changed": saved.len()}),
                &format!("Reset {} setting(s).", saved.len()),
                args.json(),
            );
            Ok(0)
        }
        "credential-remove" => {
            let key = args.required_option("key")?;
            let id = deterministic_uuid(&format!("credential:{key}"));
            let credential = credentials
                .into_iter()
                .find(|record| record.id == id)
                .ok_or_else(|| CliError("Encrypted credential was not found.".to_owned()))?;
            let mut removed = trash(&credential);
            removed.fields.remove("value");
            let saved = mutate(path, &snapshot, &[removed])?;
            emit(
                output,
                json!({"changed": saved.len(), "credential": true}),
                "Encrypted credential removed.",
                args.json(),
            );
            Ok(0)
        }
        "import" => {
            let input_value = match args.option("input") {
                Some(value) => value.to_owned(),
                None => args.required_position(0, "settings input file")?.to_owned(),
            };
            let input = resolve_path(&input_value);
            let text = std::fs::read_to_string(&input).map_err(|error| {
                CoreError::new("settings_import_failed", format!("Could not read settings: {error}"))
            })?;
            let mut changes = Vec::new();
            let mut seen = BTreeSet::new();
            for (index, line) in text.lines().enumerate() {
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, value)) = line.split_once('=') else {
                    return Err(CliError(format!("Expected key=value on line {}.", index + 1)).into());
                };
                let key = key.trim();
                if key.is_empty() {
                    return Err(CliError(format!("Expected key=value on line {}.", index + 1)).into());
                }
                if crate::core::archive::is_sensitive_setting_key(key) {
                    return Err(CliError(
                        "Sensitive values cannot be imported from plaintext settings files.".to_owned(),
                    )
                    .into());
                }
                if !seen.insert(key.to_owned()) {
                    return Err(CliError(format!("The settings file repeats key \"{key}\".")).into());
                }
                changes.push(make_setting_record(key, value, false));
            }
            let saved = mutate(path, &snapshot, &changes)?;
            emit(
                output,
                json!({"changed": saved.len()}),
                &format!("Imported {} archive setting(s).", saved.len()),
                args.json(),
            );
            Ok(0)
        }
        "copy-to-archive" => {
            let source_path = resolve_path(args.required_option("source-archive")?);
            let source_passphrase = match args.option("source-passphrase-env") {
                Some(name) => Some(setting_environment_value(name)?),
                None => context.passphrase().map(str::to_owned),
            };
            let source = load(
                &source_path,
                &CliContext {
                    passphrase: source_passphrase,
                    archive_path: Some(source_path.clone()),
                },
            )?;
            let key = args.option("key");
            let selected: Vec<ArchiveRecord> = source
                .list_records(RecordType::SETTINGS, false)?
                .into_iter()
                .filter(|record| record.field("record_role") == Some("setting"))
                .filter(|record| key.map(|key| record.field("key") == Some(key)).unwrap_or(true))
                .filter(|record| !crate::core::archive::has_sensitive_credential_material(record))
                .collect();
            let saved = mutate(path, &snapshot, &selected)?;
            emit(
                output,
                json!({"changed": saved.len()}),
                &format!("Copied {} archive setting(s).", saved.len()),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("settings {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

