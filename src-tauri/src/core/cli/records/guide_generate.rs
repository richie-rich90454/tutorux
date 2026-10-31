use super::*;
#[path = "guide_generate_entry.rs"]
mod guide_generate_entry;
pub(crate) use guide_generate_entry::*;
pub(crate) fn guide_int(value: &str) -> i64 {
    if !value.is_empty()
        && (value.starts_with('-') || value.bytes().all(|byte| byte.is_ascii_digit()))
        && value
            .trim_start_matches('-')
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        value.parse().unwrap_or(0)
    } else {
        0
    }
}
fn guide_time(value: i64) -> String {
    format_transcript_time(value)
}
fn annotation_heading(annotation_type: &str) -> &'static str {
    match annotation_type {
        "important-concept" => "Key concepts",
        "student-mistake" => "Student misconceptions",
        "tutor-correction" => "Errors and corrections",
        "explicit-instruction" => "Tutor instructions",
        "worked-example" => "Worked examples",
        "follow-up-priority" => "Next-session priorities",
        "student-question" => "Student questions",
        "learning-outcome" => "Learning outcomes",
        "general-note" => "Tutor notes",
        "custom" => "Additional tutor notes",
        _ => "Tutor notes",
    }
}
fn transcript_evidence_heading(evidence_type: &str) -> Option<&'static str> {
    match evidence_type {
        "explicit-instruction-candidate" => Some("Tutor-verified spoken instructions"),
        "important-concept-candidate" => Some("Verified spoken concepts"),
        "explanation-candidate" => Some("Verified spoken explanations"),
        "tutor-correction-candidate" => Some("Verified spoken corrections"),
        "student-mistake-candidate" => Some("Verified learner misconceptions"),
        "worked-example-candidate" => Some("Verified spoken examples"),
        "learning-outcome-candidate" => Some("Verified learning outcomes"),
        "follow-up-priority-candidate" => Some("Verified follow-up priorities"),
        "student-question-candidate" => Some("Verified questions"),
        _ => None,
    }
}
fn get_or_add_section<'a>(draft: &'a mut GuideDraft, heading: &str) -> &'a mut GuideSection {
    let existing = draft
        .sections
        .iter()
        .position(|section| section.heading.to_lowercase() == heading.to_lowercase());
    let index = match existing {
        Some(index) => index,
        None => {
            draft.sections.push(GuideSection {
                id: crate::core::archive::new_uuid(),
                heading: heading.to_owned(),
                blocks: Vec::new(),
            });
            draft.sections.len() - 1
        }
    };
    &mut draft.sections[index]
}
fn compare_record_time(left: &ArchiveRecord, right: &ArchiveRecord) -> std::cmp::Ordering {
    guide_int(left.field("start_time_us").unwrap_or(""))
        .cmp(&guide_int(right.field("start_time_us").unwrap_or("")))
}
fn transcript_time_range(segment: &ArchiveRecord) -> String {
    if segment.field("timestamp_state") == Some("not-timestamped") {
        return "time not provided".to_owned();
    }
    let start = guide_int(segment.field("start_time_us").unwrap_or(""));
    let end = guide_int(segment.field("end_time_us").unwrap_or(""));
    if end > start {
        format!("{}–{}", guide_time(start), guide_time(end))
    } else {
        guide_time(start)
    }
}
fn evidence_sources_current(
    evidence: &ArchiveRecord,
    records: &[ArchiveRecord],
    session_id: &str,
) -> bool {
    let by_id: BTreeMap<String, &ArchiveRecord> = records
        .iter()
        .map(|record| (record.id.to_lowercase(), record))
        .collect();
    let validate = |record_type: u16, ids: &[String], revisions: &BTreeMap<String, i64>| {
        for raw_id in ids {
            let id = raw_id.to_lowercase();
            if !is_uuid(&id) {
                return false;
            }
            let Some(source) = by_id.get(&id) else {
                return false;
            };
            if source.record_type != record_type
                || source.field("_deleted") == Some("true")
                || source
                    .field("session_id")
                    .is_some_and(|value| value.to_lowercase() != session_id)
            {
                return false;
            }
            if let Some(expected) = revisions.get(&id) {
                if source.revision != *expected as u64 {
                    return false;
                }
            }
        }
        true
    };
    let annotation_id = evidence.field("source_annotation_id").unwrap_or("");
    if !annotation_id.is_empty() {
        let raw_revision = evidence.field("source_annotation_revision").unwrap_or("");
        let mut map = BTreeMap::new();
        if !raw_revision.is_empty() {
            let Ok(revision) = raw_revision.parse::<i64>() else {
                return false;
            };
            if revision < 0 || !raw_revision.bytes().all(|byte| byte.is_ascii_digit()) {
                return false;
            }
            map.insert(annotation_id.to_lowercase(), revision);
        }
        if !validate(RecordType::ANNOTATION, &[annotation_id.to_owned()], &map) {
            return false;
        }
    }
    let segment_ids = split_ids(evidence.field("source_segment_ids").unwrap_or(""));
    let mut revisions = BTreeMap::new();
    for entry in split_ids(evidence.field("source_segment_revisions").unwrap_or("")) {
        let Some((id, raw)) = entry.split_once('=') else {
            return false;
        };
        let Ok(revision) = raw.parse::<i64>() else {
            return false;
        };
        if !is_uuid(id) || revision < 0 {
            return false;
        }
        revisions.insert(id.to_lowercase(), revision);
    }
    if !validate(RecordType::TRANSCRIPT_SEGMENT, &segment_ids, &revisions) {
        return false;
    }
    let asset_ids = split_ids(evidence.field("source_asset_ids").unwrap_or(""));
    validate(RecordType::ASSET_METADATA, &asset_ids, &BTreeMap::new())
        && (!annotation_id.is_empty() || !segment_ids.is_empty() || !asset_ids.is_empty())
}
fn order_sections(draft: &mut GuideDraft, preferred: &[String]) {
    let rank = |section: &GuideSection| -> usize {
        let heading = section.heading.to_lowercase();
        preferred
            .iter()
            .position(|candidate| {
                let candidate = candidate.to_lowercase();
                heading == candidate || heading.contains(&candidate) || candidate.contains(&heading)
            })
            .unwrap_or(preferred.len())
    };
    let mut indexed: Vec<(usize, GuideSection)> = draft
        .sections
        .drain(..)
        .enumerate()
        .map(|(index, section)| (index, section))
        .collect();
    indexed.sort_by(|left, right| {
        rank(&left.1)
            .cmp(&rank(&right.1))
            .then_with(|| left.0.cmp(&right.0))
    });
    draft.sections = indexed.into_iter().map(|(_, section)| section).collect();
}
pub(crate) fn generate_guide_draft_from_session(
    session: &ArchiveRecord,
    template_id: &str,
    records: &[ArchiveRecord],
    include_entry_evidence: bool,
) -> CliResult<GuideDraft> {
    if session.record_type != RecordType::SESSION || session.field("_deleted") == Some("true") {
        return Err(CliError(
            "Choose an active session before generating a study guide.".to_owned(),
        )
        .into());
    }
    let requested = template_id.trim();
    let automatic = requested.is_empty() || requested.to_lowercase() == "auto";
    let student_id = session.field("student_id").unwrap_or("").to_lowercase();
    let student = if !student_id.is_empty() && student_id != "anonymous" {
        records
            .iter()
            .find(|record| record.record_type == RecordType::STUDENT)
            .filter(|record| record.id.to_lowercase() == student_id)
    } else {
        None
    };
    let inferred = infer_template_id(session.field("subject").unwrap_or(""));
    let preferred = student
        .and_then(|student| student.field("preferred_guide_template"))
        .unwrap_or("");
    let session_template = session.field("guide_template_id").unwrap_or("").trim();
    let resolved = if automatic {
        if !session_template.is_empty() {
            session_template
        } else if !preferred.is_empty() {
            preferred
        } else {
            &inferred
        }
    } else {
        requested
    };
    let normalized = resolved.to_lowercase();
    let catalog = resolve_guide_templates(records);
    let template = catalog
        .iter()
        .find(|candidate| {
            candidate.id.to_lowercase() == normalized || candidate.name.to_lowercase() == normalized
        })
        .or_else(|| {
            if automatic && session_template.is_empty() {
                catalog
                    .iter()
                    .find(|candidate| candidate.id.to_lowercase() == inferred.to_lowercase())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            CliError("Choose a study guide template available in this archive.".to_owned())
        })?;
    let mut draft = create_guide_draft_from_sections(session, &template.id, &template.sections);
    let session_id = session.id.to_lowercase();
    let entry_id = session.field("entry_id").unwrap_or("").to_lowercase();
    let active: Vec<&ArchiveRecord> = records
        .iter()
        .filter(|record| record.field("_deleted") != Some("true"))
        .collect();
    let session_records: Vec<&ArchiveRecord> = active
        .iter()
        .copied()
        .filter(|record| {
            let source_session = record.field("session_id").unwrap_or("").to_lowercase();
            if source_session == session_id {
                return true;
            }
            include_entry_evidence
                && !entry_id.is_empty()
                && record.record_type == RecordType::SETTINGS
                && record.field("record_role") == Some("journal-notes")
                && record.field("entry_id").unwrap_or("").to_lowercase() == entry_id
        })
        .collect();
    let session_title = session.field("title").unwrap_or("Tutoring Session");
    let subject = session.field("subject").unwrap_or("");
    let overview = get_or_add_section(&mut draft, "Session overview");
    overview.blocks.push(GuideBlock {
        kind: "paragraph".to_owned(),
        text: format!(
            "Session: {session_title}{}",
            if subject.is_empty() {
                String::new()
            } else {
                format!("\nSubject: {subject}")
            }
        ),
        source_ids: vec![session.id.clone()],
        stale: false,
        origin: "session-evidence".to_owned(),
    });
    let objectives = session.field("learning_objectives").unwrap_or("");
    if !objectives.is_empty() {
        overview.blocks.push(GuideBlock {
            kind: "paragraph".to_owned(),
            text: format!("Learning objectives provided for this session:\n{objectives}"),
            source_ids: vec![session.id.clone()],
            stale: false,
            origin: "session-evidence".to_owned(),
        });
    }
    if let Some(student) = student {
        add_tutor_profile(&mut draft, student);
    }
    let mut annotations: Vec<&ArchiveRecord> = session_records
        .iter()
        .copied()
        .filter(|record| record.record_type == RecordType::ANNOTATION)
        .collect();
    annotations.sort_by(|left, right| compare_record_time(left, right));
    for annotation in annotations {
        let annotation_type = annotation.field("type").unwrap_or("general-note");
        let heading = annotation_heading(annotation_type);
        let title = annotation.field("title").unwrap_or("");
        let priority = annotation.field("priority").unwrap_or("normal");
        let content = annotation.field("content").unwrap_or("");
        let mut text = format!("[{priority} priority] ");
        if !title.is_empty() {
            text.push_str(&format!("**{title}**\n"));
        }
        text.push_str(content);
        let block = GuideBlock {
            kind: "list-item".to_owned(),
            text,
            source_ids: vec![annotation.id.to_lowercase()],
            stale: false,
            origin: if annotation.field("origin") == Some("tutor-authored") {
                "tutor-authored"
            } else {
                "session-evidence"
            }
            .to_owned(),
        };
        get_or_add_section(&mut draft, heading).blocks.push(block);
    }
    let mut transcripts: Vec<&ArchiveRecord> = session_records
        .iter()
        .copied()
        .filter(|record| record.record_type == RecordType::TRANSCRIPT_SEGMENT)
        .collect();
    transcripts.sort_by(|left, right| compare_record_time(left, right));
    if !transcripts.is_empty() {
        let section = get_or_add_section(
            &mut draft,
            "Transcript excerpts — verbatim, review required",
        );
        for segment in &transcripts {
            section.blocks.push(GuideBlock {
                kind: "quote".to_owned(),
                text: format!(
                    "[{}] {}",
                    transcript_time_range(segment),
                    segment.field("text").unwrap_or("")
                ),
                source_ids: vec![segment.id.to_lowercase()],
                stale: false,
                origin: "session-evidence".to_owned(),
            });
        }
    }
    let current_transcript_ids: BTreeSet<String> = transcripts
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect();
    let active_owned: Vec<ArchiveRecord> = active.iter().map(|record| (*record).clone()).collect();
    let mut verified: Vec<&ArchiveRecord> = session_records
        .iter()
        .copied()
        .filter(|record| {
            record.record_type == RecordType::EVIDENCE_NODE
                && record.field("origin") == Some("transcript-derived-candidate")
                && record.field("verification_state") == Some("human-verified")
                && evidence_sources_current(record, &active_owned, &session_id)
        })
        .collect();
    verified.sort_by(|left, right| compare_record_time(left, right));
    let mut evidence_sections: BTreeSet<String> = BTreeSet::new();
    for node in verified {
        let heading = transcript_evidence_heading(node.field("type").unwrap_or(""))
            .unwrap_or("Verified transcript evidence");
        if evidence_sections.insert(heading.to_owned()) {
            draft.sections.push(GuideSection {
                id: crate::core::archive::new_uuid(),
                heading: heading.to_owned(),
                blocks: Vec::new(),
            });
        }
        let segment_ids = split_ids(node.field("source_segment_ids").unwrap_or(""));
        if segment_ids
            .iter()
            .any(|id| !current_transcript_ids.contains(&id.to_lowercase()))
        {
            continue;
        }
        let mut source_ids = vec![node.id.to_lowercase()];
        source_ids.extend(segment_ids);
        let speaker = node.field("source_speaker_label").unwrap_or("");
        let attribution = format!(
            "[{}]{}",
            guide_time(guide_int(node.field("start_time_us").unwrap_or(""))),
            if speaker.is_empty() {
                String::new()
            } else {
                format!(" [{speaker}]")
            }
        );
        let text = format!("{attribution} {}", node.field("content").unwrap_or(""));
        if let Some(section) = draft
            .sections
            .iter_mut()
            .find(|section| section.heading == heading)
        {
            section.blocks.push(GuideBlock {
                kind: "list-item".to_owned(),
                text,
                source_ids,
                stale: false,
                origin: "session-evidence".to_owned(),
            });
        }
    }
    if let Some(student) = student {
        add_student_progress(&mut draft, student, records);
    }
    let mut notes_records: Vec<&ArchiveRecord> = session_records
        .iter()
        .copied()
        .filter(|record| {
            record.record_type == RecordType::SETTINGS
                && record.field("record_role") == Some("journal-notes")
        })
        .collect();
    notes_records.sort_by(|left, right| {
        let left_entry = left.field("session_id").unwrap_or("").is_empty();
        let right_entry = right.field("session_id").unwrap_or("").is_empty();
        left_entry
            .cmp(&right_entry)
            .then_with(|| {
                guide_int(left.field("created_at_us").unwrap_or(""))
                    .cmp(&guide_int(right.field("created_at_us").unwrap_or("")))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    for notes in notes_records {
        let notes_session_id = notes.field("session_id").unwrap_or("").to_lowercase();
        if !is_guide_notes_source(notes, session, records)
            || (notes_session_id != session_id && !include_entry_evidence)
        {
            continue;
        }
        let decoded = note_blocks(notes)
            .into_iter()
            .filter(|(_, _, text)| !text.is_empty())
            .map(|(_, _, text)| text)
            .collect::<Vec<_>>();
        if decoded.is_empty() {
            continue;
        }
        let note_session = active.iter().find(|record| {
            record.record_type == RecordType::SESSION
                && record.id.to_lowercase() == notes_session_id
        });
        let heading = match note_session {
            Some(note_session) if note_session.id.to_lowercase() == session_id => {
                "Session notes".to_owned()
            }
            Some(note_session) => format!(
                "Session notes · {}",
                note_session.field("title").unwrap_or("Related session")
            ),
            None => "Journal reflection".to_owned(),
        };
        draft.sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading,
            blocks: decoded
                .into_iter()
                .map(|text| GuideBlock {
                    kind: "paragraph".to_owned(),
                    text,
                    source_ids: vec![notes.id.to_lowercase()],
                    stale: false,
                    origin: "session-evidence".to_owned(),
                })
                .collect(),
        });
    }
    draft.sections.retain(|section| !section.blocks.is_empty());
    if draft.sections.len() == 1 {
        draft.sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading: "Evidence status".to_owned(),
            blocks: vec![GuideBlock {
                kind: "paragraph".to_owned(),
                text: "No tutor-authored observations or transcript segments are linked to this session yet. This draft contains only the session details above; it does not infer lesson outcomes.".to_owned(),
                source_ids: vec![session.id.clone()],
                stale: false,
                origin: "system-generated".to_owned(),
            }],
        });
    }
    order_sections(&mut draft, &template.sections);
    Ok(draft)
}
