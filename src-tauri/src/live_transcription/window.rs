use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext};

use super::{
    session::{LiveWhisperOptions, SharedOutput},
    LiveWhisperCue, MAX_PENDING_CUES, MAX_PENDING_CUE_TEXT_BYTES, SAMPLE_RATE_HZ,
};

pub(super) struct WindowProcessor {
    sample_limit: usize,
    pub(super) samples: Vec<f32>,
    window_start_sample: u64,
}

impl WindowProcessor {
    pub(super) fn new(
        window_seconds: u32,
        first_sample_index: u64,
        timeline_base_sample_index: u64,
        source_rate_hz: u32,
    ) -> Result<Self, String> {
        let sample_limit = usize::try_from(SAMPLE_RATE_HZ * window_seconds)
            .map_err(|_| "Whisper window is too large for this device.".to_owned())?;
        let offset = first_sample_index
            .checked_sub(timeline_base_sample_index)
            .ok_or_else(|| "Live audio starts before the selected track timeline.".to_owned())?;
        let timeline_offset_samples =
            u64::try_from((offset as u128 * SAMPLE_RATE_HZ as u128) / source_rate_hz as u128)
                .map_err(|_| "Live audio starts beyond the supported transcript timeline.")?;
        Ok(Self {
            sample_limit,
            samples: Vec::with_capacity(sample_limit),
            window_start_sample: timeline_offset_samples,
        })
    }

    pub(super) fn consume(
        &mut self,
        context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        incoming: &[f32],
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        let mut cursor = 0;
        while cursor < incoming.len() {
            if cancelled.load(Ordering::Acquire) {
                return Ok(());
            }
            let available = self.sample_limit - self.samples.len();
            let count = available.min(incoming.len() - cursor);
            self.samples
                .extend_from_slice(&incoming[cursor..cursor + count]);
            cursor += count;
            if self.samples.len() == self.sample_limit {
                self.transcribe_window(
                    context,
                    state,
                    options,
                    model_name,
                    backend_version,
                    cancelled,
                    shared,
                )?;
            }
        }
        Ok(())
    }

    pub(super) fn finish(
        &mut self,
        context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        if !self.samples.is_empty() && !cancelled.load(Ordering::Acquire) {
            self.transcribe_window(
                context,
                state,
                options,
                model_name,
                backend_version,
                cancelled,
                shared,
            )?;
        }
        self.samples.fill(0.0);
        self.samples.clear();
        Ok(())
    }

