use std::{
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

use crate::application::APPLICATION_CHANNELS;

pub(crate) fn write_silence_frames(
    output: &mut impl Write,
    frames: u64,
    bytes_per_frame: usize,
) -> Result<(), String> {
    const ZEROES: [u8; 4096] = [0; 4096];
    let mut bytes = frames.saturating_mul(bytes_per_frame as u64);
    while bytes > 0 {
        let take = usize::try_from(bytes.min(ZEROES.len() as u64)).unwrap_or(ZEROES.len());
        let take = take - take % bytes_per_frame;
        if take == 0 {
            break;
        }
        output
            .write_all(&ZEROES[..take])
            .map_err(|error| format!("could not deliver capture gap silence: {error}"))?;
        bytes -= take as u64;
    }
    Ok(())
}

pub(crate) fn watch_for_stop(stop: Arc<AtomicBool>) -> Result<(), String> {
    thread::Builder::new()
        .name("tutorux-audio-helper-control".to_owned())
        .spawn(move || {
            let mut command = String::new();
            let _ = io::stdin().lock().read_line(&mut command);
            stop.store(true, Ordering::Release);
        })
        .map(|_| ())
        .map_err(|error| format!("could not start the capture control channel: {error}"))
}

pub(crate) fn write_f32le(output: &mut impl Write, samples: &[f32]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    output
        .write_all(&bytes)
        .map_err(|error| format!("could not deliver captured audio to the CLI: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio to the CLI: {error}"))
}

pub(crate) fn application_frame_bytes() -> usize {
    usize::from(APPLICATION_CHANNELS) * 4
}
