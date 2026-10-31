use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::cli::{
    emit, open_archive, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::embedded_ai::{estimate_gguf_memory, read_gguf_metadata, GgufMetadata};

const LOCAL_FILE_PROVIDERS: &[&str] = &[
    "whisper",
    "whisper.cpp",
    "local-whisper",
    "llama.cpp-embedded",
    "embedded-gguf",
];

pub(super) fn run_model(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    match action {
        "list" => {
            let references: Vec<ArchiveRecord> = snapshot
                .list_records(RecordType::SETTINGS, false)?
                .into_iter()
                .filter(|record| record.field("record_role") == Some("model-reference"))
                .collect();
            emit(
                output,
                Value::Array(
                    references
                        .iter()
                        .map(crate::core::cli::records::plain)
                        .collect(),
                ),
                &references
                    .iter()
                    .map(|record| {
                        format!(
                            "{}  {} / {}  {}{}",
                            record.id,
                            record.field("provider").unwrap_or(""),
                            record.field("model_id").unwrap_or(""),
                            record.field("path").unwrap_or(""),
                            if record.field("active") == Some("true") {
                                "  selected"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                args.json(),
            );
            Ok(0)
        }
        "select" => select(&snapshot, &args, output, path, context),
        "remove-reference" => remove(&snapshot, &args, output, path, context),
        "inspect" | "verify" => inspect(&snapshot, &args, output, path, action == "verify"),
        _ => Err(CliError(format!(
            "model {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

fn select(
    snapshot: &crate::core::archive::ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let provider = args.required_option("provider")?.to_ascii_lowercase();
    let model = args.required_option("model")?.to_owned();
    let raw_path = args.option("path").unwrap_or("").to_owned();
    let local = LOCAL_FILE_PROVIDERS.contains(&provider.as_str());
    if local && raw_path.is_empty() {
        return Err(
            CliError("This provider requires --path to a selected model file.".to_owned()).into(),
        );
    }
    if local {
        let resolved = resolve_from_archive(path, &raw_path);
        let inspection = inspect_cli_model(&resolved)?;
        if !inspection.available {
            return Err(
                CliError("Selected model must be a regular non-symlink file.".to_owned()).into(),
            );
        }
        if matches!(provider.as_str(), "llama.cpp-embedded" | "embedded-gguf")
            && inspection.format != "GGUF"
        {
            return Err(CliError("Select a GGUF file for the embedded model.".to_owned()).into());
        }
    }
    let id = crate::core::cli::records::deterministic_uuid(&format!(
        "model-reference:{provider}:{model}"
    ));
    let mut changes = Vec::new();
    for record in snapshot.list_records(RecordType::SETTINGS, false)? {
        if record.field("record_role") == Some("model-reference")
            && record.field("provider") == Some(provider.as_str())
            && record.field("active") == Some("true")
            && record.id != id
        {
            let mut record = record;
            record
                .fields
                .insert("active".to_owned(), "false".to_owned());
            record.fields.insert("updated_at_us".to_owned(), now());
            changes.push(record);
        }
    }
    let mut record = ArchiveRecord::new(
        RecordType::SETTINGS,
        &id,
        [
            ("record_role", "model-reference".to_owned()),
            ("provider", provider.clone()),
            ("model_id", model.clone()),
            ("path", raw_path.clone()),
            (
                "capabilities",
                args.option("capabilities").unwrap_or("unknown").to_owned(),
            ),
            ("active", "true".to_owned()),
            ("updated_at_us", now()),
        ],
    );
    if matches!(provider.as_str(), "llama.cpp-embedded" | "embedded-gguf") {
        let context_tokens = bounded(
            args.option("context-tokens"),
            "context-tokens",
            4096,
            32,
            1_048_576,
        )?;
        let threads = bounded(args.option("threads"), "threads", 0, 0, 64)?;
        let max_threads = bounded(args.option("max-threads"), "max-threads", 16, 1, 64)?;
        let layers = bounded(args.option("gpu-layers"), "gpu-layers", 0, 0, 1_000_000)?;
        if threads > max_threads {
            return Err(CliError("--threads cannot exceed --max-threads.".to_owned()).into());
        }
        record
            .fields
            .insert("context_tokens".to_owned(), context_tokens.to_string());
        record
            .fields
            .insert("cpu_threads".to_owned(), threads.to_string());
        record
            .fields
            .insert("maximum_cpu_threads".to_owned(), max_threads.to_string());
        record
            .fields
            .insert("gpu_layers".to_owned(), layers.to_string());
    }
    changes.push(record.clone());
    let next = snapshot.append_records(&changes)?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let _ = context;
    emit(
        output,
        crate::core::cli::records::plain(&record),
        &format!("Model reference {id} selected."),
        args.json(),
    );
    Ok(0)
}

fn remove(
    snapshot: &crate::core::archive::ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &Path,
    context: &CliContext,
) -> CliResult<i32> {
    let id = args
        .required_position(0, "model reference ID")?
        .to_lowercase();
    let mut record = snapshot
        .get_record(RecordType::SETTINGS, &id)?
        .filter(|record| {
            record.field("record_role") == Some("model-reference") && !record.deleted()
        })
        .ok_or_else(|| CliError("Model reference not found.".to_owned()))?;
    record
        .fields
        .insert("_deleted".to_owned(), "true".to_owned());
    let next = snapshot.append_records(&[record.clone()])?;
    crate::core::cli::records::save_replacing(path, &next)?;
    let _ = context;
    emit(
        output,
        crate::core::cli::records::plain(&record),
        "Model reference removed from this archive.",
        args.json(),
    );
    Ok(0)
}

struct CliModelInspection {
    path: PathBuf,
    available: bool,
    size_bytes: u64,
    format: &'static str,
    gguf: Option<GgufMetadata>,
    estimate: Option<(String, bool)>,
}

impl CliModelInspection {
    fn report(&self) -> Value {
        if !self.available {
            return json!({"path": self.path.to_string_lossy(), "available": false});
        }
        let Some(gguf) = &self.gguf else {
            return json!({
                "path": self.path.to_string_lossy(),
                "available": true,
                "size_bytes": self.size_bytes,
                "format": "unknown",
                "metadata": "not-inspected",
            });
        };
        let mut report = json!({
            "path": self.path.to_string_lossy(),
            "available": true,
            "size_bytes": self.size_bytes,
            "format": "GGUF",
            "metadata": "inspected",
            "gguf_version": gguf.gguf_version,
            "tensor_count": gguf.tensor_count.to_string(),
            "metadata_count": gguf.metadata_count.to_string(),
            "architecture": gguf.architecture.clone(),
            "name": gguf.name.clone(),
            "description": gguf.description.clone(),
            "training_context_tokens": gguf.training_context_tokens.clone(),
            "embedding_length": gguf.embedding_length.clone(),
            "layer_count": gguf.layer_count.clone(),
        });
        if let Some((total, overflowed)) = &self.estimate {
            report["estimated_memory_bytes_upper_bound"] = Value::String(total.clone());
            report["memory_estimate_overflowed"] =
                Value::String(if *overflowed { "true" } else { "false" }.to_owned());
        }
        report
    }

    fn message(&self) -> String {
        if !self.available {
            return "Selected model file is missing or not a regular non-symlink file.".to_owned();
        }
        let Some(gguf) = &self.gguf else {
            return format!(
                "Model file: {} ({} bytes; not-inspected).",
                self.path.to_string_lossy(),
                self.size_bytes
            );
        };
        if gguf.architecture.is_empty() {
            return format!(
                "Model file: {} ({} bytes; inspected).",
                self.path.to_string_lossy(),
                self.size_bytes
            );
        }
        let estimate = self
            .estimate
            .as_ref()
            .map(|(total, _)| total.as_str())
            .unwrap_or("unknown");
        format!(
            "GGUF model: {} ({}, {}, {} layers, {} bytes; estimated memory {} bytes).",
            self.path.to_string_lossy(),
            if gguf.name.is_empty() {
                "unnamed"
            } else {
                gguf.name.as_str()
            },
            gguf.architecture,
            gguf.layer_count,
            self.size_bytes,
            estimate
        )
    }
}

fn inspect_cli_model(path: &Path) -> CliResult<CliModelInspection> {
    let available = std::fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink());
    if !available {
        return Ok(CliModelInspection {
            path: path.to_path_buf(),
            available: false,
            size_bytes: 0,
            format: "unknown",
            gguf: None,
            estimate: None,
        });
    }
    let size_bytes = std::fs::metadata(path)
        .map_err(|_| CliError("The selected model file could not be inspected.".to_owned()))?
        .len();
    let is_gguf = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .ends_with(".gguf");
    if !is_gguf {
        return Ok(CliModelInspection {
            path: path.to_path_buf(),
            available: true,
            size_bytes,
            format: "unknown",
            gguf: None,
            estimate: None,
        });
    }
    let gguf = read_gguf_metadata(path).map_err(CliError)?;
    let estimate = if !gguf.architecture.is_empty()
        && !gguf.embedding_length.is_empty()
        && !gguf.layer_count.is_empty()
    {
        Some(
            estimate_gguf_memory(size_bytes, &gguf.embedding_length, &gguf.layer_count, 4096)
                .map_err(CliError)?,
        )
    } else {
        None
    };
    Ok(CliModelInspection {
        path: path.to_path_buf(),
        available: true,
        size_bytes,
        format: "GGUF",
        gguf: Some(gguf),
        estimate,
    })
}

fn inspect(
    _snapshot: &crate::core::archive::ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    archive: &Path,
    verify: bool,
) -> CliResult<i32> {
    let selected = args
        .option("path")
        .map(str::to_owned)
        .or_else(|| args.positionals.first().cloned())
        .ok_or_else(|| CliError("A model path is required.".to_owned()))?;
    let resolved = resolve_from_archive(archive, &selected);
    let inspection = inspect_cli_model(&resolved)?;
    if !inspection.available {
        let report = inspection.report();
        if verify {
            emit(output, report, &inspection.message(), args.json());
            return Ok(2);
        }
        return Err(CliError(
            "Selected model path is missing or is not a regular non-symlink file.".to_owned(),
        )
        .into());
    }
    emit(
        output,
        inspection.report(),
        &inspection.message(),
        args.json(),
    );
    Ok(0)
}

fn resolve_from_archive(archive: &Path, value: &str) -> PathBuf {
    let candidate = Path::new(value);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        archive
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(candidate)
    }
}

fn bounded(value: Option<&str>, name: &str, fallback: u64, min: u64, max: u64) -> CliResult<u64> {
    match value {
        None => Ok(fallback),
        Some(raw) => raw
            .parse::<u64>()
            .ok()
            .filter(|value| (min..=max).contains(value))
            .ok_or_else(|| {
                CliError(format!(
                    "--{name} must be an integer from {min} through {max}."
                ))
                .into()
            }),
    }
}

fn now() -> String {
    crate::core::archive::now_us().to_string()
}
