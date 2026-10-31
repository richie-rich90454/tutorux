use super::transcript_audio::{field_i64, frame_to_us, TrackLayout};
use super::*;
use crate::transcription::{parse_whisper_json, WhisperCue};

const WINDOW_SECONDS: u64 = 20;
const SPEAKER_TURN_GAP_US: i64 = 700_000;
const MAX_CUES: usize = 100_000;

pub(crate) struct WindowCues {
    start_us: i64,
    end_us: i64,
    cues: Vec<WhisperCue>,
}

pub(crate) struct RecordOptions {
    pub(crate) session_id: String,
    pub(crate) track_id: String,
    pub(crate) run_id: String,
    pub(crate) created_at: String,
    pub(crate) model_name: String,
    pub(crate) language: String,
    pub(crate) refine: bool,
    pub(crate) diarize: bool,
}

#[derive(Default)]
pub(crate) struct Counts {
    pub(crate) generated: usize,
    pub(crate) superseded: usize,
    pub(crate) skipped: usize,
    pub(crate) boundaries: usize,
}

fn metadata_error() -> String {
    "Recording audio metadata is invalid.".to_owned()
}

fn detected_language(json: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(json).ok()?;
    let language = parsed.get("result")?.get("language")?.as_str()?;
    if !language.is_empty()
        && language.len() <= 16
        && language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        Some(language.to_owned())
    } else {
        None
    }
}

pub(crate) fn transcribe_windows(
    layout: &TrackLayout,
    start_frame: u64,
    end_frame: u64,
    mut read: impl FnMut(&str) -> std::result::Result<Vec<u8>, String>,
    mut engine: impl FnMut(Vec<u8>) -> std::result::Result<String, String>,
    mut progress: impl FnMut(usize),
) -> std::result::Result<(Vec<WindowCues>, Option<String>), String> {
    let step = u64::from(layout.sample_rate) * WINDOW_SECONDS;
    if step == 0 {
        return Err(metadata_error());
    }
    let mut cursor = start_frame;
    let mut windows = Vec::new();
    let mut detected = None;
    while cursor < end_frame {
        let end = (cursor + step).min(end_frame);
        let wav = layout.window_wav(cursor, end, &mut read)?;
        let json = engine(wav)?;
        if let Some(language) = detected_language(&json) {
            detected = Some(language);
        }
        let cues = parse_whisper_json(&json)?;
        windows.push(WindowCues {
            start_us: frame_to_us(cursor, layout.sample_rate),
            end_us: frame_to_us(end, layout.sample_rate),
            cues,
        });
        progress(windows.len());
        cursor = end;
    }
    Ok((windows, detected))
}

fn is_provisional_whisper(record: &ArchiveRecord) -> bool {
    record.field("origin") == Some("local-whisper")
        && record.field("verification_state") == Some("provisional")
        && !record.fields.contains_key("human_edited_at_us")
}

fn is_protected(record: &ArchiveRecord) -> bool {
    record.fields.contains_key("human_edited_at_us")
        || matches!(
            record.field("verification_state"),
            Some("human-corrected" | "human-verified")
        )
}

fn make_record(
    cue: &WhisperCue,
    start: i64,
    end: i64,
    window_start: i64,
    options: &RecordOptions,
) -> ArchiveRecord {
    ArchiveRecord::new(
        RecordType::TRANSCRIPT_SEGMENT,
        crate::core::archive::new_uuid(),
        [
            ("session_id", options.session_id.clone()),
            ("start_time_us", start.to_string()),
            ("end_time_us", end.to_string()),
            ("text", cue.text.clone()),
            ("verification_state", "provisional".to_owned()),
            ("timestamp_state", "timestamped".to_owned()),
            ("origin", "local-whisper".to_owned()),
            ("source_audio_track_id", options.track_id.clone()),
            ("source_model", options.model_name.clone()),
            ("source_backend_version", "whisper.cpp CLI".to_owned()),
            ("source_run_id", options.run_id.clone()),
            ("source_window_start_us", window_start.to_string()),
            ("language", options.language.clone()),
            ("created_at_us", options.created_at.clone()),
        ],
    )
}

