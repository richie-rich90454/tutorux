use crate::core::cli::{CliContext, CliError, CliOutput, CliResult, ParsedArguments};

mod audio_test;
mod control;
pub(super) mod ffmpeg;
mod ffmpeg_probe;
mod helpers;
mod import;
mod mix;
mod mix_source;
mod native_audio;
mod native_capture;
mod native_probe;
mod playback;
mod takes;
mod wav;
mod waveform;
mod waveform_index;
mod worker_control;

pub fn run_recording_devices(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    native_audio::run_devices(args, output)
}

pub fn run_recording_test(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    audio_test::run_test(args, output)
}

fn validate_control(action: &str, args: &ParsedArguments) -> CliResult<()> {
    if !args.positionals.is_empty() {
        return Err(
            CliError(format!("record {action} does not accept positional arguments.")).into(),
        );
    }
    for flag in &args.flags {
        if flag != "json" && flag != "session" {
            return Err(CliError(format!("record {action} does not accept --{flag}.")).into());
        }
    }
    for option in args.options.keys() {
        if option != "session" {
            return Err(CliError(format!("record {action} does not accept --{option}.")).into());
        }
    }
    if args.flag("session") {
        return Err(CliError("--session requires a value.".to_owned()).into());
    }
    match args.option("session") {
        Some(value) => {
            if !crate::core::format::valid_uuid(value.trim()) {
                return Err(CliError("--session must be a valid UUID.".to_owned()).into());
            }
        }
        None if action != "status" => {
            return Err(
                CliError("Recording control requires '--session UUID'.".to_owned()).into(),
            )
        }
        None => {}
    }
    Ok(())
}

pub fn run_record_command(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    if matches!(action, "status" | "pause" | "resume" | "stop") {
        validate_control(action, &args)?;
    }
    match action {
        "take-list" => takes::take_list(args, output, path, context),
        "take-rename" => takes::take_rename(args, output, path, context),
        "take-delete" | "take-restore" => takes::set_take_deleted(action, args, output, path, context),
        "track-rename" => takes::track_rename(args, output, path, context),
        "waveform" => waveform::record_waveform(&args, output, path, context),
        "export-wav" => wav::record_export_wav(&args, output, path, context),
        "configure" => control::configure(args, output, path, context),
        "status" => worker_control::status(args, output, path, context),
        "pause" | "resume" | "stop" => worker_control::action(action, args, output, path, context),
        "start" => native_capture::run_start(args, output, path, context),
        "play" => playback::play(args, output, path, context),
        "mix" => mix::mix(args, output, path, context),
        "import" => import::record_import(&args, output, path, context),
        "recover" => control::recover(args, output, path, context),
        "waveform-index-build" | "waveform-index-show" => {
            waveform_index::run(action, &args, output, path, context)
        }
        _ => Err(CliError(format!("record {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
