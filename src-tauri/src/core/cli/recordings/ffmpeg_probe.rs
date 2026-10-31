use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::json;

use super::ffmpeg::{hidden_command, input_arguments, FfmpegDevice};

const PROBE_BYTES_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 32 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn probe(
    executable: &str,
    device: &FfmpegDevice,
    source: &str,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "-nostdin".to_owned(),
        "-hide_banner".to_owned(),
        "-loglevel".to_owned(),
        "error".to_owned(),
        "-t".to_owned(),
        "1.8".to_owned(),
    ];
    args.extend(input_arguments(device));
    args.extend([
        "-vn".to_owned(),
        "-f".to_owned(),
        "s16le".to_owned(),
        "-ac".to_owned(),
        "1".to_owned(),
        "-ar".to_owned(),
        "16000".to_owned(),
        "pipe:1".to_owned(),
    ]);
    let mut child = hidden_command(executable)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start FFmpeg for the signal probe: {error}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read the FFmpeg signal probe output.".to_owned())?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut overflow = false;
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if bytes.len() + count > PROBE_BYTES_LIMIT {
                        overflow = true;
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                Err(_) => break,
            }
        }
        (bytes, overflow)
    });
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > PROBE_TIMEOUT => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                break child.wait().ok();
            }
        }
    };
    let (pcm, overflow) = reader.join().unwrap_or_default();
    let mut error = String::new();
    if let Some(pipe) = stderr.take() {
        let mut bytes = Vec::new();
        let _ = pipe.take(STDERR_LIMIT as u64).read_to_end(&mut bytes);
        error = String::from_utf8_lossy(&bytes).trim().to_owned();
    }
    if timed_out {
        return Err("The FFmpeg signal probe exceeded its time limit.".to_owned());
    }
    if overflow {
        return Err("The FFmpeg signal probe exceeded its bounded capture limit.".to_owned());
    }
    if !status.map(|status| status.success()).unwrap_or(false) {
        return Err(if error.is_empty() {
            "FFmpeg exited during the signal probe.".to_owned()
        } else {
            error
        });
    }
    if pcm.len() < 2 || pcm.len() % 2 != 0 {
        return Err("The FFmpeg input opened but returned no complete PCM samples.".to_owned());
    }
    let sample_count = pcm.len() / 2;
    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f64;
    for sample in pcm.chunks_exact(2) {
        let value = f64::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0;
        let magnitude = value.abs();
        sum_squares += magnitude * magnitude;
        peak = peak.max(magnitude);
    }
    let rms = (sum_squares / sample_count as f64).sqrt();
    Ok(json!({
        "id": device.id,
        "name": device.name,
        "backend": device.backend,
        "source": source,
        "sample_format": "S16LE",
        "sample_rate_hz": 16_000,
        "channel_count": 1,
        "sample_count": sample_count,
        "duration_ms": ((sample_count as f64 / 16_000.0) * 1000.0).round() as u64,
        "rms": rms,
        "peak": peak,
        "dbfs": if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 },
        "signal_detected": rms >= 0.001,
        "probe": "ffmpeg-stream-opened-and-signal-measured",
    }))
}
