use crate::core::archive::{
    create_archive_bytes, new_uuid, ArchiveRecord, ArchiveSnapshot, RecordType,
};

use super::SanitizedCopyOptions;

macro_rules! fields {
    ($($key:expr => $value:expr),* $(,)?) => {
        vec![$(($key.to_string(), $value.to_string())),*]
    };
}

fn record(record_type: u16, id: &str, fields: Vec<(String, String)>) -> ArchiveRecord {
    ArchiveRecord::new(record_type, id, fields)
}

fn blob_record(
    record_type: u16,
    id: &str,
    fields: Vec<(String, String)>,
    blob: Vec<u8>,
) -> ArchiveRecord {
    let mut record = ArchiveRecord::new(record_type, id, fields);
    record.blob = blob;
    record
}

pub(crate) struct Ids {
    pub(crate) student_a: String,
    pub(crate) student_b: String,
    pub(crate) session_a: String,
    pub(crate) session_b: String,
    pub(crate) public_annotation: String,
    pub(crate) private_annotation: String,
    pub(crate) transcript: String,
    pub(crate) asset_a: String,
    pub(crate) asset_b: String,
    pub(crate) manifest_a: String,
    pub(crate) chunk_a: String,
    pub(crate) evidence_a: String,
    pub(crate) evidence_b: String,
    pub(crate) edge: String,
    pub(crate) guide: String,
    pub(crate) entry_a: String,
    pub(crate) notes_a: String,
    pub(crate) entry_b: String,
    pub(crate) notes_b: String,
    pub(crate) plain_settings: String,
    pub(crate) job: String,
    pub(crate) track_a: String,
    pub(crate) track_b: String,
    pub(crate) track_asset_a: String,
    pub(crate) track_asset_b: String,
    pub(crate) recording_take: String,
    pub(crate) audio_a: String,
    pub(crate) audio_b: String,
}

fn ids() -> Ids {
    Ids {
        student_a: new_uuid(),
        student_b: new_uuid(),
        session_a: new_uuid(),
        session_b: new_uuid(),
        public_annotation: new_uuid(),
        private_annotation: new_uuid(),
        transcript: new_uuid(),
        asset_a: new_uuid(),
        asset_b: new_uuid(),
        manifest_a: new_uuid(),
        chunk_a: new_uuid(),
        evidence_a: new_uuid(),
        evidence_b: new_uuid(),
        edge: new_uuid(),
        guide: new_uuid(),
        entry_a: new_uuid(),
        notes_a: new_uuid(),
        entry_b: new_uuid(),
        notes_b: new_uuid(),
        plain_settings: new_uuid(),
        job: new_uuid(),
        track_a: new_uuid(),
        track_b: new_uuid(),
        track_asset_a: new_uuid(),
        track_asset_b: new_uuid(),
        recording_take: new_uuid(),
        audio_a: new_uuid(),
        audio_b: new_uuid(),
    }
}