fn apply_diarization(records: &mut [ArchiveRecord]) -> usize {
    let mut boundaries = 0usize;
    for index in 0..records.len() {
        let boundary = records
            .get(index + 1)
            .and_then(|next| {
                let end = field_i64(&records[index], "end_time_us")?;
                let start = field_i64(next, "start_time_us")?;
                Some(start.saturating_sub(end) >= SPEAKER_TURN_GAP_US)
            })
            .unwrap_or(false);
        if boundary {
            boundaries += 1;
        }
        let record = &mut records[index];
        record
            .fields
            .insert("speaker_turn_next".to_owned(), boundary.to_string());
        record
            .fields
            .insert("speaker_identity_state".to_owned(), "unassigned".to_owned());
        record
            .fields
            .insert("diarization_enabled".to_owned(), "true".to_owned());
        record.fields.insert(
            "diarization_scope".to_owned(),
            "experimental-speaker-turn-boundaries-only".to_owned(),
        );
        record.fields.insert(
            "diarization_method".to_owned(),
            "cue-timing-heuristic".to_owned(),
        );
        record.fields.insert(
            "diarization_model_requirement".to_owned(),
            "not-applicable".to_owned(),
        );
    }
    boundaries
}

pub(crate) fn build_changes(
    existing: &[ArchiveRecord],
    windows: &[WindowCues],
    options: &RecordOptions,
) -> std::result::Result<(Vec<ArchiveRecord>, Counts), String> {
    let range_start = windows.first().map(|window| window.start_us).unwrap_or(0);
    let range_end = windows.last().map(|window| window.end_us).unwrap_or(0);
    let session_id = options.session_id.to_lowercase();
    let track_id = options.track_id.to_lowercase();
    let overlapping: Vec<&ArchiveRecord> = existing
        .iter()
        .filter(|record| {
            record.record_type == RecordType::TRANSCRIPT_SEGMENT
                && !record.deleted()
                && record.field("session_id").map(str::to_lowercase) == Some(session_id.clone())
                && record.field("source_audio_track_id").map(str::to_lowercase)
                    == Some(track_id.clone())
                && field_i64(record, "start_time_us")
                    .zip(field_i64(record, "end_time_us"))
                    .map(|(start, end)| start < range_end && end > range_start)
                    .unwrap_or(false)
        })
        .collect();
    let provisional: Vec<&ArchiveRecord> = overlapping
        .iter()
        .copied()
        .filter(|record| is_provisional_whisper(record))
        .collect();
    if !options.refine && !provisional.is_empty() {
        return Err(
            "This audio already has provisional Whisper cues. Review or remove them before transcribing this range again."
                .to_owned(),
        );
    }
    let protected: Vec<(i64, i64)> = overlapping
        .iter()
        .filter(|record| is_protected(record))
        .filter_map(|record| {
            Some((
                field_i64(record, "start_time_us")?,
                field_i64(record, "end_time_us")?,
            ))
        })
        .collect();
    let mut changes = Vec::new();
    let mut superseded = 0usize;
    if options.refine {
        for record in provisional {
            let mut deleted = record.clone();
            deleted
                .fields
                .insert("_deleted".to_owned(), "true".to_owned());
            deleted
                .fields
                .insert("superseded_by_run".to_owned(), options.run_id.clone());
            deleted
                .fields
                .insert("updated_at_us".to_owned(), options.created_at.clone());
            changes.push(deleted);
            superseded += 1;
        }
    }
    let mut generated = Vec::new();
    let mut skipped = 0usize;
    for window in windows {
        for cue in &window.cues {
            let start = window.start_us.saturating_add(cue.start_us);
            let end = window.start_us.saturating_add(cue.end_us);
            if start >= window.end_us || end > window.end_us {
                skipped += 1;
                continue;
            }
            if protected.iter().any(|(protected_start, protected_end)| {
                start < *protected_end && end > *protected_start
            }) {
                skipped += 1;
                continue;
            }
            generated.push(make_record(cue, start, end, window.start_us, options));
        }
    }
    if generated.len().saturating_add(superseded) > MAX_CUES {
        return Err("The transcription produced too many cues for one operation.".to_owned());
    }
    let boundaries = if options.diarize {
        apply_diarization(&mut generated)
    } else {
        0
    };
    let counts = Counts {
        generated: generated.len(),
        superseded,
        skipped,
        boundaries,
    };
    changes.extend(generated);
    Ok((changes, counts))
}

#[cfg(test)]
mod tests {
    use super::super::transcript_audio::test_mono_layout;
    use super::*;

