use super::*;

#[path = "guide_docx.rs"]
mod guide_docx;
#[path = "guide_pdf.rs"]
mod guide_pdf;
pub(crate) use guide_docx::render_guide_docx;
pub(crate) use guide_pdf::render_guide_pdf;

pub(crate) struct GuideExportImage {
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn guide_image_ids(record: &ArchiveRecord) -> CliResult<Vec<String>> {
    let draft = guide_draft(record);
    let mut ids = Vec::new();
    for section in &draft.sections {
        for block in &section.blocks {
            let is_image =
                block.kind == "image" || block.kind == "figure" || block.text.starts_with("![");
            if !is_image {
                continue;
            }
            let Some((asset_id, _)) = parse_guide_image_reference(&block.text) else {
                return Err(CliError(
                    "A guide image must point to one archive asset UUID.".to_owned(),
                )
                .into());
            };
            if !ids.contains(&asset_id) {
                ids.push(asset_id);
            }
        }
    }
    Ok(ids)
}

pub(crate) fn serialize_guide_json(record: &ArchiveRecord) -> String {
    let mut object = Map::new();
    for (key, value) in &record.fields {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    let mut ordered = Map::new();
    ordered.insert("id".to_owned(), Value::String(record.id.clone()));
    ordered.insert(
        "type".to_owned(),
        Value::String(record_type_name(RecordType::GUIDE).to_owned()),
    );
    ordered.insert(
        "revision".to_owned(),
        Value::String(record.revision.to_string()),
    );
    for key in object.keys() {
        ordered.insert(key.clone(), object[key].clone());
    }
    format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(ordered)).unwrap_or_else(|_| "{}".to_owned())
    )
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (first << 16) | (second << 8) | third;
        output.push(ALPHABET[(value >> 18) as usize & 63] as char);
        output.push(ALPHABET[(value >> 12) as usize & 63] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[value as usize & 63] as char
        } else {
            '='
        });
    }
    output
}

fn escape_html(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#39;"),
            _ => output.push(character),
        }
    }
    output
}

pub(crate) fn parse_table_rows(value: &str) -> CliResult<Vec<Vec<String>>> {
    let rows: Vec<Vec<String>> = value
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.trim_start_matches('|')
                .trim_end_matches('|')
                .split('|')
                .map(|cell| cell.trim().to_owned())
                .collect()
        })
        .collect();
    let is_separator = |cell: &String| {
        let normalized = cell.trim_start_matches(':').trim_end_matches(':');
        normalized.len() >= 3 && normalized.chars().all(|character| character == '-')
    };
    let valid = rows.len() >= 2
        && !rows[0].is_empty()
        && rows[0].len() == rows[1].len()
        && rows[1].iter().all(is_separator)
        && rows[2..].iter().all(|row| row.len() == rows[0].len());
    if !valid {
        return Err(CliError(
            "A guide table needs a header, matching columns, and a Markdown separator row."
                .to_owned(),
        )
        .into());
    }
    let mut output = vec![rows[0].clone()];
    output.extend(rows.into_iter().skip(2));
    Ok(output)
}

