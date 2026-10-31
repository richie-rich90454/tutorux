use serde_json::{json, Value};

use crate::core::cli::{emit, CliError, CliOutput, CliResult, ParsedArguments};
use crate::platform::synchronized_audio::headless::{enumerate_devices, probe_input, HeadlessDevice};

use super::ffmpeg::{self, FfmpegDevice};
use super::native_probe::{application_limitation, microphone_limitation, system_limitation};

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
    let ffmpeg_value = option_value("ffmpeg")?;
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
            "Select one synchronized secondary track with '--application' or '--playback'.".to_owned(),
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
    let executable = ffmpeg::resolve_executable(ffmpeg_value.as_deref());
    let ffmpeg_devices = ffmpeg::enumerate(&executable).unwrap_or_default();
    let native = enumerate_devices().ok();
    let microphone_requested = source == "microphone" || source == "both";
    let system_requested = source == "system-audio" || (source == "both" && application.is_none());
    let microphone_request = if source == "microphone" {
        microphone.as_deref().or(device.as_deref())
    } else {
        microphone.as_deref()
    };
    let system_request = if source == "system-audio" {
        playback.as_deref().or(device.as_deref())
    } else {
        playback.as_deref()
    };
    let microphone_probe = microphone_requested.then(|| {
        probe_input_source(
            "microphone",
            native.as_ref(),
            &ffmpeg_devices,
            &executable,
            microphone_request,
        )
    });
    let system_probe = system_requested.then(|| {
        probe_input_source(
            "system-audio",
            native.as_ref(),
            &ffmpeg_devices,
            &executable,
            system_request,
        )
    });
    let (report, available) = if source == "application" {
        probe_application_source(native.as_ref(), application.as_deref().or(device.as_deref()))
    } else if source == "both" {
        let microphone = microphone_probe
            .unwrap_or_else(|| unavailable("microphone", microphone_limitation()));
        let secondary = match application.as_deref() {
            Some(requested) => probe_application_source(native.as_ref(), Some(requested)).0,
            None => system_probe
                .unwrap_or_else(|| unavailable("system-audio", system_limitation())),
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
        .unwrap_or_else(|| unavailable(source, microphone_limitation()));
        let available = probe["available"].as_bool().unwrap_or(false);
        (probe, available)
    };
    let measurements = report
        .get("synchronized_tracks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![report.clone()]);
    let summary = if available {
        let details = measurements
            .iter()
            .filter(|track| track["available"].as_bool() == Some(true))
            .map(|track| {
                if track["signal_detected"].as_bool() == Some(true) {
                    format!(
                        "{}: signal detected (RMS {:.4}, peak {:.4}, {:.1} dBFS).",
                        track["source"].as_str().unwrap_or("audio"),
                        track["rms"].as_f64().unwrap_or(0.0),
                        track["peak"].as_f64().unwrap_or(0.0),
                        track["dbfs"].as_f64().unwrap_or(-120.0)
                    )
                } else {
                    format!(
                        "{}: stream opened, but no signal above threshold was measured (RMS {:.4}, {:.1} dBFS).",
                        track["source"].as_str().unwrap_or("audio"),
                        track["rms"].as_f64().unwrap_or(0.0),
                        track["dbfs"].as_f64().unwrap_or(-120.0)
                    )
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            "The requested {source} stream was opened and measured. {details} The selected stream was opened and measured for about 1.8 seconds; no recording was saved."
        )
    } else {
        format!("The requested {source} input is unavailable or unsupported.")
    };
    emit(output, report, &summary, args.json());
    Ok(if available { 0 } else { 1 })
}

fn probe_input_source(
    source: &str,
    native: Option<&crate::platform::synchronized_audio::headless::HeadlessDevices>,
    ffmpeg_devices: &[FfmpegDevice],
    executable: &str,
    requested: Option<&str>,
) -> Value {
    if let Some(devices) = native {
        let candidates: Vec<&HeadlessDevice> = devices
            .devices
            .iter()
            .filter(|device| device.source == source)
            .collect();
        let selected = match requested.filter(|value| *value != "default") {
            Some(value) => candidates
                .iter()
                .find(|device| device.id == value || device.name == value)
                .copied(),
            None => candidates
                .iter()
                .find(|device| device.is_default)
                .copied()
                .or_else(|| (candidates.len() == 1).then(|| candidates[0])),
        };
        if let Some(device) = selected {
            match probe_input(source, &device.id) {
                Ok(probe) => {
                    let mut report = json!({
                        "available": true,
                        "source": source,
                        "device_id": probe.id,
                        "device_name": probe.name,
                        "backend": probe.backend,
                        "sample_format": probe.sample_format,
                        "sample_rate_hz": probe.sample_rate_hz,
                        "channel_count": probe.channel_count,
                        "sample_count": probe.sample_count,
                        "duration_ms": probe.duration_ms,
                        "rms": probe.rms,
                        "peak": probe.peak,
                        "dbfs": probe.dbfs,
                        "signal_detected": probe.signal_detected,
                        "probe": "native-stream-opened-and-signal-measured",
                    });
                    if !probe.signal_detected {
                        report["limitation"] = json!(
                            "The stream opened, but no signal above the detection threshold was measured."
                        );
                    }
                    return report;
                }
                Err(_) => {}
            }
        }
    }
    let candidates: Vec<&FfmpegDevice> = ffmpeg_devices
        .iter()
        .filter(|device| {
            if source == "microphone" {
                !ffmpeg::is_loopback(device)
            } else {
                ffmpeg::is_loopback(device)
            }
        })
        .collect();
    let selected = match requested.filter(|value| *value != "default") {
        Some(value) => ffmpeg_devices
            .iter()
            .find(|device| device.id == value || device.name == value),
        None => candidates
            .iter()
            .find(|device| device.backend == ffmpeg::preferred_backend())
            .copied()
            .or_else(|| candidates.first().copied()),
    };
    let Some(selected) = selected else {
        return unavailable(
            source,
            if source == "system-audio" {
                system_limitation()
            } else {
                microphone_limitation()
            },
        );
    };
    if source == "system-audio" && !ffmpeg::is_loopback(selected) {
        return unavailable("system-audio", system_limitation());
    }
    match super::ffmpeg_probe::probe(executable, selected, source) {
        Ok(probe) => {
            let mut report = json!({
                "available": true,
                "source": source,
                "device_id": probe["id"],
                "device_name": probe["name"],
                "backend": probe["backend"],
                "sample_format": probe["sample_format"],
                "sample_rate_hz": probe["sample_rate_hz"],
                "channel_count": probe["channel_count"],
                "sample_count": probe["sample_count"],
                "duration_ms": probe["duration_ms"],
                "rms": probe["rms"],
                "peak": probe["peak"],
                "dbfs": probe["dbfs"],
                "signal_detected": probe["signal_detected"],
                "probe": probe["probe"],
            });
            if probe["signal_detected"].as_bool() != Some(true) {
                report["limitation"] = json!(
                    "The stream opened, but no signal above the detection threshold was measured."
                );
            }
            report
        }
        Err(error) => json!({
            "available": false,
            "source": source,
            "device_id": selected.id,
            "device_name": selected.name,
            "backend": selected.backend,
            "probe": "ffmpeg-stream-open-failed",
            "limitation": error,
        }),
    }
}

fn probe_application_source(
    native: Option<&crate::platform::synchronized_audio::headless::HeadlessDevices>,
    requested: Option<&str>,
) -> (Value, bool) {
    let Some(devices) = native else {
        return (unavailable("application", &application_limitation()), false);
    };
    let candidates: Vec<&HeadlessDevice> = devices
        .devices
        .iter()
        .filter(|device| device.source == "application-audio")
        .collect();
    let selected = match requested {
        Some(value) => candidates.iter().copied().find(|device| {
            device.id == value
                || device.name == value
                || device.process_id.map(|id| id.to_string()).as_deref() == Some(value)
        }),
        None => (candidates.len() == 1).then(|| candidates[0]),
    };
    let Some(selected) = selected else {
        return (unavailable("application", &application_limitation()), false);
    };
    match crate::platform::synchronized_audio::headless::probe_application(&selected.id) {
        Ok(probe) => {
            let mut report = json!({
                "available": true,
                "source": "application",
                "device_id": probe.id,
                "device_name": probe.name,
                "backend": probe.backend,
                "sample_format": probe.sample_format,
                "sample_rate_hz": probe.sample_rate_hz,
                "channel_count": probe.channel_count,
                "sample_count": probe.sample_count,
                "duration_ms": probe.duration_ms,
                "rms": probe.rms,
                "peak": probe.peak,
                "dbfs": probe.dbfs,
                "signal_detected": probe.signal_detected,
                "probe": "native-stream-opened-and-signal-measured",
            });
            if probe.signal_detected == false {
                report["limitation"] = json!(
                    "The application stream opened, but no signal above the detection threshold was measured."
                );
            }
            (report, true)
        }
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
    }
}

fn unavailable(source: &str, limitation: &str) -> Value {
    json!({
        "available": false,
        "source": source,
        "probe": "stream-not-opened",
        "limitation": limitation,
    })
}
