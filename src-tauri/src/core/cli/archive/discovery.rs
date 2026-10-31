use serde_json::{json, Value};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{emit, resolve_path, CliError, CliOutput, CliResult, ParsedArguments};
use crate::core::format::{decode_archive_header, inspect_archive_version, RecordType};

use super::helpers::{counter, file_stem, is_writable};

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
    let size = bytes.len();
    let writable = is_writable(path);
    let name = file_stem(path);
    let header = match decode_archive_header(&bytes) {
        Ok(header) => header,
        Err(error) => {
            let (major, minor) = inspect_archive_version(&bytes).unwrap_or((0, 0));
            let code = error.code;
            let mut value = json!({
                "path": path.display().to_string(),
                "name": name,
                "size_bytes": size.to_string(),
                "format_major": major.to_string(),
                "format_minor": minor.to_string(),
                "health": code.as_str(),
                "writable": writable,
            });
            if matches!(
                code.as_str(),
                "archive_version_unsupported" | "archive_capability_unsupported"
            ) {
                value["metadata_only"] = Value::Bool(true);
            }
            return Some(value);
        }
    };
    let snapshot = match ArchiveSnapshot::open_bytes(bytes) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Some(json!({
                "path": path.display().to_string(),
                "name": name,
                "size_bytes": size.to_string(),
                "format_major": "0",
                "format_minor": "0",
                "health": error.code,
                "writable": writable,
            }))
        }
    };
    let manifest_record = snapshot
        .get_record(RecordType::SETTINGS, &header.id)
        .ok()
        .flatten();
    let manifest = snapshot.get_manifest().ok();
    let health = if snapshot.locked() {
        "locked"
    } else if snapshot.source.size() > snapshot.published_end_offset {
        "recovery-required"
    } else {
        "healthy"
    };
    Some(json!({
        "path": path.display().to_string(),
        "name": manifest
            .as_ref()
            .map(|manifest| manifest.display_name.clone())
            .unwrap_or_else(|| name.clone()),
        "description": manifest.as_ref().map(|manifest| manifest.description.clone()).unwrap_or_default(),
        "id": header.id,
        "generation": snapshot.commit.generation.to_string(),
        "size_bytes": size.to_string(),
        "student_count": counter(manifest_record.as_ref().and_then(|record| record.field("student_count"))),
        "session_count": counter(manifest_record.as_ref().and_then(|record| record.field("session_count"))),
        "created_at_us": header.created_at_us.to_string(),
        "format_major": header.major_version.to_string(),
        "format_minor": header.minor_version.to_string(),
        "writable": writable,
        "health": health,
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
