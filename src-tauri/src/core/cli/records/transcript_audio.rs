use super::*;

#[derive(Clone)]
struct ChunkInfo {
    id: String,
    first_frame: u64,
    frame_count: u64,
}

pub(crate) struct TrackLayout {
    pub(crate) sample_rate: u32,
    pub(crate) channels: u32,
    pub(crate) format: String,
    pub(crate) frames: u64,
    width: usize,
    chunks: Vec<ChunkInfo>,
}

fn timeline_error() -> String {
    "This recording has inconsistent chunk order or timeline metadata.".to_owned()
}

fn metadata_error() -> String {
    "Recording audio metadata is invalid.".to_owned()
}

pub(crate) fn read_error() -> String {
    "A recording chunk disappeared while transcribing.".to_owned()
}

pub(crate) fn field_u64(record: &ArchiveRecord, name: &str) -> Option<u64> {
    record
        .field(name)
        .and_then(|value| value.parse::<u64>().ok())
}

pub(crate) fn field_i64(record: &ArchiveRecord, name: &str) -> Option<i64> {
    record
        .field(name)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 0)
}

pub(crate) fn frame_to_us(frames: u64, rate: u32) -> i64 {
    if rate == 0 {
        return 0;
    }
    (frames.saturating_mul(1_000_000) / u64::from(rate)) as i64
}

fn sample_width(format: &str) -> Option<usize> {
    match format {
        "pcm_u8" => Some(1),
        "pcm_s16le" => Some(2),
        "pcm_s24le" => Some(3),
        "pcm_s32le" | "pcm_f32le" => Some(4),
        _ => None,
    }
}

pub(crate) fn track_chunk_keys(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    track_id: &str,
) -> Vec<String> {
    let prefix = format!(
        "AUDIOSESSION:{}:{}:",
        session_id.to_lowercase(),
        track_id.to_lowercase()
    );
    let mut keys: Vec<String> = snapshot
        .all_index_entries()
        .keys()
        .filter(|key| key.starts_with(&prefix))
        .cloned()
        .collect();
    keys.sort();
    keys
}

pub(crate) fn session_track_ids(
    snapshot: &ArchiveSnapshot,
    session: &ArchiveRecord,
) -> Vec<String> {
    let mut tracks: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        let id = value.trim().to_lowercase();
        if crate::core::format::valid_uuid(&id) && !tracks.contains(&id) {
            tracks.push(id);
        }
    };
    for field in [
        "recording_track_ids",
        "recording_track_id",
        "audio_import_track_id",
    ] {
        for id in session.field(field).unwrap_or("").split(',') {
            push(id);
        }
    }
    if let Ok(records) = snapshot.list_record_metadata(RecordType::ASSET_METADATA, false) {
        for record in records {
            if record.field("record_role") == Some("audio-track")
                && record.field("session_id").map(str::to_lowercase)
                    == Some(session.id.to_lowercase())
            {
                push(record.field("track_id").unwrap_or(&record.id));
            }
        }
    }
    for key in snapshot.all_index_entries().keys() {
        let parts: Vec<&str> = key.split(':').collect();
        if parts.len() == 4
            && parts[0] == "AUDIOSESSION"
            && parts[1].eq_ignore_ascii_case(&session.id)
        {
            push(parts[2]);
        }
    }
    tracks
}

impl TrackLayout {
    pub(crate) fn load(
        snapshot: &ArchiveSnapshot,
        session_id: &str,
        track_id: &str,
    ) -> std::result::Result<Self, String> {
        let session_id = session_id.to_lowercase();
        let track_id = track_id.to_lowercase();
        let keys = track_chunk_keys(snapshot, &session_id, &track_id);
        let mut layout = TrackLayout {
            sample_rate: 0,
            channels: 0,
            format: String::new(),
            frames: 0,
            width: 0,
            chunks: Vec::new(),
        };
        if keys.is_empty() {
            let records = snapshot
                .list_audio_chunk_metadata(&session_id, &track_id, false)
                .map_err(|error| error.message)?;
            if records.is_empty() {
                return Err("The session has no recorded audio track.".to_owned());
            }
            for record in &records {
                layout.push_record(record)?;
            }
        } else {
            for key in keys {
                let record = snapshot
                    .get_record_by_index_key(&key)
                    .map_err(|error| error.message)?
                    .ok_or_else(timeline_error)?;
                if record.record_type != RecordType::AUDIO_CHUNK
                    || record.field("session_id").map(str::to_lowercase) != Some(session_id.clone())
                    || record.field("track_id").map(str::to_lowercase) != Some(track_id.clone())
                {
                    return Err(timeline_error());
                }
                layout.push_record(&record)?;
            }
        }
        if layout.chunks.is_empty() || layout.frames == 0 {
            return Err("The session has no recorded audio track.".to_owned());
        }
        Ok(layout)
    }

