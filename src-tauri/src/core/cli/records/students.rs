use super::*;

pub(crate) fn run_student(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    let snapshot = load(path, context)?;
    match action {
        "create" => {
            let name = args.required_option("name")?.to_owned();
            let timestamp = now_us().to_string();
            let record = ArchiveRecord::new(
                RecordType::STUDENT,
                crate::core::archive::new_uuid(),
                [
                    ("display_name", name),
                    ("grade", args.option("grade").unwrap_or("").to_owned()),
                    ("subjects", args.option("subjects").unwrap_or("").to_owned()),
                    (
                        "learning_objectives",
                        args.option("objectives").unwrap_or("").to_owned(),
                    ),
                    (
                        "known_difficulties",
                        args.option("difficulties").unwrap_or("").to_owned(),
                    ),
                    (
                        "demonstrated_improvements",
                        args.option("demonstrated-improvements")
                            .unwrap_or("")
                            .to_owned(),
                    ),
                    (
                        "preferred_guide_template",
                        args.option("preferred-guide-template")
                            .unwrap_or("")
                            .to_owned(),
                    ),
                    ("progress_classifications", String::new()),
                    (
                        "tutor_notes",
                        args.option("notes")
                            .or_else(|| args.option("tutor-notes"))
                            .unwrap_or("")
                            .to_owned(),
                    ),
                    ("created_at_us", timestamp.clone()),
                    ("updated_at_us", timestamp),
                ],
            );
            let saved = mutate(path, &snapshot, &[record])?;
            let created = &saved[0];
            emit(
                output,
                plain(created),
                &format!(
                    "Created student {} ({}).",
                    created.field("display_name").unwrap_or(""),
                    created.id
                ),
                args.json(),
            );
            Ok(0)
        }
        "list" => {
            let records = snapshot.list_records(RecordType::STUDENT, args.flag("include-deleted"))?;
            let rows: Vec<Value> = records.iter().map(student_profile_value).collect();
            emit(
                output,
                Value::Array(rows),
                &format!("{} student profile(s).", records.len()),
                args.json(),
            );
            Ok(0)
        }
        "show" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let record = require_live(&snapshot, RecordType::STUDENT, &id)?;
            emit(
                output,
                student_profile_value(&record),
                &format!(
                    "student {} (revision {})",
                    record.id, record.revision
                ),
                args.json(),
            );
            Ok(0)
        }
        "update" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::STUDENT, &id)?;
            let options = [
                ("name", "display_name"),
                ("grade", "grade"),
                ("subjects", "subjects"),
                ("objectives", "learning_objectives"),
                ("learning-objectives", "learning_objectives"),
                ("difficulties", "known_difficulties"),
                ("demonstrated-improvements", "demonstrated_improvements"),
                ("notes", "tutor_notes"),
                ("tutor-notes", "tutor_notes"),
                ("preferred-guide-template", "preferred_guide_template"),
            ];
            let mut fields = current.fields.clone();
            let mut changed = false;
            for (option, field) in options {
                if let Some(value) = args.option(option) {
                    validate_student_profile_field(field, value)?;
                    fields.insert(field.to_owned(), value.to_owned());
                    changed = true;
                }
            }
            if !changed {
                return Err(CliError(
                    "Provide at least one supported student field to update.".to_owned(),
                )
                .into());
            }
            fields.insert("updated_at_us".to_owned(), timestamp_now());
            let mut updated = current;
            updated.fields = fields;
            let saved = mutate(path, &snapshot, &[updated])?;
            emit(
                output,
                plain(&saved[0]),
                &format!(
                    "Updated student {} ({}).",
                    saved[0].field("display_name").unwrap_or(""),
                    saved[0].id
                ),
                args.json(),
            );
            Ok(0)
        }
        "delete" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let current = require_live(&snapshot, RecordType::STUDENT, &id)?;
            let saved = mutate(path, &snapshot, &[trash(&current)])?;
            emit(output, plain(&saved[0]), "Student moved to Trash.", args.json());
            Ok(0)
        }
        "restore" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let current = snapshot
                .get_record(RecordType::STUDENT, &id)?
                .ok_or_else(|| CliError(format!("Record {id} was not found in this archive.")))?;
            let mut fields = current.fields.clone();
            fields.insert("_deleted".to_owned(), "false".to_owned());
            fields.insert("restored_at_us".to_owned(), timestamp_now());
            fields.insert("updated_at_us".to_owned(), timestamp_now());
            let mut restored = current;
            restored.fields = fields;
            let saved = mutate(path, &snapshot, &[restored])?;
            emit(output, plain(&saved[0]), "Student restored.", args.json());
            Ok(0)
        }
        "history" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let student = require_live(&snapshot, RecordType::STUDENT, &id)?;
            let sessions = sessions_for_student(&snapshot, &id)?;
            let rows = plain_array(&sessions);
            emit(
                output,
                rows,
                &if sessions.is_empty() {
                    format!(
                        "No sessions recorded for {}.",
                        student.field("display_name").filter(|value| !value.is_empty()).unwrap_or("this student")
                    )
                } else {
                    format!(
                        "{} session{} in {} history.",
                        sessions.len(),
                        if sessions.len() == 1 { "" } else { "s" },
                        student.field("display_name").filter(|value| !value.is_empty()).unwrap_or("student")
                    )
                },
                args.json(),
            );
            Ok(0)
        }
        "progress" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let student = require_live(&snapshot, RecordType::STUDENT, &id)?;
            let sessions = sessions_for_student(&snapshot, &student.id)?;
            let progress = decode_progress(student.field("progress_classifications").unwrap_or(""))?;
            let evidence = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
            let classifications: Vec<Value> = progress
                .iter()
                .map(|item| {
                    let source_status = if validate_progress_citations(
                        &student.id,
                        &item.evidence_source_ids,
                        &sessions,
                        &evidence,
                        &item.classification,
                    )
                    .is_ok()
                    {
                        "valid"
                    } else {
                        "invalid-or-unavailable"
                    };
                    json!({
                        "skill": item.skill,
                        "classification": item.classification,
                        "evidence_source_ids": item.evidence_source_ids.join(","),
                        "reviewed_by": item.reviewed_by,
                        "reviewed_at_us": item.reviewed_at_us,
                        "note": item.note,
                        "claim_label": if item.classification == "unverified-improvement" {
                            "UNVERIFIED CLAIM: improvement is not established"
                        } else {
                            "Human-reviewed classification"
                        },
                        "human_reviewed": "true",
                        "source_status": source_status,
                    })
                })
                .collect();
            emit(
                output,
                json!({
                    "student_id": student.id,
                    "sessions": plain_array(&sessions),
                    "classifications": classifications,
                }),
                &format!("{} progress classification(s).", classifications.len()),
                args.json(),
            );
            Ok(0)
        }
        "progress-review" | "progress-edit" => {
            let id = args.required_position(0, "student ID")?.to_lowercase();
            let skill = args.required_option("skill")?.to_owned();
            let classification = args.required_option("classification")?.to_owned();
            if !PROGRESS_CLASSIFICATIONS.contains(&classification.as_str()) {
                return Err(CliError(
                    "Classification must be newly-observed, recurring, partial-improvement, demonstrated-mastery, unverified-improvement, or not-revisited."
                        .to_owned(),
                )
                .into());
            }
            let raw_ids = args.required_option("evidence-ids")?;
            let evidence_ids: Vec<String> = raw_ids
                .split(',')
                .map(|value| value.trim().to_lowercase())
                .collect();
            if evidence_ids.iter().any(String::is_empty) {
                return Err(CliError(
                    "Evidence IDs must be a comma-separated list without empty items.".to_owned(),
                )
                .into());
            }
            let reviewed_by = args.required_option("reviewed-by")?.to_owned();
            let note = args.option("note").unwrap_or("").to_owned();
            let mut student = require_live(&snapshot, RecordType::STUDENT, &id)?;
            let sessions = snapshot.list_records(RecordType::SESSION, false)?;
            let evidence = snapshot.list_records(RecordType::EVIDENCE_NODE, false)?;
            validate_progress_citations(
                &student.id,
                &evidence_ids,
                &sessions,
                &evidence,
                &classification,
            )?;
            let reviewed_at_us = now_us().to_string();
            let mut items = decode_progress(student.field("progress_classifications").unwrap_or(""))?;
            let normalized = normalize_progress_skill(&skill);
            let item = ProgressItem {
                skill: skill.clone(),
                classification: classification.clone(),
                note: note.clone(),
                reviewed_by: reviewed_by.clone(),
                reviewed_at_us: reviewed_at_us.clone(),
                evidence_source_ids: evidence_ids.clone(),
            };
            if let Some(existing) = items
                .iter_mut()
                .find(|existing| normalize_progress_skill(&existing.skill) == normalized)
            {
                *existing = item.clone();
            } else {
                items.push(item.clone());
            }
            student
                .fields
                .insert("progress_classifications".to_owned(), encode_progress(&items)?);
            student
                .fields
                .insert("updated_at_us".to_owned(), reviewed_at_us);
            let saved = mutate(path, &snapshot, &[student])?;
            let saved_record = saved.first().cloned().unwrap_or_else(|| {
                ArchiveRecord::new(RecordType::STUDENT, &id, std::iter::empty::<(&str, &str)>())
            });
            let saved_item = decode_progress(saved_record.field("progress_classifications").unwrap_or(""))?
                .into_iter()
                .find(|saved| normalize_progress_skill(&saved.skill) == normalized)
                .ok_or_else(|| CliError("The saved progress review could not be read back.".to_owned()))?;
            emit(
                output,
                json!({
                    "skill": saved_item.skill,
                    "classification": saved_item.classification,
                    "evidence_source_ids": saved_item.evidence_source_ids.join(","),
                    "reviewed_by": saved_item.reviewed_by,
                    "reviewed_at_us": saved_item.reviewed_at_us,
                    "note": saved_item.note,
                    "claim_label": if saved_item.classification == "unverified-improvement" {
                        "UNVERIFIED CLAIM: improvement is not established"
                    } else {
                        "Human-reviewed classification"
                    },
                    "human_reviewed": "true",
                    "source_status": "valid",
                }),
                &format!("Human-reviewed progress saved for {}.", saved_item.skill),
                args.json(),
            );
            Ok(0)
        }
        _ => Err(CliError(format!("student {action} is not implemented in the Rust CLI yet.")).into()),
    }
}

