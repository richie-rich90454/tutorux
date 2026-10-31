use super::super::*;

fn pdf_escape(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        let mapped = match character {
            '“' | '”' => '"',
            '‘' | '’' => '\'',
            '–' | '—' => '-',
            '·' => '-',
            '•' => '-',
            '…' => '.',
            '\n' | '\r' => '\n',
            _ => character,
        };
        match mapped {
            '(' => output.push_str("\\("),
            ')' => output.push_str("\\)"),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            _ if (mapped as u32) > 0xff => output.push('?'),
            other => output.push(other),
        }
    }
    output
}

fn wrap_pdf_text(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for source_line in text.split('\n') {
        let mut current = String::new();
        for word in source_line.split_whitespace() {
            let candidate = if current.is_empty() {
                word.to_owned()
            } else {
                format!("{current} {word}")
            };
            if candidate.chars().count() > width && !current.is_empty() {
                lines.push(current);
                current = word.to_owned();
            } else {
                current = candidate;
            }
        }
        if !current.is_empty() || source_line.is_empty() {
            lines.push(current);
        }
    }
    lines
}

pub(crate) fn render_guide_pdf(record: &ArchiveRecord) -> CliResult<Vec<u8>> {
    let draft = guide_draft(record);
    if draft.title.trim().is_empty() {
        return Err(CliError("Cannot export a guide without a title.".to_owned()).into());
    }
    let mut pages: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut y = 738i32;
    let push = |line: String,
                spacing: i32,
                pages: &mut Vec<Vec<String>>,
                current: &mut Vec<String>,
                y: &mut i32| {
        if *y < 60 {
            pages.push(std::mem::take(current));
            *y = 738;
        }
        current.push(format!("BT /F1 10 Tf 54 {} Td ({}) Tj ET", *y, line));
        *y -= spacing;
    };
    push(
        pdf_escape(&draft.title),
        26,
        &mut pages,
        &mut current,
        &mut y,
    );
    push(
        pdf_escape(&format!(
            "Tutorux study guide - {} template - {}",
            draft.template_id,
            record.field("approval_state").unwrap_or("draft")
        )),
        22,
        &mut pages,
        &mut current,
        &mut y,
    );
    for section in &draft.sections {
        push(
            pdf_escape(&section.heading),
            18,
            &mut pages,
            &mut current,
            &mut y,
        );
        for block in &section.blocks {
            if block.stale {
                push(
                    pdf_escape("Source changed - review this block."),
                    14,
                    &mut pages,
                    &mut current,
                    &mut y,
                );
            }
            let is_image =
                block.kind == "image" || block.kind == "figure" || block.text.starts_with("![");
            let text = if is_image {
                match parse_guide_image_reference(&block.text) {
                    Some((asset_id, alternative)) => format!(
                        "[Image {}] {alternative}",
                        &asset_id[..asset_id.len().min(8)]
                    ),
                    None => block.text.clone(),
                }
            } else {
                replace_inline_sources(&block.text)
            };
            for line in wrap_pdf_text(&pdf_escape(&text), 92) {
                push(line, 13, &mut pages, &mut current, &mut y);
            }
            if !block.source_ids.is_empty() {
                for line in wrap_pdf_text(
                    &pdf_escape(&format!("Source: {}", block.source_ids.join(", "))),
                    92,
                ) {
                    push(line, 12, &mut pages, &mut current, &mut y);
                }
            }
        }
    }
    pages.push(current);

    let mut objects: Vec<String> = Vec::new();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_owned());
    let page_object_start = 3usize;
    let font_object = page_object_start + pages.len() * 2;
    let kids: Vec<String> = (0..pages.len())
        .map(|index| format!("{} 0 R", page_object_start + index * 2))
        .collect();
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        pages.len()
    ));
    for (index, page) in pages.iter().enumerate() {
        let content_object = page_object_start + index * 2 + 1;
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_object} 0 R >> >> /Contents {content_object} 0 R >>"
        ));
        let stream = page.join("\n");
        objects.push(format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ));
    }
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    );

    let mut output = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(output.len());
        output.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", index + 1).as_bytes());
    }
    let xref = output.len();
    output.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    Ok(output)
}
