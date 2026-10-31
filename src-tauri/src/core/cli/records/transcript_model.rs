use super::*;

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

const MAX_SOURCE_BYTES: usize = 256 * 1024 * 1024;
const MAX_CUE_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct TranscriptCue {
    pub(crate) text: String,
    pub(crate) start: Option<i64>,
    pub(crate) end: Option<i64>,
    pub(crate) source_index: usize,
    pub(crate) source_id: String,
}

fn subtitle_error() -> CliError {
    CliError("Subtitle cue timestamps are invalid or end before they start.".to_owned())
}

fn parse_subtitle_timestamp(value: &str) -> CliResult<i64> {
    let normalized = value.replace(',', ".");
    let normalized = if normalized.matches(':').count() == 1 {
        format!("00:{normalized}")
    } else {
        normalized
    };
    let mut parts = normalized.split(':');
    let (Some(hours), Some(minutes), Some(seconds), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(subtitle_error().into());
    };
    if hours.is_empty() || !hours.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(subtitle_error().into());
    }
    let valid_small = |value: &str| {
        !value.is_empty() && value.len() <= 2 && value.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !valid_small(minutes) {
        return Err(subtitle_error().into());
    }
    let (second_text, fraction) = match seconds.split_once('.') {
        Some((second_text, fraction)) => (second_text, Some(fraction)),
        None => (seconds, None),
    };
    if !valid_small(second_text) {
        return Err(subtitle_error().into());
    }
    if let Some(fraction) = fraction {
        if fraction.is_empty()
            || fraction.len() > 6
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(subtitle_error().into());
        }
    }
    let hours: i64 = hours.parse().map_err(|_| subtitle_error())?;
    let minutes: i64 = minutes.parse().map_err(|_| subtitle_error())?;
    let seconds: i64 = second_text.parse().map_err(|_| subtitle_error())?;
    if minutes > 59 || seconds > 59 {
        return Err(subtitle_error().into());
    }
    let micros = fraction
        .map(|fraction| format!("{fraction:0<6}"))
        .filter(|fraction| !fraction.is_empty())
        .map(|fraction| fraction.parse::<i64>())
        .transpose()
        .map_err(|_| subtitle_error())?
        .unwrap_or(0);
    let total = hours
        .checked_mul(3_600_000_000)
        .and_then(|value| value.checked_add(minutes * 60_000_000))
        .and_then(|value| value.checked_add(seconds * 1_000_000))
        .and_then(|value| value.checked_add(micros));
    total.ok_or_else(|| {
        CliError("Subtitle cue timestamp exceeds the supported range.".to_owned()).into()
    })
}

pub(crate) fn parse_transcript_timestamp(value: &str) -> CliResult<i64> {
    let normalized = value.trim().replace(',', ".");
    if !normalized.contains(':') {
        if normalized.is_empty() || !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(CliError("Use HH:MM:SS[.ffffff] or whole seconds.".to_owned()).into());
        }
        let seconds: i64 = normalized
            .parse()
            .map_err(|_| CliError("Timestamp exceeds the supported range.".to_owned()))?;
        return seconds
            .checked_mul(1_000_000)
            .ok_or_else(|| CliError("Timestamp exceeds the supported range.".to_owned()).into());
    }
    let converted = if normalized.matches(':').count() == 1 {
        format!("00:{normalized}")
    } else {
        normalized
    };
    parse_subtitle_timestamp(&converted)
}

fn validate_source(source: &str) -> CliResult<()> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(
            CliError("Transcript source exceeds the configured 256 MiB limit.".to_owned()).into(),
        );
    }
    Ok(())
}

pub(crate) fn validate_cue_text(value: &str) -> CliResult<()> {
    if value.chars().any(|character| {
        let code = character as u32;
        code == 0x7f || (code < 0x20 && !matches!(code, 0x09 | 0x0a))
    }) {
        return Err(CliError(
            "Transcript text contains unsupported control characters.".to_owned(),
        )
        .into());
    }
    if value.len() > MAX_CUE_BYTES {
        return Err(CliError("Transcript cue exceeds 16 MiB.".to_owned()).into());
    }
    Ok(())
}

fn is_vtt_metadata_block(block: &[String]) -> bool {
    if block.iter().any(|line| line.contains("-->")) {
        return false;
    }
    let first = block.first().map(String::as_str).unwrap_or("");
    first == "NOTE"
        || first.starts_with("NOTE ")
        || first.starts_with("NOTE\t")
        || first == "STYLE"
        || first == "REGION"
}

fn parse_subtitle_time_range(line: &str) -> CliResult<(i64, i64)> {
    let separator = line.find("-->").ok_or_else(|| {
        CliError("Subtitle cue must contain exactly one '-->' timestamp separator.".to_owned())
    })?;
    if line[separator + 3..].contains("-->") {
        return Err(CliError(
            "Subtitle cue must contain exactly one '-->' timestamp separator.".to_owned(),
        )
        .into());
    }
    let start_text = line[..separator].trim();
    let end_text = line[separator + 3..]
        .trim()
        .split(['\t', ' '])
        .next()
        .unwrap_or("");
    let start = parse_subtitle_timestamp(start_text)?;
    let end = parse_subtitle_timestamp(end_text)?;
    if end < start {
        return Err(subtitle_error().into());
    }
    Ok((start, end))
}

