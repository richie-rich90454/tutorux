use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::{
    env, fs,
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const MAX_COMPRESSED_IMPORT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PCM_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_WAV_HEADER_CHUNK_BYTES: u32 = 1024 * 1024;
const MIN_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_SAMPLE_RATE_HZ: u32 = 384_000;
const MAX_CHANNELS: u16 = 8;
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
const FFMPEG_MISSING_MESSAGE: &str = "FFmpeg is required to import FLAC, MP3, and M4A audio. Install FFmpeg so it is on PATH, pass ffmpegPath, or set TUTORUX_FFMPEG to its executable path.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCompressedAudio {
    source_filename: String,
    source_codec: String,
    sample_rate_hz: u32,
    channel_count: u16,
    channel_mask: u32,
    sample_format: &'static str,
    sample_count: String,
    byte_count: u64,
    chunk_count: u64,
    duration_us: String,
    chunks: Vec<ImportedPcmChunk>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedPcmChunk {
    sequence: u64,
    first_sample_index: String,
    frame_count: String,
    pcm_base64: String,
}

#[derive(Debug)]
struct WavFormat {
    sample_rate_hz: u32,
    channel_count: u16,
    channel_mask: u32,
    block_align: u32,
}

#[tauri::command]
pub async fn import_compressed_audio(
    path: String,
    ffmpeg_path: Option<String>,
) -> Result<ImportedCompressedAudio, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_compressed_audio_blocking(&path, ffmpeg_path)
    })
    .await
    .map_err(|_| "Compressed audio import stopped unexpectedly.".to_owned())?
}

fn import_compressed_audio_blocking(
    path: &str,
    ffmpeg_path: Option<String>,
) -> Result<ImportedCompressedAudio, String> {
    let source = PathBuf::from(path);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| "The selected audio file could not be read.".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Choose a regular audio file, not a folder or symbolic link.".to_owned());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "flac" | "mp3" | "m4a") {
        return Err("Compressed audio import supports FLAC, MP3, and M4A sources.".to_owned());
    }
    let executable = ffmpeg_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            env::var("TUTORUX_FFMPEG")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "ffmpeg".to_owned());
    let mut process = start_ffmpeg(&executable, &source)?;
    let stdout = process
        .0
        .stdout
        .take()
        .ok_or_else(|| "FFmpeg did not expose its decoded audio stream.".to_owned())?;
    let mut stderr = process
        .0
        .stderr
        .take()
        .ok_or_else(|| "FFmpeg did not expose its diagnostic stream.".to_owned())?;
    let mut reader = BufReader::new(stdout);
    let decoded = read_decoded_audio(&mut reader);

    if decoded.is_err() {
        let _ = process.0.kill();
    }
    let stderr_text = read_bounded_text(&mut stderr, 16 * 1024);
    let status = process.0.wait();
    let (format, chunks, sample_count, byte_count) = match decoded {
        Ok(decoded) => decoded,
        Err(error) => return Err(error),
    };
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => {
            let detail = stderr_text.trim();
            return Err(if detail.is_empty() {
                format!("FFmpeg could not decode the selected audio file (exit status {status}).")
            } else {
                format!("FFmpeg could not decode the selected audio file: {detail}")
            });
        }
        Err(error) => {
            return Err(format!(
                "The FFmpeg process could not be waited on after decoding: {error}"
            ));
        }
    }
    let chunk_count = u64::try_from(chunks.len())
        .map_err(|_| "The decoded audio exceeded the supported chunk count.".to_owned())?;
    let duration_us = sample_count
        .checked_mul(1_000_000)
        .map(|value| value / u64::from(format.sample_rate_hz))
        .ok_or_else(|| "The decoded audio duration exceeded the supported range.".to_owned())?;
    Ok(ImportedCompressedAudio {
        source_filename: source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_owned(),
        source_codec: extension,
        sample_rate_hz: format.sample_rate_hz,
        channel_count: format.channel_count,
        channel_mask: format.channel_mask,
        sample_format: "pcm_s16le",
        sample_count: sample_count.to_string(),
        byte_count,
        chunk_count,
        duration_us: duration_us.to_string(),
        chunks,
    })
}

fn start_ffmpeg(executable: &str, source: &Path) -> Result<FfmpegProcess, String> {
    let child = Command::new(executable)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-acodec",
            "pcm_s16le",
            "-f",
            "wav",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                FFMPEG_MISSING_MESSAGE.to_owned()
            } else {
                format!("FFmpeg could not be started: {error}")
            }
        })?;
    Ok(FfmpegProcess(child))
}

