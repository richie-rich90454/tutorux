use super::*;

pub(crate) fn integer_field(
    record: &ArchiveRecord,
    name: &str,
    fallback: i64,
    alternate: Option<&str>,
) -> i64 {
    let raw = record
        .field(name)
        .filter(|value| !value.is_empty())
        .or_else(|| alternate.and_then(|alternate| record.field(alternate)))
        .unwrap_or("");
    if !raw.is_empty()
        && (raw.starts_with('-') || raw.bytes().all(|byte| byte.is_ascii_digit()))
        && raw
            .trim_start_matches('-')
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        raw.parse().unwrap_or(fallback)
    } else {
        fallback
    }
}

fn compare_integer_field(
    left: &ArchiveRecord,
    right: &ArchiveRecord,
    name: &str,
    alternate: Option<&str>,
) -> std::cmp::Ordering {
    integer_field(left, name, 0, alternate).cmp(&integer_field(right, name, 0, alternate))
}

pub(crate) fn transcript_sort(records: &mut [ArchiveRecord]) {
    records.sort_by(|left, right| {
        let left_timed = left.field("timestamp_state") != Some("not-timestamped");
        let right_timed = right.field("timestamp_state") != Some("not-timestamped");
        if left_timed != right_timed {
            return if left_timed {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if left_timed {
            let start = compare_integer_field(left, right, "start_time_us", None);
            if start != std::cmp::Ordering::Equal {
                return start;
            }
            let end = compare_integer_field(left, right, "end_time_us", None);
            if end != std::cmp::Ordering::Equal {
                return end;
            }
        }
        let imported =
            compare_integer_field(left, right, "source_imported_at_us", Some("created_at_us"));
        if imported != std::cmp::Ordering::Equal {
            return imported;
        }
        let import_id = left
            .field("source_import_id")
            .unwrap_or("")
            .cmp(right.field("source_import_id").unwrap_or(""));
        if import_id != std::cmp::Ordering::Equal {
            return import_id;
        }
        let source_index =
            compare_integer_field(left, right, "source_index", Some("imported_line"));
        if source_index != std::cmp::Ordering::Equal {
            return source_index;
        }
        left.id.cmp(&right.id)
    });
}

pub(crate) fn format_transcript_time(value: i64) -> String {
    let seconds = value.div_euclid(1_000_000);
    let micros = value.rem_euclid(1_000_000);
    let fraction = if micros == 0 {
        String::new()
    } else {
        format!(".{micros:06}").trim_end_matches('0').to_owned()
    };
    format!(
        "{:02}:{:02}:{:02}{fraction}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

pub(crate) fn format_subtitle_time(value: i64, separator: char) -> String {
    let milliseconds = value.div_euclid(1_000);
    format!(
        "{:02}:{:02}:{:02}{separator}{:03}",
        milliseconds / 3_600_000,
        (milliseconds / 60_000) % 60,
        (milliseconds / 1_000) % 60,
        milliseconds.rem_euclid(1_000)
    )
}

pub(crate) fn escape_subtitle_text(value: &str, escape_markup: bool) -> String {
    let collapsed = value.replace("\r\n", "\n").replace('\r', "\n");
    let mut output = String::new();
    let mut previous_newline = false;
    for character in collapsed.chars() {
        if character == '\n' {
            if previous_newline {
                continue;
            }
            previous_newline = true;
        } else {
            previous_newline = false;
        }
        output.push(character);
    }
    if escape_markup {
        output = output
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
    }
    output
}

fn format_long_time(value: i64) -> String {
    format_transcript_time(value)
}

fn time_range(record: &ArchiveRecord) -> String {
    if record.field("timestamp_state") == Some("not-timestamped") {
        return "time not provided".to_owned();
    }
    let start = integer_field(record, "start_time_us", 0, None);
    let end = integer_field(record, "end_time_us", 0, None);
    format!(
        "{}{}",
        format_long_time(start),
        if end > start {
            format!("–{}", format_long_time(end))
        } else {
            String::new()
        }
    )
}

pub(crate) fn transcript_time_range(record: &ArchiveRecord) -> String {
    time_range(record)
}

pub(crate) fn transcript_json(record: &ArchiveRecord) -> Value {
    let mut object = Map::new();
    object.insert("id".to_owned(), Value::String(record.id.clone()));
    object.insert("type".to_owned(), Value::String("transcript".to_owned()));
    object.insert(
        "revision".to_owned(),
        Value::String(record.revision.to_string()),
    );
    for (name, value) in &record.fields {
        object.insert(name.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

pub(crate) fn transcript_export(records: &[ArchiveRecord], format: &str) -> Result<String> {
    let mut ordered = records.to_vec();
    transcript_sort(&mut ordered);
    if format == "json" {
        return Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&Value::Array(
                ordered.iter().map(transcript_json).collect()
            ))
            .unwrap_or_else(|_| "[]".to_owned())
        ));
    }
    if format == "srt" || format == "vtt" {
        let invalid = ordered
            .iter()
            .filter(|record| {
                let start = integer_field(record, "start_time_us", -1, None);
                let end = integer_field(record, "end_time_us", -1, None);
                record.field("timestamp_state") == Some("not-timestamped")
                    || start < 0
                    || end <= start
            })
            .count();
        if invalid > 0 {
            return Err(CoreError::new(
                "transcript_subtitle_invalid",
                format!("{invalid} transcript segment(s) need valid start and end times before subtitle export."),
            ));
        }
        let mut output: Vec<String> = if format == "vtt" {
            vec!["WEBVTT".to_owned(), String::new()]
        } else {
            Vec::new()
        };
        for (index, record) in ordered.iter().enumerate() {
            let text = record.field("text").unwrap_or("");
            let speaker = record
                .field("speaker_label")
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    record
                        .field("speaker_name")
                        .filter(|value| !value.is_empty())
                })
                .unwrap_or("");
            if format == "srt" {
                output.push((index + 1).to_string());
            } else if !record.field("source_id").unwrap_or("").is_empty() {
                output.push(format!("cue-{}", index + 1));
            }
            let separator = if format == "srt" { ',' } else { '.' };
            output.push(format!(
                "{} --> {}",
                format_subtitle_time(integer_field(record, "start_time_us", 0, None), separator),
                format_subtitle_time(integer_field(record, "end_time_us", 0, None), separator)
            ));
            let speaker_prefix = if speaker.is_empty() {
                String::new()
            } else {
                format!("{}: ", escape_subtitle_text(speaker, format == "vtt"))
            };
            output.push(format!(
                "{speaker_prefix}{}",
                escape_subtitle_text(text, format == "vtt")
            ));
            output.push(String::new());
        }
        return Ok(format!("{}\n", output.join("\n")));
    }
    Ok(ordered
        .iter()
        .map(|record| {
            let speaker = record
                .field("speaker_label")
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    record
                        .field("speaker_name")
                        .filter(|value| !value.is_empty())
                })
                .unwrap_or("");
            format!(
                "[{}] {}{}",
                time_range(record),
                if speaker.is_empty() {
                    String::new()
                } else {
                    format!("{speaker}: ")
                },
                record.field("text").unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_export_marks_untimed_cues() {
        let record = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            "00000000-0000-0000-0000-000000000001",
            [
                ("text", "hello".to_owned()),
                ("timestamp_state", "not-timestamped".to_owned()),
                ("start_time_us", "0".to_owned()),
                ("end_time_us", "0".to_owned()),
            ],
        );
        assert_eq!(
            transcript_export(&[record], "text").unwrap(),
            "[time not provided] hello"
        );
    }
    #[test]
    fn subtitle_exports_keep_exact_timing_and_markup_rules() {
        let record = ArchiveRecord::new(
            RecordType::TRANSCRIPT_SEGMENT,
            "00000000-0000-0000-0000-000000000002",
            [
                ("text", "Hello & <world>".to_owned()),
                ("speaker_label", "Tutor".to_owned()),
                ("timestamp_state", "timestamped".to_owned()),
                ("start_time_us", "1000000".to_owned()),
                ("end_time_us", "2500000".to_owned()),
            ],
        );
        assert_eq!(
            transcript_export(&[record.clone()], "srt").ok().unwrap(),
            "1\n00:00:01,000 --> 00:00:02,500\nTutor: Hello & <world>\n\n"
        );
        assert_eq!(
            transcript_export(&[record], "vtt").ok().unwrap(),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nTutor: Hello &amp; &lt;world&gt;\n\n"
        );
    }
}
