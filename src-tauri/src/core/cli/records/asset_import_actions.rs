use super::*;

pub(crate) fn capture_options(
    args: &ParsedArguments,
    session_id: &str,
) -> CliResult<Option<CaptureImport>> {
    let capture = args.option("capture-source");
    if let Some(source) = capture {
        if source != "browser-microphone" {
            return Err(CliError(
                "Captured assets support the browser-microphone source label.".to_owned(),
            )
            .into());
        }
        if !args.flag("consent") {
            return Err(CliError(
                "Confirm microphone recording consent with --consent before importing a browser capture."
                    .to_owned(),
            )
            .into());
        }
        if session_id.is_empty() {
            return Err(CliError(
                "A browser microphone capture must be associated with a session.".to_owned(),
            )
            .into());
        }
    }
    if args.option("capture-consent-at-us").is_some() {
        let raw = args.option("capture-consent-at-us").unwrap_or("");
        let parsed = if capture.is_some()
            && !raw.is_empty()
            && raw.bytes().all(|byte| byte.is_ascii_digit())
        {
            raw.parse::<u64>().ok()
        } else {
            None
        };
        let Some(parsed) = parsed.filter(|value| *value > 0) else {
            return Err(CliError(
                "Capture consent time requires a valid browser microphone source.".to_owned(),
            )
            .into());
        };
        return Ok(capture.map(|source| CaptureImport {
            source: source.to_owned(),
            consent_at_us: parsed.to_string(),
        }));
    }
    Ok(capture.map(|source| CaptureImport {
        source: source.to_owned(),
        consent_at_us: timestamp_now(),
    }))
}

fn import_one(
    path: &std::path::Path,
    snapshot: &ArchiveSnapshot,
    input: &std::path::Path,
    session_id: &str,
    capture: Option<&CaptureImport>,
) -> CliResult<(ArchiveRecord, bool)> {
    let metadata = std::fs::symlink_metadata(input)
        .map_err(|_| CliError(format!("Could not read material: {}", input.display())))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(CliError("Material input must be a regular file.".to_owned()).into());
    }
    let bytes = std::fs::read(input).map_err(|error| {
        CoreError::new(
            "asset_read_failed",
            format!("Could not read material: {error}"),
        )
    })?;
    let filename = input
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("material");
    let records = import_asset(snapshot, &bytes, filename, session_id, capture)?;
    let new_id = records
        .iter()
        .find(|record| record.record_type == RecordType::ASSET_METADATA)
        .map(|record| record.id.clone())
        .ok_or_else(|| CliError("Material import produced no metadata.".to_owned()))?;
    let deduplicated = !records
        .iter()
        .any(|record| record.record_type == RecordType::ASSET_BLOB);
    let saved = mutate_staged_assets(path, snapshot, records)?;
    let metadata = saved
        .into_iter()
        .find(|record| record.id == new_id)
        .ok_or_else(|| CliError("Material import produced no metadata.".to_owned()))?;
    Ok((metadata, deduplicated))
}

pub(crate) fn run_asset_import(
    action: &str,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
    snapshot: &mut ArchiveSnapshot,
) -> CliResult<i32> {
    if action == "add" || action == "import" {
        let input = resolve_path(
            args.positionals
                .first()
                .map(String::as_str)
                .or(args.option("input"))
                .ok_or_else(|| {
                    CliError(
                        if action == "add" {
                            "Source file is required."
                        } else {
                            "--input is required."
                        }
                        .to_owned(),
                    )
                })?,
        );
        let session_id = args.option("session").unwrap_or("").to_lowercase();
        if !session_id.is_empty() {
            require_live(snapshot, RecordType::SESSION, &session_id)?;
        }
        let capture = capture_options(args, &session_id)?;
        let (metadata, deduplicated) =
            import_one(path, snapshot, &input, &session_id, capture.as_ref())?;
        emit(
            output,
            Value::Array(vec![plain(&metadata)]),
            &format!(
                "{} imported{}.",
                metadata.field("filename").unwrap_or("Material"),
                if deduplicated {
                    " (content deduplicated)"
                } else {
                    ""
                }
            ),
            args.json(),
        );
        return Ok(0);
    }
    let directory = resolve_path(args.required_position(0, "material directory")?);
    let info = std::fs::metadata(&directory)
        .map_err(|_| CliError("Material directory is unavailable.".to_owned()))?;
    if !info.is_dir() {
        return Err(CliError("Import source must be a directory.".to_owned()).into());
    }
    let session_id = args.option("session").unwrap_or("").to_lowercase();
    if !session_id.is_empty() {
        require_live(snapshot, RecordType::SESSION, &session_id)?;
    }
    let capture = capture_options(args, &session_id)?;
    let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(&directory)
        .map_err(|_| CliError("Material directory is unavailable.".to_owned()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            std::fs::symlink_metadata(path)
                .map(|metadata| {
                    metadata.file_type().is_file() && !metadata.file_type().is_symlink()
                })
                .unwrap_or(false)
        })
        .collect();
    if entries.len() > 10_000 {
        return Err(
            CliError("Folder import is limited to 10,000 regular files.".to_owned()).into(),
        );
    }
    entries.sort_by(|left, right| {
        left.file_name()
            .unwrap_or_default()
            .cmp(right.file_name().unwrap_or_default())
    });
    let mut rows = Vec::new();
    for entry in entries {
        let (metadata, _) = import_one(path, snapshot, &entry, &session_id, capture.as_ref())?;
        rows.push(plain(&metadata));
        *snapshot = load(path, context)?;
    }

    let count = rows.len();
    emit(
        output,
        Value::Array(rows),
        &format!(
            "Imported {count} asset{} into the archive.",
            if count == 1 { "" } else { "s" }
        ),
        args.json(),
    );
    Ok(0)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn args(options: &[(&str, &str)], flags: &[&str]) -> ParsedArguments {
        ParsedArguments {
            positionals: Vec::new(),
            options: options
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
        }
    }

    #[test]
    fn capture_requires_consent_and_session() {
        let missing_consent = args(&[("capture-source", "browser-microphone")], &[]);
        assert!(capture_options(&missing_consent, "session").is_err());
        let missing_session = args(&[("capture-source", "browser-microphone")], &["consent"]);
        assert!(capture_options(&missing_session, "").is_err());
    }

    #[test]
    fn capture_rejects_other_sources_and_orphan_consent_time() {
        let other = args(&[("capture-source", "desktop")], &["consent"]);
        assert!(capture_options(&other, "session").is_err());
        let orphan = args(&[("capture-consent-at-us", "10")], &[]);
        assert!(capture_options(&orphan, "session").is_err());
    }

    #[test]
    fn capture_accepts_explicit_consent_time() {
        let valid = args(
            &[
                ("capture-source", "browser-microphone"),
                ("capture-consent-at-us", "42"),
            ],
            &["consent"],
        );
        let capture = capture_options(&valid, "session").ok().flatten().unwrap();
        assert_eq!(capture.source, "browser-microphone");
        assert_eq!(capture.consent_at_us, "42");
    }
}
