use crate::core::cli::{CliContext, CliError, CliOutput, CliResult, ParsedArguments};

mod control;
mod helpers;
mod import;
mod native_audio;
mod native_capture;
mod native_probe;
mod takes;
mod wav;
mod waveform;

pub fn run_recording_devices(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    native_audio::run_devices(args, output)
}

pub fn run_recording_test(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    native_audio::run_test(args, output)
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
        "status" => native_capture::run_status(args, output, path, context),
        "pause" | "resume" | "stop" => native_capture::run_control(action, args, output, path, context),
        "start" => native_capture::run_start(args, output, path, context),
        "play" => Err(CliError(
            "Playback requires ffplay from a host FFmpeg distribution; the Rust CLI does not bundle it."
                .to_owned(),
        )
        .into()),
        "mix" => control::mix(args, output, path, context),
        "import" => import::record_import(&args, output, path, context),
        "recover" => control::recover(args, output, path, context),
        "waveform-index-build" | "waveform-index-show" => Err(CliError(
            "Native recording control is available in the desktop application.".to_owned(),
        )
        .into()),        _ => Err(CliError(format!("record {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
