use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::transcription::{parse_whisper_json, transcribe_wav};

use super::worker::save_records;

const TARGET_RATE_HZ: u32 = 16_000;
const MAX_PCM_BYTES: usize = 28 * 1024 * 1024;

pub(super) struct WhisperCapture {
    pub executable: String,
    pub model: String,
    pub language: String,
    pub threads: Option<u32>,
    pub diarize: bool,
}

/// Transcribe a finished single-source capture and commit provisional cues.
///
/// This runs after the take is durably saved. The desktop application remains the only
/// adapter that streams cues while audio is still being captured.
pub(super) fn transcribe_capture(
    path: &Path,
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: &str,
    request: &WhisperCapture,
) -> Result<(usize, usize), String> {
    let wav = build_track_wav(snapshot, session_id, track_id)?;
    let output = transcribe_wav(
        &request.executable,
        &request.model,
        wav,
        &request.language,
        request.diarize,
        request.threads,
        Arc::new(AtomicBool::new(false)),
    )?;
    let cues = parse_whisper_json(&output.json)?;
    let run_id = new_uuid();
    let created_at = now_us().to_string();
    let mut boundaries = 0usize;
    let mut records = Vec::with_capacity(cues.len());
    for cue in cues {
        if request.diarize && cue.speaker_turn_next.is_none() {
            return Err("Whisper did not return speaker-turn boundaries. Use a compatible whisper.cpp executable and TDRZ model, or turn off tiny diarization.".to_owned());
        }
        let mut record = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            new_uuid(),
            [
                ("session_id", session_id.to_owned()),
                ("start_time_us", cue.start_us.to_string()),
                ("end_time_us", cue.end_us.to_string()),
                ("text", cue.text),
                ("verification_state", "provisional".to_owned()),
                ("timestamp_state", "timestamped".to_owned()),
                ("origin", "local-whisper".to_owned()),
                ("source_audio_track_id", track_id.to_owned()),
                ("source_model", output.model_name.clone()),
                ("source_backend_version", "whisper.cpp CLI".to_owned()),
                ("source_run_id", run_id.clone()),
                ("source_window_start_us", "0".to_owned()),
                ("language", request.language.clone()),
                ("created_at_us", created_at.clone()),
            ],
        );
        if request.diarize {
            if cue.speaker_turn_next == Some(true) {
                boundaries += 1;
            }
            record.fields.insert(
                "speaker_turn_next".to_owned(),
                cue.speaker_turn_next.unwrap_or(false).to_string(),
            );
            record
                .fields
                .insert("speaker_identity_state".to_owned(), "unassigned".to_owned());
            record
                .fields
                .insert("diarization_enabled".to_owned(), "true".to_owned());
            record.fields.insert(
                "diarization_scope".to_owned(),
                "experimental-speaker-turn-boundaries-only".to_owned(),
            );
            record
                .fields
                .insert("diarization_method".to_owned(), "whisper.cpp-tinydiarize".to_owned());
            record.fields.insert(
                "diarization_model_requirement".to_owned(),
                "TDRZ-compatible Whisper model required".to_owned(),
            );
        }
        records.push(record);
    }
    if !records.is_empty() {
        if let Some(mut session) = snapshot
            .get_record(RecordType::SESSION, session_id)
            .map_err(|error| error.message)?
        {
            session
                .fields
                .insert("processing_state".to_owned(), "review-required".to_owned());
            session.fields.insert(
                "processing_detail".to_owned(),
                "Local transcription is provisional and ready for tutor review.".to_owned(),
            );
            session
                .fields
                .insert("processing_updated_at_us".to_owned(), now_us().to_string());
            records.push(session);
        }
        let next = snapshot
            .append_records(&records)
            .map_err(|error| error.message)?;
        save_records(path, &next)?;
    }
    Ok((records
        .iter()
        .filter(|record| record.record_type == RecordType::TRANSCRIPT_SEGMENT)
        .count(), boundaries))
}

