use std::time::Duration;

use serde_json::{json, Value};

use crate::core::archive::{new_uuid, now_us, ArchiveSnapshot};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::platform::synchronized_audio::headless::HeadlessChunk;

use super::{samples_to_microseconds, track_index, track_label, CaptureConfig};

pub(super) struct CaptureWriter {
    session: ArchiveRecord,
    take: ArchiveRecord,
    tracks: [Option<ArchiveRecord>; 3],
    samples: [u64; 3],
    timeline: [u64; 3],
}

impl CaptureWriter {
    pub(super) fn begin(
        snapshot: &ArchiveSnapshot,
        config: &CaptureConfig,
        started: &crate::platform::synchronized_audio::headless::HeadlessCaptureStarted,
    ) -> Result<(Self, ArchiveSnapshot), String> {
        let mut session = snapshot
            .get_record(RecordType::SESSION, &config.session_id)
            .map_err(|error| error.message)?
            .ok_or_else(|| "Session was not found.".to_owned())?;
        let timestamp = started.started_at_us.to_string();
        let active = ["microphone", "system-audio", "application-audio"];
        let mut tracks: [Option<ArchiveRecord>; 3] = [None, None, None];
        let mut track_ids = Vec::new();
        for (index, source) in active.iter().enumerate() {
            let track_id = &config.track_ids[index];
            let (rate, channels, format) = match index {
                0 => (
                    started.microphone_sample_rate_hz,
                    started.microphone_channel_count,
                    &started.microphone_sample_format,
                ),
                1 => (
                    started.system_audio_sample_rate_hz,
                    started.system_audio_channel_count,
                    &started.system_audio_sample_format,
                ),
                _ => (
                    started.application_audio_sample_rate_hz,
                    started.application_audio_channel_count,
                    &started.application_audio_sample_format,
                ),
            };
            if rate == 0 {
                continue;
            }
            let mut record = ArchiveRecord::new(
                RecordType::ASSET_METADATA,
                track_id.clone(),
                [
                    ("record_role", "audio-track".to_owned()),
                    ("session_id", config.session_id.clone()),
                    ("track_id", track_id.clone()),
                    ("recording_take_id", config.take_id.clone()),
                    ("label", track_label(source).to_owned()),
                    ("source", (*source).to_owned()),
                    ("capture_source_backend", started.backend.clone()),
                    ("capture_consent_at_us", config.consent_at_us.to_string()),
                    ("capture_consent_policy", "1".to_owned()),
                    ("consent_confirmed_by", config.confirmed_by.clone()),
                    ("state", "recording".to_owned()),
                    ("sample_format", format.clone()),
                    ("sample_rate_hz", rate.to_string()),
                    ("channel_count", channels.to_string()),
                    ("channel_mask", "0".to_owned()),
                    ("sample_count", "0".to_owned()),
                    ("timeline_sample_count", "0".to_owned()),
                    ("duration_us", "0".to_owned()),
                    ("chunk_count", "0".to_owned()),
                    ("byte_count", "0".to_owned()),
                    ("capture_pause_count", "0".to_owned()),
                    ("capture_paused_duration_us", "0".to_owned()),
                    ("durability", config.durability.clone()),
                    ("started_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp.clone()),
                ],
            );
            let device_id = match index {
                0 => config.microphone_device_id.clone(),
                1 => config.system_device_id.clone(),
                _ => config.application_device_id.clone(),
            };
            if let Some(device_id) = device_id {
                record
                    .fields
                    .insert("source_device_id".to_owned(), device_id);
            }
            if index == 2 {
                if let Some(name) = &started.application_audio_name {
                    record
                        .fields
                        .insert("application_name".to_owned(), name.clone());
                }
                if let Some(process_id) = started.application_audio_process_id {
                    record
                        .fields
                        .insert("application_process_id".to_owned(), process_id.to_string());
                }
            }
            track_ids.push(track_id.clone());
            tracks[index] = Some(record);
        }
        if track_ids.is_empty() {
            return Err("No native audio source started recording.".to_owned());
        }
        let mut blob_records = Vec::new();
        let empty_hash = hex::encode(crate::core::archive::sha256(&[]));
        for record in tracks.iter_mut().flatten() {
            let blob_id = new_uuid();
            blob_records.push(empty_asset_blob(&blob_id, &empty_hash, &timestamp));
            record.fields.insert("blob_id".to_owned(), blob_id);
        }
        let take_blob_id = new_uuid();
        blob_records.push(empty_asset_blob(&take_blob_id, &empty_hash, &timestamp));
        let take = ArchiveRecord::new(
            RecordType::ASSET_METADATA,
            &config.take_id,
            [
                ("record_role", "recording-take".to_owned()),
                ("blob_id", take_blob_id),
                ("session_id", config.session_id.clone()),
                (
                    "label",
                    if track_ids.len() == 2 {
                        "Synchronized recording"
                    } else {
                        "Audio recording"
                    }
                    .to_owned(),
                ),
                (
                    "source",
                    if track_ids.len() == 2 {
                        "microphone+system-audio"
                    } else {
                        "microphone"
                    }
                    .to_owned(),
                ),
                ("capture_source_backend", started.backend.clone()),
                ("capture_consent_at_us", config.consent_at_us.to_string()),
                ("capture_consent_policy", "1".to_owned()),
                ("consent_confirmed_by", config.confirmed_by.clone()),
                ("state", "recording".to_owned()),
                ("track_ids", track_ids.join(",")),
                ("started_at_us", timestamp.clone()),
                ("ended_at_us", String::new()),
                ("duration_us", "0".to_owned()),
                ("capture_pause_count", "0".to_owned()),
                ("capture_paused_duration_us", "0".to_owned()),
                ("durability", config.durability.clone()),
                ("created_at_us", timestamp.clone()),
                ("updated_at_us", timestamp.clone()),
            ],
        );
        let existing: Vec<String> = session
            .field("recording_track_ids")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        let mut linked = existing;
        for id in &track_ids {
            if !linked.contains(id) {
                linked.push(id.clone());
            }
        }
        session
            .fields
            .insert("recording_track_ids".to_owned(), linked.join(","));
        session
            .fields
            .insert("recording_track_count".to_owned(), linked.len().to_string());
        session
            .fields
            .entry("recording_track_id".to_owned())
            .or_insert_with(|| track_ids[0].clone());
        session
            .fields
            .insert("recording_source".to_owned(), "native".to_owned());
        session.fields.insert(
            "recording_source_backend".to_owned(),
            started.backend.clone(),
        );
        session.fields.insert(
            "recording_sample_format".to_owned(),
            started.microphone_sample_format.clone(),
        );
        session.fields.insert(
            "recording_sample_rate_hz".to_owned(),
            started.microphone_sample_rate_hz.to_string(),
        );
        session.fields.insert(
            "recording_channel_count".to_owned(),
            started.microphone_channel_count.to_string(),
        );
        session
            .fields
            .insert("recording_started_at_us".to_owned(), timestamp.clone());
        session.fields.insert(
            "recording_consent_at_us".to_owned(),
            config.consent_at_us.to_string(),
        );
        session
            .fields
            .insert("recording_consent_policy".to_owned(), "1".to_owned());
        session.fields.insert(
            "recording_consent_confirmed_by".to_owned(),
            config.confirmed_by.clone(),
        );
        session
            .fields
            .insert("recording_durability".to_owned(), config.durability.clone());
        session.fields.insert(
            "recording_track_mode".to_owned(),
            if track_ids.len() == 2 {
                "synchronized-separate"
            } else {
                "single-source"
            }
            .to_owned(),
        );
        session
            .fields
            .insert("recording_state".to_owned(), "recording".to_owned());
        session
            .fields
            .insert("recording_error".to_owned(), String::new());
        session.fields.insert("updated_at_us".to_owned(), timestamp);

        let mut records: Vec<ArchiveRecord> = tracks.iter().flatten().cloned().collect();
        records.extend(blob_records);
        records.push(take.clone());
        records.push(session.clone());
        let next = snapshot
            .append_records(&records)
            .map_err(|error| error.message)?;
        Ok((
            Self {
                session,
                take,
                tracks,
                samples: [0; 3],
                timeline: [0; 3],
            },
            next,
        ))
    }

    pub(super) fn write_chunks(
        &mut self,
        snapshot: &ArchiveSnapshot,
        pending: &mut Vec<HeadlessChunk>,
    ) -> Result<ArchiveSnapshot, String> {
        let mut records = Vec::new();
        for chunk in pending.drain(..) {
            let index = track_index(chunk.track);
            let track = &mut self.tracks[index];
            let Some(track) = track else { continue };
            let rate = chunk.sample_rate_hz;
            let frames = chunk.frame_count;
            self.samples[index] = self.samples[index].saturating_add(frames);
            self.timeline[index] = self.timeline[index]
                .saturating_add(chunk.gap_before_samples)
                .saturating_add(frames);
            let mut chunk_record = ArchiveRecord::new(
                RecordType::AUDIO_CHUNK,
                new_uuid(),
                [
                    ("session_id", self.session.id.clone()),
                    ("track_id", track.id.clone()),
                    ("sequence_number", chunk.sequence.to_string()),
                    ("first_sample_index", chunk.first_sample_index.to_string()),
                    ("sample_count", frames.to_string()),
                    ("gap_before_samples", chunk.gap_before_samples.to_string()),
                    (
                        "timeline_start_us",
                        samples_to_microseconds(chunk.first_sample_index, rate).to_string(),
                    ),
                    (
                        "timeline_end_us",
                        samples_to_microseconds(
                            chunk.first_sample_index.saturating_add(frames),
                            rate,
                        )
                        .to_string(),
                    ),
                    ("sample_format", chunk.sample_format.to_owned()),
                    ("sample_rate_hz", rate.to_string()),
                    ("channel_count", chunk.channel_count.to_string()),
                    ("channel_mask", "0".to_owned()),
                    ("codec", "none".to_owned()),
                    ("source", chunk.track.to_owned()),
                    (
                        "contains_device_discontinuity",
                        chunk.contains_device_discontinuity.to_string(),
                    ),
                    (
                        "payload_checksum",
                        crate::core::format::crc32(&chunk.pcm).to_string(),
                    ),
                    ("created_at_us", now_us().to_string()),
                ],
            );
            chunk_record.blob = chunk.pcm;
            track
                .fields
                .insert("sample_count".to_owned(), self.samples[index].to_string());
            track.fields.insert(
                "timeline_sample_count".to_owned(),
                self.timeline[index].to_string(),
            );
            track.fields.insert(
                "duration_us".to_owned(),
                samples_to_microseconds(self.timeline[index], rate).to_string(),
            );
            track
                .fields
                .insert("chunk_count".to_owned(), (chunk.sequence + 1).to_string());
            track.fields.insert(
                "byte_count".to_owned(),
                (chunk_record.blob.len() as u64
                    + track
                        .field("byte_count")
                        .unwrap_or("0")
                        .parse::<u64>()
                        .unwrap_or(0))
                .to_string(),
            );
            track
                .fields
                .insert("updated_at_us".to_owned(), now_us().to_string());
            records.push(chunk_record);
        }
        if records.is_empty() {
            return Ok(snapshot.clone());
        }
        let mut counters = self.session.clone();
        counters.fields.insert(
            "recording_audio_chunks".to_owned(),
            (records.len() as u64
                + counters
                    .field("recording_audio_chunks")
                    .unwrap_or("0")
                    .parse::<u64>()
                    .unwrap_or(0))
            .to_string(),
        );
        counters.fields.insert(
            "recording_bytes".to_owned(),
            (records
                .iter()
                .map(|record| record.blob.len() as u64)
                .sum::<u64>()
                + counters
                    .field("recording_bytes")
                    .unwrap_or("0")
                    .parse::<u64>()
                    .unwrap_or(0))
            .to_string(),
        );
        counters
            .fields
            .insert("recording_state".to_owned(), "recording".to_owned());
        counters
            .fields
            .insert("updated_at_us".to_owned(), now_us().to_string());
        for track in self.tracks.iter().flatten() {
            records.push(track.clone());
        }
        records.push(counters.clone());
        let next = snapshot
            .append_records(&records)
            .map_err(|error| error.message)?;
        self.session = counters;
        Ok(next)
    }

    pub(super) fn merge_session(&mut self, session: &ArchiveRecord) {
        for field in [
            "processing_state",
            "processing_detail",
            "processing_updated_at_us",
        ] {
            if let Some(value) = session.field(field) {
                self.session
                    .fields
                    .insert(field.to_owned(), value.to_owned());
            }
        }
    }

    pub(super) fn finish(
        &mut self,
        snapshot: &ArchiveSnapshot,
        finished: &crate::platform::synchronized_audio::headless::HeadlessFinished,
        pause_count: u64,
        paused: Duration,
    ) -> Result<ArchiveSnapshot, String> {
        let timestamp = now_us().to_string();
        let summaries = [
            &finished.microphone,
            &finished.system_audio,
            &finished.application_audio,
        ];
        let mut failures = Vec::new();
        let mut records = Vec::new();
        for (index, track) in self.tracks.iter_mut().enumerate() {
            let Some(track) = track else { continue };
            let summary = summaries[index];
            let failure = summary.failure.clone().unwrap_or_default();
            if !failure.is_empty() {
                failures.push(format!(
                    "{}: {failure}",
                    track.field("source").unwrap_or("audio")
                ));
            }
            track.fields.insert(
                "state".to_owned(),
                if failure.is_empty() {
                    "completed"
                } else {
                    "interrupted"
                }
                .to_owned(),
            );
            track
                .fields
                .insert("capture_pause_count".to_owned(), pause_count.to_string());
            track.fields.insert(
                "capture_paused_duration_us".to_owned(),
                paused.as_micros().to_string(),
            );
            track
                .fields
                .insert("ended_at_us".to_owned(), timestamp.clone());
            track.fields.insert("recovery_error".to_owned(), failure);
            track
                .fields
                .insert("updated_at_us".to_owned(), timestamp.clone());
            records.push(track.clone());
        }
        let duration = self
            .tracks
            .iter()
            .flatten()
            .filter_map(|track| {
                track
                    .field("duration_us")
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .max()
            .unwrap_or(0);
        let partial = !failures.is_empty();
        self.take.fields.insert(
            "state".to_owned(),
            if partial { "partial" } else { "completed" }.to_owned(),
        );
        self.take
            .fields
            .insert("capture_pause_count".to_owned(), pause_count.to_string());
        self.take.fields.insert(
            "capture_paused_duration_us".to_owned(),
            paused.as_micros().to_string(),
        );
        self.take
            .fields
            .insert("ended_at_us".to_owned(), timestamp.clone());
        self.take
            .fields
            .insert("duration_us".to_owned(), duration.to_string());
        self.take
            .fields
            .insert("recovery_error".to_owned(), failures.join("\n"));
        self.take
            .fields
            .insert("updated_at_us".to_owned(), timestamp.clone());
        self.session.fields.insert(
            "recording_state".to_owned(),
            if partial { "partial" } else { "completed" }.to_owned(),
        );
        self.session
            .fields
            .insert("recording_ended_at_us".to_owned(), timestamp.clone());
        self.session
            .fields
            .insert("recording_error".to_owned(), failures.join("\n"));
        self.session.fields.insert(
            "recording_capture_pause_count".to_owned(),
            pause_count.to_string(),
        );
        self.session.fields.insert(
            "recording_capture_paused_duration_us".to_owned(),
            paused.as_micros().to_string(),
        );
        self.session
            .fields
            .insert("recording_duration_us".to_owned(), duration.to_string());
        self.session
            .fields
            .insert("updated_at_us".to_owned(), timestamp);
        records.push(self.take.clone());
        records.push(self.session.clone());
        snapshot
            .append_records(&records)
            .map_err(|error| error.message)
    }

    pub(super) fn report(
        &self,
        config: &CaptureConfig,
        finished: &crate::platform::synchronized_audio::headless::HeadlessFinished,
    ) -> Value {
        let summaries = [
            &finished.microphone,
            &finished.system_audio,
            &finished.application_audio,
        ];
        let tracks: Vec<Value> = self
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(index, track)| {
                let track = track.as_ref()?;
                let summary = summaries[index];
                Some(json!({
                    "source": track.field("source").unwrap_or("microphone"),
                    "trackId": track.id,
                    "deviceId": track.field("source_device_id").unwrap_or(""),
                    "deviceName": config.device_names[index],
                    "sampleFormat": summary.sample_format,
                    "sampleRateHz": summary.sample_rate_hz,
                    "channelCount": summary.channel_count,
                    "sampleCount": summary.sample_count.to_string(),
                    "chunkCount": summary.chunk_count,
                    "byteCount": summary.byte_count,
                    "durationUs": samples_to_microseconds(summary.sample_count, summary.sample_rate_hz).to_string(),
                    "state": if summary.failure.is_some() { "interrupted" } else { "completed" },
                    "error": summary.failure.clone().unwrap_or_default(),
                }))
            })
            .collect();
        let state = if tracks.iter().any(|track| {
            track["error"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        }) {
            "interrupted"
        } else if tracks
            .iter()
            .any(|track| track["sampleCount"].as_str() != Some("0"))
        {
            "completed"
        } else {
            "failed"
        };
        let duration = tracks
            .iter()
            .filter_map(|track| track["durationUs"].as_str()?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        let sample_count: u64 = summaries.iter().map(|summary| summary.sample_count).sum();
        let chunk_count: u64 = summaries.iter().map(|summary| summary.chunk_count).sum();
        let byte_count: u64 = summaries.iter().map(|summary| summary.byte_count).sum();
        let first = tracks.first().cloned().unwrap_or_else(|| json!({}));
        if tracks.len() == 1 {
            let failure = summaries
                .iter()
                .find(|summary| summary.sample_rate_hz > 0)
                .and_then(|summary| summary.failure.clone())
                .unwrap_or_default();
            json!({
                "sessionId": config.session_id,
                "source": first["source"],
                "trackId": first["trackId"],
                "takeId": config.take_id,
                "deviceId": first["deviceId"],
                "deviceName": first["deviceName"],
                "inputBackend": "native",
                "sampleFormat": first["sampleFormat"],
                "sampleRateHz": first["sampleRateHz"],
                "channelCount": first["channelCount"],
                "sampleCount": sample_count.to_string(),
                "chunkCount": chunk_count,
                "byteCount": byte_count,
                "durationUs": duration.to_string(),
                "state": state,
                "liveTranscriptSegmentCount": 0,
                "liveSpeakerTurnBoundaryCount": 0,
                "liveTranscriptionError": "",
                "error": failure,
            })
        } else {
            json!({
                "sessionId": config.session_id,
                "source": "both",
                "trackMode": "synchronized-separate",
                "tracks": tracks,
                "durationUs": duration.to_string(),
                "sampleCount": sample_count.to_string(),
                "chunkCount": chunk_count,
                "byteCount": byte_count,
                "state": state,
                "error": "",
                "inputBackend": "native",
            })
        }
    }
}

fn empty_asset_blob(id: &str, content_hash: &str, timestamp: &str) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::ASSET_BLOB,
        id,
        [
            ("record_role", "asset-blob-manifest".to_owned()),
            ("byte_size", "0".to_owned()),
            ("content_hash", content_hash.to_owned()),
            ("chunk_count", "0".to_owned()),
            ("chunk_ids", String::new()),
            ("created_at_us", timestamp.to_owned()),
            ("updated_at_us", timestamp.to_owned()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::{CaptureConfig, CaptureWriter};
    use crate::core::archive::{create_archive_bytes, new_uuid, ArchiveSnapshot};
    use crate::core::format::{crc32, ArchiveRecord, RecordType};
    use crate::core::source::FileSource;
    use crate::platform::synchronized_audio::headless::{
        HeadlessCaptureStarted, HeadlessChunk, HeadlessFinished, HeadlessTrackSummary,
    };
    use std::{sync::Arc, time::Duration};

    const RATE_HZ: u32 = 48_000;
    const FRAMES_PER_CHUNK: u64 = 480;

    fn started() -> HeadlessCaptureStarted {
        HeadlessCaptureStarted {
            capture_id: new_uuid(),
            started_at_us: 1_000_000,
            microphone_sample_rate_hz: RATE_HZ,
            microphone_channel_count: 1,
            microphone_sample_format: "f32".to_owned(),
            system_audio_sample_rate_hz: 0,
            system_audio_channel_count: 0,
            system_audio_sample_format: String::new(),
            application_audio_sample_rate_hz: 0,
            application_audio_channel_count: 0,
            application_audio_sample_format: String::new(),
            application_audio_device_id: None,
            application_audio_name: None,
            application_audio_process_id: None,
            application_audio_backend: None,
            backend: "test".to_owned(),
        }
    }

    fn chunk(sequence: u64, first_sample_index: u64, pcm: Vec<u8>) -> HeadlessChunk {
        HeadlessChunk {
            track: "microphone",
            sequence,
            first_sample_index,
            frame_count: (pcm.len() / 2) as u64,
            sample_rate_hz: RATE_HZ,
            channel_count: 1,
            sample_format: "f32",
            gap_before_samples: 0,
            contains_device_discontinuity: false,
            pcm,
        }
    }

    #[test]
    fn writes_two_chunks_and_finishes_a_verifiable_archive() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("capture.tux");
        let initial = create_archive_bytes("Recording", "", 1).expect("create archive");
        std::fs::write(&path, initial).expect("write archive");

        let session_id = new_uuid();
        let take_id = new_uuid();
        let track_ids = [new_uuid(), new_uuid(), new_uuid()];
        let snapshot = ArchiveSnapshot::open(Arc::new(
            FileSource::open(&path).expect("open archive source"),
        ))
        .expect("open archive");
        let snapshot = snapshot
            .append_records(&[ArchiveRecord::new(
                RecordType::SESSION,
                &session_id,
                [("display_name", "Lesson")],
            )])
            .expect("append session");

        let config = CaptureConfig {
            session_id: session_id.clone(),
            take_id: take_id.clone(),
            track_ids: track_ids.clone(),
            device_names: ["Microphone".to_owned(), String::new(), String::new()],
            microphone_device_id: Some("device-1".to_owned()),
            system_device_id: None,
            application_device_id: None,
            consent_at_us: 1_000,
            confirmed_by: "Tutor".to_owned(),
            duration_seconds: 0,
            durability: "durable".to_owned(),
            whisper: None,
        };
        let (mut writer, snapshot) =
            CaptureWriter::begin(&snapshot, &config, &started()).expect("begin capture");

        let first_pcm = vec![0x11u8; (FRAMES_PER_CHUNK * 2) as usize];
        let second_pcm = vec![0x22u8; (FRAMES_PER_CHUNK * 2) as usize];
        let mut pending = vec![chunk(0, 0, first_pcm.clone())];
        let snapshot = writer
            .write_chunks(&snapshot, &mut pending)
            .expect("write first chunk");
        let mut pending = vec![chunk(1, FRAMES_PER_CHUNK, second_pcm.clone())];
        let snapshot = writer
            .write_chunks(&snapshot, &mut pending)
            .expect("write second chunk");

        let chunks = snapshot
            .list_records(RecordType::AUDIO_CHUNK, true)
            .expect("list audio chunks");
        assert_eq!(chunks.len(), 2);
        let first = chunks
            .iter()
            .find(|record| record.field("sequence_number") == Some("0"))
            .expect("first chunk");
        assert_eq!(first.field("first_sample_index"), Some("0"));
        assert_eq!(first.field("sample_count"), Some("480"));
        assert_eq!(first.field("timeline_start_us"), Some("0"));
        assert_eq!(first.field("timeline_end_us"), Some("10000"));
        let first_checksum = crc32(&first_pcm).to_string();
        assert_eq!(
            first.field("payload_checksum"),
            Some(first_checksum.as_str())
        );
        let second = chunks
            .iter()
            .find(|record| record.field("sequence_number") == Some("1"))
            .expect("second chunk");
        assert_eq!(second.field("first_sample_index"), Some("480"));
        assert_eq!(second.field("timeline_start_us"), Some("10000"));
        assert_eq!(second.field("timeline_end_us"), Some("20000"));
        let second_checksum = crc32(&second_pcm).to_string();
        assert_eq!(
            second.field("payload_checksum"),
            Some(second_checksum.as_str())
        );

        let track = snapshot
            .get_record(RecordType::ASSET_METADATA, &track_ids[0])
            .expect("read track")
            .expect("track exists");
        assert_eq!(track.field("sample_count"), Some("960"));
        assert_eq!(track.field("timeline_sample_count"), Some("960"));
        assert_eq!(track.field("chunk_count"), Some("2"));
        assert_eq!(track.field("duration_us"), Some("20000"));

        let finished = HeadlessFinished {
            microphone: HeadlessTrackSummary {
                sample_rate_hz: RATE_HZ,
                channel_count: 1,
                sample_format: "f32".to_owned(),
                sample_count: FRAMES_PER_CHUNK * 2,
                byte_count: FRAMES_PER_CHUNK * 4,
                chunk_count: 2,
                discontinuity_count: 0,
                failure: None,
            },
            system_audio: HeadlessTrackSummary::default(),
            application_audio: HeadlessTrackSummary::default(),
        };
        let snapshot = writer
            .finish(&snapshot, &finished, 0, Duration::ZERO)
            .expect("finish capture");

        let take = snapshot
            .get_record(RecordType::ASSET_METADATA, &take_id)
            .expect("read take")
            .expect("take exists");
        assert_eq!(take.field("state"), Some("completed"));
        assert_eq!(take.field("duration_us"), Some("20000"));
        assert!(take
            .field("ended_at_us")
            .is_some_and(|value| !value.is_empty()));
        let session = snapshot
            .get_record(RecordType::SESSION, &session_id)
            .expect("read session")
            .expect("session exists");
        assert_eq!(session.field("recording_state"), Some("completed"));

        snapshot.verify().expect("recording verifies");
        let bytes = snapshot
            .source
            .read(0, snapshot.source.size() as usize)
            .expect("read archive bytes");
        let merged = directory.path().join("merged.tux");
        std::fs::write(&merged, &bytes).expect("write merged archive");
        let reopened =
            ArchiveSnapshot::open(Arc::new(FileSource::open(&merged).expect("reopen source")))
                .expect("reopen archive");
        reopened.verify().expect("merged recording verifies");
    }
}
