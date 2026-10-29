use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Response, State, WebviewWindow};
use uuid::Uuid;

const MAX_CAPTURE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHUNK_BYTES: usize = 32 * 1024;
const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_SAMPLE_RATE_HZ: u32 = 192_000;

#[derive(Default)]
pub struct AudioCaptureState(Mutex<HashMap<Uuid, CaptureBuffer>>);

struct CaptureBuffer {
    sample_rate_hz: u32,
    samples: Vec<u8>,
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
            samples: Vec::new(),
            next_sequence: 0,
            paused: false,
        },
    );
    Ok(CaptureStarted {
        capture_id: id.to_string(),
        started_at_us: started_at_us.to_string(),
        consent_at_us: consent_at_us.to_string(),
        max_bytes: MAX_CAPTURE_BYTES,
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
    if capture.samples.len().saturating_add(samples.len()) > MAX_CAPTURE_BYTES {
        return Err("The microphone recording reached its 128 MiB memory limit.".into());
    }
    capture.samples.extend_from_slice(&samples);
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

fn make_wav(sample_rate_hz: u32, samples: &[u8]) -> Result<Vec<u8>, String> {
    let data_len = u32::try_from(samples.len())
        .map_err(|_| "The microphone recording is too large for a WAV file.".to_owned())?;
    let riff_len = data_len
        .checked_add(36)
        .ok_or_else(|| "The microphone recording is too large for a WAV file.".to_owned())?;
    let byte_rate = sample_rate_hz
        .checked_mul(2)
        .ok_or_else(|| "The microphone sample rate is invalid.".to_owned())?;
    let mut wav = Vec::with_capacity(44 + samples.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_len.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(samples);
    Ok(wav)
}

#[tauri::command]
pub fn finish_audio_capture(
    window: WebviewWindow,
    state: State<'_, AudioCaptureState>,
    capture_id: String,
) -> Result<Response, String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let capture = state
        .0
        .lock()
        .map_err(|_| "Microphone capture state is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "The microphone capture session has ended.".to_owned())?;
    if capture.samples.is_empty() {
        return Err("The microphone did not provide any audio.".into());
    }
    make_wav(capture.sample_rate_hz, &capture.samples).map(Response::new)
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
