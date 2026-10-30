//! Standalone process-audio capture helper used by the Tutorux CLI.
//!
//! `devices` and `inputs` write JSON arrays to stdout. `capture` writes mono 16 kHz signed
//! 16-bit little-endian PCM to stdout until stdin receives `stop` or closes.
//! Diagnostics are written to stderr so PCM remains an unframed byte stream.

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
    time::Duration,
};

const SAMPLE_RATE_HZ: u32 = 16_000;
const CHANNELS: u16 = 2;
const MAX_QUEUED_CHUNKS: usize = 8;
const MAX_FRAMES_PER_CHUNK: usize = 128 * 1024;

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
            let source_option = arguments.next();
            let source = arguments.next();
            let device_option = arguments.next();
            let device_id = arguments.next();
            if source_option.as_deref() != Some("--source")
                || device_option.as_deref() != Some("--device")
                || arguments.next().is_some()
            {
                return Err("use probe --source microphone|system-audio --device <device-id>".to_owned());
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
        _ => Err("use devices, inputs, probe --source microphone|system-audio --device <device-id>, capture --application <device-id>, capture --source microphone|system-audio --device <device-id>, archive-lock --shared|--exclusive <archive-path>, or --version".to_owned()),
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
            sample_rate: SAMPLE_RATE_HZ,
            channels: CHANNELS,
        },
        ring_capacity_chunks: MAX_QUEUED_CHUNKS,
        silence_probe: false,
        ..Default::default()
    })
    .map_err(|error| format!("the selected application audio could not be opened: {error}"))?;
    stream
        .start()
        .map_err(|error| format!("the selected application audio could not be started: {error}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut expected_frame_index = None;
    let mut samples_written = 0_u64;
    while !stop.load(Ordering::Acquire) {
        while let Some(chunk) = stream.poll_chunk() {
            let frame_count = usize::try_from(chunk.frames)
                .map_err(|_| "the application-audio backend returned an invalid frame count")?;
            if frame_count == 0
                || frame_count > MAX_FRAMES_PER_CHUNK
                || frame_count.checked_mul(usize::from(CHANNELS)) != Some(chunk.data.len())
            {
                return Err(
                    "the application-audio backend returned an incomplete PCM frame".into(),
                );
            }
            if expected_frame_index.is_some_and(|expected| expected != chunk.frame_index) {
                return Err(
                    "the application-audio backend dropped frames from its timeline".into(),
                );
            }
            expected_frame_index = Some(
                chunk
                    .frame_index
                    .checked_add(frame_count as u64)
                    .ok_or_else(|| {
                        "the application-audio timeline exceeded its limit".to_owned()
                    })?,
            );
            write_stereo_f32_as_mono_s16le(&mut output, &chunk.data)?;
            samples_written = samples_written
                .checked_add(frame_count as u64)
                .ok_or_else(|| "the capture sample count exceeded its limit".to_owned())?;
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
    if samples_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
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
        .with_sample_rate(SAMPLE_RATE_HZ)
        .with_channel_count(u32::from(CHANNELS));
    let (sender, receiver) = mpsc::sync_channel::<Vec<i16>>(MAX_QUEUED_CHUNKS);
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
                match screen_capture_audio_to_mono(sample) {
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

    let stop = Arc::new(AtomicBool::new(false));
    watch_for_stop(Arc::clone(&stop))?;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let mut samples_written = 0_u64;
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
                write_s16le(&mut output, &samples)?;
                samples_written = samples_written
                    .checked_add(samples.len() as u64)
                    .ok_or_else(|| "the capture sample count exceeded its limit".to_owned())?;
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
    if samples_written == 0 {
        return Err("the selected application produced no audio samples".to_owned());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn screen_capture_audio_to_mono(
    sample: screencapturekit::prelude::CMSampleBuffer,
) -> Result<Vec<i16>, ()> {
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
        if samples.len() > MAX_FRAMES_PER_CHUNK * usize::from(CHANNELS) {
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
    if frame_count > MAX_FRAMES_PER_CHUNK || channel_total == 0 {
        return Err(());
    }
    Ok((0..frame_count)
        .map(|frame| {
            let sum = channels
                .iter()
                .map(|(channel_count, samples)| {
                    let start = frame * channel_count;
                    samples[start..start + channel_count]
                        .iter()
                        .copied()
                        .sum::<f32>()
                })
                .sum::<f32>();
            float_to_i16(sum / channel_total as f32)
        })
        .collect())
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn capture_application_audio(_device: &ApplicationDevice) -> Result<(), String> {
    Err("per-application audio capture is not supported on this operating system".to_owned())
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

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn write_stereo_f32_as_mono_s16le(output: &mut impl Write, samples: &[f32]) -> Result<(), String> {
    let mono: Vec<i16> = samples
        .chunks_exact(usize::from(CHANNELS))
        .map(|frame| float_to_i16((frame[0] + frame[1]) * 0.5))
        .collect();
    write_s16le(output, &mono)
}

fn write_s16le(output: &mut impl Write, samples: &[i16]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
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

fn float_to_i16(value: f32) -> i16 {
    if value.is_finite() {
        let clipped = value.clamp(-1.0, 1.0);
        if clipped <= -1.0 {
            i16::MIN
        } else {
            (clipped * f32::from(i16::MAX)).round() as i16
        }
    } else {
        0
    }
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