fn build_track_wav(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: &str,
) -> Result<Vec<u8>, String> {
    let mut chunks: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::AUDIO_CHUNK, false)
        .map_err(|error| error.message)?
        .into_iter()
        .filter(|record| {
            record.field("session_id").map(str::to_lowercase) == Some(session_id.to_lowercase())
                && record.field("track_id").map(str::to_lowercase) == Some(track_id.to_lowercase())
        })
        .collect();
    chunks.sort_by_key(|record| {
        record
            .field("sequence_number")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    });
    if chunks.is_empty() {
        return Err("The captured track has no committed audio chunks.".to_owned());
    }
    let rate = chunks[0]
        .field("sample_rate_hz")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Recording audio metadata is invalid.".to_owned())?;
    let channels = chunks[0]
        .field("channel_count")
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "Recording audio metadata is invalid.".to_owned())?;
    let format = chunks[0]
        .field("sample_format")
        .unwrap_or("pcm_s16le")
        .to_owned();
    let width = match format.as_str() {
        "pcm_u8" => 1,
        "pcm_s16le" => 2,
        "pcm_s24le" => 3,
        "pcm_s32le" | "pcm_f32le" => 4,
        _ => return Err("Recording audio metadata is invalid.".to_owned()),
    };
    let total: usize = chunks.iter().map(|chunk| chunk.blob.len()).sum();
    if total > MAX_PCM_BYTES {
        return Err(
            "This capture exceeds the 28 MiB single-window transcription limit; run transcript generate after recording to window it."
                .to_owned(),
        );
    }
    let frame_bytes = width * usize::from(channels);
    let mut mono = Vec::with_capacity(total / frame_bytes);
    for chunk in &chunks {
        let gap = chunk
            .field("gap_before_samples")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        mono.extend(std::iter::repeat(0.0f32).take(usize::try_from(gap).unwrap_or(0)));
        for frame in chunk.blob.chunks(frame_bytes) {
            if frame.len() < frame_bytes {
                break;
            }
            let mut sum = 0.0f64;
            for sample in frame.chunks(width) {
                sum += f64::from(decode_sample(sample, &format)?);
            }
            mono.push((sum / f64::from(channels)) as f32);
        }
    }
    if mono.is_empty() {
        return Err("The captured track contains no samples.".to_owned());
    }
    let count = (mono.len() as u64)
        .saturating_mul(u64::from(TARGET_RATE_HZ))
        .checked_div(u64::from(rate))
        .unwrap_or(0) as usize;
    let mut pcm = Vec::with_capacity(count.saturating_mul(2));
    for index in 0..count {
        let position = (index as f64) * f64::from(rate) / f64::from(TARGET_RATE_HZ);
        let frame = (position.floor() as usize).min(mono.len() - 1);
        let next = (frame + 1).min(mono.len() - 1);
        let fraction = (position - position.floor()) as f32;
        let value = mono[frame] * (1.0 - fraction) + mono[next] * fraction;
        pcm.extend_from_slice(&(value.mul_add(32_767.0, 0.0).clamp(-32_768.0, 32_767.0) as i16).to_le_bytes());
    }
    Ok(write_wav_pcm(&pcm))
}

fn decode_sample(sample: &[u8], format: &str) -> Result<f32, String> {
    match format {
        "pcm_u8" => Ok((f32::from(sample[0]) - 128.0) / 128.0),
        "pcm_s16le" => Ok(f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0),
        "pcm_s24le" => {
            let raw = i32::from(sample[0])
                | (i32::from(sample[1]) << 8)
                | (i32::from(sample[2]) << 16);
            Ok(((raw << 8) >> 8) as f32 / 8_388_608.0)
        }
        "pcm_s32le" => Ok(
            i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f32
                / 2_147_483_648.0,
        ),
        "pcm_f32le" => Ok(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])),
        _ => Err("Recording audio metadata is invalid.".to_owned()),
    }
}

fn write_wav_pcm(pcm: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(44 + pcm.len());
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&TARGET_RATE_HZ.to_le_bytes());
    output.extend_from_slice(&(TARGET_RATE_HZ * 2).to_le_bytes());
    output.extend_from_slice(&2u16.to_le_bytes());
    output.extend_from_slice(&16u16.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    output.extend_from_slice(pcm);
    output
}

#[cfg(test)]
mod tests {
    use super::{decode_sample, write_wav_pcm};

    #[test]
    fn decodes_capture_widths_for_whisper() {
        assert!((decode_sample(&[0x00, 0x40], "pcm_s16le").unwrap() - 0.5).abs() < 0.001);
        assert!((decode_sample(&[0x00, 0x00, 0x40], "pcm_s24le").unwrap() - 0.5).abs() < 0.001);
        assert!((decode_sample(&[192], "pcm_u8").unwrap() - 0.5).abs() < 0.001);
    }

    #[test]
    fn writes_a_16khz_mono_wav_header() {
        let wav = write_wav_pcm(&[0, 0, 1, 0]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(wav.len(), 48);
    }
}
