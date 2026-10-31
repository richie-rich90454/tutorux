use std::io::Read;
use std::process::Child;
use std::sync::mpsc::{self, Receiver, TryRecvError};

use crate::platform::synchronized_audio::headless::{
    HeadlessChunk, HeadlessFinished, HeadlessTrackSummary,
};

use super::super::ffmpeg::{spawn_capture, FfmpegDevice};

const QUEUE_CHUNKS: usize = 64;
const READ_BYTES: usize = 4 * 1024;

pub(crate) struct FfmpegTrack {
    pub(super) source: &'static str,
    pub(super) device: FfmpegDevice,
}

pub(crate) struct FfmpegPlan {
    pub(super) executable: String,
    pub(super) tracks: Vec<FfmpegTrack>,
}

struct TrackState {
    source: &'static str,
    child: Option<Child>,
    receiver: Receiver<Vec<u8>>,
    reader: Option<std::thread::JoinHandle<()>>,
    sequence: u64,
    samples: u64,
    bytes: u64,
    chunks: u64,
    failure: Option<String>,
}

pub(super) struct FfmpegCapture {
    tracks: Vec<TrackState>,
}

impl FfmpegCapture {
    pub(super) fn start(plan: &FfmpegPlan) -> Result<Self, String> {
        let mut tracks = Vec::with_capacity(plan.tracks.len());
        for track in &plan.tracks {
            let mut child = spawn_capture(&plan.executable, &track.device)?;
            let mut stdout = child
                .stdout
                .take()
                .ok_or_else(|| "Could not read FFmpeg audio capture output.".to_owned())?;
            let (sender, receiver) = mpsc::sync_channel(QUEUE_CHUNKS);
            let reader = std::thread::Builder::new()
                .name(format!("tutorux-ffmpeg-{}", track.source))
                .spawn(move || {
                    let mut buffer = vec![0u8; READ_BYTES];
                    loop {
                        match stdout.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(count) => {
                                let aligned = count - (count % 2);
                                if aligned > 0 && sender.send(buffer[..aligned].to_vec()).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                })
                .map_err(|error| format!("Could not start the FFmpeg reader: {error}"))?;
            tracks.push(TrackState {
                source: track.source,
                child: Some(child),
                receiver,
                reader: Some(reader),
                sequence: 0,
                samples: 0,
                bytes: 0,
                chunks: 0,
                failure: None,
            });
        }
        Ok(Self { tracks })
    }

    pub(super) fn drain(&mut self, sink: &mut dyn FnMut(HeadlessChunk)) {
        for track in &mut self.tracks {
            loop {
                match track.receiver.try_recv() {
                    Ok(pcm) => {
                        let frames = (pcm.len() / 2) as u64;
                        let first = track.samples;
                        track.samples = track.samples.saturating_add(frames);
                        track.bytes = track.bytes.saturating_add(pcm.len() as u64);
                        track.chunks = track.chunks.saturating_add(1);
                        sink(HeadlessChunk {
                            track: track.source,
                            sequence: track.sequence,
                            first_sample_index: first,
                            frame_count: frames,
                            sample_rate_hz: 16_000,
                            channel_count: 1,
                            sample_format: "pcm_s16le",
                            gap_before_samples: 0,
                            contains_device_discontinuity: false,
                            pcm,
                        });
                        track.sequence = track.sequence.saturating_add(1);
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break,
                }
            }
            if track.failure.is_none() {
                if let Some(child) = track.child.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        if !status.success() {
                            track.failure = Some(format!(
                                "FFmpeg exited during recording with code {:?}.",
                                status.code()
                            ));
                        }
                    }
                }
            }
        }
    }

    pub(super) fn pause(&mut self) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn resume(&mut self) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn finish(&mut self, sink: &mut dyn FnMut(HeadlessChunk)) -> HeadlessFinished {
        for track in &mut self.tracks {
            if let Some(mut child) = track.child.take() {
                drop(child.stdin.take());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.drain(sink);
        for track in &mut self.tracks {
            if let Some(reader) = track.reader.take() {
                let _ = reader.join();
            }
        }
        self.drain(sink);
        let mut finished = HeadlessFinished {
            microphone: HeadlessTrackSummary::default(),
            system_audio: HeadlessTrackSummary::default(),
            application_audio: HeadlessTrackSummary::default(),
        };
        for track in &self.tracks {
            let summary = HeadlessTrackSummary {
                sample_rate_hz: 16_000,
                channel_count: 1,
                sample_format: "pcm_s16le".to_owned(),
                sample_count: track.samples,
                byte_count: track.bytes,
                chunk_count: track.chunks,
                discontinuity_count: 0,
                failure: track.failure.clone(),
            };
            match track.source {
                "microphone" => finished.microphone = summary,
                "system-audio" => finished.system_audio = summary,
                _ => finished.application_audio = summary,
            }
        }
        finished
    }
}

impl Drop for TrackState {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for FfmpegCapture {
    fn drop(&mut self) {
        for track in &mut self.tracks {
            if let Some(mut child) = track.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(reader) = track.reader.take() {
                let _ = reader.join();
            }
        }
    }
}
