use super::*;

pub(crate) struct EvidenceCandidate {
    pub(crate) evidence_type: &'static str,
    pub(crate) title: &'static str,
    pub(crate) method: &'static str,
    pub(crate) confidence: &'static str,
}

const CUE_GROUPS: [(&str, &str, &str, &str, &[&str]); 8] = [
    (
        "explicit-instruction-candidate",
        "Possible spoken tutor instruction",
        "instruction-phrase-heuristic",
        "0.72",
        &[
            "remember to",
            "make sure",
            "you should",
            "you need to",
            "don't forget",
            "next time",
            "practice this",
            "try to",
        ],
    ),
    (
        "important-concept-candidate",
        "Possible concept or definition",
        "concept-phrase-heuristic",
        "0.58",
        &[
            "means ",
            "is defined as",
            "is called",
            "the idea is",
            "the concept of",
            "in other words",
        ],
    ),
    (
        "explanation-candidate",
        "Possible explanation",
        "explanation-phrase-heuristic",
        "0.54",
        &[
            "because ",
            "this works",
            "the reason is",
            "so that",
            "which means",
        ],
    ),
    (
        "tutor-correction-candidate",
        "Possible correction",
        "correction-phrase-heuristic",
        "0.62",
        &[
            "not quite",
            "actually,",
            "instead of",
            "the correct",
            "should be",
            "that should be",
            "you meant",
        ],
    ),
    (
        "student-mistake-candidate",
        "Possible learner misconception",
        "first-person-error-phrase-heuristic",
        "0.56",
        &[
            "i thought",
            "i assumed",
            "i confused",
            "i forgot",
            "my mistake",
            "i mixed up",
        ],
    ),
    (
        "worked-example-candidate",
        "Possible worked example",
        "example-phrase-heuristic",
        "0.62",
        &[
            "for example",
            "let's solve",
            "suppose ",
            "consider ",
            "an example",
        ],
    ),
    (
        "learning-outcome-candidate",
        "Possible learning outcome",
        "learning-outcome-phrase-heuristic",
        "0.62",
        &[
            "now i understand",
            "i see now",
            "i learned",
            "i can now",
            "that makes sense",
        ],
    ),
    (
        "follow-up-priority-candidate",
        "Possible follow-up priority",
        "follow-up-phrase-heuristic",
        "0.65",
        &[
            "next session",
            "for next time",
            "practice this",
            "review this",
            "homework",
            "before next",
        ],
    ),
];

pub(crate) fn classify_transcript_evidence(text: &str) -> Vec<EvidenceCandidate> {
    let normalized = text.to_lowercase();
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut candidates: Vec<EvidenceCandidate> = CUE_GROUPS
        .iter()
        .filter(|(_, _, _, _, cues)| cues.iter().any(|cue| normalized.contains(cue)))
        .map(
            |(evidence_type, title, method, confidence, _)| EvidenceCandidate {
                evidence_type,
                title,
                method,
                confidence,
            },
        )
        .collect();
    if normalized.contains('?') {
        candidates.push(EvidenceCandidate {
            evidence_type: "student-question-candidate",
            title: "Possible question",
            method: "question-mark-heuristic",
            confidence: "0.5",
        });
    }
    candidates
}

