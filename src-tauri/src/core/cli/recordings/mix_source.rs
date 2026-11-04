use crate::core::format::ArchiveRecord;

pub(super) struct Source {
    pub(super) rate: u32,
    pub(super) channels: u16,
    format: String,
    width: usize,
    pub(super) total_frames: u64,
    gaps: Vec<(u64, u64)>,
    chunks: Vec<ArchiveRecord>,
    chunk_index: usize,
    offset: usize,
    sample_index: u64,
}

impl Source {
    pub(super) fn new(
        rate: u32,
        channels: u16,
        format: String,
        width: usize,
        total_frames: u64,
        gaps: Vec<(u64, u64)>,
        chunks: Vec<ArchiveRecord>,
    ) -> Self {
        Self {
            rate,
            channels,
            format,
            width,
            total_frames,
            gaps,
            chunks,
            chunk_index: 0,
            offset: 0,
            sample_index: 0,
        }
    }

    fn frame_bytes(&self) -> usize {
        self.width * usize::from(self.channels)
    }

    pub(super) fn sample_at(&mut self, frame: u64) -> Option<Vec<i32>> {
        if frame < self.sample_index {
            return None;
        }
        while self.sample_index < frame {
            if !self.advance() {
                return None;
            }
        }
        if frame != self.sample_index {
            return None;
        }
        if self
            .gaps
            .iter()
            .any(|(start, end)| frame >= *start && frame < *end)
        {
            return None;
        }
        let stride = self.frame_bytes();
        if self.offset + stride > self.chunks[self.chunk_index].blob.len() {
            return None;
        }
        let chunk = &self.chunks[self.chunk_index];
        let mut samples = Vec::with_capacity(usize::from(self.channels));
        for channel in 0..usize::from(self.channels) {
            let at = self.offset + channel * self.width;
            samples.push(decode_sample(
                &chunk.blob[at..at + self.width],
                &self.format,
            ));
        }
        Some(samples)
    }

    fn advance(&mut self) -> bool {
        self.offset += self.frame_bytes();
        self.sample_index = self.sample_index.saturating_add(1);
        if self.offset < self.chunks[self.chunk_index].blob.len() {
            return true;
        }
        self.chunk_index += 1;
        if self.chunk_index >= self.chunks.len() {
            return false;
        }
        self.offset = 0;
        self.sample_index = self.chunks[self.chunk_index]
            .field("first_sample_index")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(self.sample_index);
        true
    }
}

fn decode_sample(bytes: &[u8], format: &str) -> i32 {
    let value = match format {
        "pcm_u8" => (f64::from(bytes[0]) - 128.0) * 256.0,
        "pcm_s16le" => f64::from(i16::from_le_bytes([bytes[0], bytes[1]])),
        "pcm_s24le" => {
            let raw =
                i32::from(bytes[0]) | (i32::from(bytes[1]) << 8) | (i32::from(bytes[2]) << 16);
            let signed = if raw & 0x80_0000 != 0 {
                raw | !0xff_ffff
            } else {
                raw
            };
            (f64::from(signed) / 256.0).round()
        }
        "pcm_s32le" => (f64::from(i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
            / 65_536.0)
            .round(),
        "pcm_f32le" => {
            let sample = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            if sample.is_finite() {
                (f64::from(sample) * 32_768.0).round()
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    value.clamp(-32_768.0, 32_767.0) as i32
}

#[cfg(test)]
mod tests {
    use super::{decode_sample, Source};
    use crate::core::archive::{new_uuid, ArchiveRecord};
    use crate::core::format::RecordType;

    fn chunk(first_sample_index: u64, samples: &[i16]) -> ArchiveRecord {
        let mut blob = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            blob.extend_from_slice(&sample.to_le_bytes());
        }
        let mut record = ArchiveRecord::new(
            RecordType::AUDIO_CHUNK,
            new_uuid(),
            [("first_sample_index", first_sample_index.to_string())],
        );
        record.blob = blob;
        record
    }

    #[test]
    fn decodes_every_supported_pcm_width_and_clamps() {
        assert_eq!(decode_sample(&[0x80], "pcm_u8"), 0);
        assert_eq!(
            decode_sample(&(-32_768i16).to_le_bytes(), "pcm_s16le"),
            -32_768
        );
        assert_eq!(decode_sample(&[0x00, 0x00, 0x80], "pcm_s24le"), -32_768);
        assert_eq!(decode_sample(&i32::MIN.to_le_bytes(), "pcm_s32le"), -32_768);
        assert_eq!(decode_sample(&f32::INFINITY.to_le_bytes(), "pcm_f32le"), 0);
        assert_eq!(decode_sample(&[0], "unknown"), 0);
    }

    #[test]
    fn reads_across_chunk_boundaries_and_respects_gaps() {
        let mut source = Source::new(
            8_000,
            1,
            "pcm_s16le".to_owned(),
            2,
            4,
            vec![(2, 3)],
            vec![chunk(0, &[1, 2]), chunk(3, &[4])],
        );
        assert_eq!(source.sample_at(0), Some(vec![1]));
        assert_eq!(source.sample_at(1), Some(vec![2]));
        assert_eq!(source.sample_at(2), None);
        assert_eq!(source.sample_at(3), Some(vec![4]));
        assert_eq!(source.sample_at(4), None);
    }
}
