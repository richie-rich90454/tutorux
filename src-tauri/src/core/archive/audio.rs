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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::archive::{create_archive_bytes, new_uuid};

    fn chunk(session: &str, track: &str, sequence: u64, deleted: bool) -> ArchiveRecord {
        let mut fields = vec![
            ("session_id".to_owned(), session.to_owned()),
            ("track_id".to_owned(), track.to_owned()),
            ("sequence_number".to_owned(), sequence.to_string()),
        ];
        if deleted {
            fields.push(("_deleted".to_owned(), "true".to_owned()));
        }
        ArchiveRecord::new(RecordType::AUDIO_CHUNK, new_uuid(), fields)
    }

    #[test]
    fn lists_only_the_requested_track_in_sequence_order() {
        let session = new_uuid();
        let track_a = new_uuid();
        let track_b = new_uuid();
        let snapshot =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Audio", "", 1).unwrap()).unwrap();
        let snapshot = snapshot
            .append_records(&[
                chunk(&session, &track_a, 1, false),
                chunk(&session, &track_b, 0, false),
                chunk(&session, &track_a, 0, false),
                chunk(&session, &track_a, 2, true),
            ])
            .unwrap();
        let chunks = snapshot
            .list_audio_chunk_metadata(&session, &track_a, false)
            .unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].field("sequence_number"), Some("0"));
        assert_eq!(chunks[1].field("sequence_number"), Some("1"));
        let with_deleted = snapshot
            .list_audio_chunk_metadata(&session, &track_a, true)
            .unwrap();
        assert_eq!(with_deleted.len(), 3);
    }

    #[test]
    fn rejects_invalid_chunk_identity() {
        let snapshot =
            ArchiveSnapshot::open_bytes(create_archive_bytes("Audio", "", 1).unwrap()).unwrap();
        let error = snapshot
            .list_audio_chunk_metadata("not-a-uuid", "also-not-a-uuid", false)
            .unwrap_err();
        assert_eq!(error.code, "audio_chunk_identity_invalid");
    }
}
