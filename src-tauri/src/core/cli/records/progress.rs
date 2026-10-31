use super::*;

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct ProgressItem {
    pub(crate) skill: String,
    pub(crate) classification: String,
    pub(crate) note: String,
    pub(crate) reviewed_by: String,
    pub(crate) reviewed_at_us: String,
    pub(crate) evidence_source_ids: Vec<String>,
}

pub(crate) const PROGRESS_CLASSIFICATIONS: [&str; 6] = [
    "newly-observed",
    "recurring",
    "partial-improvement",
    "demonstrated-mastery",
    "unverified-improvement",
    "not-revisited",
];

pub(crate) fn progress_read_count(raw: &[u8], position: &mut usize, maximum: usize) -> Option<usize> {
    let delimiter = raw[*position..].iter().position(|byte| *byte == b';')? + *position;
    if delimiter <= *position {
        return None;
    }
    let text = std::str::from_utf8(&raw[*position..delimiter]).ok()?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let count: usize = text.parse().ok()?;
    if count > maximum {
        return None;
    }
    *position = delimiter + 1;
    Some(count)
}

pub(crate) fn progress_read_string(raw: &[u8], position: &mut usize, maximum: usize) -> Option<String> {
    let delimiter = raw[*position..].iter().position(|byte| *byte == b':')? + *position;
    if delimiter <= *position {
        return None;
    }
    let length_text = std::str::from_utf8(&raw[*position..delimiter]).ok()?;
    if length_text.is_empty() || !length_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let length: usize = length_text.parse().ok()?;
    if length > maximum || length > raw.len().saturating_sub(delimiter + 1) {
        return None;
    }
    let start = delimiter + 1;
    let value = std::str::from_utf8(&raw[start..start + length]).ok()?.to_owned();
    *position = start + length;
    Some(value)
}

pub(crate) fn decode_progress(value: &str) -> CliResult<Vec<ProgressItem>> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let raw = value.as_bytes();
    if raw.len() > 4 * 1024 * 1024 || !raw.starts_with(b"TP1;") {
        return Err(CliError("Student progress data is malformed.".to_owned()).into());
    }
    let mut position = 4usize;
    let invalid = || CliError("Student progress data is malformed.".to_owned());
    let count = progress_read_count(raw, &mut position, 512).ok_or_else(invalid)?;
    let mut items = Vec::with_capacity(count);
    for _ in 0..count {
        let skill = progress_read_string(raw, &mut position, 256).ok_or_else(invalid)?;
        let classification = progress_read_string(raw, &mut position, 64).ok_or_else(invalid)?;
        let note = progress_read_string(raw, &mut position, 4_096).ok_or_else(invalid)?;
        let reviewed_by = progress_read_string(raw, &mut position, 128).ok_or_else(invalid)?;
        let reviewed_at_us = progress_read_string(raw, &mut position, 32).ok_or_else(invalid)?;
        let source_count = progress_read_count(raw, &mut position, 64).ok_or_else(invalid)?;
        if skill.is_empty()
            || !PROGRESS_CLASSIFICATIONS.contains(&classification.as_str())
            || reviewed_by.is_empty()
            || source_count == 0
            || reviewed_at_us.is_empty()
            || !reviewed_at_us.bytes().all(|byte| byte.is_ascii_digit())
            || reviewed_at_us.parse::<u128>().map(|value| value == 0).unwrap_or(true)
        {
            return Err(invalid().into());
        }
        let mut ids = Vec::with_capacity(source_count);
        for _ in 0..source_count {
            let id = progress_read_string(raw, &mut position, 36).ok_or_else(invalid)?;
            if !crate::core::format::valid_uuid(&id) || ids.contains(&id.to_lowercase()) {
                return Err(invalid().into());
            }
            ids.push(id.to_lowercase());
        }
        items.push(ProgressItem {
            skill,
            classification,
            note,
            reviewed_by,
            reviewed_at_us,
            evidence_source_ids: ids,
        });
    }
    if position != raw.len() {
        return Err(invalid().into());
    }
    Ok(items)
}

pub(crate) fn encode_progress(items: &[ProgressItem]) -> CliResult<String> {
    let mut output = format!("TP1;{};", items.len());
    for item in items {
        output.push_str(&format!("{}:{}", item.skill.len(), item.skill));
        output.push_str(&format!("{}:{}", item.classification.len(), item.classification));
        output.push_str(&format!("{}:{}", item.note.len(), item.note));
        output.push_str(&format!("{}:{}", item.reviewed_by.len(), item.reviewed_by));
        output.push_str(&format!("{}:{}", item.reviewed_at_us.len(), item.reviewed_at_us));
        output.push_str(&format!("{};", item.evidence_source_ids.len()));
        for id in &item.evidence_source_ids {
            output.push_str(&format!("{}:{}", id.len(), id));
        }
    }
    if output.len() > 4 * 1024 * 1024 {
        return Err(CliError("Student progress data exceeds the 4 MiB limit.".to_owned()).into());
    }
    Ok(output)
}

pub(crate) fn normalize_progress_skill(value: &str) -> String {
    value
        .trim_matches(|character| character == ' ' || character == '\t')
        .to_lowercase()
}

