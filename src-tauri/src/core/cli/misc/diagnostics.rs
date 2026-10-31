use serde_json::{json, Value};

use crate::core::cli::{
    emit, open_archive, resolve_path, Cancellation, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::diagnostics::headless_system_snapshot;

use super::providers::run_diagnostics_providers;

pub fn run_diagnostics_command(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
    cancellation: &dyn Cancellation,
) -> CliResult<i32> {
    match action {
        "providers" => run_diagnostics_providers(args, output),
        "network" => {
            if args.option("provider").is_none() {
                emit(
                    output,
                    json!({"network_checked": false, "reason": "provider-not-selected"}),
                    "No provider selected; no request sent.",
                    args.json(),
                );
                return Ok(0);
            }
            let Some(path) = context.archive_path.as_deref() else {
                return Err(CliError("Network diagnostics require --archive.".to_owned()).into());
            };
            super::ai::run_ai_action("test", &args, output, path, context)
        }
        "audio" => {
            let rows = audio_rows();
            if rows.is_empty() {
                emit(
                    output,
                    json!({
                        "status": "unavailable-in-cli",
                        "reason": "The native audio backend enumerated no microphone, system-audio, or application endpoints.",
                    }),
                    "Audio endpoint enumeration is unavailable.",
                    args.json(),
                );
                return Ok(0);
            }
            emit(
                output,
                json!({
                    "status": "checked",
                    "samples_retained": false,
                    "network_checked": false,
                    "endpoints": rows,
                }),
                &format!(
                    "Audio diagnostics inspected {} endpoint(s); no samples were retained and no network request was made.",
                    rows.len()
                ),
                args.json(),
            );
            Ok(0)
        }
        "graphics" => {
            emit(
                output,
                json!({
                    "backend": "Tauri",
                    "compiled": true,
                    "status": "native-gui-enabled",
                    "reason": "No frame was rendered by this CLI process.",
                    "rendering_measured": false,
                    "rendering_reason": "run-the-benchmark-in-the-active-desktop-window",
                }),
                "Graphics diagnostics: native-gui-enabled; no frame was rendered by this CLI process.",
                args.json(),
            );
            Ok(0)
        }
        "run" | "archive" | "report" => {
            let Some(path) = context.archive_path.clone() else {
                return Err(CliError("Archive diagnostics require --archive.".to_owned()).into());
            };
            let snapshot = open_archive(&path, context.passphrase())?;
            if snapshot.locked() {
                return Err(CliError(
                    "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
                )
                .into());
            }
            if cancellation.is_cancelled() {
                return Err(CliError("Diagnostics cancelled.".to_owned()).into());
            }
            let full = args.flag("full");
            let include_system = action != "archive";
            let mut issues: Vec<String> = Vec::new();
            let mut verification: Option<crate::core::verify::HistoryVerificationResult> = None;
            if full {
                match crate::core::verify::verify_history(&snapshot) {
                    Ok(result) => verification = Some(result),
                    Err(error) => issues.push(error.message),
                }
            } else if let Err(error) = snapshot.verify_authenticated() {
                issues.push(error.message);
            }
            let base = snapshot.verify()?;
            let mut report = serde_json::Map::new();
            report.insert("archive_generation".to_owned(), json!(base.generation.to_string()));
            report.insert("archive_valid".to_owned(), json!(issues.is_empty()));
            report.insert(
                "records_checked".to_owned(),
                json!(verification.as_ref().map_or(0, |value| value.verified_generation_records)),
            );
            report.insert(
                "index_pages_checked".to_owned(),
                if full { Value::Null } else { json!(1) },
            );
            report.insert("issues".to_owned(), json!(issues.join("\n")));
            report.insert("archive_id".to_owned(), json!(snapshot.header.id));
            report.insert("encrypted".to_owned(), json!(snapshot.encrypted()));
            report.insert(
                "full_verification".to_owned(),
                verification.as_ref().map_or(Value::Null, |value| {
                    json!({
                        "generation": value.current.generation.to_string(),
                        "currentRecords": value.current.current_records,
                        "liveRecords": value.current.live_records,
                        "deletedRecords": value.current.deleted_records,
                        "indexEntries": value.current.index_entries,
                        "valid": value.current.valid,
                        "recordsChecked": value.current.records_checked,
                        "indexPagesChecked": value.current.index_pages_checked,
                        "issues": value.current.issues,
                        "historicalRevisions": value.historical_revisions,
                        "verifiedCommits": value.verified_commits,
                        "verifiedGenerationRecords": value.verified_generation_records,
                    })
                }),
            );
            if include_system {
                if let Some(system) = headless_system_snapshot().as_object() {
                    for (name, value) in system {
                        report.insert(format!("system_{name}"), value.clone());
                    }
                }
                let audio_count = audio_rows().len();
                report.insert(
                    "audio_device_count".to_owned(),
                    if audio_count == 0 { json!("unavailable") } else { json!(audio_count) },
                );
                report.insert(
                    "audio_status".to_owned(),
                    if audio_count == 0 { json!("unavailable") } else { json!("checked") },
                );
                report.insert("audio_samples_retained".to_owned(), json!(false));
                report.insert("network_checked".to_owned(), json!(false));
            }
            let report = Value::Object(report);

            if action == "report" {
                let destination = resolve_path(args.required_option("output")?);
                if crate::core::cli::records::same_path_public(&destination, &path) {
                    return Err(CliError(
                        "Diagnostic output cannot replace its source archive.".to_owned(),
                    )
                    .into());
                }
                let contents = format!(
                    "{}\n",
                    serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_owned())
                );
                crate::core::cli::write_file_atomically(&destination, contents.as_bytes())?;
                emit(
                    output,
                    json!({
                        "output": destination.to_string_lossy(),
                        "status": "exported",
                        "bytes": contents.len(),
                    }),
                    &format!("Diagnostic report exported to {}.", destination.display()),
                    args.json(),
                );
                return Ok(0);
            }
            let valid = report["archive_valid"].as_bool() == Some(true);
            emit(
                output,
                report.clone(),
                &format!(
                    "Archive diagnostics: {valid}; generation {}; {} record(s) checked.\n{}",
                    report["archive_generation"].as_str().unwrap_or("0"),
                    report["records_checked"].as_str().unwrap_or("0"),
                    serde_json::to_string_pretty(&report).unwrap_or_default()
                ),
                args.json(),
            );
            Ok(if valid { 0 } else { 2 })
        }
        _ => Err(CliError(format!(
            "diagnostics {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

pub(crate) fn audio_rows() -> Vec<Value> {
    let Ok(devices) = crate::platform::synchronized_audio::headless::enumerate_devices() else {
        return Vec::new();
    };
    devices
        .devices
        .into_iter()
        .map(|device| {
            let kind = match device.source.as_str() {
                "microphone" => "microphone",
                "application-audio" => "application",
                _ => "playback",
            };
            let configured = device.sample_format.is_some()
                && device.sample_rate_hz.is_some()
                && device.channel_count.is_some();
            let mut row = json!({
                "device_id": device.id,
                "name": device.name,
                "kind": kind,
                "default": if device.source == "application-audio" { Value::Null } else { json!(device.is_default) },
                "backend": device.backend,
                "probe_state": if configured { "ready" } else { "unsupported" },
                "probe_message": if configured {
                    "The native audio backend inspected the endpoint configuration without starting a stream."
                } else if device.source == "application-audio" {
                    "The application endpoint was discovered and has not been opened yet."
                } else {
                    "This endpoint did not report a supported native audio configuration."
                },
            });
            if let Some(sample_format) = device.sample_format {
                row["sample_format"] = json!(sample_format);
            }
            if let Some(sample_rate) = device.sample_rate_hz {
                row["sample_rate_hz"] = json!(sample_rate.to_string());
            }
            if let Some(channels) = device.channel_count {
                row["channel_count"] = json!(channels.to_string());
            }
            if let Some(process_id) = device.process_id {
                row["application_process_id"] = json!(process_id.to_string());
                row["probe_state"] = json!("not-probed");
                row["probe_message"] = json!(
                    "The application stream was discovered and has not been opened yet."
                );
            }
            row
        })
        .collect()
}