fn render_html_block(
    block: &GuideBlock,
    images: &BTreeMap<String, GuideExportImage>,
) -> CliResult<String> {
    let label = guide_block_label(&block.kind, &block.origin);
    let is_image = block.kind == "image" || block.kind == "figure" || block.text.starts_with("![");
    let image = if is_image {
        parse_guide_image_reference(&block.text)
    } else {
        None
    };
    if is_image && image.is_none() {
        return Err(
            CliError("A guide image must point to one archive asset UUID.".to_owned()).into(),
        );
    }
    let content = if let Some((asset_id, alternative)) = image {
        let Some(image) = images.get(&asset_id) else {
            return Err(CliError(format!(
                "Guide image {asset_id} is missing from this archive."
            ))
            .into());
        };
        let mime = image.mime_type.as_str();
        if !matches!(
            mime,
            "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
        ) {
            return Err(CliError(
                "Only PNG, JPEG, GIF, and WebP guide images can be exported.".to_owned(),
            )
            .into());
        }
        let source = format!("data:{mime};base64,{}", base64(&image.bytes));
        let caption = if alternative.is_empty() {
            String::new()
        } else {
            format!("<figcaption>{}</figcaption>", escape_html(&alternative))
        };
        format!(
            "<figure class=\"guide-figure\"><img src=\"{source}\" alt=\"{}\">{caption}</figure>",
            escape_html(&alternative)
        )
    } else if block.kind == "table" {
        let rows = parse_table_rows(&block.text)?;
        let headers = rows.first().cloned().unwrap_or_default();
        let body = &rows[1..];
        format!(
            "<table class=\"guide-table\"><thead><tr>{}</tr></thead><tbody>{}</tbody></table>",
            headers
                .iter()
                .map(|cell| format!(
                    "<th scope=\"col\">{}</th>",
                    escape_html(&replace_inline_sources(cell))
                ))
                .collect::<Vec<_>>()
                .join(""),
            body.iter()
                .map(|row| {
                    format!(
                        "<tr>{}</tr>",
                        row.iter()
                            .map(|cell| format!(
                                "<td>{}</td>",
                                escape_html(&replace_inline_sources(cell))
                            ))
                            .collect::<Vec<_>>()
                            .join("")
                    )
                })
                .collect::<Vec<_>>()
                .join("")
        )
    } else {
        let text = escape_html(&block.text);
        match block.kind.as_str() {
            "list-item" => format!("<ul><li class=\"guide-text\">{text}</li></ul>"),
            "quote" => format!("<blockquote class=\"guide-text\">{text}</blockquote>"),
            "code" => format!("<pre class=\"guide-text\">{text}</pre>"),
            "equation" => format!("<div class=\"guide-equation guide-text\">{text}</div>"),
            _ => format!("<p class=\"guide-text\">{text}</p>"),
        }
    };
    Ok(format!(
        "<article class=\"guide-block\">\n            <p class=\"guide-block-kind\">{}</p>\n            {}\n            {content}\n            {}\n          </article>",
        escape_html(if label.is_empty() { &block.kind } else { &label }),
        if block.stale {
            "<aside class=\"guide-stale\">Source changed. Review this block against the archive before relying on it.</aside>"
        } else {
            ""
        },
        if block.source_ids.is_empty() {
            String::new()
        } else {
            format!(
                "<p class=\"guide-sources\"><strong>Sources:</strong> {}</p>",
                block
                    .source_ids
                    .iter()
                    .map(|id| escape_html(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    ))
}

pub(crate) fn render_guide_html(
    record: &ArchiveRecord,
    images: &BTreeMap<String, GuideExportImage>,
) -> CliResult<String> {
    let draft = guide_draft(record);
    let mut sections = Vec::new();
    for section in &draft.sections {
        let mut blocks = Vec::new();
        for block in &section.blocks {
            blocks.push(render_html_block(block, images)?);
        }
        sections.push(format!(
            "<section class=\"guide-section\">\n        <h2>{}</h2>\n        {}\n      </section>",
            escape_html(&section.heading),
            blocks.join("\n")
        ));
    }
    let title = escape_html(&draft.title);
    let template = escape_html(&draft.template_id);
    let state = escape_html(record.field("approval_state").unwrap_or("draft"));
    Ok(format!(
        "<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <meta name=\"color-scheme\" content=\"light\">
  <title>{title} · Tutorux study guide</title>
  <style>
    :root {{ color-scheme: light; font-family: \"Noto Sans\", \"Segoe UI\", sans-serif; color: #18211b; background: #f4f6f3; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; padding: 32px 18px; }}
    .document {{ max-width: 860px; margin: 0 auto; padding: 54px 64px 62px; background: #fff; border: 1px solid #dfe6df; border-radius: 10px; box-shadow: 0 12px 36px rgb(19 39 27 / 8%); }}
    .document-header {{ padding-bottom: 26px; border-bottom: 1px solid #dfe6df; }}
    .brand {{ margin: 0 0 22px; color: #315b4a; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }}
    h1 {{ margin: 0; font-size: clamp(30px, 5vw, 42px); line-height: 1.12; letter-spacing: -.04em; text-wrap: balance; }}
    .document-meta {{ margin: 12px 0 0; color: #637267; font-size: 13px; }}
    .guide-section {{ margin-top: 34px; break-inside: avoid-page; }}
    h2 {{ margin: 0 0 14px; padding-bottom: 9px; border-bottom: 1px solid #e6ebe6; font-size: 21px; letter-spacing: -.025em; }}
    .guide-block {{ margin: 0 0 18px; break-inside: avoid; }}
    .guide-block-kind {{ margin: 0 0 6px; color: #637267; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }}
    .guide-text {{ margin: 0; color: #35443a; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }}
    ul {{ margin: 0; padding-left: 22px; }}
    blockquote {{ padding-left: 16px; border-left: 3px solid #9bc8aa; }}
    pre {{ padding: 12px 14px; border-radius: 6px; background: #f0f3ef; font: 13px/1.6 ui-monospace, \"Cascadia Code\", monospace; }}
    .guide-stale {{ margin: 0 0 8px; padding: 9px 11px; border-left: 3px solid #9b6e2f; background: #fbf4e9; color: #704d20; font-size: 12px; line-height: 1.5; }}
    .guide-sources {{ margin: 8px 0 0; color: #637267; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }}
    .guide-table {{ width: 100%; margin: 12px 0; border-collapse: collapse; font-size: 13px; line-height: 1.5; }}
    .guide-table th, .guide-table td {{ padding: 8px 10px; border: 1px solid #d9e0d8; text-align: left; vertical-align: top; }}
    .guide-table th {{ background: #edf1eb; color: #28463c; }}
    .guide-figure {{ margin: 16px 0; text-align: center; }}
    .guide-figure img {{ max-width: 100%; max-height: 680px; object-fit: contain; }}
    .guide-figure figcaption {{ margin-top: 7px; color: #637267; font-size: 12px; }}
    .document-footer {{ margin-top: 38px; padding-top: 14px; border-top: 1px solid #dfe6df; color: #637267; font-size: 10px; }}
    @media (max-width: 620px) {{ body {{ padding: 0; }} .document {{ padding: 32px 22px; border: 0; border-radius: 0; box-shadow: none; }} }}
    @media print {{ :root {{ background: #fff; }} body {{ padding: 0; }} .document {{ max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; }} .guide-section {{ margin-top: 24px; }} }}
  </style>
</head>
<body>
  <main class=\"document\">
    <header class=\"document-header\">
      <p class=\"brand\">Tutorux · Study guide</p>
      <h1>{title}</h1>
      <p class=\"document-meta\">{template} structure · {state}</p>
    </header>
    {}
    <footer class=\"document-footer\">Source identifiers refer to records in the Tutorux archive. Check any source-change notices against the original archive.</footer>
  </main>
</body>
</html>
",
        sections.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guide() -> ArchiveRecord {
        let mut record = ArchiveRecord::new(
            RecordType::GUIDE,
            "00000000-0000-0000-0000-000000000010",
            [
                ("title", "Guide".to_owned()),
                ("template_id", "general".to_owned()),
                ("approval_state", "draft".to_owned()),
                ("section_count", "1".to_owned()),
                ("section.0.id", "s1".to_owned()),
                ("section.0.heading", "Overview".to_owned()),
                ("section.0.block_count", "1".to_owned()),
                ("section.0.block.0.kind", "paragraph".to_owned()),
                ("section.0.block.0.text", "Hello".to_owned()),
                ("section.0.block.0.source_ids", "".to_owned()),
                ("section.0.block.0.stale", "false".to_owned()),
                ("section.0.block.0.origin", "tutor-authored".to_owned()),
            ],
        );
        record
            .fields
            .insert("created_at_us".to_owned(), "1".to_owned());
        record
    }

    #[test]
    fn json_export_sorts_fields_after_identity() {
        let json = serialize_guide_json(&guide());
        let value: Value = serde_json::from_str(&json).ok().unwrap();
        assert_eq!(value["type"], "guide");
        assert_eq!(value["revision"], "0");
        assert_eq!(value["title"], "Guide");
    }

    #[test]
    fn html_export_embeds_sections() {
        let html = render_guide_html(&guide(), &BTreeMap::new()).ok().unwrap();
        assert!(html.contains("<h2>Overview</h2>"));
        assert!(html.contains("<p class=\"guide-text\">Hello</p>"));
    }

    #[test]
    fn docx_and_pdf_are_valid_containers() {
        let docx = render_guide_docx(&guide(), &BTreeMap::new()).ok().unwrap();
        assert_eq!(&docx[..2], b"PK");
        assert!(String::from_utf8_lossy(&docx).contains("Overview"));
        let pdf = render_guide_pdf(&guide()).ok().unwrap();
        assert_eq!(&pdf[..5], b"%PDF-");
        assert!(String::from_utf8_lossy(&pdf).contains("%%EOF"));
        assert!(String::from_utf8_lossy(&pdf).contains("Overview"));
    }
}
