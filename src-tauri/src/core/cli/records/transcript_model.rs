use super::*;

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

pub(crate) struct TranscriptCue {
    pub(crate) text: String,
    pub(crate) start: Option<i64>,
    pub(crate) end: Option<i64>,
    pub(crate) source_index: usize,
    pub(crate) source_id: String,
}

pub(crate) fn parse_subtitle_time(value: &str) -> CliResult<i64> {
    let normalized = value.trim().replace(',', ".");
    let normalized = if normalized.matches(':').count() == 1 {
        format!("00:{normalized}")
    } else {
        normalized
    };
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() != 3 {
        return Err(CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()).into());
    }
    let hours: i64 = parts[0]
        .parse()
        .map_err(|_| CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()))?;
    let minutes: i64 = parts[1]
        .parse()
        .map_err(|_| CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()))?;
    if minutes > 59 {
        return Err(CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()).into());
    }
    let second_parts: Vec<&str> = parts[2].split('.').collect();
    let seconds: i64 = second_parts[0]
        .parse()
        .map_err(|_| CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()))?;
    if seconds > 59 {
        return Err(CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()).into());
    }
    let fraction = second_parts.get(1).copied().unwrap_or("");
    let micros = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<6}")[..6]
            .parse::<i64>()
            .map_err(|_| CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()))?
    };
    Ok(hours * 3_600_000_000 + minutes * 60_000_000 + seconds * 1_000_000 + micros)
}

pub(crate) fn parse_transcript_source(text: &str, format: &str) -> CliResult<Vec<TranscriptCue>> {
    let mut cues = Vec::new();
    match format {
        "srt" | "vtt" => {
            let mut block: Vec<String> = Vec::new();
            let mut index = 0usize;
            let mut flush = |block: &mut Vec<String>, cues: &mut Vec<TranscriptCue>| -> CliResult<()> {
                if block.is_empty() {
                    return Ok(());
                }
                if block[0].starts_with("NOTE")
                    || block[0].starts_with("STYLE")
                    || block[0].starts_with("REGION")
                    || block[0].starts_with("WEBVTT")
                {
                    block.clear();
                    return Ok(());
                }
                let timing = block.iter().position(|line| line.contains("-->"));
                let Some(timing) = timing else {
                    block.clear();
                    return Ok(());
                };
                if timing > 1 {
                    block.clear();
                    return Ok(());
                }
                let timing_line = &block[timing];
                let Some((start_text, rest)) = timing_line.split_once("-->") else {
                    block.clear();
                    return Ok(());
                };
                let end_text = rest.split_whitespace().next().unwrap_or("");
                let start = parse_subtitle_time(start_text)?;
                let end = parse_subtitle_time(end_text)?;
                if end < start {
                    return Err(CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned()).into());
                }
                let cue_text = block[timing + 1..].join("\n");
                if cue_text.is_empty() {
                    return Err(CliError("Subtitle cue contains no text.".to_owned()).into());
                }
                let source_id = if timing == 1 { block[0].clone() } else { String::new() };
                cues.push(TranscriptCue {
                    text: cue_text,
                    start: Some(start),
                    end: Some(end),
                    source_index: index,
                    source_id,
                });
                index += 1;
                block.clear();
                Ok(())
            };
            for line in text.lines() {
                if line.trim().is_empty() {
                    flush(&mut block, &mut cues)?;
                } else {
                    block.push(line.to_owned());
                }
            }
            flush(&mut block, &mut cues)?;
        }
        _ => {
            let mut index = 0usize;
            let mut paragraph: Vec<&str> = Vec::new();
            let flush = |paragraph: &mut Vec<&str>, cues: &mut Vec<TranscriptCue>, index: &mut usize| {
                if paragraph.is_empty() {
                    return;
                }
                let text = paragraph.join("\n");
                cues.push(TranscriptCue {
                    text,
                    start: None,
                    end: None,
                    source_index: *index,
                    source_id: String::new(),
                });
                *index += 1;
                paragraph.clear();
            };
            for line in text.lines() {
                if line.trim().is_empty() {
                    flush(&mut paragraph, &mut cues, &mut index);
                } else {
                    paragraph.push(line);
                }
            }
            flush(&mut paragraph, &mut cues, &mut index);
        }
    }
    if cues.is_empty() {
        return Err(CliError("Transcript source contains no cues.".to_owned()).into());
    }
    Ok(cues)
}

