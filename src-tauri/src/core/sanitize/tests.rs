use crate::core::archive::{ArchiveRecord, RecordType};
use crate::core::sanitize::test_support::{create_source, options_student};
use crate::core::sanitize::*;

#[test]
fn previews_and_creates_student_scoped_copy() {
    let (snapshot, ids) = create_source();
    let options = options_student(&ids);
    let preview = preview_sanitized_copy(&snapshot, &options).unwrap();
    assert_eq!(preview.students, 1);
    assert_eq!(preview.sessions, 1);
    assert_eq!(preview.annotations, 1);
    assert_eq!(preview.assets, 1);
    assert_eq!(preview.evidence_items, 2);
    assert_eq!(preview.guides, 1);
    assert_eq!(preview.recording_tracks, 0);
    assert_eq!(preview.recordings, 0);
    assert_eq!(preview.generation_logs, 0);
    assert_eq!(preview.credentials, 0);

    let expanded_options = SanitizedCopyOptions {
        include_private_annotations: true,
        include_generation_logs: true,
        ..options.clone()
    };
    let expanded = preview_sanitized_copy(&snapshot, &expanded_options).unwrap();
    assert_eq!(expanded.annotations, 2);
    assert_eq!(expanded.generation_logs, 1);

    let copy = create_sanitized_copy(&snapshot, &options, &preview, None).unwrap();
    copy.snapshot.verify().unwrap();
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::STUDENT, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::SESSION, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::ANNOTATION, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::TRANSCRIPT_SEGMENT, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::ASSET_METADATA, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::ASSET_BLOB, false)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::EVIDENCE_NODE, false)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::EVIDENCE_EDGE, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::GUIDE, false)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::AI_JOB, false)
            .unwrap()
            .len(),
        0
    );
    let settings = copy
        .snapshot
        .list_records(RecordType::SETTINGS, false)
        .unwrap();
    assert!(settings
        .iter()
        .any(|record| record.field("record_role") == Some("journal-entry")));
    assert!(settings
        .iter()
        .any(|record| record.field("record_role") == Some("journal-notes")));
    assert!(settings
        .iter()
        .any(|record| record.field("note") == Some("must-not-copy")));
    let session = &copy
        .snapshot
        .list_records(RecordType::SESSION, false)
        .unwrap()[0];
    assert_eq!(session.field("session_type"), Some("notes-only"));
    assert!(session.field("recording_device_id").is_none());
    assert!(session.field("audio_import_source").is_none());

    let expanded_copy =
        create_sanitized_copy(&snapshot, &expanded_options, &expanded, None).unwrap();
    assert_eq!(
        expanded_copy
            .snapshot
            .list_records(RecordType::ANNOTATION, false)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        expanded_copy
            .snapshot
            .list_records(RecordType::AI_JOB, false)
            .unwrap()
            .len(),
        1
    );

    let encrypted = create_sanitized_copy(
        &snapshot,
        &options,
        &preview,
        Some("Optional encrypted output phrase for sanitizer"),
    )
    .unwrap();
    assert!(encrypted.snapshot.encrypted());
    assert!(!encrypted.snapshot.locked());
}

#[test]
fn retains_only_selected_recordings() {
    let (snapshot, ids) = create_source();
    let options = SanitizedCopyOptions {
        include_students: [ids.student_a.clone()].into_iter().collect(),
        include_recording_tracks: [ids.track_a.clone()].into_iter().collect(),
        ..Default::default()
    };
    let preview = preview_sanitized_copy(&snapshot, &options).unwrap();
    assert_eq!(preview.recordings, 1);
    assert_eq!(preview.recording_tracks, 1);
    assert_eq!(preview.assets, 3);
    let copy = create_sanitized_copy(&snapshot, &options, &preview, None).unwrap();
    assert_eq!(
        copy.snapshot
            .list_records(RecordType::AUDIO_CHUNK, false)
            .unwrap()
            .len(),
        1
    );
    let session = &copy
        .snapshot
        .list_records(RecordType::SESSION, false)
        .unwrap()[0];
    assert_eq!(
        session.field("recording_track_ids"),
        Some(ids.track_a.as_str())
    );
    assert_eq!(
        session.field("recording_track_id"),
        Some(ids.track_a.as_str())
    );
    assert_eq!(session.field("recording_track_count"), Some("1"));
    assert_eq!(session.field("recording_audio_chunks"), Some("1"));
    assert!(session.field("recording_device_id").is_none());
    let assets = copy
        .snapshot
        .list_records(RecordType::ASSET_METADATA, false)
        .unwrap();
    let tracks: Vec<&ArchiveRecord> = assets
        .iter()
        .filter(|record| record.field("record_role") == Some("audio-track"))
        .collect();
    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0].field("track_id"), Some(ids.track_a.as_str()));
    let take = assets
        .iter()
        .find(|record| record.field("record_role") == Some("recording-take"))
        .expect("recording take");
    assert_eq!(take.field("track_ids"), Some(ids.track_a.as_str()));
}