    fn push_record(&mut self, record: &ArchiveRecord) -> std::result::Result<(), String> {
        let sequence = field_u64(record, "sequence_number").ok_or_else(metadata_error)?;
        if sequence != self.chunks.len() as u64 {
            return Err(timeline_error());
        }
        let first = field_u64(record, "first_sample_index").ok_or_else(metadata_error)?;
        let count = field_u64(record, "sample_count").ok_or_else(metadata_error)?;
        if count == 0 {
            return Err(metadata_error());
        }
        let gap = field_u64(record, "gap_before_samples").unwrap_or(0);
        let rate = field_u64(record, "sample_rate_hz").ok_or_else(metadata_error)?;
        let channels = field_u64(record, "channel_count").ok_or_else(metadata_error)?;
        if !(8_000..=384_000).contains(&rate) || !(1..=8).contains(&channels) {
            return Err(metadata_error());
        }
        let format = record
            .field("sample_format")
            .unwrap_or("pcm_s16le")
            .to_owned();
        let width = sample_width(&format).ok_or_else(metadata_error)?;
        if self.chunks.is_empty() {
            self.sample_rate = u32::try_from(rate).map_err(|_| metadata_error())?;
            self.channels = u32::try_from(channels).map_err(|_| metadata_error())?;
            self.width = width;
            self.format = format;
            if first != gap {
                return Err(timeline_error());
            }
        } else if rate != u64::from(self.sample_rate)
            || channels != u64::from(self.channels)
            || format != self.format
        {
            return Err(timeline_error());
        }
        let expected_first = self.frames.checked_add(gap).ok_or_else(timeline_error)?;
        if !self.chunks.is_empty() && first != expected_first {
            return Err(timeline_error());
        }
        let frame_bytes = count
            .checked_mul(channels)
            .and_then(|value| value.checked_mul(width as u64))
            .ok_or_else(timeline_error)?;
        if record.blob.len() as u64 != frame_bytes {
            return Err("A recording chunk has an invalid byte length.".to_owned());
        }
        self.frames = first.checked_add(count).ok_or_else(timeline_error)?;
        self.chunks.push(ChunkInfo {
            id: record.id.clone(),
            first_frame: first,
            frame_count: count,
        });
        Ok(())
    }

    pub(crate) fn window_wav(
        &self,
        start: u64,
        end: u64,
        read: &mut dyn FnMut(&str) -> std::result::Result<Vec<u8>, String>,
    ) -> std::result::Result<Vec<u8>, String> {
        if end <= start {
            return Err("The selected recording range is empty.".to_owned());
        }
        let frame_count = usize::try_from(end - start).map_err(|_| metadata_error())?;
        let mut pcm = vec![0i16; frame_count];
        let channel_count = self.channels as usize;
        let frame_bytes = channel_count * self.width;
        for chunk in &self.chunks {
            let chunk_end = chunk
                .first_frame
                .checked_add(chunk.frame_count)
                .ok_or_else(timeline_error)?;
            if chunk_end <= start {
                continue;
            }
            if chunk.first_frame >= end {
                break;
            }
            let from = chunk.first_frame.max(start);
            let to = chunk_end.min(end);
            let blob = read(&chunk.id)?;
            let expected = chunk
                .frame_count
                .checked_mul(frame_bytes as u64)
                .ok_or_else(timeline_error)?;
            if blob.len() as u64 != expected {
                return Err("A recording chunk has an invalid byte length.".to_owned());
            }
            for frame in from..to {
                let source = (frame - chunk.first_frame) as usize * frame_bytes;
                let mut sum = 0.0f64;
                for channel in 0..channel_count {
                    sum += decode_sample(&blob[source + channel * self.width..], &self.format)?;
                }
                let value = sum / channel_count as f64;
                pcm[(frame - start) as usize] = (value.clamp(-1.0, 1.0) * 32_768.0).round() as i16;
            }
        }
        Ok(wav_bytes(self.sample_rate, &pcm))
    }
}