struct FfmpegProcess(Child);

impl Drop for FfmpegProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn read_bounded_text(reader: &mut impl Read, limit: usize) -> String {
    let mut bytes = Vec::with_capacity(limit);
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(bytes.len());
                if remaining > 0 {
                    bytes.extend_from_slice(&buffer[..read.min(remaining)]);
                }
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn read_decoded_audio(
    reader: &mut impl Read,
) -> Result<(WavFormat, Vec<ImportedPcmChunk>, u64, u64), String> {
    let format = read_wav_format(reader)?;
    let block_align = usize::try_from(format.block_align)
        .map_err(|_| "FFmpeg returned an invalid WAV frame size.".to_owned())?;
    let aligned_chunk_bytes = (MAX_PCM_CHUNK_BYTES / block_align) * block_align;
    let mut pending = Vec::with_capacity(aligned_chunk_bytes + 64 * 1024);
    let mut chunks = Vec::new();
    let mut sample_count = 0u64;
    let mut byte_count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("The decoded audio stream could not be read: {error}"))?;
        if read == 0 {
            break;
        }
        byte_count = byte_count
            .checked_add(read as u64)
            .ok_or_else(|| "The decoded audio length exceeded the supported range.".to_owned())?;
        if byte_count > MAX_COMPRESSED_IMPORT_BYTES {
            return Err("Decoded audio exceeds the 256 MiB import limit.".to_owned());
        }
        pending.extend_from_slice(&buffer[..read]);
        while pending.len() >= aligned_chunk_bytes {
            let chunk: Vec<u8> = pending.drain(..aligned_chunk_bytes).collect();
            push_pcm_chunk(&mut chunks, &mut sample_count, block_align, chunk)?;
        }
    }
    if !pending.is_empty() {
        if pending.len() % block_align != 0 {
            return Err("FFmpeg returned an incomplete PCM sample frame.".to_owned());
        }
        push_pcm_chunk(&mut chunks, &mut sample_count, block_align, pending)?;
    }
    if sample_count == 0 {
        return Err("The selected audio source decoded to no samples.".to_owned());
    }
    Ok((format, chunks, sample_count, byte_count))
}

fn push_pcm_chunk(
    chunks: &mut Vec<ImportedPcmChunk>,
    sample_count: &mut u64,
    block_align: usize,
    pcm: Vec<u8>,
) -> Result<(), String> {
    let frame_count = u64::try_from(pcm.len() / block_align)
        .map_err(|_| "The decoded audio exceeded the supported frame count.".to_owned())?;
    let sequence = u64::try_from(chunks.len())
        .map_err(|_| "The decoded audio exceeded the supported chunk count.".to_owned())?;
    chunks.push(ImportedPcmChunk {
        sequence,
        first_sample_index: sample_count.to_string(),
        frame_count: frame_count.to_string(),
        pcm_base64: BASE64.encode(pcm),
    });
    *sample_count = sample_count
        .checked_add(frame_count)
        .ok_or_else(|| "The decoded audio exceeded the supported sample timeline.".to_owned())?;
    Ok(())
}

fn read_wav_format(reader: &mut impl Read) -> Result<WavFormat, String> {
    let mut header = [0u8; 12];
    read_exact_wav(reader, &mut header)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("FFmpeg did not produce a RIFF/WAVE audio stream.".to_owned());
    }
    let mut format = None;
    loop {
        let mut chunk = [0u8; 8];
        read_exact_wav(reader, &mut chunk)?;
        let chunk_id = &chunk[..4];
        let chunk_size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
        if chunk_id == b"fmt " {
            if chunk_size < 16 || chunk_size > MAX_WAV_HEADER_CHUNK_BYTES {
                return Err("FFmpeg returned an invalid WAV format chunk.".to_owned());
            }
            let mut bytes = vec![0u8; chunk_size as usize];
            read_exact_wav(reader, &mut bytes)?;
            format = Some(parse_wav_format(&bytes)?);
            if chunk_size % 2 == 1 {
                read_exact_wav(reader, &mut [0u8; 1])?;
            }
            continue;
        }
        if chunk_id == b"data" {
            return format
                .ok_or_else(|| "FFmpeg returned WAV audio before its format chunk.".to_owned());
        }
        if chunk_size == u32::MAX {
            return Err("FFmpeg returned an incomplete WAV header chunk.".to_owned());
        }
        skip_exact(reader, u64::from(chunk_size) + u64::from(chunk_size % 2))?;
    }
}

