use std::collections::{BTreeMap, BTreeSet};

use crate::core::archive::ArchiveSnapshot;
use crate::core::error::{err, Result};
use crate::core::format::{ArchiveRecord, RecordType};

use super::plan_assets::{plan_assets, plan_notes_and_guides};
use super::refs::private_annotation;
use super::types::{
    active, field, parse_uuid, SanitizedCopyOptions, SanitizedCopyPlan, SanitizedCopySummary,
};

pub(crate) const METADATA_TYPES: [u16; 12] = [
    RecordType::STUDENT,
    RecordType::SESSION,
    RecordType::TRANSCRIPT_SEGMENT,
    RecordType::ANNOTATION,
    RecordType::ASSET_METADATA,
    RecordType::ASSET_BLOB,
    RecordType::EVIDENCE_NODE,
    RecordType::EVIDENCE_EDGE,
    RecordType::GUIDE,
    RecordType::SETTINGS,
    RecordType::AI_JOB,
    RecordType::WAVEFORM_INDEX,
];

pub(crate) const COPY_TYPES: [u16; 13] = [
    RecordType::STUDENT,
    RecordType::SESSION,
    RecordType::AUDIO_CHUNK,
    RecordType::TRANSCRIPT_SEGMENT,
    RecordType::ANNOTATION,
    RecordType::ASSET_METADATA,
    RecordType::ASSET_BLOB,
    RecordType::EVIDENCE_NODE,
    RecordType::EVIDENCE_EDGE,
    RecordType::GUIDE,
    RecordType::SETTINGS,
    RecordType::AI_JOB,
    RecordType::WAVEFORM_INDEX,
];

pub(crate) struct NormalizedOptions {
    pub(crate) include_students: BTreeSet<String>,
    pub(crate) exclude_students: BTreeSet<String>,
    pub(crate) include_sessions: BTreeSet<String>,
    pub(crate) exclude_sessions: BTreeSet<String>,
    pub(crate) include_recording_tracks: BTreeSet<String>,
    pub(crate) exclude_recording_tracks: BTreeSet<String>,
    pub(crate) include_recordings: bool,
    pub(crate) include_private_annotations: bool,
    pub(crate) include_generation_logs: bool,
    pub(crate) include_credentials: bool,
}

pub(crate) fn normalize_options(options: &SanitizedCopyOptions) -> Result<NormalizedOptions> {
    Ok(NormalizedOptions {
        include_students: normalized_set(&options.include_students, "included student")?,
        exclude_students: normalized_set(&options.exclude_students, "excluded student")?,
        include_sessions: normalized_set(&options.include_sessions, "included session")?,
        exclude_sessions: normalized_set(&options.exclude_sessions, "excluded session")?,
        include_recording_tracks: normalized_set(
            &options.include_recording_tracks,
            "included recording track",
        )?,
        exclude_recording_tracks: normalized_set(
            &options.exclude_recording_tracks,
            "excluded recording track",
        )?,
        include_recordings: options.include_recordings,
        include_private_annotations: options.include_private_annotations,
        include_generation_logs: options.include_generation_logs,
        include_credentials: options.include_credentials,
    })
}

fn normalized_set(value: &BTreeSet<String>, name: &str) -> Result<BTreeSet<String>> {
    let mut result = BTreeSet::new();
    for raw in value {
        let Some(id) = parse_uuid(raw) else {
            return err(
                "sanitized_copy_id_invalid",
                &format!("The {name} selection contains an invalid archive ID."),
            );
        };
        result.insert(id);
    }
    Ok(result)
}

fn selected_by(id: &str, include: &BTreeSet<String>, exclude: &BTreeSet<String>) -> bool {
    (include.is_empty() || include.contains(id)) && !exclude.contains(id)
}

pub(crate) fn recordings_requested(options: &NormalizedOptions) -> bool {
    options.include_recordings
        || !options.include_recording_tracks.is_empty()
        || !options.exclude_recording_tracks.is_empty()
}

fn scoped(options: &NormalizedOptions) -> bool {
    !options.include_students.is_empty()
        || !options.exclude_students.is_empty()
        || !options.include_sessions.is_empty()
        || !options.exclude_sessions.is_empty()
}

pub fn plan_sanitized_copy(
    snapshot: &ArchiveSnapshot,
    options: &SanitizedCopyOptions,
) -> Result<SanitizedCopyPlan> {
    let normalized = normalize_options(options)?;
    make_plan(snapshot, &normalized)
}

pub(crate) fn session_is_kept(plan: &SanitizedCopyPlan, record: &ArchiveRecord) -> bool {
    let session_id = field(record, "session_id");
    session_id.is_empty() || plan.has_kept(RecordType::SESSION, &session_id)
}

