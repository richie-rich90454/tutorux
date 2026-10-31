use serde_json::{json, Value};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{emit, resolve_path, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::decode_archive_header;

use super::helpers::{file_stem, is_writable};

pub(super) fn run(args: &ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    if args.flag("directory") {
        return Err(CliError("--directory requires a path.".to_owned()).into());
    }
    if !args.positionals.is_empty() {
        return Err(CliError(
            "archive discover does not accept an archive path; use --directory.".to_owned(),
        )
        .into());
    }
    let directory = resolve_path(args.option("directory").unwrap_or("."));
    let entries = std::fs::read_dir(&directory)
        .map_err(|_| CliError("Archive discovery path is not a directory.".to_owned()))?;
    let mut paths: Vec<std::path::PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .map(|extension| extension.eq_ignore_ascii_case("tux"))
                .unwrap_or(false)
        })
        .collect();
    paths.sort();
    let mut archives = Vec::new();
    for path in paths {
        if let Some(value) = inspect_candidate(&path) {
            archives.push(value);
        }
    }
    let summary = if archives.is_empty() {
        "No valid .tux archives found in this directory.".to_owned()
    } else {
        archives
            .iter()
            .map(discovery_text)
            .collect::<Vec<_>>()
            .join("\n")
    };
    emit(output, Value::Array(archives), &summary, args.json());
    Ok(0)
}

fn inspect_candidate(path: &std::path::Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let header = decode_archive_header(&bytes).ok()?;
    let size = bytes.len().to_string();
    let writable = is_writable(path);
    let name = file_stem(path);
    let snapshot = ArchiveSnapshot::open_bytes(bytes).ok();
    let (display_name, description, generation, records, health) = match snapshot {
        Some(snapshot) => {
            let manifest = snapshot.get_manifest().ok();
            let live = snapshot.verify().ok();
            (
                manifest
                    .as_ref()
                    .map(|manifest| manifest.display_name.clone())
                    .unwrap_or(name.clone()),
                manifest.map(|manifest| manifest.description).unwrap_or_default(),
                snapshot.commit.generation.to_string(),
                live.map(|value| value.live_records).unwrap_or(0),
                "healthy".to_owned(),
            )
        }
        None => (name.clone(), String::new(), "0".to_owned(), 0, "locked".to_owned()),
    };
    Some(json!({
        "path": path.display().to_string(),
        "name": display_name,
        "description": description,
        "id": header.id,
        "archiveId": header.id,
        "archive_id": header.id,
        "generation": generation,
        "size": size,
        "size_bytes": size,
        "student_count": records.to_string(),
        "session_count": "0",
        "created_at_us": header.created_at_us.to_string(),
        "format_major": header.major_version.to_string(),
        "format_minor": header.minor_version.to_string(),
        "formatMajor": header.major_version,
        "formatMinor": header.minor_version,
        "writable": writable,
        "health": health,
        "recoveryNeeded": false,
        "metadataOnly": false,
        "metadata_only": false,
        "encrypted": header.capabilities & 1 != 0,
        "locked": header.capabilities & 1 != 0,
        "verified": false,
        "valid": false,
        "records": records,
        "recordsVerified": records,
        "records_checked": records,
        "index_pages_checked": 0,
        "deletedRecords": 0,
        "issues": Vec::<String>::new(),
        "historicalRevisionsVerified": Value::Null,
        "commitsVerified": Value::Null,
        "verificationScope": "header-and-index",
    }))
}

fn discovery_text(value: &Value) -> String {
    let mut lines = vec![
        format!("{}", value["name"].as_str().unwrap_or("Archive")),
        format!("  Format: {}.{}", value["format_major"], value["format_minor"]),
        format!("  Size: {} bytes", value["size_bytes"]),
        format!(
            "  Access: {}",
            if value["writable"] == Value::Bool(true) {
                "Read/Write"
            } else {
                "Read-only"
            }
        ),
        format!("  Name: {}", value["name"].as_str().unwrap_or("Archive")),
        format!("  ID: {}", value["id"].as_str().unwrap_or("")),
        format!("  Generation: {}", value["generation"].as_str().unwrap_or("0")),
        format!("  Students: {}", value["student_count"].as_str().unwrap_or("0")),
        format!("  Sessions: {}", value["session_count"].as_str().unwrap_or("0")),
    ];
    if value["health"].as_str() != Some("healthy") {
        lines.push(format!("  Health: {}", value["health"].as_str().unwrap_or("unknown")));
    }
    if let Some(description) = value["description"].as_str() {
        if !description.is_empty() {
            lines.push(format!("  Description: {description}"));
        }
    }
    lines.join("\n")
}
