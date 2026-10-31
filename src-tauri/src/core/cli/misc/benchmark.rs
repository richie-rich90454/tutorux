use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::core::cli::{
    emit, open_archive, Cancellation, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::diagnostics::{headless_host_summary, headless_system_snapshot};

pub fn run_benchmark_command(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
    cancellation: &dyn Cancellation,
) -> CliResult<i32> {
    let started = Instant::now();
    if !matches!(
        action,
        "startup" | "memory" | "cpu" | "indexing" | "rendering" | "export" | "audio" | "full"
    ) {
        return Err(CliError(format!("Unknown benchmark: {action}.")).into());
    }
    let mut report = base_report(action);
    let needs_archive = matches!(action, "indexing" | "export" | "full");
    if needs_archive {
        let Some(path) = context.archive_path.clone() else {
            return Err(CliError(format!("benchmark {action} requires --archive.")).into());
        };
        let snapshot = open_archive(&path, context.passphrase())?;
        if snapshot.locked() {
            return Err(CliError(
                "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
            )
            .into());
        }
        if cancellation.is_cancelled() {
            return Err(CliError("Benchmark cancelled.".to_owned()).into());
        }
        if matches!(action, "indexing" | "full") {
            measure_index(&mut report, &snapshot, cancellation)?;
        }
        if action == "export" {
            measure_export(&mut report, &snapshot, &args)?;
        }
    }
    if matches!(action, "audio" | "full") {
        if cancellation.is_cancelled() {
            return Err(CliError("Benchmark cancelled.".to_owned()).into());
        }
        measure_audio(&mut report);
    }
    if action == "rendering" {
        report.insert("rendering_measured".to_owned(), json!(false));
        report.insert(
            "rendering_reason".to_owned(),
            json!("run-the-benchmark-in-the-active-desktop-window"),
        );
    }
    report.insert(
        "command_elapsed_us".to_owned(),
        json!(started.elapsed().as_micros() as u64),
    );
    emit(
        output,
        Value::Object(report.clone()),
        &serde_json::to_string_pretty(&Value::Object(report)).unwrap_or_else(|_| "{}".to_owned()),
        args.json(),
    );
    Ok(0)
}

fn node_os_release() -> String {
    #[cfg(windows)]
    {
        if let Ok(output) = std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut token = String::new();
            let mut found = false;
            for character in text.chars() {
                if character.is_ascii_digit() || (found && character == '.') {
                    found = true;
                    token.push(character);
                } else if found {
                    break;
                }
            }
            let parts: Vec<&str> = token.split('.').filter(|part| !part.is_empty()).collect();
            if parts.len() >= 3 {
                return parts[..3].join(".");
            }
        }
        return String::new();
    }
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|value| value.trim().to_owned())
            .unwrap_or_default();
    }
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("uname")
            .arg("-r")
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default();
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        String::new()
    }
}

fn base_report(action: &str) -> Map<String, Value> {
    let mut report = Map::new();
    report.insert("benchmark".to_owned(), json!(action));
    if let Some(system) = headless_system_snapshot().as_object() {
        for (name, value) in system {
            report.insert(name.clone(), value.clone());
        }
    }
    if let Some(host) = headless_host_summary().as_object() {
        for (name, value) in host {
            report.insert(name.clone(), value.clone());
        }
    }
    report.insert("os_release".to_owned(), json!(node_os_release()));
    let number = |name: &str| {
        report
            .get(name)
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            .map_or(Value::Null, |value| json!(value))
    };
    let total_memory = report
        .get("total_memory_bytes")
        .cloned()
        .unwrap_or_else(|| json!(0));
    let available_memory = number("available_memory_bytes");
    let resident_memory = number("resident_memory_bytes");
    let uptime_seconds = report
        .get("process_uptime_us")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .map_or(Value::Null, |value| json!(value as f64 / 1_000_000.0));
    report.insert("total_memory_bytes".to_owned(), total_memory);
    report.insert("available_memory_bytes".to_owned(), available_memory);
    report.insert("resident_memory_bytes".to_owned(), resident_memory);
    report.insert("process_uptime_seconds".to_owned(), uptime_seconds);
    report.insert(
        "measurement_scope".to_owned(),
        json!(if action == "startup" {
            "process-uptime-and-current-command"
        } else {
            "current-process"
        }),
    );
    report
}

fn measure_index(
    report: &mut Map<String, Value>,
    snapshot: &crate::core::archive::ArchiveSnapshot,
    cancellation: &dyn Cancellation,
) -> CliResult<()> {
    let started = Instant::now();
    let mut indexed = 0usize;
    for record_type in [
        RecordType::STUDENT,
        RecordType::SESSION,
        RecordType::TRANSCRIPT_SEGMENT,
        RecordType::ANNOTATION,
        RecordType::ASSET_METADATA,
        RecordType::EVIDENCE_NODE,
        RecordType::GUIDE,
    ] {
        if cancellation.is_cancelled() {
            return Err(CliError("Benchmark cancelled.".to_owned()).into());
        }
        indexed += snapshot.list_record_metadata(record_type, false)?.len();
    }
    report.insert("index_records".to_owned(), json!(indexed.to_string()));
    report.insert(
        "index_elapsed_us".to_owned(),
        json!(started.elapsed().as_micros().to_string()),
    );
    report.insert(
        "archive_generation".to_owned(),
        json!(snapshot.commit.generation.to_string()),
    );
    Ok(())
}

fn measure_export(
    report: &mut Map<String, Value>,
    snapshot: &crate::core::archive::ArchiveSnapshot,
    args: &ParsedArguments,
) -> CliResult<()> {
    let guide_id = args.required_option("guide")?.to_lowercase();
    let guide: ArchiveRecord = snapshot
        .get_record(RecordType::GUIDE, &guide_id)?
        .filter(|record| !record.deleted())
        .ok_or_else(|| CliError("Guide was not found.".to_owned()))?;
    let started = Instant::now();
    let markdown = crate::core::cli::records::render_guide_markdown(&guide);
    report.insert("export_format".to_owned(), json!("markdown-render"));
    report.insert("export_bytes".to_owned(), json!(markdown.len()));
    report.insert(
        "export_elapsed_us".to_owned(),
        json!(started.elapsed().as_micros() as u64),
    );
    Ok(())
}

fn measure_audio(report: &mut Map<String, Value>) {
    let started = Instant::now();
    let count = super::diagnostics::audio_rows().len();
    report.insert(
        "audio_devices".to_owned(),
        if count == 0 { json!("unavailable") } else { json!(count) },
    );
    report.insert(
        "audio_enumeration_elapsed_us".to_owned(),
        json!(started.elapsed().as_micros() as u64),
    );
    if count == 0 {
        report.insert(
            "audio_reason".to_owned(),
            json!("Audio endpoint enumeration is unavailable."),
        );
        report.insert("audio_status".to_owned(), json!("unavailable"));
    } else {
        report.insert("audio_status".to_owned(), json!("checked"));
    }
}

#[cfg(test)]
mod tests {
    use super::base_report;

    #[test]
    fn benchmark_report_keeps_legacy_numeric_and_string_scalars() {
        let report = base_report("startup");
        assert_eq!(report.get("benchmark").and_then(|value| value.as_str()), Some("startup"));
        assert!(report.get("total_memory_bytes").is_some_and(|value| value.is_number()));
        assert!(report.get("process_uptime_us").is_some_and(|value| value.is_string()));
        assert!(report.get("platform").is_some_and(|value| value.is_string()));
        assert_eq!(
            report.get("measurement_scope").and_then(|value| value.as_str()),
            Some("process-uptime-and-current-command")
        );
    }
}