pub(crate) fn has_kept_session(plan: &SanitizedCopyPlan, record: &ArchiveRecord) -> bool {
    let session_id = field(record, "session_id");
    !session_id.is_empty() && plan.has_kept(RecordType::SESSION, &session_id)
}

pub(crate) fn make_plan(
    snapshot: &ArchiveSnapshot,
    options: &NormalizedOptions,
) -> Result<SanitizedCopyPlan> {
    if snapshot.locked() {
        return err(
            "archive_locked",
            "Unlock this archive before reviewing a sanitized copy.",
        );
    }
    if snapshot.source.size() != snapshot.published_end_offset {
        return err(
            "archive_recovery_required",
            "Recover or repair unpublished archive data before making a sanitized copy.",
        );
    }
    snapshot.verify()?;
    let mut metadata: BTreeMap<u16, Vec<ArchiveRecord>> = BTreeMap::new();
    for record_type in METADATA_TYPES {
        metadata.insert(
            record_type,
            snapshot.list_record_metadata(record_type, true)?,
        );
    }
    let fingerprint = selection_fingerprint(snapshot, &options);
    let summary = SanitizedCopySummary {
        source_generation: snapshot.commit.generation,
        selection_fingerprint: fingerprint,
        students: 0,
        sessions: 0,
        annotations: 0,
        assets: 0,
        evidence_items: 0,
        guides: 0,
        recording_tracks: 0,
        recordings: 0,
        generation_logs: 0,
        credentials: 0,
    };
    let mut plan = SanitizedCopyPlan {
        metadata,
        keep: BTreeMap::new(),
        metadata_updates: BTreeMap::new(),
        source_recording_tracks_by_session: BTreeMap::new(),
        recording_tracks_by_session: BTreeMap::new(),
        recording_chunks_by_session: BTreeMap::new(),
        source_manifest_id: snapshot.header.id.to_lowercase(),
        retained_notes: BTreeSet::new(),
        encrypted_source: snapshot.encrypted(),
        summary,
    };
    let records = |plan: &SanitizedCopyPlan, record_type: u16| plan.records(record_type).to_vec();

    let available_students: BTreeSet<String> = records(&plan, RecordType::STUDENT)
        .into_iter()
        .filter(active)
        .map(|record| record.id.to_lowercase())
        .collect();
    let available_sessions: BTreeSet<String> = records(&plan, RecordType::SESSION)
        .into_iter()
        .filter(active)
        .map(|record| record.id.to_lowercase())
        .collect();
    for id in options
        .include_students
        .iter()
        .chain(options.exclude_students.iter())
    {
        if !available_students.contains(id) {
            return err(
                "sanitized_copy_student_missing",
                "A selected or excluded student does not exist in the source archive.",
            );
        }
    }
    for id in options
        .include_sessions
        .iter()
        .chain(options.exclude_sessions.iter())
    {
        if !available_sessions.contains(id) {
            return err(
                "sanitized_copy_session_missing",
                "A selected or excluded session does not exist in the source archive.",
            );
        }
    }
    for record in records(&plan, RecordType::STUDENT) {
        let id = record.id.to_lowercase();
        if active(&record) && selected_by(&id, &options.include_students, &options.exclude_students)
        {
            plan.keep_set(RecordType::STUDENT).insert(id);
        }
    }
    for record in records(&plan, RecordType::SESSION) {
        let id = record.id.to_lowercase();
        if !active(&record)
            || !selected_by(&id, &options.include_sessions, &options.exclude_sessions)
        {
            continue;
        }
        let student_id = parse_uuid(&field(&record, "student_id"));
        if let Some(student_id) = &student_id {
            if available_students.contains(student_id)
                && !plan.kept(RecordType::STUDENT).contains(student_id)
            {
                continue;
            }
        }
        if !options.include_students.is_empty()
            && student_id
                .as_ref()
                .map(|id| !plan.kept(RecordType::STUDENT).contains(id))
                .unwrap_or(true)
        {
            continue;
        }
        plan.keep_set(RecordType::SESSION).insert(id);
    }

    let is_scoped = scoped(&options);
    if recordings_requested(&options) {
        plan_recordings(snapshot, &mut plan, &options)?;
    }
    for record in records(&plan, RecordType::ANNOTATION) {
        if active(&record)
            && session_is_kept(&plan, &record)
            && (!is_scoped || has_kept_session(&plan, &record))
            && (options.include_private_annotations || !private_annotation(&record))
        {
            plan.keep_set(RecordType::ANNOTATION)
                .insert(record.id.to_lowercase());
        }
    }
    for record in records(&plan, RecordType::TRANSCRIPT_SEGMENT) {
        if active(&record)
            && session_is_kept(&plan, &record)
            && (!is_scoped || has_kept_session(&plan, &record))
        {
            plan.keep_set(RecordType::TRANSCRIPT_SEGMENT)
                .insert(record.id.to_lowercase());
        }
    }
    let requested_assets = plan_notes_and_guides(&mut plan, is_scoped);
    plan_assets(&mut plan, &options, is_scoped, &requested_assets)?;
    plan.summary.students = plan.kept(RecordType::STUDENT).len();
    plan.summary.sessions = plan.kept(RecordType::SESSION).len();
    plan.summary.annotations = plan.kept(RecordType::ANNOTATION).len();
    plan.summary.assets = plan.kept(RecordType::ASSET_METADATA).len();
    plan.summary.evidence_items = plan.kept(RecordType::EVIDENCE_NODE).len();
    plan.summary.guides = plan.kept(RecordType::GUIDE).len();
    plan.summary.recordings = plan.kept(RecordType::AUDIO_CHUNK).len();
    plan.summary.recording_tracks = plan
        .recording_tracks_by_session
        .values()
        .map(BTreeSet::len)
        .sum();
    plan.summary.generation_logs = plan.kept(RecordType::AI_JOB).len();
    plan.summary.credentials = records(&plan, RecordType::SETTINGS)
        .iter()
        .filter(|record| {
            plan.kept(RecordType::SETTINGS)
                .contains(&record.id.to_lowercase())
                && crate::core::archive::is_credential_settings_record(record)
        })
        .count();
    Ok(plan)
}

