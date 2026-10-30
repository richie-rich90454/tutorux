//! Standalone process-audio capture helper used by the Tutorux CLI.
//!
//! `devices` and `inputs` write JSON arrays to stdout. `probe` reports either a short microphone /
//! system-audio signal measurement or a per-application stream measurement. `capture` writes raw
//! interleaved PCM in the endpoint's native sample rate, channel count, and sample format to stdout
//! until stdin receives `stop` or closes. The selected format is announced as a JSON line on stderr
//! before the first PCM byte, followed by a frame/byte summary on stderr after the stream ends.

mod native_input;

use serde::Serialize;
use tutorux_archive_lock::{ArchiveLock, LockMode};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::{
    collections::HashSet,
    env,
    io::{self, BufRead, BufWriter, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const APPLICATION_SAMPLE_RATE_HZ: u32 = 48_000;
const APPLICATION_CHANNELS: u16 = 2;
const APPLICATION_SAMPLE_FORMAT: &str = "pcm_f32le";
const MAX_QUEUED_CHUNKS: usize = 8;
const MAX_FRAMES_PER_CHUNK: usize = 128 * 1024;
const APPLICATION_PROBE_DURATION: Duration = Duration::from_millis(1_800);
const MAX_APPLICATION_GAP_FRAMES: u64 = u64::from(APPLICATION_SAMPLE_RATE_HZ) * 10;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationCaptureFormat {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    bytes_per_sample: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationCaptureSummary {
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    frame_count: u64,
    byte_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationDevice {
    id: String,
    name: String,
    backend: String,
    process_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationSignalProbe {
    id: String,
    name: String,
    backend: String,
    source: &'static str,
    sample_format: &'static str,
    sample_rate_hz: u32,
    channel_count: u16,
    sample_count: u64,
    frame_count: u64,
    duration_ms: u64,
    rms: f64,
    peak: f64,
    dbfs: f64,
    signal_detected: bool,
    probe: &'static str,
}

#[derive(Default)]
struct ProbeMetrics {
    sample_count: u64,
    sum_squares: f64,
    peak: f64,
}

impl ProbeMetrics {
    fn record(&mut self, sample: f32) {
        let value = f64::from(sample).abs();
        self.sample_count = self.sample_count.saturating_add(1);
        self.sum_squares += value * value;
        self.peak = self.peak.max(value);
    }
}

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr().lock(), "tutorux-audio-helper: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("devices") => {
            if arguments.next().is_some() {
                return Err("devices does not accept arguments".to_owned());
            }
            let devices = application_devices()?;
            serde_json::to_writer(io::stdout().lock(), &devices)
                .map_err(|error| format!("could not write the application list: {error}"))?;
            io::stdout()
                .lock()
                .write_all(b"\n")
                .map_err(|error| format!("could not finish the application list: {error}"))?;
            Ok(())
        }
        Some("inputs") => {
            if arguments.next().is_some() {
                return Err("inputs does not accept arguments".to_owned());
            }
            let devices = native_input::enumerate()?;
            serde_json::to_writer(io::stdout().lock(), &devices)
                .map_err(|error| format!("could not write the native audio input list: {error}"))?;
            io::stdout()
                .lock()
                .write_all(b"\n")
                .map_err(|error| format!("could not finish the native audio input list: {error}"))?;
            Ok(())
        }
        Some("probe") => {
            let first_option = arguments.next();
            if first_option.as_deref() == Some("--application") {
                let id = arguments
                    .next()
                    .ok_or_else(|| "an application device ID is required".to_owned())?;
                if arguments.next().is_some() {
                    return Err("use probe --application <device-id>".to_owned());
                }
                let device = application_devices()?
                    .into_iter()
                    .find(|device| device.id == id)
                    .ok_or_else(|| application_probe_unavailable_reason())?;
                return probe_application_audio(&device);
            }
            let source = arguments.next();
            let device_option = arguments.next();
            let device_id = arguments.next();
            if first_option.as_deref() != Some("--source")
                || device_option.as_deref() != Some("--device")
                || arguments.next().is_some()
            {
                return Err("use probe --source microphone|system-audio --device <device-id> or probe --application <device-id>".to_owned());
            }
            let source = capture_source(source.as_deref(), "probe")?;
            let device_id = device_id.ok_or_else(|| "a device ID is required".to_owned())?;
            native_input::probe(source, &device_id)
        }
        Some("capture") => {
            let option = arguments.next();
            let id = arguments.next();
            if option.as_deref() == Some("--application") {
                if arguments.next().is_some() {
                    return Err("use capture --application <device-id>".to_owned());
                }
                let id = id.ok_or_else(|| "an application device ID is required".to_owned())?;
                let device = application_devices()?
                    .into_iter()
                    .find(|device| device.id == id)
                    .ok_or_else(|| "the selected application is no longer available".to_owned())?;
                return capture_application_audio(&device);
            }
            if option.as_deref() != Some("--source") {
                return Err("use capture --source microphone|system-audio --device <device-id>".to_owned());
            }
            let source = capture_source(id.as_deref(), "capture")?;
            let device_option = arguments.next();
            let device_id = arguments.next();
            if device_option.as_deref() != Some("--device") || arguments.next().is_some() {
                return Err("use capture --source microphone|system-audio --device <device-id>".to_owned());
            }
            let device_id = device_id.ok_or_else(|| "a device ID is required".to_owned())?;
            native_input::capture(source, &device_id)
        }
        Some("archive-lock") => archive_lock(arguments),
        Some("--version") => {
            if arguments.next().is_some() {
                return Err("--version does not accept arguments".to_owned());
            }
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err("use devices, inputs, probe --source microphone|system-audio --device <device-id>, probe --application <device-id>, capture --application <device-id>, capture --source microphone|system-audio --device <device-id>, archive-lock --shared|--exclusive <archive-path>, or --version".to_owned()),
    }
}

fn capture_source<'a>(source: Option<&'a str>, command: &str) -> Result<&'a str, String> {
    match source {
        Some(value @ ("microphone" | "system-audio")) => Ok(value),
        _ => Err(format!("{command} source must be microphone or system-audio")),
    }
}

fn archive_lock(mut arguments: impl Iterator<Item = String>) -> Result<(), String> {
    let mode = match arguments.next().as_deref() {
        Some("--shared") => LockMode::Shared,
        Some("--exclusive") => LockMode::Exclusive,
        _ => return Err("use archive-lock --shared|--exclusive <archive-path>".to_owned()),
    };
    let path = arguments
        .next()
        .ok_or_else(|| "an archive path is required".to_owned())?;
    if arguments.next().is_some() {
        return Err("archive-lock accepts one archive path".to_owned());
    }

    let mut lock = ArchiveLock::try_acquire(std::path::Path::new(&path), mode)?;
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    writeln!(output, "LOCKED")
        .and_then(|()| output.flush())
        .map_err(|error| format!("could not acknowledge archive lock: {error}"))?;

    for command in io::stdin().lock().lines() {
        let command = command.map_err(|error| format!("could not read archive-lock command: {error}"))?;
        match command.as_str() {
            "upgrade" => match lock.try_upgrade() {
                Ok(()) => writeln!(output, "EXCLUSIVE"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "downgrade" => match lock.downgrade() {
                Ok(()) => writeln!(output, "SHARED"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "adopt-replacement" => match lock.adopt_replacement_file() {
                Ok(()) => writeln!(output, "REPLACEMENT_ADOPTED"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "release" => {
                lock.release()?;
                writeln!(output, "RELEASED")
            }
            _ if command.starts_with("prepare-replacement ") => {
                let encoded_path = command
                    .strip_prefix("prepare-replacement ")
                    .unwrap_or_default();
                match serde_json::from_str::<String>(encoded_path) {
                    Ok(path) => match lock.prepare_replacement_file(std::path::Path::new(&path)) {
                        Ok(()) => writeln!(output, "REPLACEMENT_READY"),
                        Err(error) => writeln!(output, "ERROR {error}"),
                    },
                    Err(error) => writeln!(output, "ERROR invalid replacement path: {error}"),
                }
            }
            _ => writeln!(output, "ERROR unknown archive-lock command"),
        }
        .and_then(|()| output.flush())
        .map_err(|error| format!("could not respond to archive-lock command: {error}"))?;
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    let processes = flexaudio::processes().map_err(|error| {
        format!(
            "{} Process audio discovery failed: {error}",
            platform_limitation()
        )
    })?;
    let mut seen = HashSet::new();
    let mut devices = Vec::new();
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
        devices.push(ApplicationDevice {
            id: format!("{prefix}:{}", process.pid),
            name: format!("{} · process {}", name, process.pid),
            backend: backend.to_owned(),
            process_id: process.pid,
            bundle_id: None,
        });
    }
    devices.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.process_id.cmp(&right.process_id))
    });
    Ok(devices)
}

#[cfg(target_os = "macos")]
fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    use screencapturekit::prelude::SCShareableContent;

    let content = SCShareableContent::get().map_err(|error| {
        format!(
            "ScreenCaptureKit could not list applications. Grant Screen & System Audio Recording permission and restart Tutorux: {error}"
        )
    })?;
    let mut seen = HashSet::new();
    let mut devices = Vec::new();
    for application in content.applications().iter() {
        let Ok(process_id) = u32::try_from(application.process_id()) else {
            continue;
        };
        if process_id == std::process::id() || !seen.insert(process_id) {
            continue;
        }
        let name = application.application_name().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let raw_bundle_id = application.bundle_identifier().to_string();
        devices.push(ApplicationDevice {
            id: format!("screencapturekit-app:{process_id}"),
            name: format!("{} · process {process_id}", name.trim()),
            backend: "screencapturekit-app-audio".to_owned(),
            process_id,
            bundle_id: (!raw_bundle_id.trim().is_empty()).then_some(raw_bundle_id),
        });
    }
    devices.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.process_id.cmp(&right.process_id))
    });
    Ok(devices)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn application_devices() -> Result<Vec<ApplicationDevice>, String> {
    Err("per-application audio capture is not supported on this operating system".to_owned())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn capture_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(device.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_SAMPLE_RATE_HZ,
            channels: APPLICATION_CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| format!("the selected application audio could not be opened: {error}"))?;
    stream
        .start()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;

    announce_application_format()?;
    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut expected_frame_index = None;
    let mut frame_count_written = 0_u64;
    let mut byte_count_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        while let Some(chunk) = stream.poll_chunk() {
            let frame_count = usize::try_from(chunk.frames)
                .map_err(|_| "the application-audio backend returned an invalid frame count")?;
            if frame_count == 0
                || frame_count > MAX_FRAMES_PER_CHUNK
                || frame_count.checked_mul(usize::from(APPLICATION_CHANNELS)) != Some(chunk.data.len())
            {
                return Err(
                    "the application-audio backend returned an incomplete PCM frame".into(),
                );
            }
            let (gap_before_samples, contains_device_discontinuity) =
                match expected_frame_index {
                    Some(expected) if chunk.frame_index > expected => {
                        (chunk.frame_index - expected, true)
                    }
                    Some(expected) => (0, chunk.frame_index != expected),
                    None => (0, false),
                };
            if gap_before_samples > MAX_APPLICATION_GAP_FRAMES {
                return Err(
                    "the application-audio backend dropped more than the supported 10-second audio gap"
                        .to_owned(),
                );
            }
            if contains_device_discontinuity {
                let _ = writeln!(
                    io::stderr().lock(),
                    "tutorux-audio-helper: application-audio gap of {gap_before_samples} frames"
                );
            }
            if gap_before_samples > 0 {
                write_silence_frames(
                    &mut output,
                    gap_before_samples,
                    application_frame_bytes(),
                )?;
            }
            expected_frame_index = Some(
                chunk
                    .frame_index
                    .checked_add(frame_count as u64)
                    .ok_or_else(|| {
                        "the application-audio timeline exceeded its limit".to_owned()
                    })?,
            );
            write_f32le(&mut output, &chunk.data)?;
            frame_count_written = frame_count_written
                .checked_add(frame_count as u64)
                .and_then(|count| count.checked_add(gap_before_samples))
                .ok_or_else(|| "the capture frame count exceeded its limit".to_owned())?;
            byte_count_written = byte_count_written
                .checked_add(
                    (frame_count as u64)
                        .checked_add(gap_before_samples)
                        .and_then(|count| count.checked_mul(application_frame_bytes() as u64))
                        .ok_or_else(|| "the capture byte count exceeded its limit".to_owned())?,
                )
                .ok_or_else(|| "the capture byte count exceeded its limit".to_owned())?;
        }
        if let Some(error) = stream.terminal_error() {
            stream.stop();
            return Err(format!(
                "the selected application-audio source stopped: {error}"
            ));
        }
        thread::sleep(Duration::from_millis(4));
    }
    stream.stop();
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio: {error}"))?;
    if frame_count_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
    announce_application_summary(frame_count_written, byte_count_written);
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    use screencapturekit::{prelude::*, stream::delegate_trait::StreamCallbacks};

    let content = SCShareableContent::get().map_err(|error| {
        format!("ScreenCaptureKit could not list applications. Check recording permission: {error}")
    })?;
    let application = content
        .applications()
        .iter()
        .find(|application| application.process_id() == device.process_id as i32)
        .ok_or_else(|| "the selected application is no longer running".to_owned())?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit could not find a display for application audio".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|error| format!("the selected application could not be filtered: {error}"))?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_CHANNELS));
    let (sender, receiver) = mpsc::sync_channel::<Vec<f32>>(MAX_QUEUED_CHUNKS);
    let callback_failed = Arc::new(AtomicBool::new(false));
    let failure_signal = Arc::clone(&callback_failed);
    let delegate = StreamCallbacks::new().on_stop(move |error| {
        if error.is_some() {
            failure_signal.store(true, Ordering::Release);
        }
    });
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("the application-audio stream could not be created: {error}"))?;
    let callback_failed = Arc::clone(&callback_failed);
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                match screen_capture_audio_interleaved(sample) {
                    Ok(samples) if !samples.is_empty() => match sender.try_send(samples) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                            callback_failed.store(true, Ordering::Release);
                        }
                    },
                    Ok(_) => {}
                    Err(()) => callback_failed.store(true, Ordering::Release),
                }
            },
            SCStreamOutputType::Audio,
        )
        .map_err(|error| {
            format!("the application-audio handler could not be installed: {error}")
        })?;
    stream
        .start_capture()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;
    announce_application_format()?;

    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut frame_count_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        if callback_failed.load(Ordering::Acquire) {
            let _ = stream.stop_capture();
            return Err(
                "ScreenCaptureKit audio delivery stopped or fell behind its bounded queue"
                    .to_owned(),
            );
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(samples) => {
                write_f32le(&mut output, &samples)?;
                frame_count_written = frame_count_written
                    .checked_add((samples.len() / usize::from(APPLICATION_CHANNELS)) as u64)
                    .ok_or_else(|| "the capture frame count exceeded its limit".to_owned())?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = stream.stop_capture();
                return Err("ScreenCaptureKit audio delivery ended unexpectedly".to_owned());
            }
        }
    }
    let _ = stream.stop_capture();
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio: {error}"))?;
    if frame_count_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
    announce_application_summary(
        frame_count_written,
        frame_count_written * application_frame_bytes() as u64,
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn screen_capture_audio_interleaved(
    sample: screencapturekit::prelude::CMSampleBuffer,
) -> Result<Vec<f32>, ()> {
    let buffers = sample.audio_buffer_list().map_err(|_| ())?;
    let mut channels = Vec::new();
    for buffer in buffers.iter() {
        let channel_count = buffer.number_channels as usize;
        if channel_count == 0 || buffer.data().len() % 4 != 0 {
            return Err(());
        }
        let samples: Vec<f32> = buffer
            .data()
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            .collect();
        if samples.len() > MAX_FRAMES_PER_CHUNK * usize::from(APPLICATION_CHANNELS) {
            return Err(());
        }
        channels.push((channel_count, samples));
    }
    let frame_count = channels
        .iter()
        .map(|(channel_count, samples)| samples.len() / channel_count)
        .min()
        .unwrap_or_default();
    let channel_total: usize = channels.iter().map(|(count, _)| *count).sum();
    if frame_count > MAX_FRAMES_PER_CHUNK
        || channel_total != usize::from(APPLICATION_CHANNELS)
    {
        return Err(());
    }
    let mut interleaved = Vec::with_capacity(frame_count * channel_total);
    for frame in 0..frame_count {
        for (channel_count, samples) in &channels {
            let start = frame * channel_count;
            interleaved.extend_from_slice(&samples[start..start + channel_count]);
        }
    }
    Ok(interleaved)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn capture_application_audio(_device: &ApplicationDevice) -> Result<(), String> {
    Err("per-application audio capture is not supported on this operating system".to_owned())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn probe_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    let mut stream = flexaudio::open(flexaudio::StreamConfig {
        kind: flexaudio::SourceKind::ProcessLoopback,
        target_pid: Some(device.process_id),
        output: flexaudio::OutputFormat {
            sample_rate: APPLICATION_SAMPLE_RATE_HZ,
            channels: APPLICATION_CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| format!("{} Details: {error}", application_probe_unavailable_reason()))?;
    stream.start().map_err(|error| {
        format!(
            "The native per-application audio backend could not start this endpoint. Details: {error}"
        )
    })?;

    let started = Instant::now();
    let mut metrics = ProbeMetrics::default();
    while started.elapsed() < APPLICATION_PROBE_DURATION {
        while let Some(chunk) = stream.poll_chunk() {
            let frame_count = usize::try_from(chunk.frames)
                .map_err(|_| "the application-audio backend returned an invalid frame count")?;
            if frame_count == 0
                || frame_count > MAX_FRAMES_PER_CHUNK
                || frame_count.checked_mul(usize::from(APPLICATION_CHANNELS))
                    != Some(chunk.data.len())
            {
                stream.stop();
                return Err(
                    "the application-audio backend returned an incomplete PCM frame".to_owned(),
                );
            }
            for sample in &chunk.data {
                metrics.record(*sample);
            }
        }
        if let Some(error) = stream.terminal_error() {
            stream.stop();
            return Err(format!(
                "the selected application-audio source stopped: {error}"
            ));
        }
        thread::sleep(Duration::from_millis(4));
    }
    stream.stop();
    write_application_probe(
        device,
        &metrics,
        APPLICATION_CHANNELS,
        APPLICATION_SAMPLE_FORMAT,
        started.elapsed(),
    )
}

#[cfg(target_os = "macos")]
fn probe_application_audio(device: &ApplicationDevice) -> Result<(), String> {
    use screencapturekit::{prelude::*, stream::delegate_trait::StreamCallbacks};

    let content = SCShareableContent::get()
        .map_err(|error| format!("{} Details: {error}", application_probe_unavailable_reason()))?;
    let application = content
        .applications()
        .iter()
        .find(|application| application.process_id() == device.process_id as i32)
        .ok_or_else(|| "the selected application is no longer running".to_owned())?;
    let display = content.displays().into_iter().next().ok_or_else(|| {
        "ScreenCaptureKit could not find a display for application audio".to_owned()
    })?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_including_applications(&[application], &[])
        .build()
        .map_err(|error| format!("the selected application could not be filtered: {error}"))?;
    let configuration = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_sample_rate(APPLICATION_SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(APPLICATION_CHANNELS));
    let delegate = StreamCallbacks::new().on_stop(|_| {});
    let metrics = Arc::new(std::sync::Mutex::new(ProbeMetrics::default()));
    let channel_count = Arc::new(std::sync::Mutex::new(APPLICATION_CHANNELS));
    let callback_metrics = Arc::clone(&metrics);
    let callback_channels = Arc::clone(&channel_count);
    let mut stream = SCStream::new_with_delegate(&filter, &configuration, delegate)
        .map_err(|error| format!("the application-audio stream could not be created: {error}"))?;
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, _output_type: SCStreamOutputType| {
                let Ok(buffers) = sample.audio_buffer_list() else {
                    return;
                };
                let total: u16 = buffers
                    .iter()
                    .map(|buffer| buffer.number_channels as u16)
                    .sum();
                if total == 0 || total > APPLICATION_CHANNELS {
                    return;
                }
                if let Ok(mut channels) = callback_channels.lock() {
                    *channels = total;
                }
                if let Ok(mut metrics) = callback_metrics.lock() {
                    for buffer in buffers.iter() {
                        if buffer.data().len() % 4 != 0 {
                            continue;
                        }
                        for bytes in buffer.data().chunks_exact(4) {
                            metrics.record(f32::from_le_bytes([
                                bytes[0], bytes[1], bytes[2], bytes[3],
                            ]));
                        }
                    }
                }
            },
            SCStreamOutputType::Audio,
        )
        .map_err(|error| {
            format!("the application-audio handler could not be installed: {error}")
        })?;
    stream
        .start_capture()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;
    let started = Instant::now();
    thread::sleep(APPLICATION_PROBE_DURATION);
    let _ = stream.stop_capture();
    let metrics = metrics
        .lock()
        .map_err(|_| "the application-audio probe could not read its measurements".to_owned())?;
    let channels = *channel_count
        .lock()
        .map_err(|_| "the application-audio probe could not read its channel count".to_owned())?;
    write_application_probe(
        device,
        &metrics,
        channels,
        APPLICATION_SAMPLE_FORMAT,
        started.elapsed(),
    )
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn probe_application_audio(_device: &ApplicationDevice) -> Result<(), String> {
    Err(platform_limitation().to_owned())
}

fn write_application_probe(
    device: &ApplicationDevice,
    metrics: &ProbeMetrics,
    channel_count: u16,
    sample_format: &'static str,
    duration: Duration,
) -> Result<(), String> {
    let channels = u64::from(channel_count.max(1));
    let frame_count = metrics.sample_count / channels;
    if frame_count == 0 {
        return Err("the selected application-audio stream opened but returned no samples".to_owned());
    }
    let rms = (metrics.sum_squares / metrics.sample_count as f64).sqrt();
    let dbfs = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 };
    let report = ApplicationSignalProbe {
        id: device.id.clone(),
        name: device.name.clone(),
        backend: device.backend.clone(),
        source: "application",
        sample_format,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count,
        sample_count: frame_count,
        frame_count,
        duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        rms,
        peak: metrics.peak,
        dbfs,
        signal_detected: rms >= 0.001,
        probe: "native-stream-opened-and-signal-measured",
    };
    serde_json::to_writer(io::stdout().lock(), &report)
        .map_err(|error| format!("could not write the application-audio probe result: {error}"))?;
    io::stdout()
        .lock()
        .write_all(b"\n")
        .map_err(|error| format!("could not finish the application-audio probe result: {error}"))
}

fn application_probe_unavailable_reason() -> String {
    #[cfg(target_os = "windows")]
    {
        format!(
            "No active WASAPI application-audio session was found. {}",
            platform_limitation()
        )
    }
    #[cfg(target_os = "macos")]
    {
        format!(
            "No shareable ScreenCaptureKit application was found. {}",
            platform_limitation()
        )
    }
    #[cfg(target_os = "linux")]
    {
        format!(
            "No active PipeWire application output stream was found. {}",
            platform_limitation()
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        platform_limitation().to_owned()
    }
}

fn application_frame_bytes() -> usize {
    usize::from(APPLICATION_CHANNELS) * 4
}

fn announce_application_format() -> Result<(), String> {
    let format = ApplicationCaptureFormat {
        sample_format: APPLICATION_SAMPLE_FORMAT,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count: APPLICATION_CHANNELS,
        bytes_per_sample: 4,
    };
    let encoded = serde_json::to_string(&format)
        .map_err(|error| format!("could not describe the application audio format: {error}"))?;
    eprintln!("tutorux-audio-helper: capture-format {encoded}");
    Ok(())
}

fn announce_application_summary(frame_count: u64, byte_count: u64) {
    let summary = ApplicationCaptureSummary {
        sample_format: APPLICATION_SAMPLE_FORMAT,
        sample_rate_hz: APPLICATION_SAMPLE_RATE_HZ,
        channel_count: APPLICATION_CHANNELS,
        frame_count,
        byte_count,
    };
    if let Ok(encoded) = serde_json::to_string(&summary) {
        eprintln!("tutorux-audio-helper: capture-summary {encoded}");
    }
}

fn write_silence_frames(
    output: &mut impl Write,
    frames: u64,
    bytes_per_frame: usize,
) -> Result<(), String> {
    const ZEROES: [u8; 4096] = [0; 4096];
    let mut bytes = frames.saturating_mul(bytes_per_frame as u64);
    while bytes > 0 {
        let take = usize::try_from(bytes.min(ZEROES.len() as u64)).unwrap_or(ZEROES.len());
        let take = take - take % bytes_per_frame;
        if take == 0 {
            break;
        }
        output
            .write_all(&ZEROES[..take])
            .map_err(|error| format!("could not deliver capture gap silence: {error}"))?;
        bytes -= take as u64;
    }
    Ok(())
}

fn watch_for_stop(stop: Arc<AtomicBool>) -> Result<(), String> {
    thread::Builder::new()
        .name("tutorux-audio-helper-control".to_owned())
        .spawn(move || {
            let mut command = String::new();
            let _ = io::stdin().lock().read_line(&mut command);
            stop.store(true, Ordering::Release);
        })
        .map(|_| ())
        .map_err(|error| format!("could not start the capture control channel: {error}"))
}

fn write_f32le(output: &mut impl Write, samples: &[f32]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    output
        .write_all(&bytes)
        .map_err(|error| format!("could not deliver captured audio to the CLI: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("could not flush captured audio to the CLI: {error}"))
}

#[cfg(target_os = "windows")]
fn platform_limitation() -> &'static str {
    "Application capture requires Windows 10 build 20348 or newer and an active WASAPI audio session."
}

#[cfg(target_os = "macos")]
fn platform_limitation() -> &'static str {
    "Application capture requires macOS 14 or newer and Screen & System Audio Recording permission."
}

#[cfg(target_os = "linux")]
fn platform_limitation() -> &'static str {
    "Application capture requires an active PipeWire output stream; ALSA cannot identify application audio."
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn platform_limitation() -> &'static str {
    "Per-application audio capture is not supported on this operating system."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gap_silence_uses_the_native_frame_width() {
        let mut output = Vec::new();
        write_silence_frames(&mut output, 3, application_frame_bytes())
            .expect("silence must be writable");
        assert_eq!(output.len(), 3 * application_frame_bytes());
        assert!(output.iter().all(|byte| *byte == 0));

        let mut mono = Vec::new();
        write_silence_frames(&mut mono, 5, 2).expect("silence must be writable");
        assert_eq!(mono.len(), 10);
    }

    #[test]
    fn application_capture_preserves_stereo_frames() {
        let mut output = Vec::new();
        write_f32le(&mut output, &[0.25, -0.25, 0.5, -0.5]).expect("PCM must be writable");
        assert_eq!(output.len(), 4 * 4);
        assert_eq!(
            output,
            [
                0.25_f32.to_le_bytes(),
                (-0.25_f32).to_le_bytes(),
                0.5_f32.to_le_bytes(),
                (-0.5_f32).to_le_bytes()
            ]
            .concat()
        );
    }
}