#[cfg(test)]
pub(crate) fn test_mono_layout(samples: &[i16], rate: u32) -> (TrackLayout, ArchiveRecord) {
    let mut bytes = Vec::new();
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let mut record = ArchiveRecord::new(
        RecordType::AUDIO_CHUNK,
        "00000000-0000-0000-0000-000000000010",
        [
            ("session_id", "00000000-0000-0000-0000-000000000001".to_owned()),
            ("track_id", "00000000-0000-0000-0000-000000000002".to_owned()),
            ("sequence_number", "0".to_owned()),
            ("first_sample_index", "0".to_owned()),
            ("sample_count", samples.len().to_string()),
            ("gap_before_samples", "0".to_owned()),
            ("sample_rate_hz", rate.to_string()),
            ("channel_count", "1".to_owned()),
            ("sample_format", "pcm_s16le".to_owned()),
        ],
    );
    record.blob = bytes;
    let mut layout = TrackLayout {
        sample_rate: rate,
        channels: 1,
        format: "pcm_s16le".to_owned(),
        frames: 0,
        width: 2,
        chunks: Vec::new(),
    };
    layout.push_record(&record).expect("test layout");
    (layout, record)
}

fn decode_sample(sample: &[u8], format: &str) -> std::result::Result<f64, String> {
    match format {
        "pcm_u8" => Ok((f64::from(sample[0]) - 128.0) / 128.0),
        "pcm_s16le" => Ok(f64::from(i16::from_le_bytes([sample[0], sample[1]])) / 32_768.0),
        "pcm_s24le" => {
            let raw =
                i32::from(sample[0]) | (i32::from(sample[1]) << 8) | (i32::from(sample[2]) << 16);
            Ok(f64::from((raw << 8) >> 8) / 8_388_608.0)
        }
        "pcm_s32le" => Ok(f64::from(i32::from_le_bytes([
            sample[0], sample[1], sample[2], sample[3],
        ])) / 2_147_483_648.0),
        "pcm_f32le" => {
            let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
            Ok(if value.is_finite() {
                f64::from(value.clamp(-1.0, 1.0))
            } else {
                0.0
            })
        }
        _ => Err(metadata_error()),
    }
}

fn wav_bytes(sample_rate: u32, pcm: &[i16]) -> Vec<u8> {
    let data_len = pcm.len() * 2;
    let mut output = Vec::with_capacity(44 + data_len);
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&sample_rate.to_le_bytes());
    output.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    output.extend_from_slice(&2u16.to_le_bytes());
    output.extend_from_slice(&16u16.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in pcm {
        output.extend_from_slice(&sample.to_le_bytes());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, sequence: u64, first: u64, gap: u64, samples: &[i16]) -> ArchiveRecord {
        let mut bytes = Vec::new();
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let mut record = ArchiveRecord::new(
            RecordType::AUDIO_CHUNK,
            id,
            [
                ("session_id", "00000000-0000-0000-0000-000000000001".to_owned()),
                ("track_id", "00000000-0000-0000-0000-000000000002".to_owned()),
                ("sequence_number", sequence.to_string()),
                ("first_sample_index", first.to_string()),
                ("sample_count", samples.len().to_string()),
                ("gap_before_samples", gap.to_string()),
                ("sample_rate_hz", "8000".to_owned()),
                ("channel_count", "1".to_owned()),
                ("sample_format", "pcm_s16le".to_owned()),
            ],
        );
        record.blob = bytes;
        record
    }

    fn layout_for(record: &ArchiveRecord) -> TrackLayout {
        let mut layout = TrackLayout {
            sample_rate: 8_000,
            channels: 1,
            format: "pcm_s16le".to_owned(),
            frames: 0,
            width: 2,
            chunks: Vec::new(),
        };
        layout.push_record(record).expect("valid chunk");
        layout
    }

    #[test]
    fn window_wav_keeps_gaps_silent_and_respects_actual_rate() {
        let first = chunk("0", 0, 0, 0, &[1000, 1000]);
        let second = chunk("1", 1, 5, 3, &[2000, 2000]);
        let mut layout = layout_for(&first);
        layout.push_record(&second).expect("contiguous gap");
        let mut read = |id: &str| -> std::result::Result<Vec<u8>, String> {
            match id {
                "0" => Ok(first.blob.clone()),
                "1" => Ok(second.blob.clone()),
                _ => Err(read_error()),
            }
        };
        let wav = layout.window_wav(0, 7, &mut read).expect("window wav");
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            8_000
        );
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 14);
        let samples: Vec<i16> = wav[44..]
            .chunks_exact(2)
            .map(|value| i16::from_le_bytes([value[0], value[1]]))
            .collect();
        assert_eq!(samples, vec![1000, 1000, 0, 0, 0, 2000, 2000]);
    }

    #[test]
    fn rejects_non_contiguous_chunks() {
        let first = chunk("0", 0, 0, 0, &[1]);
        let second = chunk("1", 1, 3, 1, &[2]);
        let mut layout = layout_for(&first);
        assert!(layout.push_record(&second).is_err());
    }
}
