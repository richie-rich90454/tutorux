const TARGET_RATE_HZ: u32 = 16_000;

pub(super) fn sample_width(format: &str) -> usize {
    match format {
        "pcm_u8" => 1,
        "pcm_s16le" => 2,
        "pcm_s24le" => 3,
        "pcm_s32le" | "pcm_f32le" => 4,
        _ => 2,
    }
}

pub(super) fn build_wav(
    pcm: &[u8],
    sample_rate_hz: u32,
    channel_count: u16,
    sample_format: &str,
) -> Result<Vec<u8>, String> {
    let width = sample_width(sample_format);
    let channels = usize::from(channel_count.max(1));
    let frame_bytes = width * channels;
    if frame_bytes == 0 || pcm.len() % frame_bytes != 0 {
        return Err("The live Whisper window contains incomplete PCM frames.".to_owned());
    }
    let frames = pcm.len() / frame_bytes;
    let mut mono = Vec::with_capacity(frames);
    for frame in pcm.chunks_exact(frame_bytes) {
        let mut sum = 0.0f64;
        for sample in frame.chunks(width) {
            sum += f64::from(decode_sample(sample, sample_format)?);
        }
        mono.push((sum / channels as f64) as f32);
    }
    let count = (mono.len() as u64)
        .saturating_mul(u64::from(TARGET_RATE_HZ))
        .checked_div(u64::from(sample_rate_hz.max(1)))
        .unwrap_or(0) as usize;
    let mut output = Vec::with_capacity(count.saturating_mul(2));
    for index in 0..count {
        let position = (index as f64) * f64::from(sample_rate_hz.max(1)) / f64::from(TARGET_RATE_HZ);
        let frame = (position.floor() as usize).min(mono.len().saturating_sub(1));
        let next = (frame + 1).min(mono.len().saturating_sub(1));
        let fraction = (position - position.floor()) as f32;
        let value = if mono.is_empty() {
            0.0
        } else {
            mono[frame] * (1.0 - fraction) + mono[next] * fraction
        };
        output.extend_from_slice(
            &(value.mul_add(32_767.0, 0.0).clamp(-32_768.0, 32_767.0) as i16).to_le_bytes(),
        );
    }
    if output.is_empty() {
        return Err("The live Whisper window contains no samples.".to_owned());
    }
    Ok(write_wav_pcm(&output))
}

fn decode_sample(sample: &[u8], format: &str) -> Result<f32, String> {
    match format {
        "pcm_u8" => Ok((f32::from(sample[0]) - 128.0) / 128.0),
        "pcm_s16le" => Ok(f32::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0),
        "pcm_s24le" => {
            let raw = i32::from(sample[0])
                | (i32::from(sample[1]) << 8)
                | (i32::from(sample[2]) << 16);
            Ok(((raw << 8) >> 8) as f32 / 8_388_608.0)
        }
        "pcm_s32le" => Ok(
            i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) as f32
                / 2_147_483_648.0,
        ),
        "pcm_f32le" => Ok(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])),
        _ => Err("The live Whisper window has an unsupported sample format.".to_owned()),
    }
}

fn write_wav_pcm(pcm: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(44 + pcm.len());
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&TARGET_RATE_HZ.to_le_bytes());
    output.extend_from_slice(&(TARGET_RATE_HZ * 2).to_le_bytes());
    output.extend_from_slice(&2u16.to_le_bytes());
    output.extend_from_slice(&16u16.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    output.extend_from_slice(pcm);
    output
}

#[cfg(test)]
mod tests {
    use super::{decode_sample, write_wav_pcm};

    #[test]
    fn decodes_capture_widths_for_whisper() {
        assert!((decode_sample(&[0x00, 0x40], "pcm_s16le").unwrap() - 0.5).abs() < 0.001);
        assert!((decode_sample(&[0x00, 0x00, 0x40], "pcm_s24le").unwrap() - 0.5).abs() < 0.001);
        assert!((decode_sample(&[192], "pcm_u8").unwrap() - 0.5).abs() < 0.001);
    }

    #[test]
    fn writes_a_16khz_mono_wav_header() {
        let wav = write_wav_pcm(&[0, 0, 1, 0]);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(wav.len(), 48);
    }
}
