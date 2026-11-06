use super::model::{
    PcmChunk, SynchronizedAudioChunkEvent, SynchronizedAudioFailureEvent,
    SynchronizedAudioPauseDrainedEvent, TrackKind, TrackSignal, WorkerSummary, CHUNK_EVENT,
    FAILURE_EVENT, PAUSE_DRAINED_EVENT,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{Emitter, WebviewWindow};

pub(super) fn emit_audio_chunks(
    window: WebviewWindow,
    capture_id: String,
    receivers: [Receiver<PcmChunk>; 3],
    signals: [Arc<TrackSignal>; 3],
    discarded: Arc<AtomicBool>,
    pause_id: Arc<AtomicU64>,
) -> WorkerSummary {
    let mut summary = WorkerSummary::default();
    let mut disconnected = [false; 3];
    let mut drained_pause_id = 0;
    while !discarded.load(Ordering::Acquire) && !disconnected.iter().all(|value| *value) {
        let mut made_progress = false;
        let mut all_queues_empty = true;
        for index in 0..3 {
            if disconnected[index] {
                continue;
            }
            let mut queue_empty = false;
            for _ in 0..8 {
                match receivers[index].try_recv() {
                    Ok(chunk) => {
                        made_progress = true;
                        if discarded.load(Ordering::Acquire) {
                            break;
                        }
                        let track_summary = &mut summary.tracks[index];
                        let byte_count = chunk.pcm.len();
                        let event = SynchronizedAudioChunkEvent {
                            capture_id: capture_id.clone(),
                            track: chunk.track.as_str().to_owned(),
                            sequence: chunk.sequence,
                            first_sample_index: chunk.first_sample_index.to_string(),
                            frame_count: chunk.frame_count.to_string(),
                            sample_rate_hz: chunk.sample_rate_hz,
                            channel_count: chunk.channel_count,
                            sample_format: chunk.sample_format,
                            gap_before_samples: chunk.gap_before_samples.to_string(),
                            contains_device_discontinuity: chunk.contains_device_discontinuity,
                            pcm_base64: BASE64.encode(&chunk.pcm),
                        };
                        if let Err(error) = window.emit(CHUNK_EVENT, event) {
                            signals[index].fail(format!(
                                "Audio could not be delivered to the application window: {error}"
                            ));
                            continue;
                        }
                        track_summary.sample_rate_hz = chunk.sample_rate_hz;
                        track_summary.channel_count = chunk.channel_count;
                        track_summary.sample_format = chunk.sample_format;
                        track_summary.sample_count =
                            track_summary.sample_count.saturating_add(chunk.frame_count);
                        track_summary.byte_count =
                            track_summary.byte_count.saturating_add(byte_count as u64);
                        track_summary.chunk_count = track_summary.chunk_count.saturating_add(1);
                        if chunk.contains_device_discontinuity {
                            track_summary.discontinuity_count =
                                track_summary.discontinuity_count.saturating_add(1);
                        }
                    }
                    Err(TryRecvError::Empty) => {
                        queue_empty = true;
                        break;
                    }
                    Err(TryRecvError::Disconnected) => {
                        disconnected[index] = true;
                        queue_empty = true;
                        break;
                    }
                }
            }
            if !queue_empty {
                all_queues_empty = false;
            }
            if queue_empty {
                if let Some(message) = signals[index].failure_message() {
                    // Keep queued chunks in order, then announce the source failure after its queue drains.
                    if signals[index]
                        .failure_sent
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        let track = match index {
                            0 => TrackKind::Microphone,
                            1 => TrackKind::SystemAudio,
                            _ => TrackKind::ApplicationAudio,
                        };
                        let _ = window.emit(
                            FAILURE_EVENT,
                            SynchronizedAudioFailureEvent {
                                capture_id: capture_id.clone(),
                                track: track.as_str().to_owned(),
                                message,
                            },
                        );
                        made_progress = true;
                    }
                    disconnected[index] = true;
                }
            }
        }
        let requested_pause_id = pause_id.load(Ordering::Acquire);
        if all_queues_empty && requested_pause_id > drained_pause_id {
            let _ = window.emit(
                PAUSE_DRAINED_EVENT,
                SynchronizedAudioPauseDrainedEvent {
                    capture_id: capture_id.clone(),
                    pause_id: requested_pause_id,
                },
            );
            drained_pause_id = requested_pause_id;
        }
        if !made_progress && !disconnected.iter().all(|value| *value) {
            thread::sleep(Duration::from_millis(4));
        }
    }
    summary
}
