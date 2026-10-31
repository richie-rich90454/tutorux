//! Native microphone, system-audio, and application-audio capture for the Tauri desktop host.
//!
//! Each source owns its stream, bounded callback queue, counters, and failure state. A failure or
//! a slow consumer on one source therefore does not stop the other source. Samples cross the
//! webview boundary as bounded, base64-encoded interleaved PCM chunks that keep the device's
//! channel count and a legacy-compatible sample-format label; the archive remains owned by the
//! frontend.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Data, Sample, SampleFormat, SizedSample, StreamInstant,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, State, WebviewWindow};
use uuid::Uuid;

const MAX_QUEUED_CHUNKS_PER_TRACK: usize = 8;
const MAX_CAPTURE_CALLBACK_BYTES: usize = 256 * 1024;
const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_CHANNELS: u16 = 8;
const MAX_DISCONTINUITY_SECONDS: u64 = 10;
const DISCONTINUITY_TOLERANCE_DIVISOR: u32 = 200;
const CHUNK_EVENT: &str = "synchronized-audio-chunk";
const FAILURE_EVENT: &str = "synchronized-audio-source-failed";
const PAUSE_DRAINED_EVENT: &str = "synchronized-audio-pause-drained";
const APPLICATION_AUDIO_SAMPLE_RATE_HZ: u32 = 48_000;
const APPLICATION_AUDIO_CHANNELS: u16 = 2;
static APPLICATION_AUDIO_DISCOVERY_RUNNING: AtomicBool = AtomicBool::new(false);

struct ApplicationAudioDiscoveryGuard;

impl Drop for ApplicationAudioDiscoveryGuard {
    fn drop(&mut self) {
        APPLICATION_AUDIO_DISCOVERY_RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Default)]
pub struct SynchronizedAudioCaptureState(Mutex<HashMap<Uuid, Arc<CaptureSession>>>);

struct CaptureSession {
    microphone_stream: Mutex<Option<cpal::Stream>>,
    system_stream: Mutex<Option<cpal::Stream>>,
    application_capture: Mutex<Option<ApplicationAudioCapture>>,
    worker: Mutex<Option<JoinHandle<WorkerSummary>>>,
    signals: [Arc<TrackSignal>; 3],
    discarded: Arc<AtomicBool>,
    activated: AtomicBool,
    pause_id: Arc<AtomicU64>,
    microphone_sample_rate_hz: u32,
    system_sample_rate_hz: u32,
    application_audio_sample_rate_hz: u32,
}

struct TrackSignal {
    accepting: AtomicBool,
    failure_sent: AtomicBool,
    failure: Mutex<Option<String>>,
    stream_epoch: AtomicU64,
}

impl TrackSignal {
    fn new() -> Self {
        Self {
            accepting: AtomicBool::new(false),
            failure_sent: AtomicBool::new(false),
            failure: Mutex::new(None),
            stream_epoch: AtomicU64::new(0),
        }
    }

    fn fail(&self, message: impl Into<String>) {
        self.accepting.store(false, Ordering::Release);
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(message.into());
            }
        }
    }

    fn failure_message(&self) -> Option<String> {
        self.failure.lock().ok()?.clone()
    }

    fn arm(&self) {
        if self.failure_message().is_none() {
            self.accepting.store(true, Ordering::Release);
        }
    }

    fn advance_stream_epoch(&self) -> u64 {
        self.stream_epoch
            .fetch_add(1, Ordering::AcqRel)
            .saturating_add(1)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrackKind {
    Microphone,
    SystemAudio,
    ApplicationAudio,
}

impl TrackKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::SystemAudio => "system-audio",
            Self::ApplicationAudio => "application-audio",
        }
    }
}

struct PcmChunk {
    track: TrackKind,
    sequence: u64,
    first_sample_index: u64,
    frame_count: u64,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: &'static str,
    gap_before_samples: u64,
    contains_device_discontinuity: bool,
    pcm: Vec<u8>,
}

#[derive(Clone)]
struct ApplicationAudioTarget {
    process_id: u32,
    name: String,
    bundle_id: Option<String>,
    backend: &'static str,
}

struct ApplicationAudioCounters {
    sequence: AtomicU64,
    first_sample_index: AtomicU64,
}

impl ApplicationAudioCounters {
    fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            first_sample_index: AtomicU64::new(0),
        }
    }

    fn next(&self, frame_count: u64) -> Option<(u64, u64)> {
        let sequence = self
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .ok()?;
        let first_sample_index = self
            .first_sample_index
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(frame_count)
            })
            .ok()?;
        Some((sequence, first_sample_index))
    }
}

enum ApplicationAudioCommand {
    Start(SyncSender<Result<(), String>>),
    Pause(SyncSender<Result<(), String>>),
    Resume(SyncSender<Result<(), String>>),
    Stop(SyncSender<()>),
}

struct ApplicationAudioCapture {
    commands: mpsc::Sender<ApplicationAudioCommand>,
    worker: Option<JoinHandle<()>>,
}

impl ApplicationAudioCapture {
    fn new(
        target: ApplicationAudioTarget,
        sender: SyncSender<PcmChunk>,
        signal: Arc<TrackSignal>,
    ) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("tutorux-application-audio".into())
            .spawn(move || run_application_audio_capture(target, sender, signal, receiver))
            .map_err(|_| "The application-audio worker could not be started.".to_owned())?;
        Ok(Self {
            commands,
            worker: Some(worker),
        })
    }

    fn start(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Start(reply))
    }

    fn pause(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Pause(reply))
    }

    fn resume(&self) -> Result<(), String> {
        self.request(|reply| ApplicationAudioCommand::Resume(reply))
    }

    fn request(
        &self,
        command: impl FnOnce(SyncSender<Result<(), String>>) -> ApplicationAudioCommand,
    ) -> Result<(), String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(command(reply))
            .map_err(|_| "The application-audio worker has stopped.".to_owned())?;
        response
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "The application-audio source did not respond in time.".to_owned())?
    }

    fn stop(&mut self) -> bool {
        if let Some(worker) = self.worker.take() {
            let (reply, response) = mpsc::sync_channel(1);
            let _ = self.commands.send(ApplicationAudioCommand::Stop(reply));
            if response.recv_timeout(Duration::from_secs(5)).is_ok() {
                worker.join().is_ok()
            } else {
                // A native capture call can be stuck inside an OS callback; never block the UI
                // command indefinitely while tearing down an application source.
                drop(worker);
                false
            }
        } else {
            true
        }
    }
}

impl Drop for ApplicationAudioCapture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
struct NativeApplicationAudioStream(flexaudio::Stream);

#[cfg(target_os = "macos")]
struct NativeApplicationAudioStream(screencapturekit::prelude::SCStream);

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
struct NativeApplicationAudioStream;

