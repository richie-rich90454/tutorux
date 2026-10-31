use cpal::{
    traits::{DeviceTrait, StreamTrait},
    Data,
};
use serde::Serialize;
use std::{
    io::{self, BufWriter, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use super::device::{
    capture_format, resolve_device, set_terminal_error, source_config, validate_config,
    CaptureFormat,
};
use super::encode::encode_capture;

const MAX_QUEUED_CHUNKS: usize = 8;
const MAX_CALLBACK_FRAMES: usize = 128 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSummary {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_count: u64,
    byte_count: u64,
}

pub(crate) fn capture(source: &str, device_id: &str) -> Result<(), String> {
    let device = resolve_device(source, device_id)?;
    let config = source_config(&device, source)?;
    validate_config(&config, source)?;
    let format = capture_format(&config).ok_or_else(|| {
        format!("The selected {source} device uses an unsupported sample format.")
    })?;
    announce_format(&format)?;
    let frame_bytes = usize::from(format.bytes_per_sample) * usize::from(format.channel_count);
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(MAX_QUEUED_CHUNKS);
    let terminal_error = Arc::new(Mutex::new(None::<String>));
    let callback_error = Arc::clone(&terminal_error);
    let stream = build_capture_stream(&device, config, format, sender, callback_error)?;
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    stream
        .play()
        .map_err(|error| format!("The selected {source} stream could not be started: {error}"))?;

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut frame_count = 0_u64;
    let mut byte_count = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if let Some(error) = terminal_error.lock().ok().and_then(|error| error.clone()) {
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(pcm) => {
                write_pcm(&mut output, &pcm)?;
                frame_count = frame_count
                    .checked_add((pcm.len() / frame_bytes) as u64)
                    .ok_or_else(|| {
                        "The captured audio frame count exceeded its limit.".to_owned()
                    })?;
                byte_count = byte_count.checked_add(pcm.len() as u64).ok_or_else(|| {
                    "The captured audio byte count exceeded its limit.".to_owned()
                })?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "The selected {source} stream stopped unexpectedly."
                ));
            }
        }
    }
    drop(stream);
    while let Ok(pcm) = receiver.try_recv() {
        write_pcm(&mut output, &pcm)?;
        frame_count = frame_count
            .checked_add((pcm.len() / frame_bytes) as u64)
            .ok_or_else(|| "The captured audio frame count exceeded its limit.".to_owned())?;
        byte_count = byte_count
            .checked_add(pcm.len() as u64)
            .ok_or_else(|| "The captured audio byte count exceeded its limit.".to_owned())?;
    }
    output
        .flush()
        .map_err(|error| format!("Could not flush captured audio: {error}"))?;
    if frame_count == 0 {
        return Err(format!(
            "The selected {source} source returned no audio samples."
        ));
    }
    announce_summary(&CaptureSummary {
        sample_format: format.sample_format,
        sample_rate_hz: format.sample_rate_hz,
        channel_count: format.channel_count,
        frame_count,
        byte_count,
    });
    Ok(())
}

fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    format: CaptureFormat,
    sender: SyncSender<Vec<u8>>,
    callback_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String> {
    let frame_bytes = usize::from(format.bytes_per_sample) * usize::from(format.channel_count);
    let error_signal = Arc::clone(&callback_error);
    device
        .build_input_stream_raw(
            config.config(),
            config.sample_format(),
            move |data: &Data, _info| {
                let pcm = match encode_capture(data, &format) {
                    Ok(pcm) => pcm,
                    Err(error) => {
                        set_terminal_error(&callback_error, &error);
                        return;
                    }
                };
                if pcm.len() % frame_bytes != 0 {
                    set_terminal_error(&callback_error, "The audio device returned an incomplete PCM frame.");
                    return;
                }
                if pcm.len() > MAX_CALLBACK_FRAMES.saturating_mul(frame_bytes) {
                    set_terminal_error(&callback_error, "The audio device returned a callback larger than the bounded capture queue supports.");
                    return;
                }
                if pcm.is_empty() {
                    return;
                }
                match sender.try_send(pcm) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => set_terminal_error(&callback_error, "Audio delivery fell behind the bounded capture queue."),
                    Err(TrySendError::Disconnected(_)) => set_terminal_error(&callback_error, "The CLI stopped reading captured audio."),
                }
            },
            move |error| set_terminal_error(&error_signal, &format!("The audio capture stream failed: {error}")),
            None,
        )
        .map_err(|error| format!("The selected audio stream could not be opened: {error}"))
}

fn announce_format(format: &CaptureFormat) -> Result<(), String> {
    let encoded = serde_json::to_string(format)
        .map_err(|error| format!("Could not describe the capture format: {error}"))?;
    eprintln!("tutorux-audio-helper: capture-format {encoded}");
    Ok(())
}

fn announce_summary(summary: &CaptureSummary) {
    if let Ok(encoded) = serde_json::to_string(summary) {
        eprintln!("tutorux-audio-helper: capture-summary {encoded}");
    }
}

fn write_pcm(output: &mut impl Write, pcm: &[u8]) -> Result<(), String> {
    output
        .write_all(pcm)
        .and_then(|()| output.flush())
        .map_err(|error| format!("Could not deliver captured audio to the CLI: {error}"))
}

fn watch_for_stop(stop: Arc<AtomicBool>) -> Result<(), String> {
    thread::Builder::new()
        .name("tutorux-audio-helper-control".to_owned())
        .spawn(move || {
            let mut command = String::new();
            let _ = io::stdin().read_line(&mut command);
            stop.store(true, Ordering::Release);
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start the capture control channel: {error}"))
}