pub(crate) fn create_source() -> (ArchiveSnapshot, Ids) {
    let ids = ids();
    let snapshot =
        ArchiveSnapshot::open_bytes(create_archive_bytes("Sanitize source", "", 1).unwrap())
            .unwrap();
    let records = vec![
        record(
            RecordType::STUDENT,
            &ids.student_a,
            fields! {"display_name" => "Amina"},
        ),
        record(
            RecordType::STUDENT,
            &ids.student_b,
            fields! {"display_name" => "Ben"},
        ),
        record(
            RecordType::SESSION,
            &ids.session_a,
            fields! {
                "title" => "Algebra",
                "student_id" => ids.student_a,
                "session_type" => "recorded",
                "recording_state" => "complete",
                "recording_track_ids" => format!("{},{}", ids.track_a, ids.track_b),
                "recording_track_id" => ids.track_a,
                "recording_track_count" => "2",
                "recording_audio_chunks" => "2",
                "recording_device_id" => "private-device-name",
                "audio_import_track_id" => ids.track_b,
                "audio_import_source" => "private-import-path",
                "entry_id" => ids.entry_a,
                "notes_document_id" => ids.notes_a
            },
        ),
        record(
            RecordType::SESSION,
            &ids.session_b,
            fields! {
                "title" => "Writing",
                "student_id" => ids.student_b,
                "session_type" => "notes-only",
                "recording_state" => "not-started"
            },
        ),
        record(
            RecordType::ANNOTATION,
            &ids.public_annotation,
            fields! {
                "session_id" => ids.session_a,
                "content" => "Public observation",
                "linked_asset_ids" => ids.asset_a,
                "linked_evidence_ids" => ids.evidence_a
            },
        ),
        record(
            RecordType::ANNOTATION,
            &ids.private_annotation,
            fields! {"session_id" => ids.session_a, "content" => "Private observation", "private" => "true"},
        ),
        record(
            RecordType::TRANSCRIPT_SEGMENT,
            &ids.transcript,
            fields! {
                "session_id" => ids.session_a,
                "text" => "A supported explanation",
                "linked_asset_ids" => ids.asset_a
            },
        ),
        record(
            RecordType::ASSET_METADATA,
            &ids.asset_a,
            fields! {
                "record_role" => "material",
                "session_id" => ids.session_a,
                "display_name" => "worksheet.pdf",
                "blob_id" => ids.manifest_a
            },
        ),
        record(
            RecordType::ASSET_METADATA,
            &ids.asset_b,
            fields! {
                "record_role" => "material",
                "session_id" => ids.session_b,
                "display_name" => "essay.pdf"
            },
        ),
        record(
            RecordType::ASSET_BLOB,
            &ids.manifest_a,
            fields! {"record_role" => "asset-blob-manifest", "chunk_ids" => ids.chunk_a},
        ),
        blob_record(
            RecordType::ASSET_BLOB,
            &ids.chunk_a,
            fields! {"record_role" => "asset-blob-chunk", "manifest_id" => ids.manifest_a},
            vec![11, 22, 33, 44],
        ),
        record(
            RecordType::EVIDENCE_NODE,
            &ids.evidence_a,
            fields! {
                "session_id" => ids.session_a,
                "student_id" => ids.student_a,
                "source_annotation_id" => ids.public_annotation,
                "source_asset_ids" => ids.asset_a
            },
        ),
        record(
            RecordType::EVIDENCE_NODE,
            &ids.evidence_b,
            fields! {
                "session_id" => ids.session_a,
                "student_id" => ids.student_a,
                "source_segment_ids" => ids.transcript
            },
        ),
        record(
            RecordType::EVIDENCE_EDGE,
            &ids.edge,
            fields! {
                "session_id" => ids.session_a,
                "from_id" => ids.evidence_a,
                "to_id" => ids.evidence_b,
                "relationship" => "supports"
            },
        ),
        record(
            RecordType::GUIDE,
            &ids.guide,
            fields! {
                "session_id" => ids.session_a,
                "entry_id" => ids.entry_a,
                "title" => "Algebra guide",
                "section_count" => "1",
                "section.0.heading" => "Evidence",
                "section.0.block_count" => "1",
                "section.0.block.0.kind" => "paragraph",
                "section.0.block.0.text" => "Use the observation.",
                "section.0.block.0.source_ids" => ids.evidence_a,
                "section.0.block.0.stale" => "false",
                "source_index_history" => ids.student_a,
                "stale_source_id" => ids.student_b
            },
        ),
        record(
            RecordType::SETTINGS,
            &ids.entry_a,
            fields! {
                "record_role" => "journal-entry",
                "session_ids" => ids.session_a,
                "notes_document_id" => ids.notes_a,
                "study_guide_ids" => ids.guide,
                "attachment_ids" => ids.asset_a
            },
        ),
        record(
            RecordType::SETTINGS,
            &ids.notes_a,
            fields! {
                "record_role" => "journal-notes",
                "session_id" => ids.session_a,
                "entry_id" => ids.entry_a,
                "content" => "Retained notes"
            },
        ),
        record(
            RecordType::SETTINGS,
            &ids.entry_b,
            fields! {
                "record_role" => "journal-entry",
                "session_ids" => ids.session_b,
                "notes_document_id" => ids.notes_b,
                "attachment_ids" => ids.asset_b
            },
        ),
        record(
            RecordType::SETTINGS,
            &ids.notes_b,
            fields! {
                "record_role" => "journal-notes",
                "session_id" => ids.session_b,
                "entry_id" => ids.entry_b,
                "content" => "Excluded notes"
            },
        ),
        record(
            RecordType::SETTINGS,
            &ids.plain_settings,
            fields! {"record_role" => "provider-settings", "provider" => "local", "note" => "must-not-copy"},
        ),
        record(
            RecordType::AI_JOB,
            &ids.job,
            fields! {"session_id" => ids.session_a, "prompt" => "private generation log"},
        ),
        record(
            RecordType::ASSET_METADATA,
            &ids.track_asset_a,
            fields! {
                "record_role" => "audio-track",
                "session_id" => ids.session_a,
                "track_id" => ids.track_a,
                "mime_type" => "audio/wav"
            },
        ),
        record(
            RecordType::ASSET_METADATA,
            &ids.track_asset_b,
            fields! {
                "record_role" => "audio-track",
                "session_id" => ids.session_a,
                "track_id" => ids.track_b,
                "mime_type" => "audio/wav"
            },
        ),
        record(
            RecordType::ASSET_METADATA,
            &ids.recording_take,
            fields! {
                "record_role" => "recording-take",
                "session_id" => ids.session_a,
                "track_ids" => format!("{},{}", ids.track_a, ids.track_b),
                "mime_type" => "audio/wav"
            },
        ),
        blob_record(
            RecordType::AUDIO_CHUNK,
            &ids.audio_a,
            fields! {
                "session_id" => ids.session_a,
                "track_id" => ids.track_a,
                "sequence_number" => "0",
                "codec" => "aac"
            },
            vec![1, 2, 3],
        ),
        blob_record(
            RecordType::AUDIO_CHUNK,
            &ids.audio_b,
            fields! {
                "session_id" => ids.session_a,
                "track_id" => ids.track_b,
                "sequence_number" => "0",
                "codec" => "aac"
            },
            vec![4, 5, 6],
        ),
    ];
    (snapshot.append_records(&records).unwrap(), ids)
}

pub(crate) fn options_student(ids: &Ids) -> SanitizedCopyOptions {
    SanitizedCopyOptions {
        include_students: [ids.student_a.clone()].into_iter().collect(),
        ..Default::default()
    }
}