fn plan_recordings(
    snapshot: &ArchiveSnapshot,
    plan: &mut SanitizedCopyPlan,
    options: &NormalizedOptions,
) -> Result<()> {
    let chunks = snapshot.list_record_metadata(RecordType::AUDIO_CHUNK, true)?;
    let mut available_tracks: BTreeSet<String> = BTreeSet::new();
    for record in chunks {
        if !active(&record) {
            continue;
        }
        let Some(track_id) = parse_uuid(&field(&record, "track_id")) else {
            return err(
                "sanitized_copy_audio_chunk_invalid",
                "A recording chunk has an invalid session or track reference.",
            );
        };
        let Some(session_id) = parse_uuid(&field(&record, "session_id")) else {
            return err(
                "sanitized_copy_audio_chunk_invalid",
                "A recording chunk has an invalid session or track reference.",
            );
        };
        if !session_is_kept(plan, &record) {
            continue;
        }
        available_tracks.insert(track_id.clone());
        plan.source_recording_tracks_by_session
            .entry(session_id.clone())
            .or_default()
            .insert(track_id.clone());
        if !selected_by(
            &track_id,
            &options.include_recording_tracks,
            &options.exclude_recording_tracks,
        ) {
            continue;
        }
        plan.keep_set(RecordType::AUDIO_CHUNK)
            .insert(record.id.to_lowercase());
        *plan
            .recording_chunks_by_session
            .entry(session_id.clone())
            .or_default() += 1;
        plan.recording_tracks_by_session
            .entry(session_id)
            .or_default()
            .insert(track_id);
    }
    for id in options
        .include_recording_tracks
        .iter()
        .chain(options.exclude_recording_tracks.iter())
    {
        if !available_tracks.contains(id) {
            return err(
                "sanitized_copy_recording_track_missing",
                "A selected or excluded recording track does not exist in the retained sessions.",
            );
        }
    }
    Ok(())
}

pub(crate) fn selection_fingerprint(
    snapshot: &ArchiveSnapshot,
    options: &NormalizedOptions,
) -> String {
    let mut canonical = format!(
        "archive={};recordings={};private={};generation={};credentials={}",
        snapshot.header.id.to_lowercase(),
        u8::from(options.include_recordings),
        u8::from(options.include_private_annotations),
        u8::from(options.include_generation_logs),
        u8::from(options.include_credentials),
    );
    for (name, ids) in [
        ("include-students", &options.include_students),
        ("exclude-students", &options.exclude_students),
        ("include-sessions", &options.include_sessions),
        ("exclude-sessions", &options.exclude_sessions),
        (
            "include-recording-tracks",
            &options.include_recording_tracks,
        ),
        (
            "exclude-recording-tracks",
            &options.exclude_recording_tracks,
        ),
    ] {
        canonical.push(';');
        canonical.push_str(name);
        canonical.push('=');
        canonical.push_str(&ids.iter().cloned().collect::<Vec<_>>().join(","));
        if !ids.is_empty() {
            canonical.push(',');
        }
    }
    crate::core::archive::sha256(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