fn split_list(value: &str) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value
            .split(',')
            .filter(|item| !item.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

fn evidence_field<'a>(record: &'a ArchiveRecord, key: &str, fallback: &'a str) -> &'a str {
    record.field(key).unwrap_or(fallback)
}

pub(crate) fn extract_session_evidence(
    snapshot: &ArchiveSnapshot,
    session: &ArchiveRecord,
    session_id: &str,
) -> Result<Vec<ArchiveRecord>> {
    let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
    let transcripts = snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)?;
    let existing = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
    let mut existing_sources: BTreeSet<String> = BTreeSet::new();
    let mut legacy_sources: BTreeSet<String> = BTreeSet::new();
    for node in &existing {
        let annotation_id = evidence_field(node, "source_annotation_id", "");
        let annotation_revision = evidence_field(node, "source_annotation_revision", "");
        if !annotation_id.is_empty() {
            if !annotation_revision.is_empty() {
                existing_sources
                    .insert(format!("annotation:{annotation_id}:{annotation_revision}"));
            } else {
                legacy_sources.insert(format!(
                    "annotation:{annotation_id}:{}",
                    evidence_field(node, "content", "")
                ));
            }
        }
        let segment_ids = split_list(evidence_field(node, "source_segment_ids", ""));
        let revision = evidence_field(node, "source_segment_revision", "");
        let node_type = evidence_field(node, "type", "");
        for segment_id in segment_ids {
            if !revision.is_empty() {
                existing_sources.insert(format!("segment:{segment_id}:{node_type}:{revision}"));
            } else {
                legacy_sources.insert(format!(
                    "segment:{segment_id}:{node_type}:{}",
                    evidence_field(node, "content", "")
                ));
            }
        }
    }

    let student_id = evidence_field(session, "student_id", "").to_owned();
    let timestamp = now_us().to_string();
    let mut records = Vec::new();
    for annotation in &annotations {
        if evidence_field(annotation, "session_id", "") != session_id {
            continue;
        }
        let source_key = format!("annotation:{}:{}", annotation.id, annotation.revision);
        let legacy_key = format!(
            "annotation:{}:{}",
            annotation.id,
            evidence_field(annotation, "content", "")
        );
        if existing_sources.contains(&source_key) || legacy_sources.contains(&legacy_key) {
            continue;
        }
        records.push(ArchiveRecord::new(
            RecordType::EVIDENCE_NODE,
            crate::core::archive::new_uuid(),
            [
                ("session_id", session_id.to_owned()),
                ("student_id", student_id.clone()),
                (
                    "type",
                    evidence_field(annotation, "type", "general-note").to_owned(),
                ),
                (
                    "title",
                    evidence_field(annotation, "title", "Observation").to_owned(),
                ),
                (
                    "content",
                    evidence_field(annotation, "content", "").to_owned(),
                ),
                (
                    "priority",
                    evidence_field(annotation, "priority", "normal").to_owned(),
                ),
                ("origin", "tutor-authored".to_owned()),
                ("source_annotation_id", annotation.id.clone()),
                (
                    "source_annotation_revision",
                    annotation.revision.to_string(),
                ),
                ("source_segment_ids", String::new()),
                ("source_asset_ids", String::new()),
                (
                    "start_time_us",
                    evidence_field(annotation, "start_time_us", "0").to_owned(),
                ),
                (
                    "end_time_us",
                    evidence_field(annotation, "end_time_us", "0").to_owned(),
                ),
                ("verification_state", "human-verified".to_owned()),
                ("created_at_us", timestamp.clone()),
            ],
        ));
        existing_sources.insert(source_key);
    }

    for segment in &transcripts {
        if evidence_field(segment, "session_id", "") != session_id {
            continue;
        }
        let text = evidence_field(segment, "text", "");
        for candidate in classify_transcript_evidence(text) {
            let source_key = format!(
                "segment:{}:{}:{}",
                segment.id, candidate.evidence_type, segment.revision
            );
            let legacy_key = format!("segment:{}:{}:{text}", segment.id, candidate.evidence_type);
            if existing_sources.contains(&source_key) || legacy_sources.contains(&legacy_key) {
                continue;
            }
            records.push(ArchiveRecord::new(
                RecordType::EVIDENCE_NODE,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session_id.to_owned()),
                    ("student_id", student_id.clone()),
                    ("type", candidate.evidence_type.to_owned()),
                    ("title", candidate.title.to_owned()),
                    ("content", text.to_owned()),
                    ("priority", "normal".to_owned()),
                    ("origin", "transcript-derived-candidate".to_owned()),
                    ("source_annotation_id", String::new()),
                    ("source_segment_ids", segment.id.clone()),
                    ("source_segment_revision", segment.revision.to_string()),
                    (
                        "source_segment_revisions",
                        format!("{}={}", segment.id, segment.revision),
                    ),
                    (
                        "source_asset_ids",
                        evidence_field(segment, "linked_asset_ids", "").to_owned(),
                    ),
                    (
                        "source_speaker_label",
                        evidence_field(segment, "speaker_label", "").to_owned(),
                    ),
                    (
                        "start_time_us",
                        evidence_field(segment, "start_time_us", "0").to_owned(),
                    ),
                    (
                        "end_time_us",
                        evidence_field(segment, "end_time_us", "0").to_owned(),
                    ),
                    ("verification_state", "needs-review".to_owned()),
                    ("detection_method", candidate.method.to_owned()),
                    ("detection_confidence", candidate.confidence.to_owned()),
                    ("created_at_us", timestamp.clone()),
                ],
            ));
            existing_sources.insert(source_key);
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_instruction_and_question() {
        let candidates = classify_transcript_evidence("You should practice this?");
        let types: Vec<&str> = candidates
            .iter()
            .map(|candidate| candidate.evidence_type)
            .collect();
        assert!(types.contains(&"explicit-instruction-candidate"));
        assert!(types.contains(&"student-question-candidate"));
    }

    #[test]
    fn empty_text_yields_no_candidates() {
        assert!(classify_transcript_evidence("").is_empty());
    }
}
