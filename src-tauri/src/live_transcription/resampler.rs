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
        if bytes.is_empty() || !bytes.len().is_multiple_of(2) {
            return Err("Live microphone audio is not aligned 16-bit PCM.".to_owned());
        }
        let frames = bytes.len() / 2;
        let frame_count = u64::try_from(frames).map_err(|_| "Live audio chunk is too large.")?;
        let end_frame = self
            .processed_input_frames
            .checked_add(frame_count)
            .ok_or_else(|| "Live audio timeline exceeded its supported range.".to_owned())?;
        let mut source = Zeroizing::new(Vec::with_capacity(frames));
        for sample in bytes.as_chunks::<2>().0 {
            source.push(i16::from_le_bytes(*sample) as f32 / 32768.0);
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

#[cfg(test)]
mod tests {
    use super::Resampler;

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    fn ramp(frames: usize) -> Vec<i16> {
        (0..frames).map(|frame| frame as i16).collect()
    }

    fn expected_sample(frame: usize) -> f32 {
        frame as f32 / 32_768.0
    }

    #[test]
    fn resamples_48_khz_on_exact_three_to_one_frame_boundaries() {
        let mut resampler = Resampler::new(48_000);
        let output = resampler.push(&pcm(&ramp(480))).expect("resample 48 kHz");

        assert_eq!(output.len(), 160);
        for (index, value) in output.iter().enumerate() {
            let expected = expected_sample(index * 3);
            assert!(
                (value - expected).abs() < f32::EPSILON,
                "frame {index}: {value} != {expected}"
            );
        }
        assert_eq!(output[0], expected_sample(0));
        assert_eq!(output[159], expected_sample(477));
    }

    #[test]
    fn resamples_44_1_khz_with_interpolated_first_and_last_samples() {
        let mut resampler = Resampler::new(44_100);
        let output = resampler
            .push(&pcm(&ramp(4_410)))
            .expect("resample 44.1 kHz");

        assert_eq!(output.len(), 1_600);
        assert_eq!(output[0], expected_sample(0));

        let last_frame = 1_599usize;
        let left = last_frame * 44_100 / 16_000;
        let remainder = last_frame * 44_100 % 16_000;
        let expected = (left as f32 + remainder as f32 / 16_000.0) / 32_768.0;
        assert!(
            (output[last_frame] - expected).abs() < 1e-6,
            "last sample {} != {expected}",
            output[last_frame]
        );
    }

    #[test]
    fn keeps_frame_alignment_when_a_chunk_split_falls_between_output_frames() {
        let mut resampler = Resampler::new(44_100);
        let source = ramp(4_410);
        let first = resampler.push(&pcm(&source[..2_205])).expect("first chunk");
        let second = resampler
            .push(&pcm(&source[2_205..]))
            .expect("second chunk");

        assert_eq!(first.len(), 800);
        assert_eq!(first.len() + second.len(), 1_600);
        assert_eq!(first[0], expected_sample(0));
        assert_eq!(second[0], expected_sample(2_205));
    }
}