    fn transcribe_window(
        &mut self,
        _context: &WhisperContext,
        state: &mut whisper_rs::WhisperState,
        options: &LiveWhisperOptions,
        model_name: &str,
        backend_version: &str,
        cancelled: &Arc<AtomicBool>,
        shared: &Mutex<SharedOutput>,
    ) -> Result<(), String> {
        if cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(options.thread_count as i32);
        params.set_no_context(true);
        params.set_translate(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_tdrz_enable(options.diarize_speaker_turns);
        let detect_language = options.language == "auto";
        params.set_language((!detect_language).then_some(options.language.as_str()));
        params.set_detect_language(detect_language);
        let abort_flag = Arc::clone(cancelled);
        params.set_abort_callback_safe(move || abort_flag.load(Ordering::Acquire));
        state.full(params, &self.samples).map_err(|error| {
            if cancelled.load(Ordering::Acquire) {
                "Live transcription was cancelled.".to_owned()
            } else {
                format!("Whisper failed to transcribe a live audio window: {error:?}")
            }
        })?;

        let window_start_us = samples_to_microseconds(self.window_start_sample)?;
        let window_duration_us = samples_to_microseconds(self.samples.len() as u64)?;
        let window_end_us = window_start_us
            .checked_add(window_duration_us)
            .ok_or_else(|| {
                "Live transcript timestamps exceeded their supported range.".to_owned()
            })?;
        let detected_language = if detect_language {
            whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or("auto")
        } else {
            options.language.as_str()
        };
        let segment_count = state.full_n_segments();
        let mut window_cues = Vec::new();
        for index in 0..segment_count {
            let Some(segment) = state.get_segment(index) else {
                continue;
            };
            let text = segment
                .to_str_lossy()
                .map_err(|error| {
                    format!("Whisper returned unreadable text for a live cue: {error:?}")
                })?
                .trim()
                .to_owned();
            let relative_start_ticks = segment.start_timestamp();
            let relative_end_ticks = segment.end_timestamp();
            if text.is_empty()
                || relative_start_ticks < 0
                || relative_end_ticks <= relative_start_ticks
            {
                continue;
            }
            let relative_start_us = (relative_start_ticks as u64).saturating_mul(10_000);
            let relative_end_us = (relative_end_ticks as u64).saturating_mul(10_000);
            let start_time_us =
                window_start_us.saturating_add(relative_start_us.min(window_duration_us));
            let end_time_us =
                window_start_us.saturating_add(relative_end_us.min(window_duration_us));
            if start_time_us >= end_time_us || end_time_us > window_end_us {
                continue;
            }
            window_cues.push((
                start_time_us,
                end_time_us,
                text,
                options.diarize_speaker_turns && segment.next_segment_speaker_turn(),
            ));
        }
        window_cues.sort_by_key(|cue| (cue.0, cue.1));
        publish_cues(
            shared,
            window_cues,
            window_start_us,
            detected_language,
            model_name,
            backend_version,
            options.diarize_speaker_turns,
        )?;
        self.samples.fill(0.0);
        self.samples.clear();
        self.window_start_sample = self
            .window_start_sample
            .checked_add(self.sample_limit as u64)
            .ok_or_else(|| "Live transcript window exceeded its supported timeline.".to_owned())?;
        Ok(())
    }
}

impl Drop for WindowProcessor {
    fn drop(&mut self) {
        self.samples.fill(0.0);
    }
}

fn samples_to_microseconds(samples: u64) -> Result<u64, String> {
    let value = samples as u128 * 1_000_000u128 / SAMPLE_RATE_HZ as u128;
    u64::try_from(value)
        .map_err(|_| "Live transcript timestamps exceeded their supported range.".to_owned())
}

fn publish_cues(
    shared: &Mutex<SharedOutput>,
    cues: Vec<(u64, u64, String, bool)>,
    window_start_us: u64,
    language: &str,
    model_name: &str,
    backend_version: &str,
    diarization_enabled: bool,
) -> Result<(), String> {
    let mut output = shared
        .lock()
        .map_err(|_| "Live transcription output is unavailable.".to_owned())?;
    let pending_text_bytes = cues
        .iter()
        .fold(0usize, |total, cue| total.saturating_add(cue.2.len()));
    if output.cues.len().saturating_add(cues.len()) > MAX_PENDING_CUES
        || pending_text_bytes > MAX_PENDING_CUE_TEXT_BYTES.saturating_sub(output.cue_text_bytes)
    {
        output.status = "failed".to_owned();
        output.error = Some(
            "The live transcript queue reached its safety limit. Recording continues and remains saved."
                .to_owned(),
        );
        return Err("Live transcript queue reached its safety limit.".to_owned());
    }
    for (start_time_us, end_time_us, text, speaker_turn_next) in cues {
        let sequence = output.next_sequence;
        output.next_sequence = output
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| "Live transcript cue count exceeded its supported range.".to_owned())?;
        output.cue_text_bytes += text.len();
        output.cues.push_back(LiveWhisperCue {
            sequence: sequence.to_string(),
            start_time_us: start_time_us.to_string(),
            end_time_us: end_time_us.to_string(),
            window_start_us: window_start_us.to_string(),
            text,
            language: language.to_owned(),
            model_name: model_name.to_owned(),
            backend_version: backend_version.to_owned(),
            diarization_enabled,
            speaker_turn_next,
        });
    }
    Ok(())
}