fn run_application_audio_capture(
    target: ApplicationAudioTarget,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
    commands: Receiver<ApplicationAudioCommand>,
) {
    let counters = Arc::new(ApplicationAudioCounters::new());
    let mut expected_backend_frame_index = None;
    let mut stream: Option<NativeApplicationAudioStream> = None;
    loop {
        if stream.is_none() {
            match commands.recv() {
                Ok(ApplicationAudioCommand::Start(reply))
                | Ok(ApplicationAudioCommand::Resume(reply)) => {
                    let opened = start_application_audio_stream(
                        &target,
                        sender.clone(),
                        Arc::clone(&signal),
                        Arc::clone(&counters),
                    );
                    match opened {
                        Ok(opened) => {
                            stream = Some(opened);
                            let _ = reply.send(Ok(()));
                        }
                        Err(error) => {
                            signal.fail(error.clone());
                            let _ = reply.send(Err(error));
                        }
                    }
                }
                Ok(ApplicationAudioCommand::Pause(reply)) => {
                    let _ = reply.send(Ok(()));
                }
                Ok(ApplicationAudioCommand::Stop(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    let _ = reply.send(());
                    return;
                }
                Err(_) => return,
            }
            continue;
        }

        let mut should_stop = false;
        loop {
            match commands.try_recv() {
                Ok(ApplicationAudioCommand::Start(reply)) => {
                    let _ = reply.send(Err(
                        "The application-audio source has already started.".to_owned()
                    ));
                }
                Ok(ApplicationAudioCommand::Pause(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    if let Some(mut active) = stream.take() {
                        stop_application_audio_stream(&mut active);
                    }
                    expected_backend_frame_index = None;
                    let _ = reply.send(Ok(()));
                    break;
                }
                Ok(ApplicationAudioCommand::Resume(reply)) => {
                    let _ = reply.send(Err(
                        "The application-audio source is already recording.".to_owned()
                    ));
                }
                Ok(ApplicationAudioCommand::Stop(reply)) => {
                    signal.accepting.store(false, Ordering::Release);
                    if let Some(mut active) = stream.take() {
                        stop_application_audio_stream(&mut active);
                    }
                    let _ = reply.send(());
                    should_stop = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    should_stop = true;
                    break;
                }
            }
        }
        if should_stop {
            return;
        }

        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if let Some(NativeApplicationAudioStream(active)) = stream.as_mut() {
            poll_process_audio(
                active,
                &sender,
                &signal,
                &counters,
                &mut expected_backend_frame_index,
            );
        }
        if signal.failure_message().is_some() {
            if let Some(mut failed) = stream.take() {
                stop_application_audio_stream(&mut failed);
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn start_application_audio_stream(
    target: &ApplicationAudioTarget,
    _sender: SyncSender<PcmChunk>,
    _signal: Arc<TrackSignal>,
    _counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(target.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channels: APPLICATION_AUDIO_CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS_PER_TRACK,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| format!("The selected application audio could not be opened: {error}"))?;
    stream
        .start()
        .map_err(|error| format!("The selected application audio could not be started: {error}"))?;
    Ok(NativeApplicationAudioStream(stream))
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn poll_process_audio(
    stream: &mut flexaudio::Stream,
    sender: &SyncSender<PcmChunk>,
    signal: &TrackSignal,
    counters: &ApplicationAudioCounters,
    expected_backend_frame_index: &mut Option<u64>,
) {
    while let Some(chunk) = stream.poll_chunk() {
        if !signal.accepting.load(Ordering::Acquire) {
            continue;
        }
        let channels = usize::from(APPLICATION_AUDIO_CHANNELS);
        let Some(frame_count) = usize::try_from(chunk.frames).ok() else {
            signal.fail("The application-audio backend returned an invalid PCM frame count.");
            continue;
        };
        if frame_count == 0 || frame_count.checked_mul(channels) != Some(chunk.data.len()) {
            signal.fail("The application-audio backend returned an incomplete PCM frame.");
            continue;
        }
        let Ok(frame_count_u64) = u64::try_from(frame_count) else {
            signal.fail("The application-audio backend exceeded its supported frame count.");
            continue;
        };
        let Some(next_backend_frame_index) = chunk.frame_index.checked_add(frame_count_u64) else {
            signal.fail("The application-audio backend exceeded its supported frame timeline.");
            continue;
        };
        let (gap_before_samples, contains_device_discontinuity) =
            match *expected_backend_frame_index {
                Some(expected) if chunk.frame_index > expected => {
                    (chunk.frame_index - expected, true)
                }
                Some(expected) => (0, chunk.frame_index != expected),
                None => (0, false),
            };
        if gap_before_samples
            > u64::from(APPLICATION_AUDIO_SAMPLE_RATE_HZ) * MAX_DISCONTINUITY_SECONDS
        {
            signal.fail(
                "The application-audio backend dropped more than the supported 10-second audio gap.",
            );
            continue;
        }
        *expected_backend_frame_index = Some(next_backend_frame_index);
        let mut pcm = Vec::with_capacity(chunk.data.len().saturating_mul(4));
        for sample in &chunk.data {
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        if pcm.len() > MAX_CAPTURE_CALLBACK_BYTES {
            signal.fail("The application-audio backend returned a chunk larger than the bounded queue supports.");
            continue;
        }
        let Some((sequence, previous_sample_index)) =
            counters.next(frame_count_u64.saturating_add(gap_before_samples))
        else {
            signal.fail("The application-audio track exceeded its supported sample timeline.");
            continue;
        };
        let Some(first_sample_index) = previous_sample_index.checked_add(gap_before_samples) else {
            signal.fail("The application-audio track exceeded its supported sample timeline.");
            continue;
        };
        let pcm = PcmChunk {
            track: TrackKind::ApplicationAudio,
            sequence,
            first_sample_index,
            frame_count: frame_count_u64,
            sample_rate_hz: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channel_count: APPLICATION_AUDIO_CHANNELS,
            sample_format: "pcm_f32le",
            gap_before_samples,
            contains_device_discontinuity,
            pcm,
        };
        if let Err(error) = sender.try_send(pcm) {
            signal.fail(match error {
                TrySendError::Full(_) => {
                    "Application-audio delivery fell behind the bounded capture queue."
                }
                TrySendError::Disconnected(_) => "Application-audio delivery has ended.",
            });
            break;
        }
    }
    if let Some(error) = stream.terminal_error() {
        signal.fail(format!("The application-audio source stopped: {error}"));
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn stop_application_audio_stream(stream: &mut NativeApplicationAudioStream) {
    stream.0.stop();
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn start_application_audio_stream(
    _target: &ApplicationAudioTarget,
    _sender: SyncSender<PcmChunk>,
    _signal: Arc<TrackSignal>,
    _counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    Err(application_audio_unavailable_message().to_owned())
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn stop_application_audio_stream(_stream: &mut NativeApplicationAudioStream) {}

#[cfg(target_os = "macos")]
fn start_application_audio_stream(
    target: &ApplicationAudioTarget,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
    counters: Arc<ApplicationAudioCounters>,
) -> Result<NativeApplicationAudioStream, String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;

    let content = SCShareableContent::get().map_err(|error| {
        format!(
            "ScreenCaptureKit could not list shareable apps. Grant Screen & System Audio Recording permission and restart Tutorux: {error}"
        )
    })?;
    let applications = content.applications();
    let application = applications
        .iter()
        .find(|application| application.process_id() == target.process_id as i32)
        .ok_or_else(|| "The selected application is no longer running.".to_owned())?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit could not find a display for application audio capture.".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|error| format!("The selected application could not be filtered: {error}"))?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_AUDIO_CHANNELS));
    let stop_signal = Arc::clone(&signal);
    let delegate = StreamCallbacks::new().on_stop(move |error| {
        if let Some(error) = error {
            stop_signal.fail(format!(
                "ScreenCaptureKit stopped application audio: {error}"
            ));
        }
    });
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("The application-audio stream could not be created: {error}"))?;
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                receive_screen_capture_audio(sample, &sender, &signal, &counters);
            },
            SCStreamOutputType::Audio,
        )
        .map_err(|error| {
            format!("The application-audio handler could not be installed: {error}")
        })?;
    stream
        .start_capture()
        .map_err(|error| format!("The selected application audio could not be started: {error}"))?;
    Ok(NativeApplicationAudioStream(stream))
}

#[cfg(target_os = "macos")]
fn receive_screen_capture_audio(
    sample: screencapturekit::prelude::CMSampleBuffer,
    sender: &SyncSender<PcmChunk>,
    signal: &TrackSignal,
    counters: &ApplicationAudioCounters,
) {
    if !signal.accepting.load(Ordering::Acquire) {
        return;
    }
    let buffers = match sample.audio_buffer_list() {
        Ok(buffers) => buffers,
        Err(_) => {
            signal.fail("ScreenCaptureKit returned an unreadable application-audio buffer.");
            return;
        }
    };
    let mut channels = Vec::new();
    let mut channel_total = 0usize;
    for buffer in buffers.iter() {
        let channel_count = buffer.number_channels as usize;
        if channel_count == 0 || buffer.data().len() % 4 != 0 {
            signal.fail("ScreenCaptureKit returned an unsupported application-audio format.");
            return;
        }
        let samples: Vec<f32> = buffer
            .data()
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect();
        channel_total = channel_total.saturating_add(channel_count);
        if channel_total > usize::from(MAX_CHANNELS) {
            signal.fail("ScreenCaptureKit returned more application-audio channels than the archive supports.");
            return;
        }
        channels.push((channel_count, samples));
    }
    let frame_count = channels
        .iter()
        .map(|(channel_count, samples)| samples.len() / channel_count)
        .min()
        .unwrap_or_default();
    if frame_count == 0 || channel_total == 0 {
        if channel_total == 0 {
            signal.fail("ScreenCaptureKit returned no application-audio channels.");
        }
        return;
    }
    let Some(sample_value_count) = frame_count.checked_mul(channel_total) else {
        signal.fail("ScreenCaptureKit returned an application-audio buffer larger than the bounded queue supports.");
        return;
    };
    if sample_value_count > MAX_CAPTURE_CALLBACK_BYTES / 4 {
        signal.fail("ScreenCaptureKit returned a chunk larger than the bounded queue supports.");
        return;
    }
    let mut pcm = Vec::with_capacity(sample_value_count * 4);
    for frame in 0..frame_count {
        for (channel_count, samples) in &channels {
            let start = frame * channel_count;
            for sample in &samples[start..start + channel_count] {
                pcm.extend_from_slice(&sample.to_le_bytes());
            }
        }
    }
    let Ok(frame_count) = u64::try_from(frame_count) else {
        signal.fail("The application-audio track exceeded its supported frame count.");
        return;
    };
    let Some((sequence, first_sample_index)) = counters.next(frame_count) else {
        signal.fail("The application-audio track exceeded its supported sample timeline.");
        return;
    };
    let chunk = PcmChunk {
        track: TrackKind::ApplicationAudio,
        sequence,
        first_sample_index,
        frame_count,
        sample_rate_hz: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
        channel_count: u16::try_from(channel_total).unwrap_or(APPLICATION_AUDIO_CHANNELS),
        sample_format: "pcm_f32le",
        gap_before_samples: 0,
        contains_device_discontinuity: false,
        pcm,
    };
    if let Err(error) = sender.try_send(chunk) {
        signal.fail(match error {
            TrySendError::Full(_) => {
                "Application-audio delivery fell behind the bounded capture queue."
            }
            TrySendError::Disconnected(_) => "Application-audio delivery has ended.",
        });
    }
}

#[cfg(target_os = "macos")]
fn stop_application_audio_stream(stream: &mut NativeApplicationAudioStream) {
    if let Err(error) = stream.0.stop_capture() {
        // Capture may already have stopped after permission revocation or an app exit.
        let _ = error;
    }
}

#[derive(Default)]
struct TrackSummary {
    sample_rate_hz: u32,
    sample_count: u64,
    byte_count: u64,
    chunk_count: u64,
    channel_count: u16,
    sample_format: &'static str,
    discontinuity_count: u64,
}

#[derive(Default)]
struct WorkerSummary {
    tracks: [TrackSummary; 3],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioDevice {
    device_id: String,
    label: String,
    backend: String,
    source: String,
    is_default: bool,
    process_id: Option<u32>,
    application_name: Option<String>,
    bundle_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioDevices {
    microphones: Vec<SynchronizedAudioDevice>,
    system_audio: Vec<SynchronizedAudioDevice>,
    application_audio: Vec<SynchronizedAudioDevice>,
    microphone_available: bool,
    system_audio_available: bool,
    application_audio_available: bool,
    system_audio_unavailable_reason: Option<String>,
    application_audio_unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioStarted {
    capture_id: String,
    started_at_us: String,
    consent_at_us: String,
    microphone_sample_rate_hz: u32,
    microphone_channel_count: u16,
    microphone_sample_format: String,
    system_audio_sample_rate_hz: u32,
    system_audio_channel_count: u16,
    system_audio_sample_format: String,
    application_audio_sample_rate_hz: u32,
    application_audio_channel_count: u16,
    application_audio_sample_format: String,
    application_audio_device_id: Option<String>,
    application_audio_name: Option<String>,
    application_audio_process_id: Option<u32>,
    application_audio_bundle_id: Option<String>,
    application_audio_backend: Option<String>,
    backend: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynchronizedAudioChunkEvent {
    capture_id: String,
    track: String,
    sequence: u64,
    first_sample_index: String,
    frame_count: String,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: &'static str,
    gap_before_samples: String,
    contains_device_discontinuity: bool,
    pcm_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynchronizedAudioFailureEvent {
    capture_id: String,
    track: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SynchronizedAudioPauseDrainedEvent {
    capture_id: String,
    pause_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedTrack {
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: String,
    sample_count: String,
    byte_count: String,
    chunk_count: u64,
    discontinuity_count: u64,
    failure: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynchronizedAudioFinished {
    microphone: FinishedTrack,
    system_audio: FinishedTrack,
    application_audio: FinishedTrack,
}

#[tauri::command]
pub fn list_synchronized_audio_devices(
    window: WebviewWindow,
) -> Result<SynchronizedAudioDevices, String> {
    main_window(&window)?;
    enumerate_devices()
}

#[tauri::command]
pub fn begin_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    consent_confirmed: bool,
    consent_at_us: String,
    microphone_device_id: String,
    system_audio_device_id: Option<String>,
    application_audio_device_id: Option<String>,
) -> Result<SynchronizedAudioStarted, String> {
    main_window(&window)?;
    if !consent_confirmed {
        return Err(
            "Confirm that everyone being recorded has agreed before starting capture.".into(),
        );
    }
    let consent_at = consent_at_us
        .parse::<u64>()
        .map_err(|_| "The recording consent timestamp is invalid.".to_owned())?;
    let id = Uuid::parse_str(&capture_id)
        .map_err(|_| "The synchronized capture identifier is invalid.".to_owned())?;
    let devices = enumerate_devices()?;
    if !devices
        .microphones
        .iter()
        .any(|device| device.device_id == microphone_device_id)
    {
        return Err("The selected microphone is no longer available.".into());
    }
    let system_audio_device_id =
        system_audio_device_id.filter(|device_id| !device_id.trim().is_empty());
    let application_audio_device_id =
        application_audio_device_id.filter(|device_id| !device_id.trim().is_empty());
    if system_audio_device_id.is_some() && application_audio_device_id.is_some() {
        return Err("Choose either shared system audio or one application-audio source.".into());
    }
    let application_audio_target = application_audio_device_id
        .as_deref()
        .map(|device_id| resolve_application_audio_target(device_id, &devices.application_audio))
        .transpose()?;
    let mut captures = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?;
    if captures.contains_key(&id) {
        return Err("This synchronized capture identifier is already in use.".into());
    }
    if !captures.is_empty() {
        return Err("A synchronized audio recording is already active.".into());
    }

    let request_at_us = now_unix_microseconds()?;
    if consent_at > request_at_us {
        return Err("The consent timestamp is later than the recording start.".into());
    }
    let (microphone_sender, microphone_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (system_sender, system_receiver) = mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let (application_sender, application_receiver) =
        mpsc::sync_channel(MAX_QUEUED_CHUNKS_PER_TRACK);
    let signals = [
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
        Arc::new(TrackSignal::new()),
    ];

    let (
        microphone_stream,
        microphone_sample_rate_hz,
        microphone_channel_count,
        microphone_sample_format,
    ) = match resolve_device(&microphone_device_id).and_then(|device| {
        let config = device
            .default_input_config()
            .map_err(|error| device_error("microphone", error))?;
        validate_config(&config, "microphone")?;
        let sample_rate_hz = config.sample_rate();
        let stream = build_capture_stream(
            &device,
            config.clone(),
            TrackKind::Microphone,
            microphone_sender,
            Arc::clone(&signals[0]),
        )?;
        Ok((
            stream,
            sample_rate_hz,
            config.channels(),
            sample_format_name(config.sample_format()),
        ))
    }) {
        Ok((stream, sample_rate_hz, channel_count, sample_format)) => {
            (Some(stream), sample_rate_hz, channel_count, sample_format)
        }
        Err(error) => {
            signals[0].fail(error);
            (None, 0, 0, "")
        }
    };
    let (system_stream, system_sample_rate_hz, system_channel_count, system_sample_format) =
        match system_audio_device_id {
            Some(device_id) => match enumerate_devices()
                .and_then(|devices| {
                    if !devices
                        .system_audio
                        .iter()
                        .any(|device| device.device_id == device_id)
                    {
                        return Err(
                            "The selected system-audio source is no longer available.".into()
                        );
                    }
                    resolve_device(&device_id)
                })
                .and_then(|device| {
                    // WASAPI and CoreAudio expose system loopback by opening a render endpoint as an
                    // input stream. PipeWire exposes the monitor as an ordinary input device instead.
                    let config = system_audio_config(&device)?;
                    validate_config(&config, "system audio")?;
                    let sample_rate_hz = config.sample_rate();
                    let stream = build_capture_stream(
                        &device,
                        config.clone(),
                        TrackKind::SystemAudio,
                        system_sender,
                        Arc::clone(&signals[1]),
                    )?;
                    Ok((
                        stream,
                        sample_rate_hz,
                        config.channels(),
                        sample_format_name(config.sample_format()),
                    ))
                }) {
                Ok((stream, sample_rate_hz, channel_count, sample_format)) => {
                    (Some(stream), sample_rate_hz, channel_count, sample_format)
                }
                Err(error) => {
                    signals[1].fail(error);
                    (None, 0, 0, "")
                }
            },
            None => {
                drop(system_sender);
                signals[1].fail(system_audio_unavailable_message());
                (None, 0, 0, "")
            }
        };

    let (application_capture, application_audio_sample_rate_hz) =
        if let Some(target) = application_audio_target.clone() {
            let capture =
                ApplicationAudioCapture::new(target, application_sender, Arc::clone(&signals[2]))?;
            (Some(capture), APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        } else {
            drop(application_sender);
            signals[2].fail(application_audio_unavailable_message());
            (None, 0)
        };

    let worker_signals = [
        Arc::clone(&signals[0]),
        Arc::clone(&signals[1]),
        Arc::clone(&signals[2]),
    ];
    let discarded = Arc::new(AtomicBool::new(false));
    let worker_discarded = Arc::clone(&discarded);
    let pause_id = Arc::new(AtomicU64::new(0));
    let worker_pause_id = Arc::clone(&pause_id);
    let worker_window = window.clone();
    let worker_capture_id = capture_id.clone();
    let worker = thread::Builder::new()
        .name("tutorux-native-audio-events".into())
        .spawn(move || {
            emit_audio_chunks(
                worker_window,
                worker_capture_id,
                [microphone_receiver, system_receiver, application_receiver],
                worker_signals,
                worker_discarded,
                worker_pause_id,
            )
        })
        .map_err(|_| "The native audio delivery worker could not be started.".to_owned())?;

    let started_at_us = match now_unix_microseconds() {
        Ok(value) => value,
        Err(error) => {
            drop(system_stream);
            drop(microphone_stream);
            drop(application_capture);
            let _ = worker.join();
            return Err(error);
        }
    };
    let backend = microphone_device_id
        .split_once(':')
        .map_or("native", |(host, _)| host)
        .to_owned();
    let started = SynchronizedAudioStarted {
        capture_id: capture_id.clone(),
        started_at_us: started_at_us.to_string(),
        consent_at_us: consent_at_us.clone(),
        microphone_sample_rate_hz,
        microphone_channel_count,
        microphone_sample_format: microphone_sample_format.to_owned(),
        system_audio_sample_rate_hz: system_sample_rate_hz,
        system_audio_channel_count: system_channel_count,
        system_audio_sample_format: system_sample_format.to_owned(),
        application_audio_sample_rate_hz,
        application_audio_channel_count: if application_audio_target.is_some() {
            APPLICATION_AUDIO_CHANNELS
        } else {
            0
        },
        application_audio_sample_format: if application_audio_target.is_some() {
            "pcm_f32le".to_owned()
        } else {
            String::new()
        },
        application_audio_device_id: application_audio_device_id.clone(),
        application_audio_name: application_audio_target
            .as_ref()
            .map(|target| target.name.clone()),
        application_audio_process_id: application_audio_target
            .as_ref()
            .map(|target| target.process_id),
        application_audio_bundle_id: application_audio_target
            .as_ref()
            .and_then(|target| target.bundle_id.clone()),
        application_audio_backend: application_audio_target
            .as_ref()
            .map(|target| target.backend.to_owned()),
        backend,
    };
    let session = Arc::new(CaptureSession {
        microphone_stream: Mutex::new(microphone_stream),
        system_stream: Mutex::new(system_stream),
        application_capture: Mutex::new(application_capture),
        worker: Mutex::new(Some(worker)),
        signals,
        discarded,
        activated: AtomicBool::new(false),
        pause_id,
        microphone_sample_rate_hz,
        system_sample_rate_hz,
        application_audio_sample_rate_hz,
    });
    captures.insert(id, session);
    Ok(started)
}

#[tauri::command]
pub fn activate_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let session = get_session(&state, &capture_id)?;
    if session.activated.load(Ordering::Acquire) {
        return Err("The synchronized capture has already started.".into());
    }
    let mut microphone = lock_stream(&session.microphone_stream)?;
    let mut system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let microphone_started =
        start_stream(&mut microphone, TrackKind::Microphone, &session.signals[0]);
    let system_audio_started = start_stream(
        &mut system_audio,
        TrackKind::SystemAudio,
        &session.signals[1],
    );
    let application_audio_started = match application_capture.as_ref() {
        Some(capture) => match capture.start() {
            Ok(()) => true,
            Err(error) => {
                session.signals[2].fail(error);
                false
            }
        },
        None => false,
    };
    if !microphone_started && !system_audio_started && !application_audio_started {
        return Err("Neither audio source is available to start recording.".into());
    }
    // Opening a stream is not enough to start capture. Defer play() until the frontend has
    // durably committed the take and track metadata, then accept samples only from streams that
    // actually started successfully.
    if microphone_started {
        session.signals[0].arm();
    }
    if system_audio_started {
        session.signals[1].arm();
    }
    if application_audio_started {
        session.signals[2].arm();
    }
    session.activated.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn pause_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    pause_id: u64,
) -> Result<(), String> {
    main_window(&window)?;
    let session = get_session(&state, &capture_id)?;
    if !session.activated.load(Ordering::Acquire) || pause_id == 0 {
        return Err("The synchronized capture cannot be paused now.".into());
    }
    let microphone = lock_stream(&session.microphone_stream)?;
    let system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let mut paused_microphone = false;
    if let Some(stream) = microphone
        .as_ref()
        .filter(|_| session.signals[0].failure_message().is_none())
    {
        stream
            .pause()
            .map_err(|error| device_error("microphone", error))?;
        paused_microphone = true;
    }
    if let Some(stream) = system_audio
        .as_ref()
        .filter(|_| session.signals[1].failure_message().is_none())
    {
        if let Err(error) = stream.pause() {
            if paused_microphone {
                if let Some(stream) = microphone.as_ref() {
                    if let Err(rollback_error) = stream.play() {
                        session.signals[0].fail(device_error("microphone", rollback_error));
                    }
                }
            }
            return Err(device_error("system audio", error));
        }
    }
    let app_was_running =
        application_capture.is_some() && session.signals[2].failure_message().is_none();
    if app_was_running {
        if let Some(capture) = application_capture.as_ref() {
            if let Err(error) = capture.pause() {
                if paused_microphone {
                    if let Some(stream) = microphone.as_ref() {
                        if let Err(rollback_error) = stream.play() {
                            session.signals[0].fail(device_error("microphone", rollback_error));
                        }
                    }
                }
                if system_audio.is_some() && session.signals[1].failure_message().is_none() {
                    if let Some(stream) = system_audio.as_ref() {
                        if let Err(rollback_error) = stream.play() {
                            session.signals[1].fail(device_error("system audio", rollback_error));
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    let system_was_running =
        system_audio.is_some() && session.signals[1].failure_message().is_none();
    if !paused_microphone && !system_was_running && !app_was_running {
        return Err("The synchronized capture has ended.".into());
    }
    session.pause_id.store(pause_id, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn resume_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let session = get_session(&state, &capture_id)?;
    if !session.activated.load(Ordering::Acquire) {
        return Err("The synchronized capture has not started.".into());
    }
    let microphone = lock_stream(&session.microphone_stream)?;
    let system_audio = lock_stream(&session.system_stream)?;
    let application_capture = lock_application_capture(&session.application_capture)?;
    let mut resumed_microphone = false;
    if let Some(stream) = microphone
        .as_ref()
        .filter(|_| session.signals[0].failure_message().is_none())
    {
        session.signals[0].advance_stream_epoch();
        stream
            .play()
            .map_err(|error| device_error("microphone", error))?;
        resumed_microphone = true;
    }
    if let Some(stream) = system_audio
        .as_ref()
        .filter(|_| session.signals[1].failure_message().is_none())
    {
        session.signals[1].advance_stream_epoch();
        if let Err(error) = stream.play() {
            if resumed_microphone {
                if let Some(stream) = microphone.as_ref() {
                    if let Err(rollback_error) = stream.pause() {
                        session.signals[0].fail(device_error("microphone", rollback_error));
                    }
                }
            }
            return Err(device_error("system audio", error));
        }
    }
    let mut resumed_application_audio = false;
    if let Some(capture) = application_capture
        .as_ref()
        .filter(|_| session.signals[2].failure_message().is_none())
    {
        match capture.resume() {
            Ok(()) => resumed_application_audio = true,
            Err(error) => {
                if resumed_microphone {
                    if let Some(stream) = microphone.as_ref() {
                        if let Err(rollback_error) = stream.pause() {
                            session.signals[0].fail(device_error("microphone", rollback_error));
                        }
                    }
                }
                if system_audio.is_some() && session.signals[1].failure_message().is_none() {
                    if let Some(stream) = system_audio.as_ref() {
                        if let Err(rollback_error) = stream.pause() {
                            session.signals[1].fail(device_error("system audio", rollback_error));
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    if !resumed_microphone
        && (system_audio.is_none() || session.signals[1].failure_message().is_some())
        && !resumed_application_audio
    {
        return Err("The synchronized capture has ended.".into());
    }
    if resumed_application_audio {
        session.signals[2].arm();
    }
    session.pause_id.store(0, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn stop_synchronized_audio_source(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
    track: String,
    message: String,
) -> Result<(), String> {
    main_window(&window)?;
    let session = get_session(&state, &capture_id)?;
    let reason = if message.trim().is_empty() {
        "The audio source stopped because archive writing could not keep up.".to_owned()
    } else {
        message
    };
    match track.as_str() {
        "microphone" | "system-audio" => {
            let index = if track == "microphone" { 0 } else { 1 };
            let stream = if index == 0 {
                &session.microphone_stream
            } else {
                &session.system_stream
            };
            session.signals[index].fail(reason);
            if let Some(stream) = lock_stream(stream)?.take() {
                let _ = stream.pause();
                drop(stream);
            }
        }
        "application-audio" => {
            session.signals[2].fail(reason);
            if let Some(mut capture) =
                lock_application_capture(&session.application_capture)?.take()
            {
                capture.stop();
            }
        }
        _ => return Err("The synchronized audio source is invalid.".into()),
    }
    Ok(())
}

#[tauri::command]
pub fn finish_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<SynchronizedAudioFinished, String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let session = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .remove(&id)
        .ok_or_else(|| "The synchronized capture has ended.".to_owned())?;
    let summary = close_session(&session, false)?;
    Ok(finished_result(&session, summary))
}

#[tauri::command]
pub fn discard_synchronized_audio_capture(
    window: WebviewWindow,
    state: State<'_, SynchronizedAudioCaptureState>,
    capture_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let id = parse_capture_id(&capture_id)?;
    let session = state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .remove(&id);
    if let Some(session) = session {
        close_session(&session, true)?;
    }
    Ok(())
}

fn close_session(session: &CaptureSession, discard: bool) -> Result<WorkerSummary, String> {
    if discard {
        session.discarded.store(true, Ordering::Release);
    }
    let microphone = lock_stream(&session.microphone_stream)?.take();
    let system_audio = lock_stream(&session.system_stream)?.take();
    let application_audio = lock_application_capture(&session.application_capture)?.take();
    drop(microphone);
    drop(system_audio);
    if let Some(mut capture) = application_audio {
        if !capture.stop() && !discard {
            session.signals[2]
                .fail("The application-audio source did not stop within the supported timeout.");
        }
    }
    let worker = session
        .worker
        .lock()
        .map_err(|_| "Native audio capture worker state is unavailable.".to_owned())?
        .take();
    match worker {
        Some(worker) => worker
            .join()
            .map_err(|_| "The native audio delivery worker stopped unexpectedly.".to_owned()),
        None => Ok(WorkerSummary::default()),
    }
}

fn finished_result(session: &CaptureSession, summary: WorkerSummary) -> SynchronizedAudioFinished {
    let microphone_failure = session.signals[0].failure_message();
    let system_failure = session.signals[1].failure_message();
    let application_audio_failure = session.signals[2].failure_message();
    let [microphone, system_audio, application_audio] = summary.tracks;
    SynchronizedAudioFinished {
        microphone: FinishedTrack {
            sample_rate_hz: if microphone.sample_rate_hz == 0 {
                session.microphone_sample_rate_hz
            } else {
                microphone.sample_rate_hz
            },
            channel_count: microphone.channel_count,
            sample_format: microphone.sample_format.to_owned(),
            sample_count: microphone.sample_count.to_string(),
            byte_count: microphone.byte_count.to_string(),
            chunk_count: microphone.chunk_count,
            discontinuity_count: microphone.discontinuity_count,
            failure: microphone_failure,
        },
        system_audio: FinishedTrack {
            sample_rate_hz: if system_audio.sample_rate_hz == 0 {
                session.system_sample_rate_hz
            } else {
                system_audio.sample_rate_hz
            },
            channel_count: system_audio.channel_count,
            sample_format: system_audio.sample_format.to_owned(),
            sample_count: system_audio.sample_count.to_string(),
            byte_count: system_audio.byte_count.to_string(),
            chunk_count: system_audio.chunk_count,
            discontinuity_count: system_audio.discontinuity_count,
            failure: system_failure,
        },
        application_audio: FinishedTrack {
            sample_rate_hz: if application_audio.sample_rate_hz == 0 {
                session.application_audio_sample_rate_hz
            } else {
                application_audio.sample_rate_hz
            },
            channel_count: application_audio.channel_count,
            sample_format: application_audio.sample_format.to_owned(),
            sample_count: application_audio.sample_count.to_string(),
            byte_count: application_audio.byte_count.to_string(),
            chunk_count: application_audio.chunk_count,
            discontinuity_count: application_audio.discontinuity_count,
            failure: application_audio_failure,
        },
    }
}

fn start_stream(stream: &mut Option<cpal::Stream>, track: TrackKind, signal: &TrackSignal) -> bool {
    let result = match stream.as_ref() {
        Some(stream) => {
            signal.advance_stream_epoch();
            stream.play()
        }
        None => return false,
    };
    match result {
        Ok(()) => true,
        Err(error) => {
            signal.fail(device_error(track.as_str(), error));
            stream.take();
            false
        }
    }
}

fn emit_audio_chunks(
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

fn build_capture_stream(
    device: &cpal::Device,
    config: cpal::SupportedStreamConfig,
    track: TrackKind,
    sender: SyncSender<PcmChunk>,
    signal: Arc<TrackSignal>,
) -> Result<cpal::Stream, String> {
    let channels = usize::from(config.channels());
    let sample_rate_hz = config.sample_rate();
    let sample_format = config.sample_format();
    let mut sequence = 0u64;
    let mut first_sample_index = 0u64;
    let mut discontinuity = DiscontinuityTracker::new(sample_rate_hz);
    let callback_signal = Arc::clone(&signal);
    let error_signal = Arc::clone(&signal);
    device
        .build_input_stream_raw(
            config.config(),
            sample_format,
            move |data: &Data, info: &cpal::InputCallbackInfo| {
                if !callback_signal.accepting.load(Ordering::Acquire) {
                    return;
                }
                let Some((pcm, sample_format)) = encode_pcm(data, channels) else {
                    callback_signal
                        .fail("The audio device returned a sample format that cannot be recorded.");
                    return;
                };
                let bytes_per_frame = data
                    .sample_format()
                    .sample_size()
                    .saturating_mul(channels);
                if bytes_per_frame == 0 || data.bytes().len() % bytes_per_frame != 0 {
                    callback_signal.fail("The audio device returned an incomplete PCM frame.");
                    return;
                }
                let frame_count = (data.bytes().len() / bytes_per_frame) as u64;
                if frame_count == 0 {
                    return;
                }
                if pcm.len() > MAX_CAPTURE_CALLBACK_BYTES {
                    callback_signal.fail(
                        "The audio device returned a callback larger than the bounded capture queue supports.",
                    );
                    return;
                }
                let epoch = callback_signal.stream_epoch.load(Ordering::Acquire);
                let Some((gap_before_samples, contains_device_discontinuity)) =
                    discontinuity.observe(info.timestamp().callback, frame_count, epoch)
                else {
                    callback_signal.fail(
                        "The audio device dropped more than the supported 10-second audio gap.",
                    );
                    return;
                };
                let Some(next_sample_index) = first_sample_index
                    .checked_add(gap_before_samples)
                    .and_then(|start| start.checked_add(frame_count))
                else {
                    callback_signal.fail("The audio track exceeded its supported sample timeline.");
                    return;
                };
                let Some(chunk_first_sample_index) =
                    first_sample_index.checked_add(gap_before_samples)
                else {
                    callback_signal.fail("The audio track exceeded its supported sample timeline.");
                    return;
                };
                let Some(next_sequence) = sequence.checked_add(1) else {
                    callback_signal.fail("The audio track exceeded its supported chunk count.");
                    return;
                };
                let chunk = PcmChunk {
                    track,
                    sequence,
                    first_sample_index: chunk_first_sample_index,
                    frame_count,
                    sample_rate_hz,
                    channel_count: config.channels(),
                    sample_format,
                    gap_before_samples,
                    contains_device_discontinuity,
                    pcm,
                };
                match sender.try_send(chunk) {
                    Ok(()) => {
                        first_sample_index = next_sample_index;
                        sequence = next_sequence;
                    }
                    Err(TrySendError::Full(_)) => {
                        callback_signal.fail(format!(
                            "{} capture delivery fell behind. The other audio track can continue.",
                            if track == TrackKind::Microphone {
                                "Microphone"
                            } else if track == TrackKind::SystemAudio {
                                "System audio"
                            } else {
                                "Application audio"
                            }
                        ));
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        callback_signal.accepting.store(false, Ordering::Release);
                    }
                }
            },
            move |error| {
                error_signal.fail(device_error(track.as_str(), error));
            },
            None,
        )
        .map_err(|error| device_error(track.as_str(), error))
}

struct DiscontinuityTracker {
    sample_rate_hz: u32,
    epoch: u64,
    anchor: Option<StreamInstant>,
    frames_seen: u64,
}

impl DiscontinuityTracker {
    fn new(sample_rate_hz: u32) -> Self {
        Self {
            sample_rate_hz,
            epoch: 0,
            anchor: None,
            frames_seen: 0,
        }
    }

    /// Returns the missing frames before this callback and whether the callback timeline jumped.
    /// `None` when the gap exceeds the bounded recovery window.
    fn observe(&mut self, at: StreamInstant, frames: u64, epoch: u64) -> Option<(u64, bool)> {
        if self.anchor.is_none() || self.epoch != epoch {
            self.epoch = epoch;
            self.anchor = Some(at);
            self.frames_seen = frames;
            return Some((0, false));
        }
        let Some(anchor) = self.anchor else {
            return Some((0, false));
        };
        let Some(elapsed) = at.checked_duration_since(anchor) else {
            self.anchor = Some(at);
            self.frames_seen = frames;
            return Some((0, false));
        };
        let projected = elapsed.as_secs_f64() * f64::from(self.sample_rate_hz);
        let lag = projected - self.frames_seen as f64;
        let tolerance = f64::from((self.sample_rate_hz / DISCONTINUITY_TOLERANCE_DIVISOR).max(1));
        let gap = if lag > tolerance {
            lag.round() as u64
        } else {
            0
        };
        if gap > u64::from(self.sample_rate_hz) * MAX_DISCONTINUITY_SECONDS {
            return None;
        }
        self.frames_seen = self.frames_seen.saturating_add(frames).saturating_add(gap);
        Some((gap, gap > 0))
    }
}

fn encode_pcm(data: &Data, channels: usize) -> Option<(Vec<u8>, &'static str)> {
    if channels == 0 {
        return None;
    }
    match data.sample_format() {
        SampleFormat::F32 => Some((encode_f32(data.as_slice::<f32>()?), "pcm_f32le")),
        SampleFormat::F64 => Some((
            encode_f32(&convert_to_f32(data.as_slice::<f64>()?)),
            "pcm_f32le",
        )),
        SampleFormat::I16 => Some((encode_i16(data.as_slice::<i16>()?), "pcm_s16le")),
        SampleFormat::I8 => Some((
            encode_i16(&convert_to_i16(data.as_slice::<i8>()?)),
            "pcm_s16le",
        )),
        SampleFormat::U16 => Some((
            encode_i16(&convert_to_i16(data.as_slice::<u16>()?)),
            "pcm_s16le",
        )),
        SampleFormat::I32 => Some((encode_i32(data.as_slice::<i32>()?), "pcm_s32le")),
        SampleFormat::I24 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<cpal::I24>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U24 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<cpal::U24>()?)),
            "pcm_s32le",
        )),
        SampleFormat::I64 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<i64>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U32 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<u32>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U64 => Some((
            encode_i32(&convert_to_i32(data.as_slice::<u64>()?)),
            "pcm_s32le",
        )),
        SampleFormat::U8 => Some((data.as_slice::<u8>()?.to_vec(), "pcm_u8")),
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => None,
        _ => None,
    }
}

fn encode_f32(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(4));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn encode_i16(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(2));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn encode_i32(samples: &[i32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(4));
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn convert_to_f32<T: Sample + SizedSample>(samples: &[T]) -> Vec<f32>
where
    f32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<f32>())
        .collect()
}

fn convert_to_i16<T: Sample + SizedSample>(samples: &[T]) -> Vec<i16>
where
    i16: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<i16>())
        .collect()
}

fn convert_to_i32<T: Sample + SizedSample>(samples: &[T]) -> Vec<i32>
where
    i32: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| sample.to_sample::<i32>())
        .collect()
}

fn sample_format_name(format: SampleFormat) -> &'static str {
    match format {
        SampleFormat::F32 | SampleFormat::F64 => "pcm_f32le",
        SampleFormat::I16 | SampleFormat::I8 | SampleFormat::U16 => "pcm_s16le",
        SampleFormat::I32
        | SampleFormat::I24
        | SampleFormat::U24
        | SampleFormat::I64
        | SampleFormat::U32
        | SampleFormat::U64 => "pcm_s32le",
        SampleFormat::U8 => "pcm_u8",
        SampleFormat::DsdU8 | SampleFormat::DsdU16 | SampleFormat::DsdU32 => "unsupported",
        _ => "pcm_s16le",
    }
}

fn validate_config(config: &cpal::SupportedStreamConfig, source: &str) -> Result<(), String> {
    let rate = config.sample_rate();
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&rate) {
        return Err(format!(
            "The {source} device selected an unsupported sample rate."
        ));
    }
    if config.channels() == 0 || config.channels() > MAX_CHANNELS {
        return Err(format!(
            "The {source} device selected an unsupported channel count."
        ));
    }
    Ok(())
}

fn enumerate_devices() -> Result<SynchronizedAudioDevices, String> {
    let mut microphones = Vec::new();
    let mut system_audio = Vec::new();
    for host in hosts() {
        let backend = host.id().to_string();
        let default_microphone_id = host
            .default_input_device()
            .and_then(|device| device.id().ok());
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let default_output_id = host
            .default_output_device()
            .and_then(|device| device.id().ok());

        if let Ok(devices) = host.input_devices() {
            for device in devices {
                let Ok(device_id) = device.id() else { continue };
                let Ok(description) = device.description() else {
                    continue;
                };
                #[cfg(target_os = "linux")]
                let is_monitor = is_linux_monitor_name(description.name());
                #[cfg(not(target_os = "linux"))]
                let is_monitor = false;
                if !is_monitor && device.default_input_config().is_ok() {
                    microphones.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: description.name().to_owned(),
                        backend: backend.clone(),
                        source: "microphone".into(),
                        is_default: Some(&device_id) == default_microphone_id.as_ref(),
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
                    });
                }

                #[cfg(target_os = "linux")]
                if is_linux_monitor_name(description.name()) {
                    system_audio.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: format!("System audio · {}", description.name()),
                        backend: backend.clone(),
                        source: "system-audio".into(),
                        is_default: false,
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
                    });
                }
            }
        }

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if !device.supports_output() {
                    continue;
                }
                // CoreAudio's loopback path is selected when the output endpoint has no input
                // channels. A duplex endpoint would otherwise silently record its input.
                #[cfg(target_os = "macos")]
                if device.supports_input() {
                    continue;
                }
                let Ok(device_id) = device.id() else { continue };
                let Ok(description) = device.description() else {
                    continue;
                };
                if device.default_output_config().is_ok() {
                    system_audio.push(SynchronizedAudioDevice {
                        device_id: device_id.to_string(),
                        label: format!("System audio · {}", description.name()),
                        backend: backend.clone(),
                        source: "system-audio".into(),
                        is_default: Some(&device_id) == default_output_id.as_ref(),
                        process_id: None,
                        application_name: None,
                        bundle_id: None,
                    });
                }
            }
        }
    }
    deduplicate_devices(&mut microphones);
    deduplicate_devices(&mut system_audio);
    let (application_audio, application_audio_unavailable_reason) =
        enumerate_application_audio_devices();
    let microphone_available = !microphones.is_empty();
    let system_audio_available = !system_audio.is_empty();
    let application_audio_available = !application_audio.is_empty();
    Ok(SynchronizedAudioDevices {
        microphones,
        system_audio,
        application_audio,
        microphone_available,
        system_audio_available,
        application_audio_available,
        system_audio_unavailable_reason: (!system_audio_available)
            .then(system_audio_unavailable_message),
        application_audio_unavailable_reason: if application_audio_available {
            None
        } else {
            application_audio_unavailable_reason
                .or_else(|| Some(application_audio_unavailable_message().to_owned()))
        },
    })
}

fn enumerate_application_audio_devices() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    if APPLICATION_AUDIO_DISCOVERY_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            Vec::new(),
            Some(
                "A previous application-audio discovery is still running; try again shortly."
                    .to_owned(),
            ),
        );
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("tutorux-application-audio-discovery".into())
        .spawn(move || {
            let _guard = ApplicationAudioDiscoveryGuard;
            let _ = sender.send(enumerate_application_audio_devices_inner());
        });
    if worker.is_err() {
        APPLICATION_AUDIO_DISCOVERY_RUNNING.store(false, Ordering::Release);
        return (
            Vec::new(),
            Some("Application-audio discovery could not be started.".to_owned()),
        );
    }
    match receiver.recv_timeout(Duration::from_secs(4)) {
        Ok(result) => result,
        Err(_) => (
            Vec::new(),
            Some(
                "Application-audio discovery did not respond in time; refresh and try again."
                    .to_owned(),
            ),
        ),
    }
}

/// Inspect application-audio targets for the opt-in diagnostics report.
///
/// The returned values contain no application names, bundle IDs, or process IDs. Probe results
/// are anonymous, and each native stream is stopped after the requested short interval.
pub struct ApplicationAudioProbeSummary {
    pub endpoint_count: usize,
    pub probes: Vec<Option<Result<(), String>>>,
    pub unavailable_reason: Option<String>,
}

pub fn inspect_application_audio_endpoints(
    probe_requested: bool,
    maximum_listed: usize,
    maximum_probes: usize,
    probe_duration: Duration,
) -> ApplicationAudioProbeSummary {
    if !probe_requested {
        return ApplicationAudioProbeSummary {
            endpoint_count: 0,
            probes: Vec::new(),
            unavailable_reason: Some(
                "Per-application endpoint discovery and stream probes require explicit opt-in."
                    .to_owned(),
            ),
        };
    }
    let (devices, discovery_error) = enumerate_application_audio_devices();
    if devices.is_empty() {
        return ApplicationAudioProbeSummary {
            endpoint_count: 0,
            probes: Vec::new(),
            unavailable_reason: Some(if discovery_error.is_some() {
                format!(
                    "Per-application endpoint discovery failed. {}",
                    application_audio_unavailable_message()
                )
            } else {
                format!(
                    "No active per-application audio endpoints were found. {}",
                    application_audio_unavailable_message()
                )
            }),
        };
    }

    let endpoint_count = devices.len();
    let probes = devices
        .iter()
        .take(maximum_listed)
        .enumerate()
        .map(|(index, device)| {
            if index >= maximum_probes {
                return None;
            }
            let result = resolve_application_audio_target(&device.device_id, &devices)
                .and_then(|target| probe_application_audio_stream(&target, probe_duration));
            Some(result)
        })
        .collect();

    ApplicationAudioProbeSummary {
        endpoint_count,
        probes,
        unavailable_reason: None,
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn probe_application_audio_stream(
    target: &ApplicationAudioTarget,
    duration: Duration,
) -> Result<(), String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(target.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_AUDIO_SAMPLE_RATE_HZ,
            channels: APPLICATION_AUDIO_CHANNELS,
        },
        ring_capacity_chunks: 1,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|_| {
        "The native per-application audio backend could not open this endpoint.".to_owned()
    })?;
    stream.start().map_err(|_| {
        "The native per-application audio backend could not start this endpoint.".to_owned()
    })?;

    let deadline = std::time::Instant::now() + duration;
    while std::time::Instant::now() < deadline {
        for _ in 0..4 {
            if stream.poll_chunk().is_none() {
                break;
            }
        }
        thread::sleep(Duration::from_millis(4));
    }
    stream.stop();
    Ok(())
}

#[cfg(target_os = "macos")]
fn probe_application_audio_stream(
    target: &ApplicationAudioTarget,
    duration: Duration,
) -> Result<(), String> {
    use screencapturekit::prelude::*;
    use screencapturekit::stream::delegate_trait::StreamCallbacks;

    let content = SCShareableContent::get().map_err(|_| {
        "ScreenCaptureKit could not inspect application audio. Check macOS 14+ and Screen & System Audio Recording permission."
            .to_owned()
    })?;
    let application = content
        .applications()
        .iter()
        .find(|application| application.process_id() == target.process_id as i32)
        .ok_or_else(|| {
            "The selected application is no longer available for audio capture.".to_owned()
        })?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit did not expose a display for application audio.".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|_| {
            "ScreenCaptureKit could not create an application-audio probe filter.".to_owned()
        })?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_AUDIO_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_AUDIO_CHANNELS));
    let delegate = StreamCallbacks::new().on_stop(|_| {});
    let mut stream =
        SCStream::new_with_delegate(&filter, &configuration, delegate).map_err(|_| {
            "ScreenCaptureKit could not create an application-audio probe stream.".to_owned()
        })?;
    stream
        .add_output_handler(
            |_sample: CMSampleBuffer, _output_type: SCStreamOutputType| {},
            SCStreamOutputType::Audio,
        )
        .map_err(|_| {
            "ScreenCaptureKit could not install the discard-only audio probe.".to_owned()
        })?;
    stream
        .start_capture()
        .map_err(|_| "ScreenCaptureKit could not start the application-audio probe.".to_owned())?;
    thread::sleep(duration);
    stream.stop_capture().map_err(|_| {
        "ScreenCaptureKit could not stop the application-audio probe cleanly.".to_owned()
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn probe_application_audio_stream(
    _target: &ApplicationAudioTarget,
    _duration: Duration,
) -> Result<(), String> {
    Err(application_audio_unavailable_message().to_owned())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    let processes = match flexaudio::processes() {
        Ok(processes) => processes,
        Err(error) => {
            return (
                Vec::new(),
                Some(format!(
                    "{} Details: {error}",
                    application_audio_unavailable_message()
                )),
            );
        }
    };
    let mut devices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for process in processes {
        if !process.is_output_active.unwrap_or(false) || !seen.insert(process.pid) {
            continue;
        }
        let name = process.name.trim();
        if name.is_empty() {
            continue;
        }
        #[cfg(target_os = "windows")]
        let (prefix, backend) = ("wasapi-process", "wasapi-process-loopback");
        #[cfg(target_os = "linux")]
        let (prefix, backend) = ("pipewire-process", "pipewire-process-loopback");
        devices.push(SynchronizedAudioDevice {
            device_id: format!("{prefix}:{}", process.pid),
            label: format!("{} · process {}", name, process.pid),
            backend: backend.to_owned(),
            source: "application-audio".to_owned(),
            is_default: false,
            process_id: Some(process.pid),
            application_name: Some(name.to_owned()),
            bundle_id: None,
        });
    }
    if devices.is_empty() {
        (
            devices,
            Some("No active application audio streams were found.".to_owned()),
        )
    } else {
        (devices, None)
    }
}

#[cfg(target_os = "macos")]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    use screencapturekit::prelude::SCShareableContent;

    let content = match SCShareableContent::get() {
        Ok(content) => content,
        Err(error) => {
            return (
                Vec::new(),
                Some(format!(
                    "macOS application audio needs Screen & System Audio Recording permission and macOS 14 or newer. Details: {error}"
                )),
            );
        }
    };
    let current_process_id = std::process::id();
    let mut devices = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for application in content.applications().iter() {
        let process_id = application.process_id();
        let Ok(process_id) = u32::try_from(process_id) else {
            continue;
        };
        if process_id == current_process_id || !seen.insert(process_id) {
            continue;
        }
        let name = application.application_name().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let raw_bundle_id = application.bundle_identifier().to_string();
        devices.push(SynchronizedAudioDevice {
            device_id: format!("screencapturekit-app:{process_id}"),
            label: format!("{} · process {}", name, process_id),
            backend: "screencapturekit-app-audio".to_owned(),
            source: "application-audio".to_owned(),
            is_default: false,
            process_id: Some(process_id),
            application_name: Some(name),
            bundle_id: (!raw_bundle_id.trim().is_empty()).then_some(raw_bundle_id),
        });
    }
    if devices.is_empty() {
        (
            devices,
            Some("No other shareable applications were found. macOS may require Screen & System Audio Recording permission.".to_owned()),
        )
    } else {
        (devices, None)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn enumerate_application_audio_devices_inner() -> (Vec<SynchronizedAudioDevice>, Option<String>) {
    (
        Vec::new(),
        Some(application_audio_unavailable_message().to_owned()),
    )
}

fn resolve_application_audio_target(
    device_id: &str,
    devices: &[SynchronizedAudioDevice],
) -> Result<ApplicationAudioTarget, String> {
    let device = devices
        .iter()
        .find(|device| device.device_id == device_id && device.source == "application-audio")
        .ok_or_else(|| {
            "The selected application-audio source is no longer available.".to_owned()
        })?;
    let process_id = device.process_id.ok_or_else(|| {
        "The selected application has no available process identifier.".to_owned()
    })?;
    let backend = match device.backend.as_str() {
        "wasapi-process-loopback" => "wasapi-process-loopback",
        "pipewire-process-loopback" => "pipewire-process-loopback",
        "screencapturekit-app-audio" => "screencapturekit-app-audio",
        _ => return Err("The selected application-audio backend is unavailable.".to_owned()),
    };
    Ok(ApplicationAudioTarget {
        process_id,
        name: device
            .application_name
            .clone()
            .unwrap_or_else(|| device.label.clone()),
        bundle_id: device.bundle_id.clone(),
        backend,
    })
}

fn deduplicate_devices(devices: &mut Vec<SynchronizedAudioDevice>) {
    let mut seen = std::collections::HashSet::new();
    devices.retain(|device| seen.insert((device.backend.clone(), device.device_id.clone())));
}

fn system_audio_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let config = device
        .default_output_config()
        .map_err(|error| device_error("system audio", error))?;

    #[cfg(target_os = "linux")]
    let config = device
        .default_input_config()
        .map_err(|error| device_error("system audio", error))?;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let config = device
        .default_input_config()
        .map_err(|error| device_error("system audio", error))?;

    Ok(config)
}

pub(super) fn resolve_device(value: &str) -> Result<cpal::Device, String> {
    let id = cpal::DeviceId::from_str(value)
        .map_err(|_| "The selected audio device identifier is invalid.".to_owned())?;
    #[cfg(target_os = "linux")]
    let host = cpal::host_from_id(id.host())
        .map_err(|error| format!("The selected audio backend is no longer available: {error}"))?;
    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();
    host.device_by_id(&id)
        .ok_or_else(|| "The selected audio device is no longer available.".to_owned())
}

fn hosts() -> Vec<cpal::Host> {
    #[cfg(target_os = "linux")]
    {
        cpal::available_hosts()
            .into_iter()
            .filter_map(|id| cpal::host_from_id(id).ok())
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec![cpal::default_host()]
    }
}

#[cfg(target_os = "linux")]
fn is_linux_monitor_name(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("monitor") || normalized.contains("loopback")
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err(
            "Native audio capture is only available from the main application window.".into(),
        );
    }
    Ok(())
}

fn get_session(
    state: &State<'_, SynchronizedAudioCaptureState>,
    capture_id: &str,
) -> Result<Arc<CaptureSession>, String> {
    let id = parse_capture_id(capture_id)?;
    state
        .0
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_owned())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "The synchronized capture has ended.".to_owned())
}

fn lock_stream(
    stream: &Mutex<Option<cpal::Stream>>,
) -> Result<std::sync::MutexGuard<'_, Option<cpal::Stream>>, String> {
    stream
        .lock()
        .map_err(|_| "Native audio stream state is unavailable.".to_owned())
}

fn lock_application_capture(
    capture: &Mutex<Option<ApplicationAudioCapture>>,
) -> Result<std::sync::MutexGuard<'_, Option<ApplicationAudioCapture>>, String> {
    capture
        .lock()
        .map_err(|_| "Native application-audio state is unavailable.".to_owned())
}

fn parse_capture_id(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|_| "The synchronized capture identifier is invalid.".into())
}

fn now_unix_microseconds() -> Result<u64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is not available for recording metadata.".to_owned())?;
    u64::try_from(elapsed.as_micros())
        .map_err(|_| "The system clock is outside the supported recording range.".to_owned())
}

fn device_error(source: &str, error: cpal::Error) -> String {
    let source = match source {
        "microphone" => "microphone",
        "system audio" | "system-audio" => "system audio",
        _ => "audio",
    };
    format!("The {source} capture failed: {error}")
}

fn system_audio_unavailable_message() -> String {
    #[cfg(target_os = "windows")]
    {
        "Windows did not expose a usable WASAPI system-audio loopback device.".into()
    }
    #[cfg(target_os = "macos")]
    {
        "Native system-audio capture requires macOS 14.6 or newer, System Audio Recording permission, and a supported output-only device. Use shared-audio capture if no compatible device is available.".into()
    }
    #[cfg(target_os = "linux")]
    {
        "No system-audio loopback source was found. PipeWire is preferred; enable a monitor input or use the browser shared-audio capture path.".into()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Native synchronized system-audio capture is not supported on this operating system.".into()
    }
}

fn application_audio_unavailable_message() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Per-application capture needs Windows build 20348 or newer and an active WASAPI audio session."
    }
    #[cfg(target_os = "macos")]
    {
        "Per-application capture needs macOS 14 or newer and Screen & System Audio Recording permission. Video is not saved."
    }
    #[cfg(target_os = "linux")]
    {
        "Per-application capture is available for active PipeWire output streams. ALSA alone cannot identify application audio."
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Per-application audio capture is not supported on this operating system."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instant(milliseconds: u64) -> StreamInstant {
        StreamInstant::ZERO
            .checked_add(Duration::from_millis(milliseconds))
            .expect("test timestamps fit the stream clock")
    }

    #[test]
    fn discontinuity_tracker_marks_a_missing_callback_and_keeps_the_timeline() {
        let mut tracker = DiscontinuityTracker::new(48_000);
        assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
        assert_eq!(tracker.observe(instant(10), 480, 0), Some((0, false)));
        assert_eq!(tracker.observe(instant(30), 480, 0), Some((480, true)));
        assert_eq!(tracker.observe(instant(40), 480, 0), Some((0, false)));
    }

    #[test]
    fn discontinuity_tracker_resets_after_a_resume_epoch() {
        let mut tracker = DiscontinuityTracker::new(48_000);
        assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
        assert_eq!(tracker.observe(instant(2_000), 480, 1), Some((0, false)));
        assert_eq!(tracker.observe(instant(2_010), 480, 1), Some((0, false)));
    }

    #[test]
    fn discontinuity_tracker_rejects_a_gap_beyond_the_recovery_window() {
        let mut tracker = DiscontinuityTracker::new(48_000);
        assert_eq!(tracker.observe(instant(0), 480, 0), Some((0, false)));
        assert_eq!(tracker.observe(instant(11_000), 480, 0), None);
    }

    #[test]
    fn pcm_encoders_keep_every_interleaved_channel() {
        assert_eq!(
            encode_i16(&[1, -1, 2, -2]),
            vec![1, 0, 255, 255, 2, 0, 254, 255]
        );
        let stereo = encode_f32(&[0.5, -0.5]);
        assert_eq!(stereo.len(), 8);
        assert_eq!(f32::from_le_bytes(stereo[0..4].try_into().unwrap()), 0.5);
        assert_eq!(f32::from_le_bytes(stereo[4..8].try_into().unwrap()), -0.5);
    }
}
