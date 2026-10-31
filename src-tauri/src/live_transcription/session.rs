use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::JoinHandle,
};
use zeroize::Zeroizing;

use super::LiveWhisperCue;

pub(super) struct LiveWhisperHandle {
    pub(super) sender: SyncSender<WorkerMessage>,
    pub(super) shared: Arc<Mutex<SharedOutput>>,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) worker: Mutex<Option<JoinHandle<()>>>,
}

impl LiveWhisperHandle {
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }

    pub(super) fn join(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }

    pub(super) fn detach(&self) {
        if let Ok(mut worker) = self.worker.lock() {
            drop(worker.take());
        }
    }

    pub(super) fn finish(&self) -> Result<(), String> {
        let status = self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            .clone();
        if is_terminal(&status) {
            self.join();
            return Ok(());
        }

        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            == "running"
        {
            if let Ok(mut shared) = self.shared.lock() {
                shared.status = "finishing".to_owned();
            }
        }
        self.sender
            .send(WorkerMessage::Finish(reply_tx))
            .map_err(|_| "Live transcription worker has stopped.".to_owned())?;
        reply_rx.recv().map_err(|_| {
            "Live transcription worker stopped before finishing its audio window.".to_owned()
        })?;
        self.join();
        Ok(())
    }

    pub(super) fn enqueue(&self, chunk: QueuedAudioChunk) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err("Live transcription has been cancelled.".to_owned());
        }
        let status = self
            .shared
            .lock()
            .map_err(|_| "Live transcription state is unavailable.".to_owned())?
            .status
            .clone();
        if status != "running" {
            return Err(match status.as_str() {
                "failed" => {
                    "Live transcription stopped; the recording continues and remains saved."
                        .to_owned()
                }
                "cancelled" => {
                    "Live transcription was cancelled; the recording continues and remains saved."
                        .to_owned()
                }
                _ => "Live transcription is no longer accepting microphone audio.".to_owned(),
            });
        }
        match self.sender.try_send(WorkerMessage::Chunk(chunk)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(WorkerMessage::Chunk(chunk))) => {
                drop(chunk);
                self.fail_backpressure();
                Err("Live Whisper fell behind the microphone. Transcription stopped; recording continues and remains saved.".to_owned())
            }
            Err(TrySendError::Full(_)) => {
                Err("Live Whisper is finishing and cannot accept microphone audio.".to_owned())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.set_failed("Live transcription worker stopped unexpectedly; the recording continues and remains saved.");
                Err("Live transcription worker stopped unexpectedly; the recording continues and remains saved.".to_owned())
            }
        }
    }

    fn fail_backpressure(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            if shared.status == "running" {
                shared.status = "failed".to_owned();
                shared.error = Some(
                    "Live Whisper fell behind the microphone. Transcription stopped; the recording continues and remains saved."
                        .to_owned(),
                );
            }
        }
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }

    pub(super) fn set_failed(&self, message: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            if !is_terminal(&shared.status) {
                shared.status = "failed".to_owned();
                shared.error = Some(message.to_owned());
            }
        }
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
    }
}

impl Drop for LiveWhisperHandle {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.sender.try_send(WorkerMessage::Cancel);
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

#[derive(Default)]
pub(super) struct SharedOutput {
    pub(super) status: String,
    pub(super) error: Option<String>,
    pub(super) model_name: String,
    pub(super) backend_version: String,
    pub(super) next_sequence: u64,
    pub(super) cue_text_bytes: usize,
    pub(super) cues: VecDeque<LiveWhisperCue>,
}

pub(super) struct LiveWhisperOptions {
    pub(super) model_path: PathBuf,
    pub(super) model_name: String,
    pub(super) language: String,
    pub(super) window_seconds: u32,
    pub(super) thread_count: u32,
    pub(super) sample_rate_hz: u32,
    pub(super) first_sample_index: u64,
    pub(super) timeline_base_sample_index: u64,
    pub(super) diarize_speaker_turns: bool,
}

pub(super) struct QueuedAudioChunk {
    pub(super) sequence: u64,
    pub(super) first_sample_index: u64,
    pub(super) sample_rate_hz: u32,
    pub(super) samples: Zeroizing<Vec<u8>>,
}

pub(super) enum WorkerMessage {
    Chunk(QueuedAudioChunk),
    Finish(mpsc::Sender<()>),
    Cancel,
}

pub(super) fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}
