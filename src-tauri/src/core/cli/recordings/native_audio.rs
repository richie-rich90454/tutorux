use serde_json::{json, Value};

use crate::core::cli::{emit, CliError, CliOutput, CliResult, ParsedArguments};
use crate::platform::synchronized_audio::headless::{enumerate_devices, HeadlessDevice};

pub fn run_devices(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError("record devices does not accept positional arguments.".to_owned()).into());
    }
    if args.flags.contains("ffmpeg") {
        return Err(CliError("--ffmpeg requires an executable path.".to_owned()).into());
    }
    if args.option("ffmpeg").is_some_and(|value| value.trim().is_empty()) {
        return Err(CliError("--ffmpeg cannot be empty.".to_owned()).into());
    }
    let ffmpeg = resolve_ffmpeg(args.option("ffmpeg"));

    let mut rows: Vec<Value> = Vec::new();
    let mut ffmpeg_reason = String::new();
    match crate::core::cli::recordings::ffmpeg::enumerate(&ffmpeg) {
        Ok(devices) => {
            for device in devices {
                rows.push(json!({
                    "id": device.id,
                    "name": device.name,
                    "backend": device.backend,
                }));
            }
        }
        Err(error) => ffmpeg_reason = error,
    }
    let mut native_reason = String::new();
    let mut application_reason = String::new();
    match enumerate_devices() {
        Ok(devices) => {
            for device in devices.devices {
                rows.push(device_row(&device));
            }
            if let Some(reason) = devices.system_audio_unavailable_reason {
                native_reason = reason;
            }
            if let Some(reason) = devices.application_audio_unavailable_reason {
                application_reason = reason;
            }
        }
        Err(error) => native_reason = error,
    }

    let mut document = serde_json::Map::new();
    document.insert("ffmpeg".to_owned(), Value::String(ffmpeg));
    document.insert("devices".to_owned(), Value::Array(rows.clone()));
    if !ffmpeg_reason.is_empty() {
        document.insert(
            "ffmpeg_unavailable_reason".to_owned(),
            Value::String(ffmpeg_reason.clone()),
        );
    }
    if !native_reason.is_empty() {
        document.insert(
            "native_audio_unavailable_reason".to_owned(),
            Value::String(native_reason.clone()),
        );
    }
    if !application_reason.is_empty() {
        document.insert(
            "application_audio_unavailable_reason".to_owned(),
            Value::String(application_reason.clone()),
        );
    }

    let mut summary: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            Some(format!(
                "{}  {}  ({} · {}{})",
                row.get("id")?.as_str()?,
                row.get("name")?.as_str()?,
                row.get("backend")?.as_str()?,
                row.get("source").and_then(Value::as_str).unwrap_or("native"),
                if row.get("is_default").and_then(Value::as_bool) == Some(true) {
                    " · default"
                } else {
                    ""
                }
            ))
        })
        .collect();
    if !ffmpeg_reason.is_empty() {
        summary.push(format!("FFmpeg unavailable: {ffmpeg_reason}"));
    }
    if !native_reason.is_empty() {
        summary.push(format!("Native microphone/system audio unavailable: {native_reason}"));
    }
    if !application_reason.is_empty() {
        summary.push(format!("Application audio unavailable: {application_reason}"));
    }
    if rows.is_empty() {
        summary.push(
            "No audio input endpoints were found. Check device support and operating-system permissions."
                .to_owned(),
        );
    }
    emit(
        output,
        Value::Object(document),
        &summary.join("\n"),
        args.json(),
    );
    Ok(if rows.is_empty() { 1 } else { 0 })
}

pub(super) fn resolve_ffmpeg(value: Option<&str>) -> String {
    crate::core::cli::recordings::ffmpeg::resolve_executable(value)
}

fn device_row(device: &HeadlessDevice) -> Value {
    let mut row = json!({
        "id": device.id,
        "name": device.name,
        "backend": device.backend,
        "source": device.source,
        "is_default": device.is_default,
    });
    if let Some(process_id) = device.process_id {
        row["process_id"] = json!(process_id);
    }
    if let Some(bundle_id) = &device.bundle_id {
        row["bundle_id"] = json!(bundle_id);
    }
    row
}