fn parse_wav_format(bytes: &[u8]) -> Result<WavFormat, String> {
    if bytes.len() < 16 {
        return Err("FFmpeg returned a truncated WAV format chunk.".to_owned());
    }
    let format_tag = u16::from_le_bytes([bytes[0], bytes[1]]);
    let channel_count = u16::from_le_bytes([bytes[2], bytes[3]]);
    let sample_rate_hz = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let block_align = u16::from_le_bytes([bytes[12], bytes[13]]);
    let bits_per_sample = u16::from_le_bytes([bytes[14], bytes[15]]);
    let channel_mask = if format_tag == WAVE_FORMAT_EXTENSIBLE && bytes.len() >= 24 {
        u32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]])
    } else {
        0
    };
    if !matches!(format_tag, WAVE_FORMAT_PCM | WAVE_FORMAT_EXTENSIBLE) {
        return Err("FFmpeg returned a compressed WAV sample format instead of PCM.".to_owned());
    }
    if !(1..=MAX_CHANNELS).contains(&channel_count) {
        return Err("The audio source has more channels than Tutorux can import.".to_owned());
    }
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&sample_rate_hz) {
        return Err("The audio source uses an unsupported sample rate.".to_owned());
    }
    if bits_per_sample != 16 {
        return Err("FFmpeg returned a WAV sample depth other than 16-bit.".to_owned());
    }
    if u32::from(block_align) != u32::from(channel_count) * 2 {
        return Err("FFmpeg returned an invalid WAV block alignment.".to_owned());
    }
    Ok(WavFormat {
        sample_rate_hz,
        channel_count,
        channel_mask,
        block_align: u32::from(block_align),
    })
}

fn read_exact_wav(reader: &mut impl Read, buffer: &mut [u8]) -> Result<(), String> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            "FFmpeg produced an incomplete WAV header.".to_owned()
        } else {
            format!("The decoded WAV header could not be read: {error}")
        }
    })
}

fn skip_exact(reader: &mut impl Read, mut bytes: u64) -> Result<(), String> {
    let mut buffer = [0u8; 8192];
    while bytes > 0 {
        let wanted = usize::try_from(bytes.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let read = reader
            .read(&mut buffer[..wanted])
            .map_err(|error| format!("The decoded WAV header could not be skipped: {error}"))?;
        if read == 0 {
            return Err("FFmpeg produced an incomplete WAV header.".to_owned());
        }
        bytes -= read as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn wav(fmt: &[u8], data: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(4 + 8 + fmt.len() + 8 + data.len()).to_le_bytes()[..4]);
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        bytes.extend_from_slice(fmt);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(data);
        bytes
    }

    fn pcm_format(channels: u16, rate: u32) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&rate.to_le_bytes());
        fmt.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
        fmt.extend_from_slice(&(channels * 2).to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        fmt
    }

    #[test]
    fn reads_stereo_pcm_wav_and_keeps_both_channels() {
        let mut bytes = wav(&pcm_format(2, 192_000), &[1, 0, 2, 0, 3, 0, 4, 0]);
        let format = read_wav_format(&mut Cursor::new(&mut bytes)).expect("valid WAV header");
        assert_eq!(format.channel_count, 2);
        assert_eq!(format.sample_rate_hz, 192_000);
        assert_eq!(format.block_align, 4);
    }

    #[test]
    fn rejects_more_than_eight_channels() {
        let mut bytes = wav(&pcm_format(9, 48_000), &[0; 18]);
        let error = read_wav_format(&mut Cursor::new(&mut bytes)).expect_err("9 channels");
        assert!(error.contains("channels"));
    }

    #[test]
    fn decoder_chunks_align_to_sample_frames() {
        let mut bytes = wav(&pcm_format(2, 48_000), &vec![0u8; MAX_PCM_CHUNK_BYTES + 8]);
        let (_, chunks, sample_count, byte_count) =
            read_decoded_audio(&mut Cursor::new(&mut bytes)).expect("decodable WAV");
        assert_eq!(sample_count, (MAX_PCM_CHUNK_BYTES as u64 + 8) / 4);
        assert_eq!(byte_count, MAX_PCM_CHUNK_BYTES as u64 + 8);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].frame_count, (MAX_PCM_CHUNK_BYTES / 4).to_string());
    }
}
