use super::super::*;
use super::guide_int;

fn truncate_heading(value: &str) -> String {
    let mut result = String::new();
    let mut bytes = 0usize;
    for character in value.chars() {
        let size = character.len_utf8();
        if bytes + size > 256 {
            break;
        }
        result.push(character);
        bytes += size;
    }
    result.trim_end().to_owned()
}

pub(crate) fn add_tutor_profile(draft: &mut GuideDraft, student: &ArchiveRecord) {
    let known = student.field("known_difficulties").unwrap_or("");
    let improvements = student.field("demonstrated_improvements").unwrap_or("");
    if known.is_empty() && improvements.is_empty() {
        return;
    }
    let mut text =
        "Previously recorded tutor profile context (not a new finding from this session):"
            .to_owned();
    if !known.is_empty() {
        text.push_str(&format!("\nKnown difficulties: {known}"));
    }
    if !improvements.is_empty() {
        text.push_str(&format!(
            "\nPreviously recorded improvements (verify against linked evidence before treating them as established):\n{improvements}"
        ));
    }
    draft.sections.push(GuideSection {
        id: crate::core::archive::new_uuid(),
        heading: "Tutor profile context".to_owned(),
        blocks: vec![GuideBlock {
            kind: "paragraph".to_owned(),
            text,
            source_ids: vec![student.id.to_lowercase()],
            stale: false,
            origin: "tutor-authored".to_owned(),
        }],
    });
}

pub(crate) fn add_student_progress(
    draft: &mut GuideDraft,
    student: &ArchiveRecord,
    records: &[ArchiveRecord],
) {
    let Ok(progress) = decode_progress(student.field("progress_classifications").unwrap_or(""))
    else {
        return;
    };
    if progress.is_empty() {
        return;
    }
    let sessions: Vec<ArchiveRecord> = records
        .iter()
        .filter(|record| record.record_type == RecordType::SESSION)
        .cloned()
        .collect();
    let evidence: Vec<ArchiveRecord> = records
        .iter()
        .filter(|record| record.record_type == RecordType::EVIDENCE_NODE)
        .cloned()
        .collect();
    let mut blocks = Vec::new();
    for item in progress {
        let verified = validate_progress_citations(
            &student.id,
            &item.evidence_source_ids,
            &sessions,
            &evidence,
            &item.classification,
        )
        .ok()
        .map(|()| {
            item.evidence_source_ids
                .iter()
                .filter_map(|id| {
                    evidence
                        .iter()
                        .find(|record| record.id.to_lowercase() == id.to_lowercase())
                })
                .collect::<Vec<_>>()
        });
        let unverified = item.classification == "unverified-improvement" || verified.is_none();
        let evidence_session_count = verified
            .as_ref()
            .map(|records| {
                records
                    .iter()
                    .filter_map(|record| record.field("session_id"))
                    .map(str::to_lowercase)
                    .collect::<BTreeSet<_>>()
                    .len()
            })
            .unwrap_or(0);
        let mut text = format!(
            "{}: {}{}",
            item.skill,
            if unverified {
                "UNVERIFIED CLAIM — "
            } else {
                ""
            },
            progress_classification_label(&item.classification)
        );
        text.push_str(&match &verified {
            Some(records) => format!(
                " (human-reviewed; {} evidence record(s) across {} session(s))",
                records.len(),
                evidence_session_count
            ),
            None => {
                " (source evidence is missing or invalid; do not treat improvement as established)"
                    .to_owned()
            }
        });
        if !item.note.is_empty() {
            text.push_str(&format!("\nTutor note: {}", item.note));
        }
        if !item.evidence_source_ids.is_empty() {
            text.push_str(&format!(
                "\nEvidence record IDs: {}",
                item.evidence_source_ids.join(", ")
            ));
        }
        blocks.push(GuideBlock {
            kind: "list-item".to_owned(),
            text,
            source_ids: vec![student.id.to_lowercase()],
            stale: false,
            origin: if unverified {
                "uncertain"
            } else {
                "tutor-authored"
            }
            .to_owned(),
        });
    }
    if !blocks.is_empty() {
        draft.sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading: "Progress since previous lessons".to_owned(),
            blocks,
        });
    }
}

