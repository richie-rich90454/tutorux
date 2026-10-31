use crate::core::cli::{CliContext, CliError, CliResult, ParsedArguments};

use super::{open_ready, require_session, WhisperRequest, DEFAULT_DURATION_SECONDS, MAX_DURATION_SECONDS};

pub(super) struct StartOptions {
    pub(super) session_id: String,
    pub(super) device: Option<String>,
    pub(super) microphone: Option<String>,
    pub(super) playback: Option<String>,
    pub(super) application: Option<String>,
    pub(super) needs_microphone: bool,
    pub(super) needs_system: bool,
    pub(super) needs_application: bool,
    pub(super) duration_seconds: u64,
    pub(super) confirmed_by: String,
    pub(super) durability: String,
    pub(super) detach: bool,
    pub(super) whisper: Option<WhisperRequest>,
}

pub(super) fn parse(
    args: &ParsedArguments,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<StartOptions> {
    if !args.positionals.is_empty() {
        return Err(CliError("record start does not accept positional arguments.".to_owned()).into());
    }
    if !args.flags.contains("consent") {
        return Err(CliError("Recording requires explicit confirmation with --consent.".to_owned()).into());
    }
    for name in [
        "source",
        "device",
        "microphone",
        "playback",
        "application",
        "whisper",
        "model",
        "language",
        "threads",
        "window-seconds",
        "confirmed-by",
        "duration-seconds",
        "durability",
        "ffmpeg",
    ] {
        if args.flags.contains(name) {
            return Err(CliError(format!("--{name} requires a value.")).into());
        }
    }
    if args.options.contains_key("system-audio") {
        return Err(CliError("--system-audio is a flag and does not accept a value.".to_owned()).into());
    }
    if args.options.contains_key("input-format") {
        return Err(CliError(
            "The Rust recording backend does not accept --input-format; native device identifiers select the backend."
                .to_owned(),
        )
        .into());
    }
    let source = args
        .option("source")
        .unwrap_or(if args.flags.contains("system-audio") {
            "system-audio"
        } else {
            "microphone"
        });
    if !["microphone", "system-audio", "loopback", "both", "application"].contains(&source) {
        return Err(CliError(
            "Recording source must be 'microphone', 'system-audio', 'application', or 'both'."
                .to_owned(),
        )
        .into());
    }
    let source = if source == "loopback" { "system-audio" } else { source };
    let device = args.option("device").map(str::to_owned);
    let microphone_request = args.option("microphone").map(str::to_owned);
    let playback_request = args.option("playback").map(str::to_owned);
    let application_request = args.option("application").map(str::to_owned);
    if [
        device.as_deref(),
        microphone_request.as_deref(),
        playback_request.as_deref(),
        application_request.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.trim().is_empty())
    {
        return Err(CliError("A device option cannot be empty.".to_owned()).into());
    }
    if source == "system-audio" && microphone_request.is_some() {
        return Err(CliError(
            "Use --microphone only when the microphone source is enabled.".to_owned(),
        )
        .into());
    }
    if source == "microphone" && playback_request.is_some() {
        return Err(CliError(
            "Use --playback only when system-audio capture is enabled.".to_owned(),
        )
        .into());
    }
    let (needs_microphone, needs_system, needs_application) = match source {
        "both" => {
            if application_request.is_some() && args.flags.contains("system-audio") {
                return Err(CliError(
                    "Choose one synchronized secondary track with '--application' or '--system-audio'."
                        .to_owned(),
                )
                .into());
            }
            if application_request.is_some() && playback_request.is_some() {
                return Err(CliError(
                    "Select one synchronized secondary track with '--application' or '--playback'."
                        .to_owned(),
                )
                .into());
            }
            (true, application_request.is_none(), application_request.is_some())
        }
        "microphone" => {
            if application_request.is_some() {
                return Err(CliError(
                    "Use --application only with --source application or --source both.".to_owned(),
                )
                .into());
            }
            (true, args.flags.contains("system-audio"), false)
        }
        "application" => {
            if args.flags.contains("system-audio")
                || microphone_request.is_some()
                || playback_request.is_some()
            {
                return Err(CliError(
                    "Application-only capture accepts --device or --application, not microphone or system-audio selectors."
                        .to_owned(),
                )
                .into());
            }
            (false, false, true)
        }
        _ => (false, true, false),
    };
    if needs_microphone && (needs_system || needs_application) && device.is_some() {
        return Err(CliError(
            "Use source-specific selectors to choose synchronized inputs; --device is only for one source."
                .to_owned(),
        )
        .into());
    }
    if device.is_some()
        && (microphone_request.is_some()
            || playback_request.is_some()
            || application_request.is_some())
    {
        return Err(CliError(
            "Choose --device or source-specific audio selectors, not both.".to_owned(),
        )
        .into());
    }
    let live = args.flags.contains("live-transcribe");
    let diarize = args.flags.contains("diarize");
    if diarize && !live {
        return Err(CliError("Use --diarize with --live-transcribe.".to_owned()).into());
    }
    let whisper_options = ["whisper", "model", "language", "threads", "window-seconds"]
        .iter()
        .any(|name| args.options.contains_key(*name));
    if !live && (whisper_options || args.flags.contains("consent-local-audio")) {
        return Err(CliError("Whisper options require --live-transcribe.".to_owned()).into());
    }
    if live && !args.flags.contains("consent-local-audio") {
        return Err(CliError(
            "Use --consent-local-audio to authorize local Whisper processing during recording."
                .to_owned(),
        )
        .into());
    }
    if live && needs_microphone && (needs_system || needs_application) {
        return Err(CliError(
            "Live transcription requires one captured track. Start a single source or transcribe the synchronized tracks after recording."
                .to_owned(),
        )
        .into());
    }
    let whisper = if live {
        let language = args.option("language").unwrap_or("auto").to_owned();
        if language.is_empty()
            || language.len() > 16
            || !language.bytes().all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        {
            return Err(CliError("Enter a valid Whisper language code, or auto.".to_owned()).into());
        }
        let window_seconds = match args.option("window-seconds") {
            Some(value) => value
                .parse::<u32>()
                .ok()
                .filter(|value| (1..=27).contains(value))
                .ok_or_else(|| {
                    CliError("--window-seconds must be an integer from 1 through 27.".to_owned())
                })?,
            None => 27,
        };
        Some(WhisperRequest {
            executable: args.required_option("whisper")?.to_owned(),
            model: args.required_option("model")?.to_owned(),
            language,
            threads: match args.option("threads") {
                Some(value) => Some(
                    value
                        .parse::<u32>()
                        .ok()
                        .filter(|value| (1..=64).contains(value))
                        .ok_or_else(|| {
                            CliError("--threads must be an integer from 1 through 64.".to_owned())
                        })?,
                ),
                None => None,
            },
            diarize,
            window_seconds,
        })
    } else {
        None
    };
    let duration_seconds = match args.option("duration-seconds") {
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| (1..=MAX_DURATION_SECONDS).contains(value))
            .ok_or_else(|| {
                CliError("--duration-seconds must be an integer from 1 through 604800.".to_owned())
            })?,
        None => DEFAULT_DURATION_SECONDS,
    };
    let confirmed_by = args.option("confirmed-by").unwrap_or("CLI user").trim().to_owned();
    if confirmed_by.is_empty()
        || confirmed_by.len() > 256
        || confirmed_by.contains(['\r', '\n', '\0'])
    {
        return Err(CliError(
            "--confirmed-by must be a non-empty, single-line label up to 256 characters."
                .to_owned(),
        )
        .into());
    }
    let session_id = crate::core::cli::validate_uuid(
        args.required_option("session")?,
        "--session",
    )?;
    let durability = args.option("durability").unwrap_or("default").to_owned();
    if !["default", "maximum", "reduced-write"].contains(&durability.as_str()) {
        return Err(CliError(
            "Durability must be 'default', 'maximum', or 'reduced-write'.".to_owned(),
        )
        .into());
    }
    let snapshot = open_ready(path, context)?;
    let session = require_session(&snapshot, &session_id)?;
    if super::is_archive_active(session.field("recording_state").unwrap_or("")) {
        return Err(CliError(format!(
            "Session {session_id} already has an active recording state. Check record status or recover the saved take before starting another recording."
        ))
        .into());
    }
    Ok(StartOptions {
        session_id,
        device,
        microphone: microphone_request,
        playback: playback_request,
        application: application_request,
        needs_microphone,
        needs_system,
        needs_application,
        duration_seconds,
        confirmed_by,
        durability,
        detach: args.flags.contains("detach"),
        whisper,
    })
}
