use serde_json::json;

use crate::core::cli::{emit, CliContext, CliError, CliOutput, CliResult, ParsedArguments};

mod control;
mod helpers;
mod import;
mod takes;
mod wav;
mod waveform;

pub fn run_recording_devices(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    emit(
        output,
        json!({
            "native": {"available": false, "microphones": [], "system_inputs": []},
            "ffmpeg": {"available": false, "inputs": []},
            "applications": [],
        }),
        "Native audio capture is unavailable in this build; install the desktop application for device enumeration.",
        args.json(),
    );
    Ok(0)
}

pub fn run_recording_test(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    emit(
        output,
        json!({
            "status": "unavailable",
            "source": args.option("source").unwrap_or("microphone"),
            "message": "Native audio capture is unavailable in this build.",
        }),
        "Native audio capture is unavailable in this build; use the desktop application to probe devices.",
        args.json(),
    );
    Ok(0)
}

pub fn run_record_command(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    match action {
        "take-list" => takes::take_list(args, output, path, context),
        "take-rename" => takes::take_rename(args, output, path, context),
        "take-delete" | "take-restore" => takes::set_take_deleted(action, args, output, path, context),
        "track-rename" => takes::track_rename(args, output, path, context),
        "waveform" => waveform::record_waveform(&args, output, path, context),
        "export-wav" => wav::record_export_wav(&args, output, path, context),
        "configure" => control::configure(args, output, path, context),
        "status" => control::status(args, output, path, context),
        "pause" | "resume" | "stop" => control::require_detached_worker(args, path, context),
        "play" => Err(CliError(
            "Playback requires ffplay from a host FFmpeg distribution; the Rust CLI does not bundle it."
                .to_owned(),
        )
        .into()),
        "mix" => control::mix(args, output, path, context),
        "import" => import::record_import(&args, output, path, context),
        "recover" => control::recover(args, output, path, context),
        "start" | "waveform-index-build" | "waveform-index-show" => Err(CliError(
            "Native recording control is available in the desktop application.".to_owned(),
        )
        .into()),
        _ => Err(CliError(format!("record {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
