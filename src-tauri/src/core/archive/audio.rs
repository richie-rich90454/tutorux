use crate::core::error::{err, Result};
use crate::core::format::{ArchiveRecord, RecordType};
use crate::core::index::read_frame_at;

use super::support::valid_uuid;
use super::ArchiveSnapshot;

impl ArchiveSnapshot {
    pub fn list_audio_chunk_metadata(
        &self,
        session_id: &str,
        track_id: &str,
        include_deleted: bool,
    ) -> Result<Vec<ArchiveRecord>> {
        let session = session_id.to_lowercase();
        let track = track_id.to_lowercase();
        if !valid_uuid(&session) || !valid_uuid(&track) {
            return err(
                "audio_chunk_identity_invalid",
                "A recording needs a valid session and track identifier.",
            );
        }
        let session_prefix = format!("AUDIOSESSION:{session}:");
        let track_prefix = format!("{session_prefix}{track}:");
        let session_keys: Vec<&String> = self
            .index
            .keys()
            .filter(|key| key.starts_with(&session_prefix))
            .collect();
        let indexed_keys: Vec<&String> = if session_keys.is_empty() {
            self.index
                .keys()
                .filter(|key| key.starts_with("AUDIO:"))
                .collect()
        } else {
            session_keys
                .into_iter()
                .filter(|key| key.starts_with(&track_prefix))
                .collect()
        };
        let mut keys = indexed_keys;
        keys.sort();
        let mut chunks = Vec::new();
        for key in keys {
            let offset = self.index[key];
            let frame = read_frame_at(self.source.as_ref(), offset)?;
            let record = self.decode_frame_record(&frame)?;
            if record.record_type != RecordType::AUDIO_CHUNK {
                return err(
                    "audio_chunk_index_invalid",
                    "The recording index points to a non-audio record.",
                );
            }
            if record.field("session_id").map(str::to_lowercase).as_deref() != Some(&session)
                || record.field("track_id").map(str::to_lowercase).as_deref() != Some(&track)
            {
                if key.starts_with("AUDIOSESSION:") {
                    return err(
                        "audio_chunk_index_invalid",
                        "The recording index points to a different session or track.",
                    );
                }
                continue;
            }
            let sequence = record.field("sequence_number").unwrap_or("");
            if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
                return err(
                    "audio_chunk_metadata_invalid",
                    "A recording chunk has an invalid sequence number.",
                );
            }
            if key.starts_with("AUDIOSESSION:")
                && key != &format!("{track_prefix}{:020}", sequence.parse::<u64>().unwrap_or(0))
            {
                return err(
                    "audio_chunk_index_invalid",
                    "The recording index sequence does not match its chunk.",
                );
            }
            if include_deleted || !record.deleted() {
                chunks.push(record);
            }
        }
        chunks.sort_by(|left, right| {
            let left_sequence = left.field("sequence_number").unwrap_or("");
            let right_sequence = right.field("sequence_number").unwrap_or("");
            let left_value = left_sequence.parse::<u64>().unwrap_or(0);
            let right_value = right_sequence.parse::<u64>().unwrap_or(0);
            left_value
                .cmp(&right_value)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(chunks)
    }
}
