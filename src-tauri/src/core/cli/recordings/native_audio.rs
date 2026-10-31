use serde_json::{json, Value};

use crate::core::cli::{emit, CliError, CliOutput, CliResult, ParsedArguments};
use crate::platform::synchronized_audio::headless::{
    enumerate_devices, probe_application, HeadlessDevice,
};

use super::native_probe::{
    application_limitation, microphone_limitation, probe_report, probe_selected, system_limitation,
    unavailable_probe,
};

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
    let ffmpeg_reason =
        "The Rust CLI lists native cpal devices only; FFmpeg device enumeration is not used.".to_owned();

    let mut document = serde_json::Map::new();
    document.insert("ffmpeg".to_owned(), Value::String(ffmpeg));
    document.insert("devices".to_owned(), Value::Array(rows.clone()));
    document.insert(
        "ffmpeg_unavailable_reason".to_owned(),
        Value::String(ffmpeg_reason.clone()),
    );
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
    summary.push(format!("FFmpeg unavailable: {ffmpeg_reason}"));
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

pub fn run_test(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    if !args.positionals.is_empty() {
        return Err(CliError("record test does not accept positional arguments.".to_owned()).into());
    }
    if args.options.contains_key("system-audio") {
        return Err(CliError("--system-audio is a flag and does not accept a value.".to_owned()).into());
    }
    let option_value = |name: &str| -> CliResult<Option<String>> {
        if args.flags.contains(name) {
            return Err(CliError(format!("--{name} requires a value.")).into());
        }
        match args.option(name) {
            Some("") => Err(CliError(format!("--{name} cannot be empty.")).into()),
            Some(value) => Ok(Some(value.to_owned())),
            None => Ok(None),
        }
    };
    let requested_source = option_value("source")?.unwrap_or_else(|| {
        if args.flags.contains("system-audio") {
            "system-audio".to_owned()
        } else {
            "microphone".to_owned()
        }
    });
    if !["microphone", "system-audio", "loopback", "application", "both"]
        .contains(&requested_source.as_str())
    {
        return Err(CliError(
            "Recording test source must be 'microphone', 'system-audio', 'application', or 'both'."
                .to_owned(),
        )
        .into());
    }
    let device = option_value("device")?;
    let microphone = option_value("microphone")?;
    let playback = option_value("playback")?;
    let application = option_value("application")?;
    let _ffmpeg = option_value("ffmpeg")?;
    let test_both = requested_source == "both"
        || (requested_source == "microphone" && args.flags.contains("system-audio"));
    if application.is_some() && args.flags.contains("system-audio") {
        return Err(CliError(
            "Choose one synchronized secondary track with '--application' or '--system-audio'."
                .to_owned(),
        )
        .into());
    }
    if application.is_some() && playback.is_some() {
        return Err(CliError(
            "Select one synchronized secondary track with '--application' or '--playback'."
                .to_owned(),
        )
        .into());
    }
    if application.is_some() && requested_source != "both" && requested_source != "application" {
        return Err(CliError(
            "Use '--application ID' with '--source application' or '--source both'.".to_owned(),
        )
        .into());
    }
    if requested_source == "application"
        && (args.flags.contains("system-audio") || microphone.is_some() || playback.is_some())
    {
        return Err(CliError(
            "Application audio tests accept only '--device ID' or '--application ID'.".to_owned(),
        )
        .into());
    }
    if test_both && device.is_some() {
        return Err(CliError(
            "Test synchronized sources with '--microphone' and '--playback'.".to_owned(),
        )
        .into());
    }
    if !test_both && device.is_some() && {
        (requested_source == "microphone" && microphone.is_some())
            || ((requested_source == "system-audio" || requested_source == "loopback")
                && playback.is_some())
            || (requested_source == "application" && application.is_some())
    } {
        return Err(CliError(
            "Use either '--device ID' or the source-specific device option.".to_owned(),
        )
        .into());
    }

    let source = if test_both {
        "both"
    } else if requested_source == "loopback" {
        "system-audio"
    } else {
        requested_source.as_str()
    };
    let devices = match enumerate_devices() {
        Ok(devices) => devices,
        Err(error) => {
            let report = json!({
                "available": false,
                "source": source,
                "probe": "stream-not-opened",
                "limitation": error,
            });
            emit(output, report.clone(), report["limitation"].as_str().unwrap_or(""), args.json());
            return Ok(1);
        }
    };
    let device_list = devices.devices;
    let microphone_probe = if source == "microphone" || source == "both" {
        Some(probe_selected(
            "microphone",
            device_list.as_slice(),
            if source == "microphone" {
                microphone.as_deref().or(device.as_deref())
            } else {
                microphone.as_deref()
            },
        ))
    } else {
        None
    };
    let system_probe = if source == "system-audio" || (source == "both" && application.is_none()) {
        Some(probe_selected(
            "system-audio",
            device_list.as_slice(),
            if source == "system-audio" {
                playback.as_deref().or(device.as_deref())
            } else {
                playback.as_deref()
            },
        ))
    } else {
        None
    };

    let (report, available) = if source == "application" {
        let selected = device_list
            .iter()
            .find(|candidate| candidate.source == "application-audio")
            .filter(|candidate| {
                let requested = application.as_deref().or(device.as_deref());
                match requested {
                    None => device_list
                        .iter()
                        .filter(|candidate| candidate.source == "application-audio")
                        .count()
                        == 1,
                    Some(value) => {
                        candidate.id == value
                            || candidate.name == value
                            || candidate.process_id.map(|id| id.to_string()).as_deref() == Some(value)
                    }
                }
            });
        match selected {
            None => (
                json!({
                    "available": false,
                    "source": "application",
                    "probe": "native-stream-not-opened",
                    "limitation": devices
                        .application_audio_unavailable_reason
                        .unwrap_or_else(application_limitation),
                }),
                false,
            ),
            Some(selected) => match probe_application(&selected.id) {
                Ok(probe) => (probe_report(probe, "application"), true),
                Err(error) => (
                    json!({
                        "available": false,
                        "source": "application",
                        "device_id": selected.id,
                        "device_name": selected.name,
                        "backend": selected.backend,
                        "probe": "native-stream-open-failed",
                        "limitation": error,
                    }),
                    false,
                ),
            },
        }
    } else if source == "both" {
        let microphone = microphone_probe
            .unwrap_or_else(|| unavailable_probe("microphone", microphone_limitation()));
        let secondary = match application.as_deref() {
            Some(requested) => {
                let selected = device_list
                    .iter()
                    .find(|candidate| candidate.source == "application-audio")
                    .filter(|candidate| {
                        candidate.id == requested
                            || candidate.name == requested
                            || candidate.process_id.map(|id| id.to_string()).as_deref()
                                == Some(requested)
                    });
                match selected {
                    Some(selected) => match probe_application(&selected.id) {
                        Ok(probe) => probe_report(probe, "application"),
                        Err(error) => json!({
                            "available": false,
                            "source": "application",
                            "device_id": selected.id,
                            "device_name": selected.name,
                            "backend": selected.backend,
                            "probe": "native-stream-open-failed",
                            "limitation": error,
                        }),
                    },
                    None => unavailable_probe("application", &application_limitation()),
                }
            }
            None => system_probe
                .unwrap_or_else(|| unavailable_probe("system-audio", system_limitation())),
        };
        let available = microphone["available"].as_bool().unwrap_or(false)
            && secondary["available"].as_bool().unwrap_or(false);
        (
            json!({
                "available": available,
                "source": "both",
                "probe": "separate-stream-probes-opened-and-signal-measured",
                "synchronized_tracks": [microphone, secondary],
            }),
            available,
        )
    } else {
        let probe = if source == "microphone" {
            microphone_probe
        } else {
            system_probe
        }
        .unwrap_or_else(|| unavailable_probe(source, microphone_limitation()));
        let available = probe["available"].as_bool().unwrap_or(false);
        (probe, available)
    };

    let summary = if available {
        format!("The requested {source} stream was opened and measured; samples were not saved.")
    } else {
        format!("The requested {source} input is unavailable or unsupported.")
    };
    emit(output, report, &summary, args.json());
    Ok(if available { 0 } else { 1 })
}

fn resolve_ffmpeg(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("TUTORUX_FFMPEG")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "ffmpeg".to_owned())
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