    fn options(diarize: bool, refine: bool) -> RecordOptions {
        RecordOptions {
            session_id: "00000000-0000-0000-0000-000000000001".to_owned(),
            track_id: "00000000-0000-0000-0000-000000000002".to_owned(),
            run_id: "00000000-0000-0000-0000-000000000003".to_owned(),
            created_at: "1".to_owned(),
            model_name: "model.bin".to_owned(),
            language: "en".to_owned(),
            refine,
            diarize,
        }
    }

    #[test]
    fn fake_engine_seam_offsets_cues_per_window() {
        let (layout, record) = test_mono_layout(&vec![0i16; 8_000 * 25], 8_000);
        let mut read =
            |_: &str| -> std::result::Result<Vec<u8>, String> { Ok(record.blob.clone()) };
        let mut engine = |_: Vec<u8>| -> std::result::Result<String, String> {
            Ok(
                r#"{"result":{"language":"en"},"transcription":[{"offsets":{"from":0,"to":500},"text":"hello"}]}"#
                    .to_owned(),
            )
        };
        let (windows, detected) =
            transcribe_windows(&layout, 0, layout.frames, &mut read, &mut engine, |_| {})
                .expect("fake transcription");
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].start_us, 0);
        assert_eq!(windows[1].start_us, 20_000_000);
        assert_eq!(detected.as_deref(), Some("en"));
        let (changes, counts) =
            build_changes(&[], &windows, &options(true, false)).expect("records");
        assert_eq!(counts.generated, 2);
        assert_eq!(counts.boundaries, 1);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[1].field("start_time_us"), Some("20000000"));
        assert_eq!(changes[1].field("source_window_start_us"), Some("20000000"));
        assert_eq!(changes[0].field("speaker_turn_next"), Some("true"));
        assert_eq!(
            changes[0].field("speaker_identity_state"),
            Some("unassigned")
        );
    }

    #[test]
    fn protected_ranges_are_skipped_and_provisional_cues_need_refine() {
        let mut protected = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            "00000000-0000-0000-0000-000000000004",
            [
                ("session_id", "00000000-0000-0000-0000-000000000001"),
                (
                    "source_audio_track_id",
                    "00000000-0000-0000-0000-000000000002",
                ),
                ("start_time_us", "0"),
                ("end_time_us", "1000"),
                ("origin", "local-whisper"),
                ("verification_state", "provisional"),
            ],
        );
        protected
            .fields
            .insert("human_edited_at_us".to_owned(), "1".to_owned());
        let cue = WhisperCue {
            start_us: 0,
            end_us: 500_000,
            text: "hello".to_owned(),
            speaker_turn_next: None,
        };
        let windows = vec![WindowCues {
            start_us: 0,
            end_us: 1_000_000,
            cues: vec![cue],
        }];
        let (changes, counts) =
            build_changes(&[protected], &windows, &options(false, true)).expect("changes");
        assert_eq!(counts.generated, 0);
        assert_eq!(counts.superseded, 0);
        assert_eq!(counts.skipped, 1);
        assert!(changes.is_empty());

        let provisional = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            "00000000-0000-0000-0000-000000000005",
            [
                ("session_id", "00000000-0000-0000-0000-000000000001"),
                (
                    "source_audio_track_id",
                    "00000000-0000-0000-0000-000000000002",
                ),
                ("start_time_us", "0"),
                ("end_time_us", "1000"),
                ("origin", "local-whisper"),
                ("verification_state", "provisional"),
            ],
        );
        assert!(build_changes(&[provisional], &windows, &options(false, false)).is_err());
    }

    #[test]
    fn diarization_marks_pauses_between_cues() {
        let mut records = vec![
            make_record(
                &WhisperCue {
                    start_us: 0,
                    end_us: 500_000,
                    text: "one".to_owned(),
                    speaker_turn_next: None,
                },
                0,
                500_000,
                0,
                &options(false, false),
            ),
            make_record(
                &WhisperCue {
                    start_us: 1_500_000,
                    end_us: 2_000_000,
                    text: "two".to_owned(),
                    speaker_turn_next: None,
                },
                1_500_000,
                2_000_000,
                1_500_000,
                &options(false, false),
            ),
        ];
        assert_eq!(apply_diarization(&mut records), 1);
        assert_eq!(records[0].field("speaker_turn_next"), Some("true"));
        assert_eq!(records[1].field("speaker_turn_next"), Some("false"));
    }
}