fn parse_text_lines(lines: &[String]) -> CliResult<Vec<TranscriptCue>> {
    let mut cues = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        validate_cue_text(line)?;
        cues.push(TranscriptCue {
            text: line.clone(),
            start: None,
            end: None,
            source_index: cues.len(),
            source_id: (line_index + 1).to_string(),
        });
    }
    Ok(cues)
}

fn parse_subtitle_lines(lines: &[String], format: &str) -> CliResult<Vec<TranscriptCue>> {
    let mut cursor = 0usize;
    if format == "vtt" {
        let header = lines.first().map(String::as_str).unwrap_or("");
        if header != "WEBVTT" && !header.starts_with("WEBVTT ") && !header.starts_with("WEBVTT\t") {
            return Err(CliError(
                "WebVTT source must begin with a valid WEBVTT header.".to_owned(),
            )
            .into());
        }
        cursor = 1;
        while cursor < lines.len() && !lines[cursor].trim().is_empty() {
            cursor += 1;
        }
        if cursor >= lines.len() {
            return Err(
                CliError("WebVTT header metadata must end with a blank line.".to_owned()).into(),
            );
        }
        cursor += 1;
    }
    let mut cues = Vec::new();
    let mut block: Vec<String> = Vec::new();
    let flush = |block: &mut Vec<String>, cues: &mut Vec<TranscriptCue>| -> CliResult<()> {
        if block.is_empty() {
            return Ok(());
        }
        if format == "vtt" && is_vtt_metadata_block(block) {
            block.clear();
            return Ok(());
        }
        let Some(timing) = block.iter().position(|line| line.contains("-->")) else {
            return Err(CliError(
                "Subtitle cue must have an optional identifier followed by a timestamp.".to_owned(),
            )
            .into());
        };
        if timing > 1 {
            return Err(CliError(
                "Subtitle cue must have an optional identifier followed by a timestamp.".to_owned(),
            )
            .into());
        }
        let (start, end) = parse_subtitle_time_range(&block[timing])?;
        let text_lines = &block[timing + 1..];
        if text_lines.is_empty() {
            return Err(CliError("Subtitle cue contains no text.".to_owned()).into());
        }
        let text = text_lines.join("\n");
        validate_cue_text(&text)?;
        let source_id = if timing == 1 {
            block[0].clone()
        } else {
            String::new()
        };
        if !source_id.is_empty() {
            validate_cue_text(&source_id)?;
        }
        cues.push(TranscriptCue {
            text,
            start: Some(start),
            end: Some(end),
            source_index: cues.len(),
            source_id,
        });
        block.clear();
        Ok(())
    };
    for line in lines.iter().skip(cursor) {
        if line.trim().is_empty() {
            flush(&mut block, &mut cues)?;
        } else {
            block.push(line.clone());
        }
    }
    flush(&mut block, &mut cues)?;
    Ok(cues)
}

pub(crate) fn parse_transcript_source(text: &str, format: &str) -> CliResult<Vec<TranscriptCue>> {
    validate_source(text)?;
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<String> = stripped
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect();
    let cues = if format == "text" {
        parse_text_lines(&lines)?
    } else {
        parse_subtitle_lines(&lines, format)?
    };
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
    cues.iter()
        .map(|cue| {
            let timestamped = cue.start.is_some() && cue.end.is_some();
            let mut record = ArchiveRecord::new(
                RecordType::TRANSCRIPT_SEGMENT,
                crate::core::archive::new_uuid(),
                [
                    ("session_id", session_id.to_owned()),
                    ("start_time_us", cue.start.unwrap_or(0).to_string()),
                    ("end_time_us", cue.end.unwrap_or(0).to_string()),
                    ("text", cue.text.clone()),
                    ("verification_state", "provisional".to_owned()),
                    (
                        "timestamp_state",
                        if timestamped {
                            "timestamped"
                        } else {
                            "not-timestamped"
                        }
                        .to_owned(),
                    ),
                    ("source_import_id", import_id.clone()),
                    ("source_imported_at_us", imported_at.clone()),
                    ("source_index", cue.source_index.to_string()),
                    ("origin", "manual-transcript-import".to_owned()),
                    ("source_format", format.to_owned()),
                    ("source_filename", filename.to_owned()),
                    ("created_at_us", now_us().to_string()),
                ],
            );
            if !cue.source_id.is_empty() {
                record.fields.insert(
                    if format == "text" {
                        "source_line"
                    } else {
                        "source_cue_id"
                    }
                    .to_owned(),
                    cue.source_id.clone(),
                );
            }
            record
        })
        .collect()
}

#[path = "transcript_export.rs"]
mod transcript_export;
pub(crate) use transcript_export::*;
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_import_uses_one_cue_per_line() {
        let cues = parse_transcript_source("first line\n\nsecond line\n", "text")
            .ok()
            .unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].source_id, "1");
        assert_eq!(cues[1].source_id, "3");
    }

    #[test]
    fn vtt_metadata_blocks_are_skipped() {
        let source = "WEBVTT\n\nNOTE a comment\n\n00:00:01.000 --> 00:00:02.500\nhello\n";
        let cues = parse_transcript_source(source, "vtt").ok().unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].start, Some(1_000_000));
        assert_eq!(cues[0].end, Some(2_500_000));
    }

    #[test]
    fn srt_rejects_a_block_without_timing() {
        assert!(parse_transcript_source("1\nnot a cue\n", "srt").is_err());
    }

    #[test]
    fn subtitle_time_accepts_comma_separator_and_one_colon_form() {
        assert_eq!(
            parse_subtitle_timestamp("01:02,5").ok().unwrap(),
            62_500_000
        );
    }
}
