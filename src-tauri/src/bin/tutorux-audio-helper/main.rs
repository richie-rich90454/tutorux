//! Standalone process-audio capture helper used by the Tutorux CLI.
//!
//! `devices` and `inputs` write JSON arrays to stdout. `probe` reports either a short microphone /
//! system-audio signal measurement or a per-application stream measurement. `capture` writes raw
//! interleaved PCM in the endpoint's native sample rate, channel count, and sample format to stdout
//! until stdin receives `stop` or closes. The selected format is announced as a JSON line on stderr
//! before the first PCM byte, followed by a frame/byte summary on stderr after the stream ends.

mod application;
mod application_capture;
mod application_probe;
mod archive_lock;
#[path = "../../archive_lock_support.rs"]
#[allow(dead_code)]
mod archive_lock_support;
mod args;
mod capture_io;
mod native_input;

#[cfg(test)]
mod tests;

use std::io::{self, Write};

fn main() -> std::process::ExitCode {
    if let Err(error) = args::run() {
        let _ = writeln!(io::stderr().lock(), "tutorux-audio-helper: {error}");
        return std::process::ExitCode::from(1);
    }
    std::process::ExitCode::SUCCESS
}