pub(crate) fn make_transcript_records(
    session_id: &str,
    cues: &[TranscriptCue],
    format: &str,
    filename: &str,
) -> Vec<ArchiveRecord> {
    let import_id = crate::core::archive::new_uuid();
    let imported_at = now_us().to_string();
    let created_at = imported_at.clone();
    cues.iter()
        .map(|cue| {
            let timestamped = cue.start.is_some() && cue.end.is_some();
            let mut record = ArchiveRecord::new(
                RecordType::TRANSCRIPT_SEGMENT,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session_id.to_owned()),
                    (
                        "start_time_us",
                        cue.start.unwrap_or(0).to_string(),
                    ),
                    ("end_time_us", cue.end.unwrap_or(0).to_string()),
                    ("text", cue.text.clone()),
                    ("verification_state", "provisional".to_owned()),
                    (
                        "timestamp_state",
                        if timestamped { "timestamped" } else { "not-timestamped" }.to_owned(),
                    ),
                    ("source_import_id", import_id.clone()),
                    ("source_imported_at_us", imported_at.clone()),
                    ("source_index", cue.source_index.to_string()),
                    ("origin", "manual-transcript-import".to_owned()),
                    ("source_format", format.to_owned()),
                    ("source_filename", filename.to_owned()),
                    ("created_at_us", created_at.clone()),
                ],
            );
            if !cue.source_id.is_empty() {
                record.fields.insert(
                    if format == "text" { "source_line" } else { "source_cue_id" }.to_owned(),
                    cue.source_id.clone(),
                );
            }
            record
        })
        .collect()
}

pub(crate) fn transcript_sort(records: &mut [ArchiveRecord]) {
    records.sort_by(|left, right| {
        let left_timed = left.field("timestamp_state") != Some("not-timestamped");
        let right_timed = right.field("timestamp_state") != Some("not-timestamped");
        if left_timed != right_timed {
            return if left_timed { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        let left_start = left.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
        let right_start = right.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
        left_start
            .cmp(&right_start)
            .then_with(|| {
                left.field("source_import_id")
                    .unwrap_or("")
                    .cmp(right.field("source_import_id").unwrap_or(""))
            })
            .then_with(|| {
                let left_index = left
                    .field("source_index")
                    .or_else(|| left.field("imported_line"))
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                let right_index = right
                    .field("source_index")
                    .or_else(|| right.field("imported_line"))
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                left_index.cmp(&right_index)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
}

pub(crate) fn format_transcript_time(value: i64) -> String {
    let seconds = value / 1_000_000;
    let micros = value % 1_000_000;
    format!(
        "{:02}:{:02}:{:02}{}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60,
        if micros == 0 {
            String::new()
        } else {
            format!(".{micros:06}")
                .trim_end_matches('0')
                .to_owned()
        }
    )
}

pub(crate) fn format_subtitle_time(value: i64, separator: char) -> String {
    let milliseconds = value / 1_000;
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1_000) % 60;
    let fraction = milliseconds % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}{separator}{fraction:03}")
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

pub(crate) fn transcript_export(records: &[ArchiveRecord], format: &str) -> Result<String> {
    match format {
        "json" => Ok(format!(
            "{}\n",
            serde_json::to_string_pretty(&plain_array(records)).unwrap_or_else(|_| "[]".to_owned())
        )),
        "srt" | "vtt" => {
            let invalid = records
                .iter()
                .filter(|record| {
                    let start = record.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                    let end = record.field("end_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                    record.field("timestamp_state") == Some("not-timestamped") || start < 0 || end <= start
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
            for (index, record) in records.iter().enumerate() {
                let text = record.field("text").unwrap_or("");
                let speaker = record
                    .field("speaker_label")
                    .filter(|value| !value.is_empty())
                    .or_else(|| record.field("speaker_name").filter(|value| !value.is_empty()))
                    .unwrap_or("");
                let start = record.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                let end = record.field("end_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                if format == "srt" {
                    output.push((index + 1).to_string());
                } else if !record.field("source_id").unwrap_or("").is_empty() {
                    output.push(format!("cue-{}", index + 1));
                }
                let separator = if format == "srt" { ',' } else { '.' };
                output.push(format!(
                    "{} --> {}",
                    format_subtitle_time(start, separator),
                    format_subtitle_time(end, separator)
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
            Ok(format!("{}\n", output.join("\n")))
        }
        _ => Ok(records
            .iter()
            .map(|record| {
                let timed = record.field("timestamp_state") != Some("not-timestamped");
                if timed {
                    let start = record.field("start_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                    let end = record.field("end_time_us").unwrap_or("0").parse::<i64>().unwrap_or(0);
                    let speaker = record
                        .field("speaker_label")
                        .filter(|value| !value.is_empty())
                        .or_else(|| record.field("speaker_name").filter(|value| !value.is_empty()))
                        .unwrap_or("");
                    let range = format!(
                        "[{}{}]",
                        format_transcript_time(start),
                        if end > start { format!("–{}", format_transcript_time(end)) } else { String::new() }
                    );
                    format!(
                        "{range} {}{}",
                        if speaker.is_empty() { String::new() } else { format!("{speaker}: ") },
                        record.field("text").unwrap_or("")
                    )
                } else {
                    let speaker = record
                        .field("speaker_label")
                        .filter(|value| !value.is_empty())
                        .or_else(|| record.field("speaker_name").filter(|value| !value.is_empty()))
                        .unwrap_or("");
                    format!(
                        "[time not provided] {}{}",
                        if speaker.is_empty() { String::new() } else { format!("{speaker}: ") },
                        record.field("text").unwrap_or("")
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("\n")),
    }
}

