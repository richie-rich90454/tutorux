use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{State, WebviewWindow};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_CAPTURE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 32 * 1024;
const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_SAMPLE_RATE_HZ: u32 = 192_000;

#[derive(Default)]
pub struct AudioCaptureState(Mutex<HashMap<Uuid, CaptureBuffer>>);

struct CaptureBuffer {
    sample_rate_hz: u32,
    accepted_bytes: usize,
    next_sequence: u64,
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStarted {
    capture_id: String,
    started_at_us: String,
    consent_at_us: String,
    max_bytes: usize,
    sample_rate_hz: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFinished {
    byte_count: usize,
    sample_count: usize,
}

impl CaptureFinished {
    fn from(buffer: &CaptureBuffer) -> Self {
        Self {
            byte_count: buffer.accepted_bytes,
            sample_count: buffer.accepted_bytes / 2,
        }
    }
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(
            "Microphone capture is only available from the main application window.".into(),
        );
    }
    Ok(())
}

fn now_unix_microseconds() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is not available for recording metadata.".to_owned())?;
    u64::try_from(elapsed.as_micros())
        .map_err(|_| "The system clock is outside the supported recording range.".to_owned())
}

fn parse_capture_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value)
        .map_err(|_| "The microphone capture session is invalid or expired.".into())
}

#[tauri::command]
pub fn begin_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    consent_confirmed: bool,
    consent_at_us: String,
    sample_rate_hz: u32,
) -> Result<CaptureStarted, String> {
    main_window(&window)?;
    if !consent_confirmed {
        return Err(
            "Confirm that everyone being recorded has agreed before starting capture.".into(),
        );
    }
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz) {
        return Err("The microphone returned an unsupported sample rate.".into());
    }

    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?;
    if !captures.is_empty() {
        return Err("A microphone recording is already active.".into());
    }
    let consent_at_us = consent_at_us
        .parse::<u64>()
        .map_err(|_| "The microphone consent timestamp is invalid.".to_owned())?;
    let started_at_us = now_unix_microseconds()?;
    if consent_at_us > started_at_us {
        return Err("The microphone consent timestamp is later than the recording start.".into());
    }
    let id = Uuid::new_v4();
    captures.insert(
        id,
        CaptureBuffer {
            sample_rate_hz,
            accepted_bytes: 0,
            next_sequence: 0,
            paused: false,
        },
    );
    Ok(CaptureStarted {
        capture_id: id.to_string(),
        started_at_us: started_at_us.to_string(),
        consent_at_us: consent_at_us.to_string(),
        max_bytes: MAX_CAPTURE_BYTES,
        sample_rate_hz,
    })
}

#[tauri::command]
pub fn append_audio_capture_chunk(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
    sequence: u64,
    samples: Vec<u8>,
) -> Result<(), String> {
    main_window(&window)?;
    let samples = Zeroizing::new(samples);
    if samples.is_empty() || samples.len() > MAX_CHUNK_BYTES || samples.len() % 2 != 0 {
        return Err(
            "A microphone chunk must contain aligned 16-bit PCM and stay below 32 KiB.".into(),
        );
    }
    let id = parse_capture_id(&capture_id)?;
    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?;
    let capture = captures
        .get_mut(&id)
        .ok_or_else(|| "The microphone capture session has ended.".to_owned())?;
    if capture.paused {
        return Err("Audio arrived while the microphone recording was paused.".into());
    }
    if sequence != capture.next_sequence {
        return Err("A microphone audio chunk arrived out of order.".into());
    }
    if capture.accepted_bytes.saturating_add(samples.len()) > MAX_CAPTURE_BYTES {
        return Err("The microphone recording reached its 128 MiB limit.".into());
    }
    capture.accepted_bytes += samples.len();
    capture.next_sequence = capture
        .next_sequence
        .checked_add(1)
        .ok_or_else(|| "The microphone recording exceeded the supported chunk count.".to_owned())?;
    Ok(())
}

#[tauri::command]
pub fn pause_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?;
    let capture = captures
        .get_mut(&id)
        .ok_or_else(|| "The microphone capture session has ended.".to_owned())?;
    if capture.paused {
        return Err("The microphone recording is already paused.".into());
    }
    capture.paused = true;
    Ok(())
}

#[tauri::command]
pub fn resume_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?;
    let capture = captures
        .get_mut(&id)
        .ok_or_else(|| "The microphone capture session has ended.".to_owned())?;
    if !capture.paused {
        return Err("The microphone recording is not paused.".into());
    }
    capture.paused = false;
    Ok(())
}

#[tauri::command]
pub fn finish_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
) -> Result<CaptureFinished, String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let capture = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "The microphone capture session has ended.".to_owned())?;
    if capture.accepted_bytes == 0 {
        return Err("The microphone did not provide any audio.".into());
    }
    if capture.accepted_bytes % 2 != 0 || capture.sample_rate_hz == 0 {
        return Err("The microphone ended with incomplete PCM sample data.".into());
    }
    Ok(CaptureFinished::from(&capture))
}

#[tauri::command]
pub fn discard_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?
        .remove(&id);
    Ok(())
}
