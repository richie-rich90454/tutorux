use zeroize::Zeroizing;

use super::SAMPLE_RATE_HZ;

pub(super) struct Resampler {
    input_rate_hz: u32,
    processed_input_frames: u64,
    next_output_frame: u64,
    previous_sample: Option<f32>,
}

impl Resampler {
    pub(super) fn new(input_rate_hz: u32) -> Self {
        Self {
            input_rate_hz,
            processed_input_frames: 0,
            next_output_frame: 0,
            previous_sample: None,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<Zeroizing<Vec<f32>>, String> {
        if bytes.is_empty() || bytes.len() % 2 != 0 {
            return Err("Live microphone audio is not aligned 16-bit PCM.".to_owned());
        }
        let frames = bytes.len() / 2;
        let frame_count = u64::try_from(frames).map_err(|_| "Live audio chunk is too large.")?;
        let end_frame = self
            .processed_input_frames
            .checked_add(frame_count)
            .ok_or_else(|| "Live audio timeline exceeded its supported range.".to_owned())?;
        let mut source = Zeroizing::new(Vec::with_capacity(frames));
        for sample in bytes.chunks_exact(2) {
            source.push(i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0);
        }

        let mut output = Zeroizing::new(Vec::new());
        loop {
            let numerator = (self.next_output_frame as u128)
                .checked_mul(self.input_rate_hz as u128)
                .ok_or_else(|| {
                    "Resampled audio position exceeded its supported range.".to_owned()
                })?;
            let left = u64::try_from(numerator / SAMPLE_RATE_HZ as u128)
                .map_err(|_| "Resampled audio position exceeded its supported range.")?;
            let remainder = numerator % SAMPLE_RATE_HZ as u128;
            if left >= end_frame || (remainder > 0 && left.saturating_add(1) >= end_frame) {
                break;
            }
            let left_value = self.sample_at(left, &source)?;
            let value = if remainder == 0 {
                left_value
            } else {
                let right_value = self.sample_at(left + 1, &source)?;
                let fraction = remainder as f32 / SAMPLE_RATE_HZ as f32;
                left_value * (1.0 - fraction) + right_value * fraction
            };
            output.push(value.clamp(-1.0, 1.0));
            self.next_output_frame = self.next_output_frame.checked_add(1).ok_or_else(|| {
                "Resampled audio position exceeded its supported range.".to_owned()
            })?;
        }
        self.previous_sample = source.last().copied();
        self.processed_input_frames = end_frame;
        source.fill(0.0);
        Ok(output)
    }

    fn sample_at(&self, frame: u64, current: &[f32]) -> Result<f32, String> {
        if frame < self.processed_input_frames {
            if frame + 1 == self.processed_input_frames {
                return self
                    .previous_sample
                    .ok_or_else(|| "Live audio resampler lost its boundary sample.".to_owned());
            }
            return Err("Live audio resampler received a discontinuous sample range.".to_owned());
        }
        let offset = usize::try_from(frame - self.processed_input_frames)
            .map_err(|_| "Live audio chunk exceeds the supported sample range.")?;
        current
            .get(offset)
            .copied()
            .ok_or_else(|| "Live audio resampler received an incomplete sample range.".to_owned())
    }
}
