use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
};
use whisper_rs::{WhisperContext, WhisperContextParameters};

use super::{
    resampler::Resampler,
    session::{is_terminal, LiveWhisperHandle, LiveWhisperOptions, SharedOutput, WorkerMessage},
    window::WindowProcessor,
};

fn set_terminal(shared: &Mutex<SharedOutput>, status: &str, error: Option<String>) {
    if let Ok(mut output) = shared.lock() {
        if !is_terminal(&output.status) {
            output.status = status.to_owned();
            output.error = error;
        }
    }
}

pub(super) fn start_worker(
    options: LiveWhisperOptions,
    shared: Arc<Mutex<SharedOutput>>,
    cancelled: Arc<AtomicBool>,
    receiver: Receiver<WorkerMessage>,
    ready: mpsc::Sender<Result<(), String>>,
    handle: &LiveWhisperHandle,
) {
    let model_path = options.model_path.clone();
    let model_name = options.model_name.clone();
    let thread_shared = Arc::clone(&shared);
    let thread_cancelled = Arc::clone(&cancelled);
    let worker_ready = ready.clone();
    let spawn_result = thread::Builder::new()
        .name("tutorux-live-whisper".to_owned())
        .spawn(move || {
            let context = match WhisperContext::new_with_params(&model_path, WhisperContextParameters::default()) {
                Ok(context) => context,
                Err(error) => {
                    let message = format!("Could not load the selected Whisper model: {error:?}");
                    set_terminal(&thread_shared, "failed", Some(message.clone()));
                    let _ = worker_ready.send(Err(message));
                    return;
                }
            };
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
                return;
            }
            let mut state = match context.create_state() {
                Ok(state) => state,
                Err(error) => {
                    let message = format!("Could not initialize the Whisper model state: {error:?}");
                    set_terminal(&thread_shared, "failed", Some(message.clone()));
                    let _ = worker_ready.send(Err(message));
                    return;
                }
            };
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
                return;
            }
            let backend_version = format!("whisper.cpp {}", whisper_rs::get_whisper_version());
            let mut windows = match WindowProcessor::new(
                options.window_seconds,
                options.first_sample_index,
                options.timeline_base_sample_index,
                options.sample_rate_hz,
            ) {
                Ok(window) => window,
                Err(error) => {
                    let _ = worker_ready.send(Err(error.clone()));
                    set_terminal(&thread_shared, "failed", Some(error));
                    return;
                }
            };
            let mut resampler = Resampler::new(options.sample_rate_hz);
            let mut expected_sequence = 0u64;
            let mut expected_sample_index = options.first_sample_index;
            if let Ok(mut output) = thread_shared.lock() {
                output.model_name = model_name.clone();
                output.backend_version = backend_version.clone();
                output.status = "running".to_owned();
            }
            let _ = worker_ready.send(Ok(()));

            loop {
                let message = match receiver.recv() {
                    Ok(message) => message,
                    Err(_) => break,
                };
                match message {
                    WorkerMessage::Chunk(chunk) => {
                        if thread_cancelled.load(Ordering::Acquire) {
                            break;
                        }
                        if chunk.sequence != expected_sequence
                            || chunk.first_sample_index != expected_sample_index
                            || chunk.sample_rate_hz != options.sample_rate_hz
                        {
                            set_terminal(
                                &thread_shared,
                                "failed",
                                Some("Live microphone chunks arrived out of order or changed format. Recording continues and remains saved.".to_owned()),
                            );
                            thread_cancelled.store(true, Ordering::Release);
                            break;
                        }
                        let frame_count = (chunk.samples.len() / 2) as u64;
                        expected_sequence = match expected_sequence.checked_add(1) {
                            Some(value) => value,
                            None => {
                                set_terminal(&thread_shared, "failed", Some("Live microphone chunk count exceeded its supported range.".to_owned()));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        expected_sample_index = match expected_sample_index.checked_add(frame_count) {
                            Some(value) => value,
                            None => {
                                set_terminal(&thread_shared, "failed", Some("Live microphone sample position exceeded its supported range.".to_owned()));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        let resampled = match resampler.push(&chunk.samples) {
                            Ok(samples) => samples,
                            Err(error) => {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                                thread_cancelled.store(true, Ordering::Release);
                                break;
                            }
                        };
                        if let Err(error) = windows.consume(
                            &context,
                            &mut state,
                            &options,
                            &model_name,
                            &backend_version,
                            &resampled,
                            &thread_cancelled,
                            &thread_shared,
                        ) {
                            if !thread_cancelled.load(Ordering::Acquire) {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                                thread_cancelled.store(true, Ordering::Release);
                            }
                            break;
                        }
                    }
                    WorkerMessage::Finish(reply) => {
                        if !thread_cancelled.load(Ordering::Acquire) {
                            if let Err(error) = windows.finish(
                                &context,
                                &mut state,
                                &options,
                                &model_name,
                                &backend_version,
                                &thread_cancelled,
                                &thread_shared,
                            ) {
                                set_terminal(&thread_shared, "failed", Some(format!("{error} Recording continues and remains saved.")));
                            } else if !thread_cancelled.load(Ordering::Acquire) {
                                set_terminal(&thread_shared, "completed", None);
                            }
                        }
                        let _ = reply.send(());
                        break;
                    }
                    WorkerMessage::Cancel => break,
                }
            }
            windows.samples.fill(0.0);
            if thread_cancelled.load(Ordering::Acquire) {
                set_terminal(&thread_shared, "cancelled", None);
            }
        });
    match spawn_result {
        Ok(worker) => {
            if let Ok(mut slot) = handle.worker.lock() {
                *slot = Some(worker);
            }
        }
        Err(error) => {
            let message = format!("Could not start the live Whisper worker: {error}");
            if let Ok(mut output) = shared.lock() {
                output.status = "failed".to_owned();
                output.error = Some(message.clone());
            }
            let _ = ready.send(Err(message));
        }
    }
}