pub(crate) fn generate_guide_draft_from_entry(
    entry: &ArchiveRecord,
    template_id: &str,
    records: &[ArchiveRecord],
) -> CliResult<GuideDraft> {
    if entry.record_type != RecordType::SETTINGS
        || entry.field("record_role") != Some("journal-entry")
        || entry.field("_deleted") == Some("true")
    {
        return Err(CliError(
            "Choose an active journal entry before generating a study guide.".to_owned(),
        )
        .into());
    }
    let entry_id = entry.id.to_lowercase();
    let mut sessions: Vec<&ArchiveRecord> = records
        .iter()
        .filter(|record| {
            record.record_type == RecordType::SESSION
                && record.field("_deleted") != Some("true")
                && record.field("entry_id").unwrap_or("").to_lowercase() == entry_id
        })
        .collect();
    sessions.sort_by(|left, right| {
        guide_int(left.field("started_at_us").unwrap_or(""))
            .cmp(&guide_int(right.field("started_at_us").unwrap_or("")))
            .then_with(|| left.id.cmp(&right.id))
    });
    let requested = if template_id.trim().is_empty() {
        "auto"
    } else {
        template_id.trim()
    };
    let mut generated = Vec::new();
    for session in &sessions {
        let template = generated
            .first()
            .map(|draft: &GuideDraft| draft.template_id.clone())
            .unwrap_or_else(|| requested.to_owned());
        generated.push(super::generate_guide_draft_from_session(
            session, &template, records, false,
        )?);
    }
    let selected_template = match generated.first() {
        Some(draft) => draft.template_id.clone(),
        None => {
            let automatic = requested.to_lowercase() == "auto" || requested.is_empty();
            let desired = if automatic {
                infer_template_id(entry.field("subject").unwrap_or(""))
            } else {
                requested.to_owned()
            }
            .to_lowercase();
            resolve_guide_templates(records)
                .into_iter()
                .find(|candidate| {
                    candidate.id.to_lowercase() == desired
                        || candidate.name.to_lowercase() == desired
                })
                .map(|template| template.id)
                .ok_or_else(|| {
                    CliError("Choose a study guide template available in this archive.".to_owned())
                })?
        }
    };

    let mut sections = Vec::new();
    for (session, draft) in sessions.iter().zip(generated.iter()) {
        let title = session.field("title").unwrap_or("Tutoring session");
        for section in &draft.sections {
            if section.blocks.is_empty() {
                continue;
            }
            sections.push(GuideSection {
                id: format!("{}-{}", session.id, section.id),
                heading: truncate_heading(&if section.heading == "Session overview" {
                    format!("{title} — Session overview")
                } else {
                    format!("{title} — {}", section.heading)
                }),
                blocks: section.blocks.clone(),
            });
        }
    }

    let entry_notes_id = entry
        .field("notes_document_id")
        .unwrap_or("")
        .to_lowercase();
    let entry_notes = records.iter().find(|record| {
        record.record_type == RecordType::SETTINGS
            && record.id.to_lowercase() == entry_notes_id
            && record.field("record_role") == Some("journal-notes")
            && record.field("_deleted") != Some("true")
            && record.field("entry_id").unwrap_or("").to_lowercase() == entry_id
            && record.field("session_id").unwrap_or("").is_empty()
    });
    if let Some(entry_notes) = entry_notes {
        let blocks: Vec<GuideBlock> = note_blocks(entry_notes)
            .into_iter()
            .filter(|(_, _, text)| !text.is_empty())
            .map(|(_, _, text)| GuideBlock {
                kind: "paragraph".to_owned(),
                text,
                source_ids: vec![entry_notes.id.to_lowercase()],
                stale: false,
                origin: "session-evidence".to_owned(),
            })
            .collect();
        if !blocks.is_empty() {
            sections.push(GuideSection {
                id: crate::core::archive::new_uuid(),
                heading: "Entry notes".to_owned(),
                blocks,
            });
        }
    }
    if sections.is_empty() {
        sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading: "Entry overview".to_owned(),
            blocks: vec![GuideBlock {
                kind: "paragraph".to_owned(),
                text: "No session or notes material is linked to this entry yet.".to_owned(),
                source_ids: Vec::new(),
                stale: false,
                origin: "system-generated".to_owned(),
            }],
        });
    }
    Ok(GuideDraft {
        title: format!(
            "{} — Study Guide",
            entry.field("title").unwrap_or("Journal entry")
        ),
        session_id: String::new(),
        entry_id: entry.id.clone(),
        template_id: selected_template,
        sections,
    })
}