pub(crate) fn validate_progress_citations(
    student_id: &str,
    evidence_source_ids: &[String],
    sessions: &[ArchiveRecord],
    evidence: &[ArchiveRecord],
    classification: &str,
) -> CliResult<()> {
    if evidence_source_ids.is_empty() {
        return Err(CliError("Choose at least one evidence item for this review.".to_owned()).into());
    }
    if evidence_source_ids.len() > 64 {
        return Err(CliError("A review can cite at most 64 evidence items.".to_owned()).into());
    }
    let student_id = student_id.to_lowercase();
    let sessions_by_id: BTreeMap<String, &ArchiveRecord> = sessions
        .iter()
        .filter(|session| !session.deleted())
        .map(|session| (session.id.to_lowercase(), session))
        .collect();
    let evidence_by_id: BTreeMap<String, &ArchiveRecord> = evidence
        .iter()
        .filter(|item| !item.deleted())
        .map(|item| (item.id.to_lowercase(), item))
        .collect();
    let mut source_sessions = BTreeSet::new();
    let mut unique = BTreeSet::new();
    let mut selected = Vec::new();
    for raw_id in evidence_source_ids {
        let id = raw_id.to_lowercase();
        if !unique.insert(id.clone()) {
            return Err(CliError("Evidence items must not be selected more than once.".to_owned()).into());
        }
        let item = evidence_by_id.get(&id).ok_or_else(|| {
            CliError("Every cited evidence item must be active in this archive.".to_owned())
        })?;
        let session_id = item.field("session_id").unwrap_or("").to_lowercase();
        let session = sessions_by_id.get(&session_id).ok_or_else(|| {
            CliError("Cited evidence must refer to a valid session in this archive.".to_owned())
        })?;
        if session.field("student_id").map(str::to_lowercase).unwrap_or_default() != student_id {
            return Err(CliError(
                "Cited evidence must come from a session belonging to this student.".to_owned(),
            )
            .into());
        }
        let evidence_student = item.field("student_id").unwrap_or("");
        if !evidence_student.is_empty() && evidence_student.to_lowercase() != student_id {
            return Err(CliError("Cited evidence is assigned to a different student.".to_owned()).into());
        }
        source_sessions.insert(session_id);
        selected.push(*item);
    }
    if matches!(
        classification,
        "recurring" | "partial-improvement" | "demonstrated-mastery"
    ) && source_sessions.len() < 2
    {
        return Err(CliError(format!(
            "{} requires evidence from at least two sessions.",
            progress_classification_label(classification)
        ))
        .into());
    }
    if classification == "demonstrated-mastery"
        && selected
            .iter()
            .any(|item| item.field("verification_state") != Some("human-verified"))
    {
        return Err(CliError(
            "Demonstrated mastery requires human-verified evidence from every cited source.".to_owned(),
        )
        .into());
    }
    Ok(())
}

pub(crate) fn progress_classification_label(value: &str) -> &'static str {
    match value {
        "newly-observed" => "Newly observed",
        "recurring" => "Recurring",
        "partial-improvement" => "Partial improvement",
        "demonstrated-mastery" => "Demonstrated mastery",
        "unverified-improvement" => "Unverified improvement",
        "not-revisited" => "Not revisited",
        _ => "Progress classification",
    }
}

pub(crate) fn validate_student_profile_field(field: &str, value: &str) -> CliResult<()> {
    let maximum = match field {
        "display_name" => 256,
        "grade" => 128,
        "subjects" => 2_048,
        "learning_objectives" | "known_difficulties" | "demonstrated_improvements" => 4_096,
        "preferred_guide_template" => 128,
        "tutor_notes" => 16_384,
        _ => return Err(CliError("Unsupported student profile field.".to_owned()).into()),
    };
    if value.len() > maximum {
        return Err(CliError(format!(
            "Student profile fields must be {maximum} UTF-8 bytes or fewer."
        ))
        .into());
    }
    let multiline = matches!(
        field,
        "learning_objectives" | "known_difficulties" | "demonstrated_improvements" | "tutor_notes"
    );
    for character in value.chars() {
        let code = character as u32;
        if code == 0x7f
            || (code < 0x20 && !(multiline && (code == 0x09 || code == 0x0a)))
        {
            return Err(CliError(
                "Student profile fields contain unsupported control characters.".to_owned(),
            )
            .into());
        }
    }
    Ok(())
}

pub(crate) fn student_profile_value(record: &ArchiveRecord) -> Value {
    let mut value = plain(record);
    if let Value::Object(map) = &mut value {
        map.remove("progress_classifications");
    }
    value
}

pub(crate) fn sessions_for_student(snapshot: &ArchiveSnapshot, student_id: &str) -> Result<Vec<ArchiveRecord>> {
    let student_id = student_id.to_lowercase();
    let mut sessions: Vec<ArchiveRecord> = snapshot
        .list_records(RecordType::SESSION, false)?
        .into_iter()
        .filter(|session| {
            session.field("student_id").map(str::to_lowercase).as_deref() == Some(student_id.as_str())
        })
        .collect();
    sessions.sort_by(|left, right| {
        let left_start = session_started_at_us(left);
        let right_start = session_started_at_us(right);
        right_start
            .cmp(&left_start)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(sessions)
}
